import http from "http";
import { WebSocketServer } from "ws";
import { createClient } from "redis";
import "dotenv/config";

const PORT = process.env.PORT || 8081;
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const EVENTS_CHANNEL = process.env.EVENTS_CHANNEL || "events:order:status";
const ORDERS_CHANNEL = process.env.ORDERS_CHANNEL || "commands:order:submit";
const PRICES_CHANNEL = process.env.PRICES_CHANNEL || "events:price:update";

const BALANCES_CHANNEL = process.env.BALANCES_CHANNEL || "events:account:balances";

// Charts (candlesticks / klines)
const CHART_REQ_CHANNEL = process.env.CHART_REQ_CHANNEL || "events:chart:request";
const CHARTS_CHANNEL = process.env.CHARTS_CHANNEL || "events:chart:update";

// Account info RPC (event-service -> execution-service)
const ACCOUNT_REQ_CHANNEL = process.env.ACCOUNT_REQ_CHANNEL || "events:account:request";
const ACCOUNT_RES_CHANNEL = process.env.ACCOUNT_RES_CHANNEL || "events:account:response";
const ACCOUNT_CACHE_MS = Number(process.env.ACCOUNT_CACHE_MS || 5 * 1000); // 5s

// Symbol metadata (exchange filters like LOT_SIZE / stepSize / minQty)
const SYMBOL_REQ_CHANNEL = process.env.SYMBOL_REQ_CHANNEL || "events:symbol:request";
const SYMBOL_RES_CHANNEL = process.env.SYMBOL_RES_CHANNEL || "events:symbol:response";
const SYMBOL_CACHE_MS = Number(process.env.SYMBOL_CACHE_MS || 10 * 60 * 1000); // 10 minutes

let redisPub = null;

// Pending RPC-style requests waiting for execution-service responses
const pending = new Map(); // id -> { resolve, reject, timeout }

// Pending order ACK waiters (orderId -> { resolve, reject, timeout })
const pendingAcks = new Map();

// In-memory cache for account snapshot per user
const accountCache = new Map(); // userId -> { ts, data }

function accountCacheGet(userId) {
    const key = String(userId || "");
    const entry = accountCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > ACCOUNT_CACHE_MS) {
        accountCache.delete(key);
        return null;
    }
    return entry.data;
}

function accountCacheSet(userId, data) {
    const key = String(userId || "");
    accountCache.set(key, { ts: Date.now(), data });
}

function waitForOrderAck(orderId, timeoutMs = 8000) {
    const oid = String(orderId || "");
    return new Promise((resolve, reject) => {
        if (!oid) return reject(new Error("orderId missing"));
        const timeout = setTimeout(() => {
            pendingAcks.delete(oid);
            reject(new Error("order ack timeout"));
        }, timeoutMs);
        pendingAcks.set(oid, { resolve, reject, timeout });
    });
}

