import crypto from "crypto";

export async function getAccountInfo(apiKey, apiSecret) {
    const base = "https://testnet.binance.vision/api/v3/account";
    const timestamp = Date.now();
    const qs = `timestamp=${timestamp}`;

    // create signature
    const signature = crypto
        .createHmac("sha256", apiSecret)
        .update(qs)
        .digest("hex");

    const url = `${base}?${qs}&signature=${signature}`;

    const res = await fetch(url, {
        headers: { "X-MBX-APIKEY": apiKey }
    });

    return await res.json();
}

function signQuery(qs, apiSecret) {
    return crypto.createHmac("sha256", apiSecret).update(qs).digest("hex");
}

export async function getMyTrades(apiKey, apiSecret, {
    symbol,          // required
    orderId,         // optional
    startTime,       // optional (ms)
    endTime,         // optional (ms) - start/end window must be <= 24h
    fromId,          // optional
    limit = 500,     // optional (max 1000)
    recvWindow = 60000
} = {}) {
    if (!symbol) throw new Error("symbol is required");

    const base = "https://testnet.binance.vision/api/v3/myTrades";
    const timestamp = Date.now();

    const params = new URLSearchParams();
    params.set("symbol", String(symbol).toUpperCase());
    params.set("timestamp", String(timestamp));
    params.set("recvWindow", String(recvWindow));
    params.set("limit", String(Math.min(1000, Math.max(1, Number(limit) || 500))));

    if (orderId != null) params.set("orderId", String(orderId));
    if (startTime != null) params.set("startTime", String(startTime));
    if (endTime != null) params.set("endTime", String(endTime));
    if (fromId != null) params.set("fromId", String(fromId));

    const qs = params.toString();
    const signature = signQuery(qs, apiSecret);

    const url = `${base}?${qs}&signature=${signature}`;

    const res = await fetch(url, { headers: { "X-MBX-APIKEY": apiKey } });
    const data = await res.json();

    if (!res.ok) {
        const msg = data?.msg || data?.message || "Binance error";
        throw new Error(`${msg} (status ${res.status})`);
    }

    return data; // array of fills/trades
}


// const trades = await getMyTrades(
//     "LMAzl5QCLNe3FynGkt69pFPzOWlRrw02jwayucWwO2ZpsAX0WTPNFK5i9ost9d4V",
//     "V0pKZXQ74pIL4tdxnZXSEryeDMZ70LuQQROfkqeKuycQtu3h76TXL466h99rBjlP",
//     symbol: "BTCUSDT"
// );

const trades = await getMyTrades(
    "2OgAFV2nluKuLhRmsJWjeVqyvziVHdTYdmpDUU4h16dDWdjy5ENm9dU6FiN64uYg",
    "kH7DvfpjsMHPBiDvuJSJae1a7SSv8HNLzw49IwAwsaAFeIzFvxBKpfASC7IQtGzY",
    {
        symbol: "BTCUSDT"
    }
);

console.log(trades);
