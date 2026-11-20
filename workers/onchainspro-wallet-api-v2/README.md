# Persistent Quick Trade migration (staged)

This folder contains the first server-side trade engine module for the existing
`onchainspro-wallet-api-v2` Cloudflare Worker. It is intentionally **not live yet**.
Do not deploy this module by itself: the current Worker does not import it, and
the current browser still has direct Firestore wallet-write paths.

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
durations, global/user market-win-loss controls, and USDT P/L accounting. For non-USDT
funding assets, the server obtains the funding asset's USDT quote and validates the
user's recorded holding. The existing product's accounting model credits/debits P/L
in USDT; this module does not sell or consume the funding coin.

## Required integration in the existing Worker

Keep the existing Firebase JWT verification, service-account token function,
Firestore conversion helpers, wallet read route, and administrator adjustment route.
Import the module near the top of the existing Worker source:

```js
import { createTradeEngine } from "./trade-engine.js";
```

Inside `fetch(request, env)`, after Firebase token verification and URL parsing,
construct the engine:

```js
const trades = createTradeEngine({
  ROOT,
  serviceToken: () => serviceToken(env),
  toFirestore,
  fieldsFromFirestore
});
```

Add these authenticated routes before the existing 404 response:

```js
if (url.pathname === "/v1/trades" && request.method === "POST") {
  const result = await trades.create(claims.sub, await request.json());
  return json(result, 201, cors);
}
if (url.pathname === "/v1/trades" && request.method === "GET") {
  return json(await trades.list(claims.sub), 200, cors);
}
```

Add a `scheduled` handler to the same default export (do not replace the existing
`fetch` handler):

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

Configure a Cloudflare Cron Trigger for every minute (`* * * * *`). The Worker must
retain the existing `FIREBASE_SERVICE_ACCOUNT` secret and include both production
origins in `ALLOWED_ORIGINS`:
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

1. **Worker routes are not integrated yet.** The frontend adapter is staged, but the
   existing deployed Worker still does not import this engine or expose `/v1/trades`.
   Apply the integration snippet above before deploying the Hosting change. The adapter
   intercepts Confirm Trade and uses `POST /v1/trades` and `GET /v1/trades`; it restores
   active trades and renders server-provided expiry/settlement data.
2. **Wallet writes are still allowed from the browser.** The current Firestore rules let
   a user update their own `userTradeState`, and the current Buy & Hold flow plus wallet
   restore code write that document directly. Do not tighten the rule until those flows
   have been migrated to trusted server endpoints, or Buy & Hold and existing wallet
   behavior will break. The final rule must allow the owner to read their wallet but
   deny client create/update/delete; server Admin/REST writes bypass these rules.
3. **Funding accounting needs end-to-end UI verification.** The current UI selects a
   funding coin, but the historical Quick Trade settlement adjusts USDT. This module
   preserves that behavior and reserves the USDT-equivalent exposure. Do not silently
   change it to consume coin holdings without a separately reviewed accounting migration.
4. **Price-source validation is required.** Confirm the Binance spot symbols and XAU
   futures symbol are available for every selectable market asset before enabling live
   trading. A missing quote intentionally leaves a trade unsettled and retries on the
   next cron run; it never invents a result.
5. **Indexes must finish building** before enabling the list/settlement routes.

## Verification checklist before merging or deploying

- [ ] Import and route integration builds in the existing Worker without removing wallet/admin routes.
- [ ] Cron trigger is active and a test invocation reports scanned/settled/failed counts.
- [ ] Authenticated user can create a trade; another UID cannot list or read it.
- [ ] Two simultaneous confirmations cannot exceed the account's available USDT-equivalent exposure.
- [ ] Closing the browser does not stop the trade; it settles after expiry from Cron.
- [ ] Repeated Cron runs cannot create a second wallet adjustment or ledger record.
- [ ] Refresh/new device restores the same active trade and server expiry time.
- [ ] Browser-side Quick Trade result calculation and wallet writes are removed.
- [ ] Other wallet features (Buy & Hold, deposits, withdrawals, profile, support) still pass regression checks.
- [ ] Firestore client wallet writes are denied only after all browser wallet-write paths are migrated.

No live Worker, Firestore rules, Hosting site, or production wallet was changed by this staged module.