async function requestAccountInfo({ userId, pinnedAssets = [], timeoutMs = 8000 }) {
    const uid = String(userId || "");
    if (!uid) throw new Error("userId is required");

    const cached = accountCacheGet(uid);
    if (cached) return { fromCache: true, data: cached };

    if (!redisPub) throw new Error("redis publisher not ready");

    const id = `acct-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const req = {
        type: "ACCOUNT_INFO_REQUEST",
        id,
        userId: uid,
        pinnedAssets,
        replyTo: ACCOUNT_RES_CHANNEL,
        ts: Date.now(),
    };

    const p = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error("account info timeout"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timeout });
    });

    await redisPub.publish(ACCOUNT_REQ_CHANNEL, JSON.stringify(req));
    const data = await p;
    accountCacheSet(uid, data);
    return { fromCache: false, data };
}

// In-memory cache: SYMBOL -> { data, ts }
const symbolCache = new Map();

function cacheGet(symbol) {
    const key = String(symbol || "").toUpperCase();
    const entry = symbolCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > SYMBOL_CACHE_MS) {
        symbolCache.delete(key);
        return null;
    }
    return entry.data;
}

function cacheSet(symbol, data) {
    const key = String(symbol || "").toUpperCase();
    symbolCache.set(key, { data, ts: Date.now() });
}

async function requestSymbolInfo(symbol, timeoutMs = 6000) {
    const sym = String(symbol || "").toUpperCase();

    const cached = cacheGet(sym);
    if (cached) return { fromCache: true, data: cached };

    if (!redisPub) throw new Error("redis publisher not ready");

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const req = {
        type: "SYMBOL_INFO_REQUEST",
        id,
        symbol: sym,
        replyTo: SYMBOL_RES_CHANNEL,
        ts: Date.now(),
    };

    const p = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error("symbol info timeout"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timeout });
    });

    await redisPub.publish(SYMBOL_REQ_CHANNEL, JSON.stringify(req));
    const data = await p;
    cacheSet(sym, data);
    return { fromCache: false, data };
}

function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => {
            data += chunk;
            // simple guard (1MB)
            if (data.length > 1_000_000) {
                reject(new Error("Payload too large"));
                req.destroy();
            }
        });
        req.on("end", () => {
            if (!data) return resolve(null);
            try {
                resolve(JSON.parse(data));
            } catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}

// --- HTTP server (health + REST endpoints + WS upgrade) ---
const server = http.createServer(async (req, res) => {
    setCors(res);

    // Preflight
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }

    if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
            JSON.stringify({
                ok: true,
                service: "event-service",
                redisUrl: REDIS_URL,
                eventsChannel: EVENTS_CHANNEL,
                ordersChannel: ORDERS_CHANNEL,
                pricesChannel: PRICES_CHANNEL,
                balancesChannel: BALANCES_CHANNEL,
                chartReqChannel: CHART_REQ_CHANNEL,
                chartsChannel: CHARTS_CHANNEL,
                accountReqChannel: ACCOUNT_REQ_CHANNEL,
                accountResChannel: ACCOUNT_RES_CHANNEL,
                accountCacheMs: ACCOUNT_CACHE_MS,
                symbolReqChannel: SYMBOL_REQ_CHANNEL,
                symbolResChannel: SYMBOL_RES_CHANNEL,
                symbolCacheMs: SYMBOL_CACHE_MS,
                hasPublisher: Boolean(redisPub),
            })
        );
        return;
    }
    // Frontend -> event-service: fetch account balances (pinned + nonZero)
    // Example: /account-info?userId=abc&pinned=BTC,ETH,USDT
    if (req.url?.startsWith("/account-info") && req.method === "GET") {
        try {
            const u = new URL(req.url, `http://localhost:${PORT}`);
            const userId = String(u.searchParams.get("userId") || "");
            const pinnedParam = String(u.searchParams.get("pinned") || "");
            const pinnedAssets = pinnedParam
                ? pinnedParam.split(",").map((s) => s.trim()).filter(Boolean)
                : [];

            if (!userId) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "userId query param is required" }));
            }

            const out = await requestAccountInfo({ userId, pinnedAssets, timeoutMs: 8000 });
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, fromCache: out.fromCache, data: out.data }));
        } catch (e) {
            console.error("[event-service] /account-info error:", e);
            res.writeHead(504, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: e?.message || "timeout" }));
        }
    }

    // Frontend -> event-service: fetch symbol filters (LOT_SIZE, PRICE_FILTER, NOTIONAL, etc)
    if (req.url?.startsWith("/symbol-info") && req.method === "GET") {
        try {
            const u = new URL(req.url, `http://localhost:${PORT}`);
            const symbol = String(u.searchParams.get("symbol") || "").toUpperCase();
            if (!symbol) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "symbol query param is required" }));
            }

            const cached = cacheGet(symbol);
            if (cached) {
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: true, symbol, fromCache: true, data: cached }));
            }

            const out = await requestSymbolInfo(symbol, 6000);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, symbol, fromCache: out.fromCache, data: out.data }));
        } catch (e) {
            console.error("[event-service] /symbol-info error:", e);
            res.writeHead(504, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: e?.message || "timeout" }));
        }
    }

    // Frontend -> event-service: request chart stream (execution-service will connect to Binance WS)
    // Example: POST /charts/subscribe  { symbol: "BTCUSDT", interval: "1m" }
    if (req.url === "/charts/subscribe" && req.method === "POST") {
        try {
            const body = await readJson(req);
            const symbol = String(body?.symbol || "").toUpperCase();
            const interval = String(body?.interval || "1m").toLowerCase();

            if (!symbol) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "symbol is required" }));
            }
            if (!redisPub) {
                res.writeHead(503, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "redis publisher not ready" }));
            }

            const id = `chart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const msg = { type: "CHART_SUBSCRIBE", id, symbol, interval, ts: Date.now() };

            await redisPub.publish(CHART_REQ_CHANNEL, JSON.stringify(msg));

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, publishedTo: CHART_REQ_CHANNEL, request: msg }));
        } catch (e) {
            console.error("[event-service] /charts/subscribe error:", e);
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: "internal error" }));
        }
    }

    // Optional: unsubscribe
    // Example: POST /charts/unsubscribe { symbol: "BTCUSDT", interval: "1m" }
    if (req.url === "/charts/unsubscribe" && req.method === "POST") {
        try {
            const body = await readJson(req);
            const symbol = String(body?.symbol || "").toUpperCase();
            const interval = String(body?.interval || "1m").toLowerCase();

            if (!symbol) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "symbol is required" }));
            }
            if (!redisPub) {
                res.writeHead(503, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "redis publisher not ready" }));
            }

            const id = `chart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const msg = { type: "CHART_UNSUBSCRIBE", id, symbol, interval, ts: Date.now() };

            await redisPub.publish(CHART_REQ_CHANNEL, JSON.stringify(msg));

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, publishedTo: CHART_REQ_CHANNEL, request: msg }));
        } catch (e) {
            console.error("[event-service] /charts/unsubscribe error:", e);
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: "internal error" }));
        }
    }

    // Frontend -> Event-service: create an order command
    if (req.url === "/orders" && req.method === "POST") {
        try {
            const body = await readJson(req);

            // minimal validation
            const symbol = String(body?.symbol || "").toUpperCase();
            const side = String(body?.side || "").toUpperCase();
            const quantity = Number(body?.quantity);
            const orderType = String(body?.orderType || "LIMIT").toUpperCase();
            const userId = String(body?.userId || "");

            if (!symbol) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "symbol is required" }));
            }
            if (side !== "BUY" && side !== "SELL") {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "side must be BUY or SELL" }));
            }
            if (!Number.isFinite(quantity) || quantity <= 0) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "quantity must be > 0" }));
            }
            if (!userId) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "userId is required" }));
            }

            if (orderType === "LIMIT") {
                const price = Number(body?.price);
                if (!Number.isFinite(price) || price <= 0) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ ok: false, error: "LIMIT requires a valid price" }));
                }
            }

            // UI uses STOP_MARKET; execution-service maps it to Binance Spot STOP_LOSS.
            // Also accept Binance-style names directly if the frontend ever sends them.
            if (orderType === "STOP_MARKET" || orderType === "STOP_LOSS" || orderType === "TAKE_PROFIT") {
                const stopPrice = Number(body?.stopPrice);
                if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ ok: false, error: `${orderType} requires a valid stopPrice` }));
                }
            }

            // Stop-limit variants require BOTH stopPrice and price + timeInForce
            if (orderType === "STOP_LOSS_LIMIT" || orderType === "TAKE_PROFIT_LIMIT") {
                const stopPrice = Number(body?.stopPrice);
                const price = Number(body?.price);
                const tif = String(body?.timeInForce || "").toUpperCase();

                if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ ok: false, error: `${orderType} requires a valid stopPrice` }));
                }
                if (!Number.isFinite(price) || price <= 0) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ ok: false, error: `${orderType} requires a valid price` }));
                }
                if (!tif) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ ok: false, error: `${orderType} requires timeInForce` }));
                }
            }

            const event = {
                type: "ORDER_CREATED",
                userId,
                // prefer client provided orderId/id, else generate
                orderId:
                    body?.orderId ||
                    body?.id ||
                    `ord-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                symbol,
                side,
                quantity,
                orderType,
                price: body?.price,
                // Optional fields used by execution-service/Binance
                stopPrice: body?.stopPrice,
                timeInForce: body?.timeInForce,

                meta: body?.meta || {},
                ts: Date.now(),
            };

            if (!redisPub) {
                res.writeHead(503, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "redis publisher not ready" }));
            }

            const payload = JSON.stringify(event);
            await redisPub.publish(ORDERS_CHANNEL, payload);

            // Wait for execution-service to publish ORDER_ACK / ORDER_REJECTED on EVENTS_CHANNEL
            try {
                const ack = await waitForOrderAck(event.orderId, 8000);
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: true, ack }));
            } catch (e) {
                res.writeHead(504, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: e?.message || "ack timeout" }));
            }
        } catch (e) {
            console.error("[event-service] /orders error:", e);
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: "internal error" }));
        }
    }

    res.writeHead(404);
    res.end("Not found");
});

const wss = new WebSocketServer({ noServer: true });

// Track live clients
const clients = new Set();

// Only accept WS upgrades on /prices
server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/prices") return socket.destroy();

    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
    });
});

wss.on("connection", (ws) => {
    clients.add(ws);

    ws.send(
        JSON.stringify({
            type: "HELLO",
            message: "connected to /prices",
            note: "Broadcasting Redis order events + price updates to all WS clients",
            channels: {
                orders: EVENTS_CHANNEL,
                commands: ORDERS_CHANNEL,
                prices: PRICES_CHANNEL,
                balances: BALANCES_CHANNEL,
                chartsRequest: CHART_REQ_CHANNEL,
                charts: CHARTS_CHANNEL,
                symbolRequest: SYMBOL_REQ_CHANNEL,
                symbolResponse: SYMBOL_RES_CHANNEL,
            },
        })
    );

    ws.on("close", () => {
        clients.delete(ws);
    });

    ws.on("error", () => {
        clients.delete(ws);
    });
});

function broadcast(raw) {
    for (const ws of clients) {
        if (ws.readyState === 1) {
            ws.send(raw);
        } else {
            clients.delete(ws);
        }
    }
}

// --- Redis subscriber: channels -> WS broadcast ---
async function startRedisSubscriber() {
    const sub = createClient({ url: REDIS_URL });

    sub.on("error", (err) => {
        console.error("[event-service] redis error:", err);
    });

    await sub.connect();
    console.log(`[event-service] redis connected: ${REDIS_URL}`);

    const forward = (channel, message) => {
        broadcast(
            JSON.stringify({
                type: "REDIS_EVENT",
                channel,
                message,
                ts: Date.now(),
            })
        );
    };

    await sub.subscribe(EVENTS_CHANNEL, (message) => {
        // 1) Resolve /orders ACK waiters
        try {
            const payload = JSON.parse(message);
            const t = String(payload?.type || "");
            const orderId = payload?.orderId;

            if ((t === "ORDER_ACK" || t === "ORDER_REJECTED") && orderId && pendingAcks.has(String(orderId))) {
                const p = pendingAcks.get(String(orderId));
                clearTimeout(p.timeout);
                pendingAcks.delete(String(orderId));
                p.resolve(payload);
            }
        } catch {
            // ignore
        }

        forward(EVENTS_CHANNEL, message);
    });
    await sub.subscribe(PRICES_CHANNEL, (message) => forward(PRICES_CHANNEL, message));
    await sub.subscribe(CHARTS_CHANNEL, (message) => forward(CHARTS_CHANNEL, message));
    await sub.subscribe(BALANCES_CHANNEL, (message) => forward(BALANCES_CHANNEL, message));
    await sub.subscribe(SYMBOL_RES_CHANNEL, (message) => {
        try {
            const payload = JSON.parse(message);
            const id = payload?.id;
            if (id && pending.has(id)) {
                const p = pending.get(id);
                clearTimeout(p.timeout);
                pending.delete(id);
                if (payload?.ok === false) p.reject(new Error(payload?.error || "symbol info failed"));
                else p.resolve(payload?.data);
            }

            // Warm cache only if ok === true
            if (payload?.ok === true && payload?.symbol && payload?.data) {
                cacheSet(payload.symbol, payload.data);
            }
        } catch {
            // ignore
        }

        forward(SYMBOL_RES_CHANNEL, message);
    });
    await sub.subscribe(ACCOUNT_RES_CHANNEL, (message) => {
        try {
            const payload = JSON.parse(message);
            const id = payload?.id;
            if (id && pending.has(id)) {
                const p = pending.get(id);
                clearTimeout(p.timeout);
                pending.delete(id);
                if (payload?.ok === false) p.reject(new Error(payload?.error || "account info failed"));
                else p.resolve(payload?.data);
            }

            // Warm cache if ok
            if (payload?.ok === true && payload?.userId && payload?.data) {
                accountCacheSet(payload.userId, payload.data);
            }
        } catch {
            // ignore
        }

        forward(ACCOUNT_RES_CHANNEL, message);
    });

    console.log(`[event-service] subscribed to: ${EVENTS_CHANNEL}`);
    console.log(`[event-service] subscribed to: ${PRICES_CHANNEL}`);
    console.log(`[event-service] subscribed to: ${CHARTS_CHANNEL}`);
    console.log(`[event-service] subscribed to: ${SYMBOL_RES_CHANNEL}`);
    console.log(`[event-service] subscribed to: ${BALANCES_CHANNEL}`);
    console.log(`[event-service] subscribed to: ${ACCOUNT_RES_CHANNEL}`);

    return sub;
}

// --- Boot ---
(async () => {
    server.listen(PORT, () => {
        console.log(`[event-service] http://localhost:${PORT}`);
        console.log(`[event-service] ws://localhost:${PORT}/prices`);
    });

    try {
        redisPub = createClient({ url: REDIS_URL });
        redisPub.on("error", (err) => console.error("[event-service] redis pub error:", err));
        await redisPub.connect();
        console.log(`[event-service] redis publisher connected: ${REDIS_URL}`);
    } catch (e) {
        console.error("[event-service] failed to start redis publisher:", e);
    }

    let redisSub = null;
    try {
        redisSub = await startRedisSubscriber();
    } catch (e) {
        console.error("[event-service] failed to start redis subscriber:", e);
        console.error("[event-service] Tip: set REDIS_URL env or ensure redis is running on 127.0.0.1:6379");
    }

    const shutdown = async () => {
        try {
            for (const ws of clients) {
                try {
                    ws.close();
                } catch { }
            }
            clients.clear();

            for (const [id, p] of pending) {
                clearTimeout(p.timeout);
                pending.delete(id);
            }
            for (const [oid, p] of pendingAcks) {
                clearTimeout(p.timeout);
                pendingAcks.delete(oid);
            }

            if (redisSub) await redisSub.quit();
            if (redisPub) await redisPub.quit();
        } finally {
            process.exit(0);
        }
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
})();