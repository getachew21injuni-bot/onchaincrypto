import { withFirestoreTransaction, firestoreString, firestoreInteger } from "./firestore-rest.js";
import { getTrustedQuote } from "./quotes.js";

const SCALE = 100000000n;
const MIN_TRADE_USDT = 100n * SCALE;

function fail(message, status = 400, code = "INVALID_REQUEST") {
  const error = new Error(message); error.status = status; error.code = code; throw error;
}
function parseUnits(value, label) {
  if (typeof value !== "string" && typeof value !== "number") fail(`Invalid ${label}.`);
  const s = String(value);
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(s)) fail(`Invalid ${label}.`);
  const [whole, fraction = ""] = s.split(".");
  return BigInt(whole) * SCALE + BigInt((fraction + "00000000").slice(0, 8));
}
function fmt(units) {
  const whole = units / SCALE, fraction = (units % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
function valueOf(field) {
  if (!field) return undefined;
  if (field.stringValue !== undefined) return field.stringValue;
  return undefined;
}
function mapBalances(account) {
  const fields = account?.fields?.balances?.mapValue?.fields || {};
  const out = {};
  for (const [symbol, field] of Object.entries(fields)) out[symbol] = valueOf(field);
  return out;
}
async function hashKey(uid, operationId) {
  const bytes = new TextEncoder().encode(uid + ":" + operationId);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function mapValue(balances) {
  const fields = {};
  for (const [symbol, amount] of Object.entries(balances)) fields[symbol] = firestoreString(amount);
  return { mapValue: { fields } };
}
function timestampTransform(fieldPath) {
  return { fieldPath, setToServerValue: "REQUEST_TIME" };
}
export async function executeStandardTrade({ user, body, env, dependencies = {} }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid trade request.");
  const side = body.side;
  if (side !== "buy" && side !== "sell") fail("Trade side must be buy or sell.");
  const symbol = typeof body.symbol === "string" ? body.symbol.toUpperCase() : "";
  if (!/^[A-Z0-9]{2,12}$/.test(symbol) || symbol === "USDT") fail("Invalid trading asset.");
  const operationId = body.operationId;
  if (typeof operationId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(operationId)) fail("A valid unique operation ID is required.");
  const quoteAmount = parseUnits(body.quoteAmount, "trade amount");
  if (quoteAmount < MIN_TRADE_USDT) fail("The minimum trade amount is 100 USDT.", 400, "MINIMUM_TRADE");
  const quote = await (dependencies.getQuote || getTrustedQuote)(symbol, dependencies.fetchImpl || fetch);
  const priceUnits = parseUnits(quote.price, "market price");
  if (priceUnits <= 0n) fail("Invalid live market quote.", 503, "INVALID_QUOTE");
  const quantity = (quoteAmount * SCALE) / priceUnits;
  if (quantity <= 0n) fail("Trade amount is too small for this asset.");
  const actualGross = side === "buy" ? quoteAmount : (quantity * priceUnits) / SCALE;
  if (actualGross < MIN_TRADE_USDT) fail("The minimum trade amount is 100 USDT.", 400, "MINIMUM_TRADE");

  const keyId = await hashKey(user.uid, operationId);
  const tradeId = crypto.randomUUID();
  const buyEntryId = crypto.randomUUID(), sellEntryId = crypto.randomUUID();
  return withFirestoreTransaction(env, async tx => {
    const prior = await tx.get("operationKeys", keyId);
    if (prior) {
      const result = prior.fields?.result?.mapValue?.fields || {};
      return {
        replayed: true,
        tradeId: valueOf(result.tradeId),
        status: valueOf(result.status) || "filled",
        side: valueOf(result.side),
        symbol: valueOf(result.symbol),
        quantity: valueOf(result.quantity),
        price: valueOf(result.price),
        grossAmount: valueOf(result.grossAmount)
      };
    }
    const account = await tx.get("walletAccounts", user.uid);
    if (!account) fail("Your cloud wallet is not set up yet. Your existing balance has not been changed.", 409, "ACCOUNT_NOT_MIGRATED");
    const accountFields = account.fields || {};
    if (valueOf(accountFields.uid) !== user.uid ||
        valueOf(accountFields.status) !== "active" ||
        valueOf(accountFields.migrationStatus) !== "verified" ||
        Number(accountFields.schemaVersion?.integerValue) !== 1) {
      fail("Your cloud wallet must be verified before trading can be enabled.", 409, "ACCOUNT_NOT_VERIFIED");
    }
    const balances = mapBalances(account);
    const beforeQuote = parseUnits(balances.USDT || "0", "USDT balance");
    const beforeAsset = parseUnits(balances[symbol] || "0", `${symbol} balance`);
    let afterQuote, afterAsset, quoteDebit, quoteCredit, assetDebit, assetCredit;
    if (side === "buy") {
      if (beforeQuote < quoteAmount) fail("Insufficient USDT balance.", 409, "INSUFFICIENT_FUNDS");
      afterQuote = beforeQuote - quoteAmount;
      afterAsset = beforeAsset + quantity;
      quoteDebit = quoteAmount; quoteCredit = 0n; assetDebit = 0n; assetCredit = quantity;
    } else {
      if (beforeAsset < quantity) fail(`Insufficient ${symbol} balance.`, 409, "INSUFFICIENT_FUNDS");
      afterQuote = beforeQuote + actualGross;
      afterAsset = beforeAsset - quantity;
      quoteDebit = 0n; quoteCredit = actualGross; assetDebit = quantity; assetCredit = 0n;
    }
    balances.USDT = fmt(afterQuote); balances[symbol] = fmt(afterAsset);
    const ledgerBase = {
      uid: firestoreString(user.uid), operationId: firestoreString(operationId),
      type: firestoreString("trade_settlement"), status: firestoreString("posted"),
      source: firestoreString("trade_engine"), relatedId: firestoreString(tradeId)
    };
    const quoteEntry = side === "buy" ? {
      ...ledgerBase, asset: firestoreString("USDT"), amount: firestoreString(fmt(quoteDebit)),
      direction: firestoreString("debit"), balanceBefore: firestoreString(fmt(beforeQuote)), balanceAfter: firestoreString(fmt(afterQuote))
    } : {
      ...ledgerBase, asset: firestoreString("USDT"), amount: firestoreString(fmt(quoteCredit)),
      direction: firestoreString("credit"), balanceBefore: firestoreString(fmt(beforeQuote)), balanceAfter: firestoreString(fmt(afterQuote))
    };
    const assetEntry = side === "buy" ? {
      ...ledgerBase, asset: firestoreString(symbol), amount: firestoreString(fmt(assetCredit)),
      direction: firestoreString("credit"), balanceBefore: firestoreString(fmt(beforeAsset)), balanceAfter: firestoreString(fmt(afterAsset))
    } : {
      ...ledgerBase, asset: firestoreString(symbol), amount: firestoreString(fmt(assetDebit)),
      direction: firestoreString("debit"), balanceBefore: firestoreString(fmt(beforeAsset)), balanceAfter: firestoreString(fmt(afterAsset))
    };
    tx.update("walletAccounts", user.uid, {
      balances: mapValue(balances),
      version: firestoreInteger(Number(accountFields.version?.integerValue || 0) + 1)
    }, ["balances", "version"], [timestampTransform("updatedAt")]);
    tx.create("walletLedger", buyEntryId, quoteEntry, [timestampTransform("createdAt")]);
    tx.create("walletLedger", sellEntryId, assetEntry, [timestampTransform("createdAt")]);
    tx.create("tradeLedger", tradeId, {
      uid: firestoreString(user.uid), operationId: firestoreString(operationId),
      symbol: firestoreString(symbol + "/USDT"), baseAsset: firestoreString(symbol),
      quoteAsset: firestoreString("USDT"), side: firestoreString(side),
      orderType: firestoreString("market"), quantity: firestoreString(fmt(quantity)),
      price: firestoreString(fmt(priceUnits)), grossAmount: firestoreString(fmt(actualGross)),
      fee: firestoreString("0"), netAmount: firestoreString(fmt(actualGross)),
      quoteSource: firestoreString(quote.source), quoteTimestamp: firestoreString(quote.quotedAt),
      status: firestoreString("filled"),
      settlementWalletEntryIds: { arrayValue: { values: [{ stringValue: buyEntryId }, { stringValue: sellEntryId }] } }
    }, [timestampTransform("createdAt")]);
    tx.create("operationKeys", keyId, {
      uid: firestoreString(user.uid), operationId: firestoreString(operationId),
      result: { mapValue: { fields: {
        tradeId: firestoreString(tradeId), status: firestoreString("filled"),
        side: firestoreString(side), symbol: firestoreString(symbol),
        quantity: firestoreString(fmt(quantity)), price: firestoreString(fmt(priceUnits)),
        grossAmount: firestoreString(fmt(actualGross))
      } } }
    });
    return { replayed: false, tradeId, status: "filled", side, symbol, quantity: fmt(quantity), price: fmt(priceUnits), grossAmount: fmt(actualGross), quoteSource: quote.source, quoteTimestamp: quote.quotedAt };
  }, 3, dependencies.firestoreDependencies || {});
}
