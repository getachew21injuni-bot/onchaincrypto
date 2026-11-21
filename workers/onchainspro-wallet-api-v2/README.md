# Persistent Quick Trade migration (staged)

This folder contains the integrated source for the existing `onchainspro-wallet-api-v2`
Cloudflare Worker: `worker.js` preserves the uploaded wallet-read and administrator
adjustment routes, imports `trade-engine.js`, exposes the authenticated trade routes, and
runs scheduled settlement. The companion frontend adapter is also staged. This code is
on a review branch only and is **not deployed**.

## What the module does

- Creates one Firestore `activeTrades/{tradeId}` document per confirmed Quick Trade.
- Records the authenticated UID, selected market, direction, funding asset and amount,
  server entry quote, duration, expiry, and the server-read trade-control settings.
- Uses `activeTradeGuards/{uid}` with Firestore update-time preconditions to reserve
  outstanding USDT-equivalent trade exposure and prevent simultaneous confirmations
  from oversubscribing the available USDT balance.
- Reads current and expiry prices from public Binance ticker endpoints on the server.
- Settles due trades from a scheduled Worker invocation, not from a browser timer.
- Atomically updates `userTradeState/{uid}`, marks the active trade completed, releases
  its reservation, and creates `tradeLedger/{tradeId}` with an `exists:false` precondition.
  This makes settlement idempotent under retries and concurrent cron invocations.
- Lists the signed-in user's active and recent completed trades.

The companion `public/server-trades.js` adapter intercepts the existing Confirm Trade action,
submits only the selected symbol/direction/funding amount, restores running trades after
sign-in or refresh, and displays server-returned settlement data. It deliberately prevents
the old browser timer/result handler from running and has no local fallback.

The create request body is `{ symbol, direction, amount, fundingAsset }`; the server derives
the USDT-equivalent stake, entry quote, tier, duration, expiry, and outcome settings.

The module keeps the existing Quick Trade plan tiers, 30/60/90/120/180/360 second
durations, global/user market-win-loss controls, and USDT P/L accounting. Quick Trade
is restricted to USDT funding. Non-USDT funding is rejected server-side until coin
reservations and deductions can be committed atomically. This prevents the same coin
holdings from being reused to back multiple active trades.

## Worker integration included in this branch

The integrated `worker.js` already keeps the existing Firebase JWT verification,
service-account token function, Firestore conversion helpers, wallet read route, and
administrator adjustment route. It imports the trade module near the top:

```js
import { createTradeEngine } from "./trade-engine.js";
```

Inside `fetch(request, env)`, after Firebase token verification and URL parsing, it constructs the engine:

```js
const trades = createTradeEngine({
  ROOT,
  serviceToken: () => serviceToken(env),
  toFirestore,
  fieldsFromFirestore
});
```

The integrated entrypoint adds these authenticated routes before the existing 404 response:

```js
if (url.pathname === "/v1/trades" && request.method === "POST") {
  const result = await trades.create(claims.sub, await request.json());
  return json(result, 201, cors);
}
if (url.pathname === "/v1/trades" && request.method === "GET") {
  return json(await trades.list(claims.sub), 200, cors);
}
```

The same default export adds this `scheduled` handler without replacing the existing `fetch` handler:

```js
async scheduled(event, env, ctx) {
  const trades = createTradeEngine({
    ROOT,
    serviceToken: () => serviceToken(env),
    toFirestore,
    fieldsFromFirestore
  });
  ctx.waitUntil(trades.settleDue());
}
```

The included `wrangler.toml` configures a Cloudflare Cron Trigger for every minute (`* * * * *`)
and both production origins in `ALLOWED_ORIGINS`. Deploy it to the existing Worker name
so its already-configured `FIREBASE_SERVICE_ACCOUNT` secret remains available:
- `https://onchainspro.com`
- `https://www.onchainspro.com`

The Firebase service account needs permission to read and write the Firestore
collections used here. Never put its private key in GitHub or browser code.

**Expiry precision note:** a one-minute Cron Trigger checks due trades once per minute. A trade is settled on the first successful check after `expiresAt`, so settlement and its exit quote can be up to roughly 60 seconds late (longer during a price-provider outage). This is independent of the browser and survives closed devices, but it is not second-accurate. If exact-to-the-second expiry is required, use a per-trade Cloudflare Durable Object alarm or another scheduled execution service before enabling production trades.

## Firestore collections

| Collection | Purpose |
|---|---|
| `activeTrades` | Individual running trade records; server-owned |
| `activeTradeGuards` | Per-user reserved exposure and active count; server-owned |
| `tradeLedger` | Append-once completed trade and settlement record; server-owned |
| `userTradeState` | Existing canonical wallet snapshot; updated by server at settlement |

Required composite indexes were added to the branch's `firestore.indexes.json`.

## Important deployment blockers (must be resolved before production)

1. **The Worker still needs to be deployed.** The branch now includes the integrated
   Worker entrypoint and Cron configuration, but the live Cloudflare Worker has not been
   changed. Deploy this Worker source to the existing `onchainspro-wallet-api-v2` Worker
   before deploying Hosting. The adapter uses `POST /v1/trades` and `GET /v1/trades`; it
   restores active trades and renders server-provided expiry/settlement data.
2. **Wallet writes are still allowed from the browser.** The current Firestore rules let
   a user update their own `userTradeState`, and the current Buy & Hold flow plus wallet
   restore code write that document directly. Do not tighten the rule until those flows
   have been migrated to trusted server endpoints, or Buy & Hold and existing wallet
   behavior will break. The final rule must allow the owner to read their wallet but
   deny client create/update/delete; server Admin/REST writes bypass these rules.
3. **Funding UI needs alignment.** The server now rejects non-USDT Quick Trade funding until
   coin reservations and deductions are implemented atomically. The UI should clearly limit
   funding to USDT or display a clear explanation; do not enable coin funding prematurely.
4. **Price-source validation is required.** Confirm the Binance spot symbols and XAU
   futures symbol are available for every selectable market asset before enabling live
   trading. A missing quote intentionally leaves a trade unsettled and retries on the
   next cron run; it never invents a result.
5. **Indexes must finish building** before enabling the list/settlement routes.

## Verification checklist before merging or deploying

- [ ] Integrated Worker entrypoint passes `node --check` and preserves existing wallet/admin routes.
- [ ] Cron trigger is active and a test invocation reports scanned/settled/failed counts.
- [ ] Authenticated user can create a trade; another UID cannot list or read it.
- [ ] Two simultaneous confirmations cannot exceed the account's available USDT-equivalent exposure.
- [ ] Closing the browser does not stop the trade; it settles after expiry from Cron.
- [ ] Repeated Cron runs cannot create a second wallet adjustment or ledger record.
- [ ] Refresh/new device restores the same active trade and server expiry time.
- [ ] Browser-side Quick Trade result calculation and wallet writes are removed.
- [ ] Other wallet features (Buy & Hold, deposits, withdrawals, profile, support) still pass regression checks.
- [ ] Firestore client wallet writes are denied only after all browser wallet-write paths are migrated.

No live Worker, Firestore rules, Hosting site, or production wallet was changed by this staged branch.
