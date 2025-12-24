"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Inter } from "next/font/google";
import { z } from "zod";
import {
  createChart,
  CrosshairMode,
  CandlestickSeries,
} from "lightweight-charts";

import { MdDarkMode, MdOutlineLightMode } from "react-icons/md";
import { CgProfile } from "react-icons/cg";

import { getToken, getUserId } from "../lib/auth";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export default function TradePage() {
  const router = useRouter();
  const userIdRef = useRef(null);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [status, setStatus] = useState("CONNECTING");
  const [apiMsg, setApiMsg] = useState("");
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);
  const [pendingOrderId, setPendingOrderId] = useState(null);
  const [toast, setToast] = useState({ open: false, title: "", message: "", status: "" });

  // orderId -> latest order status event
  const [ordersById, setOrdersById] = useState({});

  const ORDERS_PAGE_SIZE = 10;

  const [ordersPage, setOrdersPage] = useState([]);     // current page rows from backend
  const [ordersCursor, setOrdersCursor] = useState(null); // current cursor (orderId)
  const [ordersNextCursor, setOrdersNextCursor] = useState(null);
  const [ordersPrevStack, setOrdersPrevStack] = useState([]); // stack of previous cursors

  const [ordersTotalEntries, setOrdersTotalEntries] = useState(0);
  const [ordersTotalPages, setOrdersTotalPages] = useState(1);

  const ordersCurrentPage = ordersPrevStack.length + 1;
  const ordersIsFirstPage = ordersCurrentPage <= 1;
  const ordersIsLastPage = ordersCurrentPage >= ordersTotalPages;

  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState("");

  // positions (paginated)
  const POSITIONS_PAGE_SIZE = 10;

  const [positionsPage, setPositionsPage] = useState([]); // current page rows from backend
  const [positionsCursor, setPositionsCursor] = useState(null); // cursor (Position.id)
  const [positionsNextCursor, setPositionsNextCursor] = useState(null);
  const [positionsPrevStack, setPositionsPrevStack] = useState([]);

  const [positionsTotalEntries, setPositionsTotalEntries] = useState(0);
  const [positionsTotalPages, setPositionsTotalPages] = useState(1);

  const positionsCurrentPage = positionsPrevStack.length + 1;
  const positionsIsFirstPage = positionsCurrentPage <= 1;
  const positionsIsLastPage = positionsCurrentPage >= positionsTotalPages;

  const [positionsLoading, setPositionsLoading] = useState(false);
  const [positionsError, setPositionsError] = useState("");

  // balances
  const [balances, setBalances] = useState([]); // [{ asset, free, locked }]
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [balancesError, setBalancesError] = useState("");
  const [balancesUpdatedAt, setBalancesUpdatedAt] = useState(null);

  // marketBoard: { BTCUSDT: { price, ts }, ETHUSDT: { ... } }
  const [marketBoard, setMarketBoard] = useState({});
  const [filter, setFilter] = useState("");

  const [lastEvent, setLastEvent] = useState(null);
  const [lastUpdateTs, setLastUpdateTs] = useState(null);
  const [pinned, setPinned] = useState(() => new Set());

  // UI
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "light";
    try {
      const t = localStorage.getItem("theme");
      if (t === "dark" || t === "light") return t;
    } catch { }
    return "light";
  }); // 'light' | 'dark'
  const [activeTab, setActiveTab] = useState("trades"); // positions | orders | trades
  const [selectedSymbol, setSelectedSymbol] = useState("BTCUSDT");
  const [chartInterval, setChartInterval] = useState("1m"); // 1m | 5m | 1d | 1w

  const chartContainerRef = useRef(null);
  const chartApiRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const selectedSymbolRef = useRef(selectedSymbol);
  const chartIntervalRef = useRef(chartInterval);

  useEffect(() => {
    selectedSymbolRef.current = selectedSymbol;
  }, [selectedSymbol]);

  useEffect(() => {
    chartIntervalRef.current = chartInterval;
  }, [chartInterval]);

  const [side, setSide] = useState("BUY");
  const [orderType, setOrderType] = useState("MARKET");
  const [qty, setQty] = useState("0.01");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [formErrors, setFormErrors] = useState({}); // { qty?: string, limitPrice?: string, stopPrice?: string, notional?: string, base?: string }

  // Exchange symbol filters (LOT_SIZE etc)
  const [symbolInfo, setSymbolInfo] = useState(null);
  const [symbolInfoStatus, setSymbolInfoStatus] = useState("idle"); // idle | loading | ready | error
  const [symbolInfoError, setSymbolInfoError] = useState("");

  const UI_FLUSH_MS = Number(process.env.NEXT_PUBLIC_MARKET_FLUSH_MS || 1500);
  const MAX_SYMBOLS = Number(process.env.NEXT_PUBLIC_MAX_SYMBOLS || 1000);

  // Cache of latest prices by symbol
  const latestBoardRef = useRef({});
  // Stable insertion order for the table
  const symbolOrderRef = useRef([]);
  const latestTsRef = useRef(null);

  const eventBaseUrl = (process.env.NEXT_PUBLIC_EVENT_SERVICE_URL || "http://localhost:8081").replace(/\/$/, "");
  const wsBaseUrl = (
    process.env.NEXT_PUBLIC_WS_URL ||
    eventBaseUrl.replace(/^https?:\/\//, (m) => (m === "https://" ? "wss://" : "ws://"))
  ).replace(/\/$/, "");
  const apiBaseUrl = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080").replace(/\/$/, "");

  useEffect(() => {
    const token = getToken();
    const userId = getUserId();
    userIdRef.current = userId;
    if (!token || !userId) {
      router.push("/login");
      return;
    }

    // Initial balances fetch (account snapshot)
    fetchBalances();
  }, []);

  const [wsMsgCount, setWsMsgCount] = useState(0);

  useEffect(() => {
    let ws;
    let retryTimer;
    let cancelled = false;
    let attempt = 0;

    const connect = () => {
      if (cancelled) return;

      const url = `${wsBaseUrl}/prices`;
      try {
        ws = new WebSocket(url);
      } catch {
        setStatus("ERROR");
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        attempt = 0;
        setStatus("OPEN");
      };

      ws.onclose = () => {
        setStatus("CLOSED");
        scheduleReconnect();
      };

      ws.onerror = () => {
        setStatus("ERROR");
        // onerror is usually followed by close, but be safe
      };

      ws.onmessage = (e) => {
        setWsMsgCount((c) => c + 1);

        try {
          const outer = JSON.parse(e.data);
          setLastEvent(outer);

          // We expect: { type: 'REDIS_EVENT', channel, message, ts }
          if (outer?.type !== "REDIS_EVENT") return;

          const channel = outer.channel;
          let inner;
          try {
            inner = JSON.parse(outer.message);

            // Some channels publish JSON-stringified JSON (double encoding)
            if (typeof inner === "string") {
              try {
                inner = JSON.parse(inner);
              } catch {
                return; // not usable
              }
            }
          } catch {
            // If producers ever send non-JSON, ignore
            return;
          }

          // Price channel
          if (channel === "events:price:update") {
            if (inner?.type === "MARKET_BOARD" && Array.isArray(inner.data)) {
              const ts = inner.ts || outer.ts || Date.now();

              const board = latestBoardRef.current || {};
              const order = symbolOrderRef.current || [];
              const seen = new Set(order);

              for (const t of inner.data) {
                const symbol = t?.symbol ? String(t.symbol).toUpperCase() : "";
                if (!symbol) continue;
                const price = Number(t.price);
                if (!Number.isFinite(price)) continue;

                if (!seen.has(symbol)) {
                  if (order.length >= MAX_SYMBOLS) continue;
                  order.push(symbol);
                  seen.add(symbol);
                }

                board[symbol] = { price, ts };
              }

              latestBoardRef.current = board;
              symbolOrderRef.current = order;
              latestTsRef.current = ts;
              return;
            }

            if (inner?.type === "PRICE_UPDATE" && inner.symbol) {
              const price = Number(inner.price);
              if (!Number.isFinite(price)) return;

              const sym = String(inner.symbol).toUpperCase();
              const ts = inner.ts || outer.ts || Date.now();

              const board = latestBoardRef.current || {};
              const order = symbolOrderRef.current || [];

              if (!board[sym]) {
                if (order.length >= MAX_SYMBOLS) return;
                order.push(sym);
                symbolOrderRef.current = order;
              }

              board[sym] = { price, ts };
              latestBoardRef.current = board;
              latestTsRef.current = ts;
              return;
            }
          }

          // Order status channel
          if (channel === "events:order:status") {
            const ev = inner;
            // execution-service should publish the client order id as `orderId`.
            // If it publishes it under another key, accept those too.
            const orderId = ev?.orderId || ev?.clientOrderId || ev?.origClientOrderId || ev?.id;
            if (!orderId) return;

            setOrdersById((prev) => {
              const next = { ...prev };
              next[orderId] = { ...next[orderId], ...ev, orderId, updatedAt: Date.now() };

              const ids = Object.keys(next);
              if (ids.length > 1000) {
                ids.sort((a, b) => (next[a]?.updatedAt || 0) - (next[b]?.updatedAt || 0));
                const toDrop = ids.slice(0, ids.length - 1000);
                for (const id of toDrop) delete next[id];
              }
              return next;
            });

            // console.log("Received order status update for pending order:", ev);
            if (pendingOrderId && String(orderId) === String(pendingOrderId)) {
              // if (true) {
              const st = String(ev?.status || "").toUpperCase();

              // Treat PARTIALLY_FILLED as "done enough" for UI: user should be able to close toast
              // and place another order if they want.
              const isFinalish = [
                "FILLED",
                "REJECTED",
                "CANCELED",
                "CANCELLED",
                "EXPIRED",
                "PARTIALLY_FILLED",
                "NEW",
                "PENDING",
                "PENDING_CANCEL",
              ].includes(st);

              setToast({
                open: true,
                title: isFinalish ? "Order update" : "Order submitted",
                status: st || "PENDING",
                message: `${ev?.side || ""} ${ev?.symbol || ""} • qty ${ev?.quantity ?? "—"}`.trim(),
              });

              if (isFinalish) {
                setIsPlacingOrder(false);
                setPendingOrderId(null);
              }
            }
          }

          // Account update channel (execution-service -> redis -> event-service -> WS)
          // Expected inner payload shapes:
          // - { type: 'ACCOUNT_UPDATE', balances: [...] }
          // - or { type: 'BALANCES', items: [...] }
          if (channel === "events:account:update") {
            const items = Array.isArray(inner?.balances)
              ? inner.balances
              : Array.isArray(inner?.items)
                ? inner.items
                : Array.isArray(inner?.data)
                  ? inner.data
                  : [];

            if (items.length) {
              setBalances(
                items
                  .map((b) => ({
                    asset: String(b.asset || "").toUpperCase(),
                    free: String(b.free ?? "0"),
                    locked: String(b.locked ?? "0"),
                  }))
                  .filter((b) => b.asset)
              );
              setBalancesUpdatedAt(Date.now());
              setBalancesError("");
            }
            return;
          }

          if (channel === "events:chart:update") {
            const sym = String(inner?.symbol || "").toUpperCase();
            const itv = String(inner?.interval || "");
            if (!sym || sym !== String(selectedSymbolRef.current).toUpperCase()) return;
            if (itv && itv !== chartIntervalRef.current) return;

            const series = candleSeriesRef.current;
            if (!series) return;

            if (inner?.type === "KLINE_SNAPSHOT" && Array.isArray(inner?.candles) && inner?.symbol === selectedSymbolRef.current) {
              const bars = inner.candles
                .map(c => ({
                  time: Number(c.time),        // already seconds
                  open: Number(c.open),
                  high: Number(c.high),
                  low: Number(c.low),
                  close: Number(c.close),
                }))
                .filter(b =>
                  Number.isFinite(b.time) &&
                  Number.isFinite(b.open) &&
                  Number.isFinite(b.high) &&
                  Number.isFinite(b.low) &&
                  Number.isFinite(b.close)
                )
                .sort((a, b) => a.time - b.time);

              series.setData(bars);

              const chart = chartApiRef.current;
              if (chart) {
                chart.timeScale().scrollToRealTime();
                chart.timeScale().setVisibleLogicalRange({ from: 0, to: 10 });
              }


              return;
            }

            if (inner?.type === "KLINE_UPDATE" && inner?.symbol === selectedSymbolRef.current) {
              const k = inner?.kline || inner?.k || inner?.data;
              if (!k) return;

              const bar = {
                time: Math.floor(Number(k.startTime || k.time) / 1000),
                open: Number(k.open),
                high: Number(k.high),
                low: Number(k.low),
                close: Number(k.close),
              };

              if (
                !Number.isFinite(bar.time) ||
                !Number.isFinite(bar.open) ||
                !Number.isFinite(bar.high) ||
                !Number.isFinite(bar.low) ||
                !Number.isFinite(bar.close)
              ) return;

              series.update(bar);
              return;
            }
          }
        } catch {
          // ignore parse errors
        }
      };
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      if (retryTimer) return;
      attempt += 1;
      const delay = Math.min(8000, 500 * attempt);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        ws?.close();
      } catch { }
    };
  }, [wsBaseUrl, MAX_SYMBOLS, pendingOrderId]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("pinnedSymbols");
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) setPinned(new Set(arr.map((s) => String(s).toUpperCase())));
    } catch { }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("pinnedSymbols", JSON.stringify(Array.from(pinned)));
    } catch { }
  }, [pinned]);


  useEffect(() => {
    try {
      localStorage.setItem("theme", theme);
    } catch { }

    document.documentElement.style.colorScheme = theme;
    if (theme === "dark") document.documentElement.classList.add("dark");
    else document.documentElement.classList.remove("dark");
  }, [theme]);

  useEffect(() => {
    // Flush latestBoardRef to state every UI_FLUSH_MS
    const interval = setInterval(() => {
      setMarketBoard({ ...latestBoardRef.current });
      setLastUpdateTs(latestTsRef.current);
    }, UI_FLUSH_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (activeTab === "orders") {
      fetchOrdersPage(ordersCursor);
      return;
    }
    if (activeTab === "positions") {
      fetchPositionsPage(positionsCursor);
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, ordersCursor, positionsCursor]);
  async function fetchPositionsPage(cursor = null) {
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    setPositionsLoading(true);
    setPositionsError("");

    try {
      const qs = new URLSearchParams();
      qs.set("limit", String(POSITIONS_PAGE_SIZE));
      if (cursor) qs.set("cursor", String(cursor));

      const res = await fetch(`${apiBaseUrl}/positions?${qs.toString()}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error || `Failed to fetch positions (${res.status})`);
      }

      const items = Array.isArray(json?.items)
        ? json.items
        : Array.isArray(json?.data)
          ? json.data
          : [];

      setPositionsPage(items);

      const nc =
        json?.nextCursor ||
        (items.length ? items[items.length - 1]?.id || null : null);

      setPositionsNextCursor(nc || null);

      const te = Number(json?.totalEntries);
      const tp = Number(json?.totalPages);
      if (Number.isFinite(te)) setPositionsTotalEntries(te);
      if (Number.isFinite(tp) && tp > 0) setPositionsTotalPages(tp);
    } catch (e) {
      setPositionsError(e?.message || "Failed to fetch positions");
      setPositionsPage([]);
      setPositionsNextCursor(null);
      setPositionsTotalEntries(0);
      setPositionsTotalPages(1);
    } finally {
      setPositionsLoading(false);
    }
  }

  function togglePin(sym) {
    const s = String(sym).toUpperCase();
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  async function copyOrderId(id) {
    try {
      await navigator.clipboard.writeText(String(id));
      setApiMsg("Copied order id");
      setTimeout(() => setApiMsg(""), 1200);
    } catch {
      setApiMsg("Could not copy");
      setTimeout(() => setApiMsg(""), 1200);
    }
  }

  function toggleTheme() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  function formatPrice(p) {
    if (!Number.isFinite(Number(p))) return "—";
    return Number(p).toFixed(6).replace(/\.?0+$/, "");
  }

  function asNumber(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }

  function decimalsFromStep(step) {
    const s = String(step);
    const i = s.indexOf(".");
    return i === -1 ? 0 : s.length - i - 1;
  }

  function roundToStep(value, step) {
    const v = asNumber(value);
    const st = asNumber(step);
    if (v === null || st === null || st <= 0) return null;

    const d = decimalsFromStep(step);
    const scale = Math.pow(10, d);

    // Convert to integers in "step decimals" space to avoid float remainder issues.
    const stepInt = Math.round(st * scale);
    if (!Number.isFinite(stepInt) || stepInt <= 0) return null;

    // Snap DOWN to nearest step.
    const vInt = Math.floor(v * scale + 1e-9); // tiny epsilon to counter float noise
    const snappedInt = Math.floor(vInt / stepInt) * stepInt;
    const out = snappedInt / scale;

    return Number(out.toFixed(d));
  }

  function trimZeros(n) {
    return String(n).replace(/\.?0+$/, "");
  }

  function formatByStep(value, step) {
    const v = asNumber(value);
    const st = asNumber(step);
    if (v === null) return "—";
    if (st === null || st <= 0) return trimZeros(v);

    const d = Math.min(decimalsFromStep(step), 8); // cap for UI
    return trimZeros(Number(v).toFixed(d));
  }

  function validateNotional({ qtyNum, info, orderType, priceForNotional }) {
    if (!info) return { ok: true };

    const minN = asNumber(info.minNotional);
    const maxN = asNumber(info.maxNotional);

    const applyMinToMarket = Boolean(info.applyMinToMarket);
    const applyMaxToMarket = Boolean(info.applyMaxToMarket);

    const shouldApplyMin = orderType !== "MARKET" || applyMinToMarket;
    const shouldApplyMax = orderType !== "MARKET" || applyMaxToMarket;

    if (!shouldApplyMin && !shouldApplyMax) return { ok: true };

    const p = asNumber(priceForNotional);
    if (p === null || p <= 0) return { ok: true }; // can't validate w/out a price

    const notional = p * qtyNum;

    if (shouldApplyMin && minN !== null && notional < minN) {
      return { ok: false, reason: `Notional too small: ${trimZeros(notional)} < min ${trimZeros(minN)} USDT` };
    }
    if (shouldApplyMax && maxN !== null && notional > maxN) {
      return { ok: false, reason: `Notional too large: ${trimZeros(notional)} > max ${trimZeros(maxN)} USDT` };
    }
    return { ok: true };
  }

  function validateQty(q, info) {
    const qn = asNumber(q);
    if (qn === null || qn <= 0) return { ok: false, reason: "Enter a valid quantity" };
    if (!info) return { ok: true };

    const minQty = asNumber(info.minQty);
    if (minQty !== null && qn < minQty) {
      return { ok: false, reason: `Min qty is ${info.minQty}` };
    }

    const step = asNumber(info.stepSize);
    if (step === null || step <= 0) return { ok: true };

    const d = decimalsFromStep(info.stepSize);
    const scale = Math.pow(10, d);

    const stepInt = Math.round(step * scale);
    if (!Number.isFinite(stepInt) || stepInt <= 0) return { ok: true };

    // Integer-space divisibility check (prevents float false negatives)
    const qtyInt = Math.round(qn * scale);
    if (qtyInt % stepInt !== 0) {
      return { ok: false, reason: `Qty must be a multiple of ${info.stepSize}` };
    }

    return { ok: true };
  }

  // Zod error mapping helper
  function zodErrorMap(err) {
    // Convert ZodError into a simple { field: message } map
    const out = {};
    for (const issue of err.issues || []) {
      const key = (issue.path && issue.path.length ? issue.path[0] : "base") || "base";
      if (!out[key]) out[key] = issue.message;
    }
    return out;
  }

  // Build a Zod schema for order form validation
  function buildOrderSchema({ info, orderType, currentPrice }) {
    // Accept strings from inputs; transform to numbers where needed
    return z
      .object({
        qty: z
          .string()
          .trim()
          .min(1, "Quantity is required"),
        limitPrice: z.string().trim().optional(),
        stopPrice: z.string().trim().optional(),
      })
      .superRefine((val, ctx) => {
        // Quantity
        const qcheck = validateQty(val.qty, info);
        if (!qcheck.ok) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["qty"], message: qcheck.reason });
          return;
        }

        const qtyNum = Number(val.qty);

        // Order-type specific price validation
        let priceForNotional = currentPrice;

        if (orderType === "LIMIT") {
          const p = Number(val.limitPrice);
          if (!Number.isFinite(p) || p <= 0) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["limitPrice"], message: "Enter a valid limit price" });
            return;
          }
          priceForNotional = p;
        }

        if (orderType === "STOP_LOSS") {
          const sp = Number(val.stopPrice);
          if (!Number.isFinite(sp) || sp <= 0) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stopPrice"], message: "Enter a valid stop price" });
            return;
          }
          priceForNotional = sp;
        }

        // Notional validation (minNotional/maxNotional)
        const ncheck = validateNotional({ qtyNum, info, orderType, priceForNotional });
        if (!ncheck.ok) {
          // Show this as a general form error (not tied to one field)
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["notional"], message: ncheck.reason });
          return;
        }
      });
  }

  async function fetchOrdersPage(cursor = null) {
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    setOrdersLoading(true);
    setOrdersError("");

    try {
      const qs = new URLSearchParams();
      qs.set("limit", String(ORDERS_PAGE_SIZE));
      if (cursor) qs.set("cursor", String(cursor)); // orderId cursor

      const res = await fetch(`${apiBaseUrl}/orders?${qs.toString()}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error || `Failed to fetch orders (${res.status})`);
      }

      // Expect: { ok: true, items: [...], nextCursor: "..." }
      const items = Array.isArray(json?.items)
        ? json.items
        : Array.isArray(json?.data)
          ? json.data
          : [];

      setOrdersPage(items);

      const nc =
        json?.nextCursor ||
        (items.length ? items[items.length - 1]?.orderId || null : null);

      setOrdersNextCursor(nc || null);

      const te = Number(json?.totalEntries);
      const tp = Number(json?.totalPages);
      if (Number.isFinite(te)) setOrdersTotalEntries(te);
      if (Number.isFinite(tp) && tp > 0) setOrdersTotalPages(tp);
    } catch (e) {
      setOrdersError(e?.message || "Failed to fetch orders");
      setOrdersPage([]);
      setOrdersNextCursor(null);
      setOrdersTotalEntries(0);
      setOrdersTotalPages(1);
    } finally {
      setOrdersLoading(false);
    }
  }

  async function fetchBalances() {
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    setBalancesLoading(true);
    setBalancesError("");

    try {
      // execution-service API (same auth as /orders, /positions)
      const res = await fetch(`${apiBaseUrl}/api/trading/account`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error || `Failed to fetch balances (${res.status})`);
      }

      const raw = Array.isArray(json?.balances)
        ? json.balances
        : Array.isArray(json?.account?.balances)
          ? json.account.balances
          : [];

      const cleaned = raw
        .map((b) => ({
          asset: String(b.asset || "").toUpperCase(),
          free: String(b.free ?? "0"),
          locked: String(b.locked ?? "0"),
        }))
        .filter((b) => b.asset);

      setBalances(cleaned);
      setBalancesUpdatedAt(Date.now());
    } catch (e) {
      setBalances([]);
      setBalancesError(e?.message || "Failed to fetch balances");
    } finally {
      setBalancesLoading(false);
    }
  }

  async function subscribeChart(symbol, interval) {
    try {
      await fetch(`${eventBaseUrl}/charts/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: String(symbol || "").toUpperCase(),
          interval: String(interval || "1m"),
        }),
      });
    } catch {
      // ignore
    }
  }

  const isDark = theme === "dark";


  // 1) Create the chart ONCE (do not recreate on theme toggle)
  useEffect(() => {
    const el = chartContainerRef.current;
    if (!el) return;

    // Ensure the container is clean before mounting a new chart
    try {
      el.innerHTML = "";
    } catch { }

    // cleanup previous chart (defensive)
    try {
      chartApiRef.current?.remove?.();
    } catch { }
    chartApiRef.current = null;
    candleSeriesRef.current = null;

    const chart = createChart(el, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false },
      layout: {
        background: { color: "#ffffff" },
        textColor: "#334155",
      },
      grid: {
        vertLines: { color: "#e2e8f0" },
        horzLines: { color: "#e2e8f0" },
      },
    });

    const series = chart.addSeries(CandlestickSeries, {});
    chartApiRef.current = chart;
    candleSeriesRef.current = series;

    return () => {
      try {
        chart.remove();
      } catch { }
      chartApiRef.current = null;
      candleSeriesRef.current = null;
    };
  }, []);

  // 2) Update chart colors when theme changes (do NOT wipe data)
  useEffect(() => {
    const chart = chartApiRef.current;
    if (!chart) return;

    chart.applyOptions({
      layout: {
        background: { color: isDark ? "#020617" : "#ffffff" },
        textColor: isDark ? "#cbd5e1" : "#334155",
      },
      grid: {
        vertLines: { color: isDark ? "#0f172a" : "#e2e8f0" },
        horzLines: { color: isDark ? "#0f172a" : "#e2e8f0" },
      },
    });

    // Optional: candle style tweaks for dark mode (keeps data intact)
    const series = candleSeriesRef.current;
    if (series?.applyOptions) {
      series.applyOptions({
        priceFormat: { type: "price", precision: 6, minMove: 0.000001 },
      });
    }
  }, [isDark]);

  useEffect(() => {
    let cancelled = false;

    async function fetchSymbolInfo() {
      setSymbolInfoStatus("loading");
      setSymbolInfoError("");

      try {
        const res = await fetch(
          `${eventBaseUrl}/symbol-info?symbol=${selectedSymbol}`
        );
        const json = await res.json();

        if (!res.ok) throw new Error(json.error || "Failed to load symbol info");

        if (!cancelled) {
          setSymbolInfo(json.data);
          setSymbolInfoStatus("ready");

          // snap qty to step size
          const snapped = roundToStep(qty, json.data.stepSize);
          if (snapped !== null) setQty(String(snapped));
        }
      } catch (err) {
        if (!cancelled) {
          setSymbolInfo(null);
          setSymbolInfoStatus("error");
          setSymbolInfoError(err.message);
        }
      }
    }

    fetchSymbolInfo();
    return () => (cancelled = true);
  }, [selectedSymbol]);

  useEffect(() => {
    subscribeChart(selectedSymbol, chartInterval);
    try {
      candleSeriesRef.current?.setData([]);
    } catch { }
  }, [selectedSymbol, chartInterval]);

  async function placeOrder() {
    if (!userIdRef.current) {
      setApiMsg("Not authenticated. Please login again.");
      router.push("/login");
      return;
    }
    setApiMsg("");
    setFormErrors({});
    if (isPlacingOrder) return;
    setIsPlacingOrder(true);

    const schema = buildOrderSchema({ info: symbolInfo, orderType, currentPrice: asNumber(currentPrice) });
    const parsed = schema.safeParse({
      qty,
      limitPrice,
      stopPrice,
    });

    if (!parsed.success) {
      const map = zodErrorMap(parsed.error);
      setFormErrors(map);
      // Also show a short message in apiMsg for visibility
      setApiMsg(map.notional || map.qty || map.limitPrice || map.stopPrice || map.base || "Fix the highlighted fields");
      setIsPlacingOrder(false);
      return;
    }

    let qtyNum = Number(parsed.data.qty);
    let limitPriceNum = orderType === "LIMIT" ? Number(parsed.data.limitPrice) : undefined;
    let stopPriceNum = orderType === "STOP_LOSS" ? Number(parsed.data.stopPrice) : undefined;

    // Snap inputs to exchange filters (stepSize, tickSize)
    if (symbolInfo) {
      if (symbolInfo.stepSize) {
        const s = roundToStep(qtyNum, symbolInfo.stepSize);
        if (s !== null) qtyNum = s;
      }
      if (symbolInfo.tickSize) {
        if (limitPriceNum !== undefined) {
          const s = roundToStep(limitPriceNum, symbolInfo.tickSize);
          if (s !== null) limitPriceNum = s;
        }
        if (stopPriceNum !== undefined) {
          const s = roundToStep(stopPriceNum, symbolInfo.tickSize);
          if (s !== null) stopPriceNum = s;
        }
      }
    }

    setApiMsg("Placing order...");
    const clientOrderId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `ord-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    setPendingOrderId(clientOrderId);
    setToast({
      open: true,
      title: "Placing order",
      status: "PENDING",
      message: `${side} ${selectedSymbol} • qty ${qtyNum}`,
    });

    try {
      const payload = {
        orderId: clientOrderId,
        userId: userIdRef.current,
        symbol: String(selectedSymbol || "").toUpperCase(),
        side: String(side || "").toUpperCase(),
        orderType: String(orderType || "MARKET").toUpperCase(),
        quantity: qtyNum,
        meta: {},
      };

      // Keep fields explicit:
      // - LIMIT uses `price` (+ timeInForce)
      // - STOP_LOSS (Stop Market) uses `stopPrice`
      if (orderType === "LIMIT") {
        payload.price = limitPriceNum;
        payload.timeInForce = "GTC";
      } else if (orderType === "STOP_LOSS") {
        payload.stopPrice = stopPriceNum;
      }

      const res = await fetch(`${eventBaseUrl}/orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      console.log("Place order response:", data);
      if (!res.ok || !data.ok) {
        setIsPlacingOrder(false);
        setApiMsg(data.error || "Order failed");
        return;
      }

      setApiMsg("Order sent. Waiting for status...");
    } catch (e) {
      setIsPlacingOrder(false);
      setApiMsg("Network error");
    }
  }

  const f = filter.trim().toLowerCase();

  // Keep table stable: insertion order + pinned coins on top
  const orderedSymbols = symbolOrderRef.current;

  const pinnedList = Array.from(pinned);
  const pinnedSet = pinned;

  const pinnedRows = pinnedList
    .map((sym) => [sym, marketBoard[sym]])
    .filter(([sym, v]) => v && (!f || sym.toLowerCase().includes(f)));

  const regularRows = orderedSymbols
    .filter((sym) => !pinnedSet.has(sym))
    .map((sym) => [sym, marketBoard[sym]])
    .filter(([sym, v]) => v && (!f || sym.toLowerCase().includes(f)));

  const rows = [...pinnedRows, ...regularRows];
  const shown = rows.slice(0, MAX_SYMBOLS);

  // Derived rows (pinned first)
  const totalSymbols = symbolOrderRef.current.length;

  const currentPrice = marketBoard[selectedSymbol]?.price;

  const priceLabel =
    orderType === "MARKET" ? "Price" : orderType === "STOP_LOSS" ? "Stop price" : "Limit price";

  const pricePlaceholder =
    orderType === "MARKET"
      ? "Market price"
      : orderType === "STOP_LOSS"
        ? "Enter stop price"
        : "Enter limit price";

  const priceValue =
    orderType === "MARKET"
      ? (Number.isFinite(Number(currentPrice)) ? String(currentPrice) : "")
      : orderType === "STOP_LOSS"
        ? stopPrice
        : limitPrice;


  return (
    <main className={`${inter.className} min-h-screen w-full overflow-x-hidden transition-colors duration-200 ${isDark ? "bg-[#09090b] text-neutral-200" : "bg-[#f5f5f5] text-neutral-900"}`}>
      {/* Topbar - Glassmorphism style */}
      <div className={`sticky top-0 z-40 border-b backdrop-blur-md ${isDark ? "bg-[#09090b]/80 border-white/10" : "bg-white/80 border-black/5"}`}>
        <div className="max-w-[1920px] mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 font-bold tracking-tighter text-lg">
              <Image src="/logo.svg" alt="Logo" className="invert opacity-90" width={150} height={100} />
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Live Indicator with Glow */}
            <div className={`hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border ${isDark ? "bg-neutral-900/50 border-white/5 text-emerald-400" : "bg-white border-black/5 text-emerald-600"}`}>
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              Live
            </div>

            <div className="flex items-center  dark:bg-neutral-900 bg-neutral-100 rounded-full dark:border-white/5">
              <button
                onClick={toggleTheme}
                className={`px-3 py-3 text-xs font-medium rounded-full transition-all ${isDark ? "bg-neutral-800 text-white shadow-sm" : "text-neutral-500 hover:text-neutral-900 bg-white"}`}
              >
                {isDark ? <MdDarkMode /> : <MdOutlineLightMode />}
              </button>
            </div>

            {/* <button className={`h-9 w-9 flex items-center justify-center rounded-full border transition-colors ${isDark ? "bg-neutral-900 border-white/10 hover:bg-neutral-800 text-neutral-400" : "bg-white border-black/5 hover:bg-neutral-50 text-neutral-600"}`}>
                            <CgProfile />
                        </button> */}
            {/* Profile Dropdown Container */}
            <div className="relative">
              <button
                onClick={() => setIsProfileOpen(!isProfileOpen)}
                className={`h-9 w-9 flex items-center justify-center rounded-full border transition-all duration-200 ${isProfileOpen
                  ? (isDark ? "bg-neutral-800 border-white/20 text-white" : "bg-neutral-100 border-black/10 text-black")
                  : (isDark ? "bg-neutral-900 border-white/10 hover:bg-neutral-800 text-neutral-400" : "bg-white border-black/5 hover:bg-neutral-50 text-neutral-600")
                  }`}
              >
                <CgProfile className="text-lg" />
              </button>

              {/* Dropdown Menu */}
              {isProfileOpen && (
                <div
                  className={`absolute right-0 mt-2 w-56 rounded-xl border shadow-xl backdrop-blur-sm z-50 transform origin-top-right transition-all ${isDark
                    ? "bg-[#111]/95 border-white/10 text-neutral-200 shadow-black/50"
                    : "bg-white/95 border-black/5 text-neutral-700 shadow-neutral-200/50"
                    }`}
                >
                  <div className="p-1.5 space-y-0.5">
                    {/* Header / User Info (Optional) */}
                    <div className={`px-3 py-2 text-xs font-semibold uppercase tracking-wider ${isDark ? "text-neutral-500" : "text-neutral-400"}`}>
                      My Account
                    </div>

                    {/* Edit Details */}
                    <button
                      className={`w-full flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${isDark ? "hover:bg-white/5 hover:text-white" : "hover:bg-neutral-100 hover:text-black"
                        }`}
                      onClick={() => { alert("Coming soon!"); }}

                    >
                      {/* Icon: FiEdit or similar */}
                      <svg className="w-4 h-4 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                      Edit Details
                    </button>

                    {/* Divider */}
                    <div className={`my-1 h-px ${isDark ? "bg-white/5" : "bg-black/5"}`}></div>

                    {/* Logout */}
                    <button
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg text-rose-500 hover:bg-rose-500/10 transition-colors"
                      onClick={() => {
                        router.push("/logout");
                      }}
                    >
                      {/* Icon: FiLogOut or similar */}
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                      Logout
                    </button>
                  </div>

                  {/* Footer Section: Close */}
                  <div className={`p-1.5 border-t ${isDark ? "border-white/5 bg-white/5" : "border-black/5 bg-neutral-50/50"}`}>
                    <button
                      onClick={() => setIsProfileOpen(false)}
                      className={`w-full flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${isDark ? "text-neutral-400 hover:text-white hover:bg-white/5" : "text-neutral-500 hover:text-black hover:bg-black/5"
                        }`}
                    >
                      Close Menu
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-[1920px] mx-auto p-4 lg:p-6">
        <h1 className="text-xl font-medium tracking-tight mb-6 px-1">Portfolio & Trade</h1>

        <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
          {/* Left Column: Controls */}
          <div className="space-y-6">

            {/* Order Box */}
            <div className={`rounded-xl border overflow-hidden shadow-sm ${isDark ? "bg-[#111] border-white/10" : "bg-white border-black/5"}`}>
              <div className="p-5">
                {/* Buy/Sell Segmented Control */}
                <div className={`grid grid-cols-2 gap-1 p-1 rounded-lg mb-6 ${isDark ? "bg-neutral-900" : "bg-neutral-100"}`}>
                  <button
                    onClick={() => setSide("BUY")}
                    className={`py-2 text-sm font-semibold rounded-md transition-all ${side === "BUY"
                      ? (isDark ? "bg-[#111] text-emerald-400 shadow-sm ring-1 ring-white/10" : "bg-white text-emerald-600 shadow-sm")
                      : "text-neutral-500 hover:text-neutral-400"}`}
                  >
                    BUY
                  </button>
                  <button
                    onClick={() => {
                      setSide("SELL");
                      if (orderType === "STOP_LOSS") setOrderType("MARKET");
                    }}
                    className={`py-2 text-sm font-semibold rounded-md transition-all ${side === "SELL"
                      ? (isDark ? "bg-[#111] text-rose-400 shadow-sm ring-1 ring-white/10" : "bg-white text-rose-600 shadow-sm")
                      : "text-neutral-500 hover:text-neutral-400"}`}
                  >
                    SELL
                  </button>
                </div>

                {/* Order Type Tabs */}
                <div className="flex gap-4 border-b border-neutral-200 dark:border-white/5 mb-6 pb-2 overflow-x-auto">
                  {["LIMIT", "MARKET", "STOP_LOSS"].map((t) => {
                    if (side === "SELL" && t === "STOP_LOSS") return null;
                    const isActive = orderType === t;
                    return (
                      <button
                        key={t}
                        onClick={() => {
                          setOrderType(t);
                          if (t !== "LIMIT") setLimitPrice("");
                          if (t !== "STOP_LOSS") setStopPrice("");
                        }}
                        className={`text-xs font-medium pb-2 -mb-2.5 border-b-2 transition-colors whitespace-nowrap ${isActive
                          ? (isDark ? "text-white border-white" : "text-black border-black")
                          : "text-neutral-500 border-transparent hover:text-neutral-300"}`}
                      >
                        {t === "STOP_LOSS" ? "Stop Market" : t[0] + t.slice(1).toLowerCase()}
                      </button>
                    );
                  })}
                </div>

                {/* Inputs */}
                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between text-xs mb-1.5 text-neutral-500">
                      <span>{priceLabel}</span>
                    </div>
                    <div className={`flex items-center px-3 py-2.5 rounded-lg border transition-all ${isDark ? "bg-[#09090b] border-white/10 focus-within:border-white/30" : "bg-neutral-50 border-neutral-200 focus-within:border-neutral-400"}`}>
                      <input
                        className="bg-transparent text-sm w-full outline-none font-mono"
                        placeholder={pricePlaceholder}
                        disabled={orderType === "MARKET"}
                        value={priceValue}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (orderType === "STOP_LOSS") {
                            setStopPrice(v);
                            setFormErrors((prev) => ({ ...prev, stopPrice: undefined, notional: undefined }));
                          } else if (orderType === "LIMIT") {
                            setLimitPrice(v);
                            setFormErrors((prev) => ({ ...prev, limitPrice: undefined, notional: undefined }));
                          }
                        }}
                      />
                      <span className="text-xs text-neutral-500 font-medium">USDT</span>
                    </div>
                    {/* Errors & Helpers */}
                    {orderType === "MARKET" && <div className="mt-1.5 text-xs text-neutral-500">Executes at best price.</div>}
                    {(formErrors.limitPrice || formErrors.stopPrice || formErrors.notional) && (
                      <div className="mt-1.5 text-xs text-rose-500 font-medium">{formErrors.limitPrice || formErrors.stopPrice || formErrors.notional}</div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs mb-1.5 text-neutral-500">Quantity</div>
                      <div className={`flex items-center px-3 py-2.5 rounded-lg border transition-all ${isDark ? "bg-[#09090b] border-white/10 focus-within:border-white/30" : "bg-neutral-50 border-neutral-200 focus-within:border-neutral-400"}`}>
                        <input
                          className="bg-transparent text-sm w-full outline-none font-mono"
                          value={qty}
                          onChange={(e) => {
                            setQty(e.target.value);
                            setFormErrors((prev) => ({ ...prev, qty: undefined, notional: undefined }));
                          }}
                          placeholder="0.00"
                        />
                        <span className="text-xs text-neutral-500 font-medium">{selectedSymbol.replace("USDT", "")}</span>
                      </div>
                      {formErrors.qty && <div className="mt-1.5 text-xs text-rose-500 font-medium">{formErrors.qty}</div>}
                    </div>
                    <div>
                      <div className="text-xs mb-1.5 text-neutral-500">Total</div>
                      <div className={`flex items-center px-3 py-2.5 rounded-lg border ${isDark ? "bg-[#1a1a1a] border-white/5 text-neutral-500" : "bg-neutral-100 border-neutral-200 text-neutral-400"}`}>
                        <input
                          className="bg-transparent text-sm w-full outline-none font-mono cursor-default"
                          placeholder="0.00"
                          disabled
                          value={`${formatPrice(currentPrice * Number(qty) || 0)}`}
                          readOnly
                        />
                        <span className="text-xs opacity-70 font-medium">USDT</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between py-2 text-xs">
                    <span className="text-neutral-500">Last Price</span>
                    <span className={`font-mono font-medium ${isDark ? "text-white" : "text-black"}`}>{formatPrice(currentPrice)}</span>
                  </div>

                  {symbolInfoStatus === "error" && (
                    <div className="text-xs text-rose-500 bg-rose-500/10 p-2 rounded">{symbolInfoError}</div>
                  )}

                  <button
                    onClick={placeOrder}
                    disabled={isPlacingOrder}
                    className={`w-full py-3.5 text-sm font-bold rounded-lg transition-all transform active:scale-[0.98] ${isDark
                      ? "bg-white text-black hover:bg-neutral-200 disabled:bg-neutral-800 disabled:text-neutral-500"
                      : "bg-black text-white hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-400"
                      } ${isPlacingOrder ? "cursor-not-allowed opacity-80" : ""}`}
                  >
                    {isPlacingOrder ? "Submitting..." : (
                      <>
                        {side === "BUY" ? "Buy" : "Sell"} {selectedSymbol.replace("USDT", "")}
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Account Summary */}
            <div className={`rounded-xl border shadow-sm p-5 ${isDark ? "bg-[#111] border-white/10" : "bg-white border-black/5"}`}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold tracking-tight">Assets</h3>
                <button
                  onClick={fetchBalances}
                  disabled={balancesLoading}
                  className={`p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors ${balancesLoading ? "animate-spin" : ""}`}
                  title="Refresh balances"
                >
                  <svg className={`w-3.5 h-3.5 ${isDark ? "text-neutral-400" : "text-neutral-500"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                </button>
              </div>

              {balancesError && <div className="text-xs text-rose-500 mb-3">{balancesError}</div>}

              <div className="space-y-3 text-sm">
                {(() => {
                  const byAsset = new Map(balances.map((b) => [b.asset, b]));
                  const usdt = byAsset.get("USDT");
                  const usdtFree = usdt ? Number(usdt.free || 0) : 0;
                  const pinnedBases = Array.from(pinned).map((s) => String(s).toUpperCase().replace(/USDT$/, "")).filter((s) => s && s !== "USDT");
                  const uniqPinnedBases = Array.from(new Set(pinnedBases)).slice(0, 8);

                  return (
                    <>
                      <div className="flex items-center justify-between py-1">
                        <div className="flex items-center gap-2">
                          <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center text-[10px] text-emerald-500 font-bold">$</div>
                          <span className="font-medium">USDT</span>
                        </div>
                        <div className="text-right">
                          <div className="font-mono font-medium">{trimZeros(usdtFree.toFixed(2))}</div>
                        </div>
                      </div>

                      {uniqPinnedBases.length > 0 && (
                        <div className="border-t border-dashed border-neutral-200 dark:border-white/10 pt-3 mt-3 space-y-3">
                          {uniqPinnedBases.map((asset) => {
                            const b = byAsset.get(asset);
                            const free = b ? Number(b.free || 0) : 0;
                            const sym = `${asset}USDT`;
                            const mark = Number(marketBoard[sym]?.price || 0);
                            const est = Number.isFinite(mark) && mark > 0 ? free * mark : null;

                            if (free === 0) return null;

                            return (
                              <div key={asset} className="flex items-center justify-between">
                                <button
                                  onClick={() => setSelectedSymbol(sym)}
                                  className="text-xs font-medium hover:text-emerald-500 transition-colors"
                                >
                                  {asset}
                                </button>
                                <div className="text-right">
                                  <div className="font-mono text-xs">{trimZeros(free.toFixed(4))}</div>
                                  <div className="text-[10px] text-neutral-500">
                                    {est !== null ? `≈ $${formatPrice(est)}` : "—"}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {balancesUpdatedAt && <div className="pt-2 text-[10px] text-neutral-500 text-right">Updated {new Date(balancesUpdatedAt).toLocaleTimeString()}</div>}
                    </>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* Right Column: Chart & Data - Added min-w-0 for grid safety */}
          <div className="space-y-6 flex flex-col h-full min-h-0 w-full min-w-0">
            {/* Chart Section */}
            <div className={`rounded-xl border shadow-sm flex flex-col ${isDark ? "bg-[#111] border-white/10" : "bg-white border-black/5"}`}>
              <div className="flex flex-wrap items-center justify-between p-4 border-b border-neutral-100 dark:border-white/5 gap-x-4 gap-y-4">
                <div className="flex items-center gap-4">
                  <h2 className="text-lg font-bold tracking-tight">{selectedSymbol.replace("USDT", "")}<span className="text-neutral-500 text-sm font-normal">/USDT</span></h2>
                  <div className="h-4 w-[1px] bg-neutral-200 dark:bg-white/10"></div>
                  <div className={`font-mono text-lg font-medium tracking-tight ${isDark ? "text-white" : "text-neutral-900"}`}>
                    {formatPrice(currentPrice)}
                  </div>
                </div>

                <div className={`flex rounded-lg overflow-hidden border ${isDark ? "border-white/10 bg-neutral-900" : "border-neutral-200 bg-neutral-50"}`}>
                  {["1m", "5m", "1d", "1w"].map((t) => (
                    <button
                      key={t}
                      onClick={() => setChartInterval(t)}
                      className={`px-3 py-1.5 text-xs font-medium transition-colors ${t === chartInterval
                        ? (isDark ? "bg-neutral-800 text-white" : "bg-white text-black shadow-sm")
                        : "text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-300"}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="relative h-[400px] w-full p-1">
                <div ref={chartContainerRef} className="w-full h-full" />
              </div>
            </div>

            {/* Tabs & Table Section */}
            <div className={`flex-1 rounded-xl border shadow-sm flex flex-col min-h-[500px] ${isDark ? "bg-[#111] border-white/10" : "bg-white border-black/5"}`}>
              {/* Header: Flex col on mobile, row on desktop to prevent squashing */}
              <div className="flex flex-col md:flex-row md:items-center justify-between px-4 pt-4 pb-2 border-b border-neutral-100 dark:border-white/5 gap-4">
                {/* Tabs Container: Added overflow-x-auto to handle many tabs on small screen */}
                <div className="flex gap-6 overflow-x-auto w-full md:w-auto pb-2 md:pb-0 scrollbar-hide">
                  {[
                    { id: "positions", label: "Open Positions" },
                    { id: "orders", label: "Order History" },
                    { id: "trades", label: "Market Trades" },
                  ].map((t) => (
                    <button
                      key={t.id}
                      onClick={() => {
                        setActiveTab(t.id);
                        // Reset cursors logic
                        if (t.id === "orders") { setOrdersCursor(null); setOrdersNextCursor(null); setOrdersPrevStack([]); setOrdersTotalEntries(0); setOrdersTotalPages(1); }
                        if (t.id === "positions") { setPositionsError(""); setPositionsCursor(null); setPositionsNextCursor(null); setPositionsPrevStack([]); setPositionsTotalEntries(0); setPositionsTotalPages(1); }
                      }}
                      className={`text-sm font-medium pb-3 border-b-2 transition-colors whitespace-nowrap ${activeTab === t.id
                        ? (isDark ? "text-white border-emerald-500" : "text-black border-emerald-600")
                        : "text-neutral-500 border-transparent hover:text-neutral-400"}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {activeTab === "trades" && (
                  <div className={`flex items-center px-2 py-1.5 rounded-md border w-full md:w-auto ${isDark ? "bg-neutral-900 border-white/10" : "bg-neutral-50 border-neutral-200"}`}>
                    <svg className="w-3 h-3 text-neutral-500 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                    <input
                      className="bg-transparent text-xs outline-none w-full md:w-32"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Filter Symbol"
                    />
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-hidden relative">
                <div className="absolute inset-0 overflow-auto custom-scrollbar">
                  <table className="w-full text-sm text-left">
                    <thead className={`sticky top-0 z-10 text-xs uppercase tracking-wider ${isDark ? "bg-[#151515] text-neutral-500" : "bg-neutral-50 text-neutral-500"}`}>
                      <tr>
                        {activeTab === "positions" && ["Symbol", "Size", "Entry", "Mark", "Realized PnL", "Unrealized PnL"].map(h => <th key={h} className="px-5 py-3 font-medium whitespace-nowrap">{h}</th>)}
                        {activeTab === "orders" && ["ID", "Symbol", "Side", "Type", "Qty", "Status"].map(h => <th key={h} className="px-5 py-3 font-medium whitespace-nowrap">{h}</th>)}
                        {activeTab === "trades" && ["Pin", "Symbol", "Price", "Time"].map(h => <th key={h} className="px-5 py-3 font-medium whitespace-nowrap">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100 dark:divide-white/5">
                      {/* POSITIONS RENDER LOGIC */}
                      {activeTab === "positions" && (
                        positionsLoading ? <tr><td colSpan={6} className="px-5 py-8 text-center text-neutral-500">Loading positions...</td></tr> :
                          positionsError ? <tr><td colSpan={6} className="px-5 py-8 text-center text-rose-500">{positionsError}</td></tr> :
                            positionsPage.length === 0 ? <tr><td colSpan={6} className="px-5 py-8 text-center text-neutral-500">No open positions</td></tr> :
                              positionsPage.map(p => {
                                const sym = String(p.symbol || "").toUpperCase();
                                const realized = Number(p.realizedPnl || 0);
                                const mark = Number(marketBoard[sym]?.price || 0);
                                const entry = Number(p.avgPrice || 0);
                                const qtyNum = Number(p.quantity || 0);
                                const unrealized = (Number.isFinite(mark) && Number.isFinite(entry)) ? (mark - entry) * qtyNum : 0;

                                return (
                                  <tr key={p.id || `${p.userId}:${sym}`} className="hover:bg-neutral-50 dark:hover:bg-white/5 transition-colors">
                                    <td className="px-5 py-3 font-medium cursor-pointer hover:text-emerald-500" onClick={() => setSelectedSymbol(sym)}>{sym}</td>
                                    <td className="px-5 py-3 font-mono text-neutral-500">{trimZeros(qtyNum.toFixed(6))}</td>
                                    <td className="px-5 py-3 font-mono">{trimZeros(entry.toFixed(6))}</td>
                                    <td className="px-5 py-3 font-mono">{formatPrice(mark)}</td>
                                    <td className={`px-5 py-3 font-mono ${realized >= 0 ? "text-emerald-500" : "text-rose-500"}`}>{realized > 0 && "+"}{trimZeros(realized.toFixed(4))}</td>
                                    <td className={`px-5 py-3 font-mono ${unrealized >= 0 ? "text-emerald-500" : "text-rose-500"}`}>{unrealized > 0 && "+"}{trimZeros(unrealized.toFixed(4))}</td>
                                  </tr>
                                )
                              })
                      )}

                      {/* ORDERS RENDER LOGIC */}
                      {activeTab === "orders" && (
                        ordersLoading ? <tr><td colSpan={6} className="px-5 py-8 text-center text-neutral-500">Loading orders...</td></tr> :
                          ordersPage.length === 0 ? <tr><td colSpan={6} className="px-5 py-8 text-center text-neutral-500">No order history</td></tr> :
                            ordersPage.map(o => (
                              <tr key={o.orderId} className="hover:bg-neutral-50 dark:hover:bg-white/5 transition-colors">
                                <td className="px-5 py-3 font-mono text-xs text-neutral-500 flex items-center gap-2">
                                  {String(o.orderId).slice(0, 8)}...
                                  <CopyOrderButton orderId={o.orderId} isDark={isDark} onCopy={copyOrderId} />
                                </td>
                                <td className="px-5 py-3 font-medium cursor-pointer hover:text-emerald-500" onClick={() => setSelectedSymbol(o.symbol)}>{o.symbol}</td>
                                <td className="px-5 py-3">
                                  <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${o.side === "BUY" ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"}`}>
                                    {o.side}
                                  </span>
                                </td>
                                <td className="px-5 py-3 text-neutral-500 text-xs">{o.orderType}</td>
                                <td className="px-5 py-3 font-mono">{o.quantity}</td>
                                <td className="px-5 py-3 text-xs font-medium">
                                  <span className={`px-2 py-1 rounded border ${(ordersById[o.orderId]?.status || o.status) === "FILLED" ? "border-emerald-500/20 text-emerald-500 bg-emerald-500/5" :
                                    (ordersById[o.orderId]?.status || o.status) === "CANCELED" ? "border-neutral-500/20 text-neutral-500" :
                                      "border-yellow-500/20 text-yellow-500 bg-yellow-500/5"
                                    }`}>
                                    {ordersById[o.orderId]?.status || o.status}
                                  </span>
                                </td>
                              </tr>
                            ))
                      )}

                      {/* TRADES RENDER LOGIC */}
                      {activeTab === "trades" && (
                        shown.length === 0 ? <tr><td colSpan={4} className="px-5 py-8 text-center text-neutral-500">Waiting for market data...</td></tr> :
                          shown.map(([sym, v]) => (
                            <tr key={sym} className="hover:bg-neutral-50 dark:hover:bg-white/5 transition-colors">
                              <td className="px-5 py-3">
                                <button onClick={() => togglePin(sym)} className={`text-sm ${pinned.has(sym) ? "text-amber-400" : "text-neutral-600 dark:text-neutral-600 hover:text-neutral-400"}`}>
                                  {pinned.has(sym) ? "★" : "☆"}
                                </button>
                              </td>
                              <td className="px-5 py-3 font-medium cursor-pointer hover:text-emerald-500" onClick={() => setSelectedSymbol(sym)}>{sym}</td>
                              <td className="px-5 py-3 font-mono">{formatPrice(v.price)}</td>
                              <td className="px-5 py-3 text-xs text-neutral-500 tabular-nums">{v.ts ? new Date(v.ts).toLocaleTimeString() : "-"}</td>
                            </tr>
                          ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Footer / Pagination */}
              {(activeTab === "positions" || activeTab === "orders") && (
                <div
                  className={`flex items-center justify-between p-2 border-t ${isDark ? "border-white/10" : "border-black/5"}`}>

                  <div className="text-xs text-neutral-500">
                    {activeTab === "positions" ? positionsTotalEntries : ordersTotalEntries} items
                  </div>
                  <div className="flex gap-2">
                    <button
                      className={`p-1.5 rounded-md border disabled:opacity-30 ${isDark ? "border-white/10 hover:bg-neutral-800" : "border-neutral-200 hover:bg-white"}`}
                      onClick={() => activeTab === "positions" ? fetchPositionsPage(positionsCursor) : fetchOrdersPage(ordersCursor)}
                      disabled={activeTab === "positions" ? positionsLoading : ordersLoading}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                    </button>
                    <button
                      className={`p-1.5 rounded-md border disabled:opacity-30 ${isDark ? "border-white/10 hover:bg-neutral-800" : "border-neutral-200 hover:bg-white"}`}
                      disabled={(activeTab === "positions" ? positionsPrevStack.length === 0 : ordersPrevStack.length === 0)}
                      onClick={() => {
                        if (activeTab === "positions") {
                          setPositionsPrevStack(prev => {
                            const next = [...prev];
                            setPositionsCursor(next.pop() || null);
                            return next;
                          });
                        } else {
                          setOrdersPrevStack(prev => {
                            const next = [...prev];
                            setOrdersCursor(next.pop() || null);
                            return next;
                          });
                        }
                      }}
                    >
                      <FiArrowLeft className="w-4 h-4" />
                    </button>
                    <span className="text-xs flex items-center px-2 text-neutral-500">
                      Page {activeTab === "positions" ? positionsCurrentPage : ordersCurrentPage}
                    </span>
                    <button
                      className={`p-1.5 rounded-md border disabled:opacity-30 ${isDark ? "border-white/10 hover:bg-neutral-800" : "border-neutral-200 hover:bg-white"}`}
                      disabled={activeTab === "positions" ? (!positionsNextCursor || positionsIsLastPage) : (!ordersNextCursor || ordersIsLastPage)}
                      onClick={() => {
                        if (activeTab === "positions" && positionsNextCursor) {
                          setPositionsPrevStack(p => [...p, positionsCursor]);
                          setPositionsCursor(positionsNextCursor);
                        } else if (activeTab === "orders" && ordersNextCursor) {
                          setOrdersPrevStack(p => [...p, ordersCursor]);
                          setOrdersCursor(ordersNextCursor);
                        }
                      }}
                    >
                      <FiArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Toast Modal - Styled Premium */}
      {toast.open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 sm:p-0">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" onClick={() => !isPlacingOrder && setToast(t => ({ ...t, open: false }))} />
          <div className={`relative w-full max-w-sm rounded-2xl border shadow-2xl overflow-hidden transform transition-all ${isDark ? "bg-[#111] border-white/10" : "bg-white border-black/5"}`}>
            <div className={`h-1.5 w-full ${toast.status === "FILLED" ? "bg-emerald-500" : toast.status === "REJECTED" ? "bg-rose-500" : "bg-neutral-500"}`}></div>
            <div className="p-6">
              <h3 className="text-lg font-bold tracking-tight mb-1">{toast.title}</h3>
              <p className={`text-sm mb-4 ${isDark ? "text-neutral-400" : "text-neutral-500"}`}>{toast.message}</p>

              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => { setActiveTab("orders"); setToast(t => ({ ...t, open: false })); }}
                  className={`flex-1 py-2.5 text-sm font-medium rounded-lg border ${isDark ? "border-white/10 hover:bg-white/5" : "border-neutral-200 hover:bg-neutral-50"}`}
                >
                  View Order
                </button>
                <button
                  onClick={() => setToast(t => ({ ...t, open: false }))}
                  className={`flex-1 py-2.5 text-sm font-bold rounded-lg ${isDark ? "bg-white text-black hover:bg-neutral-200" : "bg-black text-white hover:bg-neutral-800"}`}
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}


import { FiCopy, FiCheck, FiArrowRight, FiArrowLeft, FiSun } from "react-icons/fi";
import { Fi } from "zod/v4/locales";

const CopyOrderButton = ({ orderId, isDark, onCopy }) => {
  const [copied, setCopied] = useState(false);

  const handleClick = () => {
    // 1. Perform the actual copy action
    if (onCopy) {
      onCopy(orderId);
    } else {
      // Fallback if no function passed
      navigator.clipboard.writeText(orderId);
    }

    // 2. Trigger the icon change
    setCopied(true);

    // 3. Revert back after 2 seconds
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`p-1 rounded transition-all duration-200 ${isDark
        ? "hover:bg-slate-800"
        : "hover:bg-slate-200"
        } ${copied
          ? "text-emerald-500 scale-110" // Green and slightly larger when copied
          : isDark ? "text-slate-400" : "text-slate-500"
        }`}
      title={copied ? "Copied!" : "Copy order id"}
    >
      {copied ? <FiCheck className="w-4 h-4" /> : <FiCopy className="w-4 h-4" />}
    </button>
  );
};