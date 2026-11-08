// Server-side market quotes. Never trust a price supplied by the browser.
const BINANCE_ROOT = "https://data-api.binance.vision/api/v3";
const ALLOWED_ASSETS = new Set([
  "BTC","ETH","BNB","SOL","XRP","USDC","DOGE","TRX","TON","ADA","AVAX","SHIB",
  "LINK","BCH","SUI","XLM","DOT","LTC","NEAR","UNI","ETC","ICP","APT","FIL",
  "HBAR","ARB","OP","RENDER","ATOM","VET","INJ","MKR","AAVE","GRT","ALGO",
  "THETA","MANA","SAND","AXS","EOS","ZEC","XMR","DASH","QNT","CAKE","FLOKI",
  "PEPE","BONK","FET","TAO","JUP","ONDO","SEI","KAS","STX","IMX","WLD","DAI",
  "FDUSD","PAXG","XAUT"
]);

export async function getTrustedQuote(symbol, fetchImpl = fetch) {
  const asset = String(symbol || "").toUpperCase();
  if (!ALLOWED_ASSETS.has(asset)) {
    const error = new Error("This trading pair is not enabled yet.");
    error.status = 400; error.code = "UNSUPPORTED_ASSET"; throw error;
  }
  const pair = asset + "USDT";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(`${BINANCE_ROOT}/ticker/price?symbol=${encodeURIComponent(pair)}`, {
      headers: { Accept: "application/json" }, signal: controller.signal, cf: { cacheTtl: 0 }
    });
    if (!response.ok) {
      const error = new Error("A live quote is not available for this pair.");
      error.status = response.status === 400 ? 400 : 503;
      error.code = "QUOTE_UNAVAILABLE"; throw error;
    }
    const body = await response.json();
    if (body.symbol !== pair || typeof body.price !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(body.price) || Number(body.price) <= 0) {
      const error = new Error("The market returned an invalid quote.");
      error.status = 503; error.code = "INVALID_QUOTE"; throw error;
    }
    return { symbol: asset, pair, price: body.price, source: "Binance", quotedAt: new Date().toISOString() };
  } catch (error) {
    if (error.status) throw error;
    const wrapped = new Error("Live market pricing is temporarily unavailable.");
    wrapped.status = 503; wrapped.code = "QUOTE_UNAVAILABLE"; throw wrapped;
  } finally { clearTimeout(timer); }
}
