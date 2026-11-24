import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Script } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";

const html = await readFile("public/index.html", "utf8");
const supportChat = await readFile("public/support-chat.js", "utf8");
const admin = await readFile("public/admin.html", "utf8");
const serverTrades = await readFile("public/server-trades.js", "utf8");
const tradeEngine = await readFile("workers/onchainspro-wallet-api-v2/trade-engine.js", "utf8");
const tradeWorker = await readFile("workers/onchainspro-wallet-api-v2/worker.js", "utf8");


test("Admin activity records signed-in page views, button clicks, and every restored Quick Trade result once", () => {
  assert.ok(html.includes('id="oc-complete-user-activity-tracking"'), "Expected one delegated user activity tracker");
  assert.ok(html.includes('window.ocRecordActivity?.("page_view"'), "Authenticated page navigation must be recorded");
  assert.ok(html.includes('window.ocRecordActivity?.("button_click"'), "Authenticated button clicks must be recorded");
  assert.ok(html.includes('"button_click"'), "Firestore activity sync must accept button-click events");
  assert.ok(admin.includes('<option value="button_click">Button clicks</option>'), "Admin must be able to filter button clicks");
  assert.ok(serverTrades.includes('if (completedActivityId && !activityCompletedTradeIds.has(completedActivityId))'), "Restored completed trades must be logged even if this browser did not observe the running state");
  assert.ok(serverTrades.includes('"quick-trade-completed-" + completedActivityId'), "Trade completion events must use a stable event key to avoid duplicate records across reloads");
});


test("Admin Trades view uses the secure administrator-only Worker endpoint and shows live status and P/L", () => {
  assert.ok(tradeWorker.includes("async function adminTradeMonitor(env, claims)"), "Worker must expose an administrator-only trade monitor");
  assert.ok(tradeWorker.includes('url.pathname === "/v1/admin/trades"'), "Worker must expose the Admin trade read route");
  assert.ok(tradeWorker.includes('admins.includes(email)'), "Worker must independently authorize the configured admin email");
  assert.ok(admin.includes("window.adminGetTrades=async function"), "Admin Trades view must load live server trade data");
  assert.ok(admin.includes("NOT TRADING") && admin.includes("TRADING"), "Admin must see whether each registered user has an active trade");
  assert.ok(admin.includes("Profit / Loss") && admin.includes("Active trades now"), "Admin must see active trades and completed profit/loss results");
});

test("all inline classic JavaScript parses", () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const failures = [];
  let checked = 0;
  for (let index = 0; index < scripts.length; index += 1) {
    const [, attributes, source] = scripts[index];
    if (/\bsrc\s*=/.test(attributes) || !source.trim()) continue;
    const type = (attributes.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || "text/javascript";
    if (!/^(text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript)$/i.test(type)) continue;
    checked += 1;
    const id = (attributes.match(/\bid\s*=\s*["']([^"']+)/i) || [])[1] || "inline-" + (index + 1);
    try {
      new Script(source, { filename: "public/index.html#" + id });
    } catch (error) {
      failures.push(id + ": " + error.stack);
    }
  }
  assert.ok(checked > 0, "Expected inline JavaScript to be checked");
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("HTML element IDs are unique", () => {
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
  const seen = new Set();
  const duplicates = new Set();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  assert.deepEqual([...duplicates], [], "Duplicate IDs: " + [...duplicates].join(", "));
});

test("market, trade summary, and withdrawal validation elements are present", () => {
  for (const id of ["marketRows", "priceChart", "timedTradeChart", "timedResultBoard", "timedBoardClose", "withdrawNetwork", "withdrawAddressCheck"]) {
    assert.ok(html.includes('id="' + id + '"') || html.includes("id='" + id + "'"), "Missing required element: " + id);
  }
  assert.ok(html.includes('id="timedBoardPnlChart"'), "The completed-trade profit graph must be present");
  assert.ok(html.includes("function drawTimedPnlGraph("), "The completed-trade profit graph renderer must exist");
  assert.ok(serverTrades.includes('"timedBoardPnlChart"'), "Server-confirmed settlement must draw the completed-trade graph");
  assert.ok(serverTrades.includes("ocDismissedTradeResult"), "Closing a result must keep it dismissed after refresh");
  assert.ok(html.includes("data-api.binance.vision/api/v3/klines"), "Expected an independent chart-history fallback");
  assert.ok(html.includes("networksByAsset"), "Expected asset-specific withdrawal network rules");
});

test("home quick actions use one More/Less controller", () => {
  const start = html.indexOf('id="page-home"');
  const end = html.indexOf('id="page-markets"', start);
  assert.ok(start >= 0 && end > start, "Expected home and market page sections");
  const home = html.slice(start, end);
  const actions = [...home.matchAll(/class="quick-action(?:\s+[^"]*)?"/g)];
  assert.equal(actions.length, 9, "Expected nine Home actions");
  assert.ok(html.includes('wrap.id="homeQuickActionsMoreWrap"'), "Expected the shared More/Less wrapper to be created once");
  assert.ok(html.includes('id="homeQuickActionsMore"'), "Expected the shared More/Less button");
  assert.equal((html.match(/wrap\.id="homeQuickActionsMoreWrap"/g) || []).length, 1, "Only one More/Less wrapper should be created");
  assert.equal((html.match(/id="homeQuickActionMore"/g) || []).length, 0, "Legacy duplicate control should be removed");
  assert.equal((html.match(/home-quick-action-extra/g) || []).length, 0, "Legacy competing visibility classes should be removed");
  assert.ok(html.includes('actions.forEach((item,index)=>item.classList.toggle("oc-quick-action-hidden",!expanded&&index>=4))'));
});

test("install-button observer cannot loop across the login page", () => {
  assert.ok(html.includes("if(button.hidden!==shouldHide)button.hidden=shouldHide;"), "Install button visibility must only change when needed");
  assert.ok(html.includes("observer.observe(homePage,{attributes:true,attributeFilter:['class']})"), "Observe only Home visibility changes");
  assert.ok(!html.includes("observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['class','style','hidden']})"), "Do not observe every descendant style/hidden mutation");
});

test("wallet forms use concise network labels and hide unavailable deposit networks", () => {
  assert.ok(html.includes('for="depositNetwork">Select network</label>'));
  assert.ok(html.includes('for="withdrawNetwork">Select network</label>'));
  assert.ok(html.includes('select.innerHTML=\'<option value="">No network available</option>\''));
});


test("public copy uses neutral Quick Trade wording and keeps transaction disclosures", () => {
  const lower = html.toLowerCase();
  for (const phrase of [
    "demo usdt balances only",
    "demo-trade outcome",
    "simulated environment",
    "simulated balances",
    "demo wallet balance",
    "deposits unavailable",
    "real orders stay unavailable",
    "copy execution is not available yet",
  ]) {
    assert.ok(!lower.includes(phrase), "Legacy public wording remains: " + phrase);
  }
  assert.ok(html.includes("Quick Trade calculates outcomes from public market prices"));
  assert.ok(html.includes("it does not place external exchange orders"));
  assert.ok(html.includes("Deposit address not configured"));
  assert.ok(html.includes("Deposit address setup is required for this asset."));
});

test("authentication navigation controls have one click handler each", () => {
  for (const id of ["mobileRegisterBtn", "signin-nav", "showRegisterBtn", "registerLoginBtn"]) {
    const handlers = [...html.matchAll(new RegExp("getElementById\\(['\\\"]" + id + "['\\\"]\\)\\??\\.addEventListener\\(['\\\"]click['\\\"]", "g"))];
    assert.equal(handlers.length, 1, id + " should have one shared click handler");
  }
});

test("unguarded event listeners only target elements present in the HTML", () => {
  const declaredIds = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));
  const references = [...html.matchAll(/(?:\$\(\s*["']([^"']+)["']\s*\)|getElementById\(\s*["']([^"']+)["']\s*\))\.addEventListener/g)]
    .map(match => match[1] || match[2]);
  const missing = [...new Set(references.filter(id => !declaredIds.has(id)))];
  assert.deepEqual(missing, [], "Missing elements used by unguarded event listeners: " + missing.join(", "));
});


test("Quick Trade confirmation validates the selected funding asset", () => {
  assert.ok(html.includes('window.ocValidateQuickTradeForm=validatePlan;'), "Expected one shared Quick Trade validator");
  assert.ok(html.includes('const funding=window.__ocTradeFundingCoin||"USDT";'), "Expected the selected funding asset");
  assert.ok(html.includes('const fundingPrice=funding==="USDT"?1:Number(priceFor(funding)?.current_price||0);'), "USDT funding must use its fixed 1:1 quote and not depend on the market ticker list");
  assert.ok(html.includes("stake>fundingBalance+1e-10"), "Expected validation against the selected asset balance");
  assert.ok(html.includes('if(typeof window.ocValidateQuickTradeForm==="function")window.ocValidateQuickTradeForm();'), "Expected the secondary control to reuse the shared validator");
});

test("wallet sync cannot trade on failed restore or overwrite results on unchanged admin snapshots", () => {
  assert.ok(html.includes("tradeCloudReadyUid=null;"), "A failed wallet restore must block trading");
  assert.ok(html.includes("lastAdminBalance"), "Admin wallet snapshots must track the last applied balance");
  assert.ok(html.includes("data.demoBalanceUSDT!==lastAdminBalance"), "Unchanged admin profile snapshots must not overwrite trade results");
});


test("wallet state subscribes to Firestore for live cross-device balance and history updates", () => {
  assert.ok(html.includes("let stopTradeStateSync=null;"), "Expected a managed live wallet listener");
  assert.ok(html.includes("function applyRemoteTradeState(snap,user){"), "Expected remote wallet snapshots to update the account view");
  assert.ok(html.includes("stopTradeStateSync=onSnapshot(ref,{includeMetadataChanges:true}"), "Wallet must listen for server-confirmed Firestore changes");
  assert.ok(html.includes("watchCloudTradeState(ref,user);"), "The listener must start after the account wallet restore");
  assert.ok(html.includes("if(stopTradeStateSync){stopTradeStateSync();stopTradeStateSync=null;}"), "The listener must stop when the signed-in account changes");
  assert.ok(html.includes("state={balance:Math.round(balance*100)/100,holdings,history};"), "Remote balance, holdings and trade history must replace the stale device view together");
});

test("the floating assistant is restricted to signed-in Home", () => {
  assert.ok(!html.includes("ocVisitorSupportBot"), "The duplicate visitor-only bot shell must be removed");
  assert.ok(!html.includes("oc-visitor-support-bot-script"), "The duplicate visitor-only answer script must be removed");
  assert.ok(supportChat.includes('btn.id="oc-support-button"'), "The assistant must create one launcher");
  assert.ok(supportChat.includes('box.id="oc-chat"'), "The assistant must create one chat panel");
  assert.ok(supportChat.includes("function botAnswer(q)"), "One shared knowledge engine must answer signed-in questions");
  assert.ok(supportChat.includes("Welcome to Onchain! 👋 Need help with deposits, withdrawals, KYC, trading or your wallet? Choose a topic or ask me a question."), "The assistant must show the short welcome message");
  for (const label of ["Deposit","Withdraw","KYC","Wallet","Trading","Account help"]) assert.ok(supportChat.includes(">"+label+"</button>"), "Missing support shortcut: "+label);
  assert.ok(supportChat.includes("font-size:30px;line-height:1"), "The existing assistant symbol style must remain unchanged");
  assert.ok(supportChat.includes('if(!activeUser||activeUser.isAnonymous)return false;'), "Visitors must not see the assistant launcher");
  assert.ok(supportChat.includes('const page=document.getElementById("page-home")'), "The assistant must be limited to signed-in Home, not visitor Home");
  assert.ok(supportChat.includes('addBubble(botAnswer(q),"bot")'), "Questions must use the powered information answers");
  assert.ok(!supportChat.includes("mailto:")&&!supportChat.includes("support@onchainspro.com"), "The floating assistant must not expose direct email contact");
  assert.ok(!supportChat.includes("signInAnonymously"), "Opening the assistant must not create a login session");
  assert.ok(!supportChat.includes("if(!user||user.isAnonymous)newTicket()"), "Visitors must not be routed into agent ticket creation");
});


test("Firebase auth persistence is local and the visitor route guard trusts the live Firebase user", () => {
  assert.ok(html.includes("setPersistence,") && html.includes("setPersistence(auth, browserLocalPersistence)"), "Use Firebase browser-local persistence explicitly");
  assert.ok(html.includes("await authPersistenceReady;"), "Wait for persistent storage before starting a sign-in flow");
  assert.ok(html.includes("const currentUser=window.ocFirebaseAuth?.currentUser||window.onchaincryptoCurrentUser||null;"), "Route protection must check the actual Firebase user");
  assert.ok(html.includes("if(currentUser){window.ocLoggedOut=false;return true;}"), "A restored Firebase session must override a stale guest flag");
});
test("the single assistant uses one theme and closes on outside clicks or navigation", () => {
  assert.ok(!html.includes("ocVisitorSupportBot"), "No second visitor bot launcher or panel should remain");
  assert.ok(!html.includes("oc-role-based-bot-visibility"), "No competing role-based bot visibility rules should remain");
  assert.ok(supportChat.includes('style.id="oc-single-assistant-theme"'), "One shared color theme must style the assistant");
  assert.ok(supportChat.includes("#20d9ff") && supportChat.includes("#102641"), "The shared assistant must use the Onchain navy and cyan palette");
  assert.ok(html.includes('id="oc-bot-dismiss-controller"'), "Expected one assistant dismissal controller");
  assert.ok(html.includes('document.addEventListener("pointerdown"'), "Clicking outside the assistant must close it");
  assert.ok(html.includes('window.addEventListener("popstate",closeAssistant)'), "Browser navigation must close the assistant");
  assert.ok(html.includes('window.addEventListener("hashchange",closeAssistant)'), "Hash navigation must close the assistant");
});

test("one Home-only assistant has agent contact and no direct email link", () => {
  assert.ok(supportChat.includes("if(!user||user.isAnonymous){body.innerHTML="), "Visitors must sign in before agent tickets can be created");
  assert.ok(supportChat.includes('id="oc-agent">Talk to an agent</button>'), "Talk to an agent must be visible in the one shared assistant");
  assert.ok(supportChat.includes("if(u&&!u.isAnonymous)offT=onSnapshot"), "Only signed-in accounts should subscribe to their support conversations");
  assert.ok(supportChat.includes('source:"website-chat"'), "Signed-in support tickets must retain the existing admin inbox source");
  assert.ok(supportChat.includes("function isHomeSurfaceVisible()"), "The assistant must be limited to Home and visitor Home");
  assert.ok(supportChat.includes("btn.style.display=visible?\"flex\":\"none\""), "The launcher must hide outside Home");
  assert.ok(!supportChat.includes("mailto:")&&!supportChat.includes("support@onchainspro.com"), "The floating assistant must contain no direct email contact");
  assert.ok(admin.includes("mailto:support@onchainspro.com"), "Direct email support must be available in the Admin Email section");
  assert.ok(!supportChat.includes("ocSubmitGuestSupport"), "The old separate visitor ticket workflow must not be used by the shared assistant");
});


test("Quick Trade uses concise positive copy and its result Close button restores the trade form", () => {
  assert.ok(html.includes("Live trades · Automatic wallet updates."));
  assert.ok(html.includes('form.classList.remove("oc-stage-complete","oc-stage-running","oc-stage-error");form.classList.add("oc-stage-config");'));
  assert.ok(html.includes('document.getElementById("timedBoardClose")?.addEventListener("click"'));
  assert.ok(html.includes("resultBoard.dataset.dismissed='true'"));
  assert.ok(html.includes("resultBoard.hidden=true;resultBoard.style.display='none'"));
});

test("Quick Trade uses the external server-owned trade adapter", () => {
  assert.ok(html.includes('<script src="/server-trades.js"></script>'), "The page must load the server trade adapter");
  assert.ok(serverTrades.includes('const API = "https://onchainspro-wallet-api-v2.getachew21-inj-uni.workers.dev"'), "The adapter must target the configured trade Worker");
  assert.ok(serverTrades.includes("await user.getIdToken()"), "Trade API requests must use the signed-in Firebase ID token");
  assert.ok(serverTrades.includes('request("/v1/trades", { method: "POST"'), "Starting a trade must call the server endpoint");
  assert.ok(serverTrades.includes('request("/v1/trades")'), "The browser must restore active and recent trades from the server");
});

test("server trade adapter blocks the old browser settlement handler", () => {
  assert.ok(serverTrades.includes('event.target?.closest?.("#timedConfirmBtn")'), "The adapter must capture the confirmation action");
  assert.ok(serverTrades.includes("event.stopImmediatePropagation()"), "The old browser-only trade handler must not run");
  assert.ok(serverTrades.includes("void startServerTrade()"), "Confirmation must use the server-owned trade flow");
  assert.ok(!serverTrades.includes("window.ocTradeCloudReadyUid !== user.uid"), "Confirmation must not wait on the browser-side wallet-sync flag");
  assert.ok(serverTrades.includes('if (!user?.uid)'), "The adapter must still require an authenticated user");
  assert.ok(serverTrades.includes('request("/v1/trades"'), "The server must validate and reserve the trade before it starts");
  assert.ok(!serverTrades.includes("localStorage"), "Active trades must not depend on browser-local storage");
});

test("server trade refresh returns live price samples and retries due settlement for the signed-in account", () => {
  assert.ok(tradeEngine.includes("const beforeSettlement = await activeQuery();"), "The account refresh must inspect its own active trades");
  assert.ok(tradeEngine.includes("await settleOne(access, item);"), "The account refresh must retry expired settlement without waiting for the cron minute");
  assert.ok(tradeEngine.includes("latestPrice:"), "Active trades must expose a server-quoted current price");
  assert.ok(tradeEngine.includes("priceSampledAt:"), "Active trade price samples must include server timestamps");
  assert.ok(tradeEngine.includes("const prices = new Map();"), "Active trades on the same pair should share one quote per refresh");
});

test("running Quick Trade graph and estimated P/L update from server samples", () => {
  assert.ok(serverTrades.includes("const tradeSamples = new Map();"), "The browser must retain graph samples for each active server trade");
  assert.ok(serverTrades.includes("trade.latestPrice"), "The graph must consume the server mark price");
  assert.ok(serverTrades.includes("drawTimedTradeGraph(samples, entry)"), "The running graph must redraw as server samples arrive");
  assert.ok(serverTrades.includes("const estimated = Number(trade.amountUSDT)"), "Running estimated P/L must be derived from the current server price");
});

test("latest completed server trade restores after a page reload", () => {
  assert.ok(serverTrades.includes(": recent[0];"), "A reload without an active trade must restore the newest completed ledger result");
  assert.ok(serverTrades.includes("completedId !== lastCompletedTradeId"), "The same completed result must not reopen on every polling cycle");
});

test("server adapter restores active trades across devices and displays server results", () => {
  assert.ok(serverTrades.includes("window.ocRestoreServerTrades = async function ()"), "The adapter must restore trades after wallet readiness");
  assert.ok(serverTrades.includes('window.addEventListener("focus"'), "Returning to a device must refresh its trade state");
  assert.ok(serverTrades.includes('document.addEventListener("visibilitychange"'), "A visible device must refresh its trade state");
  assert.ok(serverTrades.includes("pollTimer = setInterval("), "The adapter must periodically synchronize active trades");
  assert.ok(serverTrades.includes("renderRunning({ ...current, tradeId: current.id }, active.length)"), "All devices must render the same server-owned active trade");
  assert.ok(serverTrades.includes("renderCompleted(completed)"), "A device must display the server-settled result");
  assert.ok(serverTrades.includes("SETTLED BY SERVER"), "The result view must identify server settlement");
});

test("Quick Trade completion display is concise and hides internal plan metadata", () => {
  assert.ok(html.includes("Live trades · Automatic wallet updates."), "Use a short Quick Trade description");
  assert.ok(serverTrades.includes('textContent = "Your trade is complete."'), "Show a simple completion message without server timestamps or duration");
  assert.ok(!html.includes("ocBoardPlanValue"), "Do not inject investment plan details into the completed-trade result");
  assert.ok(serverTrades.includes('won ? "Trade Won" : lost ? "Trade Lost" : "Trade Complete"'), "Use a clean result title");
});

test("Quick Trade countdown begins immediately and reconciles to the server start time", () => {
  assert.ok(!serverTrades.includes("provisionalExpiry"), "Do not consume trade duration while server confirmation is pending");
  assert.ok(serverTrades.includes('if ($("timedCountdown")) $("timedCountdown").textContent = "—";'), "Keep the countdown paused until the server confirms the trade");
  assert.ok(serverTrades.includes('showMessage("Starting your trade securely…")'), "Keep the user informed while the server confirms");
  assert.ok(serverTrades.includes('if (countdownTimer) clearInterval(countdownTimer);'), "The provisional timer must be replaced by the server-authoritative timer");
  assert.ok(serverTrades.includes('if ($("timedCountdown")) $("timedCountdown").textContent = "—";'), "A rejected trade must clear its provisional countdown");
  assert.ok(tradeEngine.includes("const committedAt = Date.parse(reservation?.commitTime) || Date.now();"), "The full duration must start from Firestore's successful reservation commit time");
  assert.ok(tradeEngine.includes("trade.expiresAt = new Date(committedAt + p.duration * 1000);"), "The server must set expiry to the full duration after the reservation commits");
  assert.ok(tradeEngine.includes("for (let attempt = 0; attempt < 3 && !finalized; attempt++)"), "Expiry finalization must retry transient Firestore failures");
  assert.ok(tradeEngine.includes("const entry = await quote(symbol);") && tradeEngine.includes("const guard = await readDoc(access, \"activeTradeGuards\", uid);"), "Entry pricing and reservation checks must finish before the countdown starts");
});

test("server trade engine atomically creates and reserves trades in Firestore", () => {
  assert.ok(tradeEngine.includes('readDoc(access, "userTradeState", uid)'), "Trade creation must read the cloud wallet");
  assert.ok(tradeEngine.includes('fundingAsset !== "USDT"'), "Trade creation must reject non-USDT funding until coin holdings can be reserved and deducted");
  assert.ok(tradeEngine.includes('readDoc(access, "activeTradeGuards", uid)'), "Trade creation must account for existing active reservations");
  assert.ok(tradeEngine.includes('writeDoc(enc("activeTrades", id)'), "The server must create an active trade record");
  assert.ok(tradeEngine.includes('writeDoc(enc("activeTradeGuards", uid), nextGuard'), "The server must reserve the trade amount");
  assert.ok(tradeEngine.includes("{ updateTime: wallet.updateTime }"), "The wallet write must use a concurrency precondition");
  assert.ok(tradeEngine.includes('writeDoc(enc("userTradeState", uid)'), "The server must serialize trade creation against wallet updates");
  assert.ok(tradeEngine.includes("const enc = (collection, id)") && tradeEngine.includes("ROOT.replace(") && tradeEngine.includes("encodeURIComponent(id)"), "Commit document names must be converted from REST URLs to Firestore resource names");
});

test("Firestore trade commit exposes the HTTP failure class and logs sanitized diagnostics", () => {
  assert.ok(tradeEngine.includes("const responseText = await response.text();"), "Read the Firestore response body once for diagnostics");
  assert.ok(tradeEngine.includes('console.error("Firestore trade commit rejected"'), "Log Firestore's safe status and message for diagnosis");
  assert.ok(tradeEngine.includes('httpStatus: response.status'), "Preserve the HTTP status in Worker logs");
  assert.ok(tradeEngine.includes("firestoreStatus"), "Preserve Google's structured error status in Worker logs");
  assert.ok(tradeEngine.includes('"Firestore trade commit failed (HTTP "'), "Return the Firestore HTTP failure class");
  assert.ok(tradeEngine.includes('(firestoreMessage ? ": " + firestoreMessage : ".")'), "Expose the bounded Google error message so invalid writes can be diagnosed");
  assert.ok(tradeEngine.includes('if (response.status === 409 || response.status === 412) throw new Error("TRADE_CONFLICT");'), "Keep concurrency conflicts distinct");
});

test("server settlement atomically updates wallet, active trade, reservation and ledger", () => {
  assert.ok(tradeEngine.includes("async function settleOne(access, item)"), "The server must own the settlement routine");
  assert.ok(tradeEngine.includes('writeDoc(enc("userTradeState", uid), { uid, balance: after'), "Settlement must commit the updated cloud balance");
  assert.ok(tradeEngine.includes('writeDoc(enc("activeTrades", item.id), completed'), "Settlement must mark the active trade completed");
  assert.ok(tradeEngine.includes('writeDoc(enc("activeTradeGuards", uid), nextGuard'), "Settlement must release the active reservation");
  assert.ok(tradeEngine.includes('writeDoc(enc("tradeLedger", item.id), ledger, { exists: false })'), "Settlement must create one idempotent ledger record");
  assert.ok(tradeEngine.includes("const before = safeNumber(wallet.data.balance), after = round2(Math.max(0, before + pnl))"), "The server must calculate the resulting wallet balance");
  assert.ok(tradeEngine.includes("holdings: wallet.data.holdings || {}, history"), "Settlement must preserve other coin holdings and update history");
});

test("server trade engine enforces current account and platform outcome settings", () => {
  assert.ok(tradeEngine.includes('readDoc(access, "platformSettings", "demoTradeControl")'), "The server must read the latest global controls");
  assert.ok(tradeEngine.includes('readDoc(access, "users", uid)'), "The server must read the account controls");
  assert.ok(tradeEngine.includes('u.tradingEnabled === false || u.accountStatus === "suspended"'), "Disabled or suspended accounts must not start trades");
  assert.ok(tradeEngine.includes('globalMode === "win" || globalMode === "lose"'), "Global forced outcomes must take priority");
  assert.ok(tradeEngine.includes('userMode === "inherit" ? globalMode : userMode'), "Per-user controls must apply when global mode is market-based");
});

test("Worker exposes authenticated trade routes and scheduled settlement", () => {
  assert.ok(tradeWorker.includes('url.pathname === "/v1/trades" && request.method === "POST"'), "The Worker must expose trade creation");
  assert.ok(tradeWorker.includes('url.pathname === "/v1/trades" && request.method === "GET"'), "The Worker must expose trade restoration");
  assert.ok(tradeWorker.includes("trades.settleDue()"), "The scheduled Worker must settle expired trades");
  assert.ok(tradeWorker.includes("verifyUserToken"), "Trade routes must verify Firebase authentication");
});

test("server trade adapter and engine JavaScript parse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "onchain-server-trade-check-"));
  try {
    for (const [name, source] of [["server-trades.js", serverTrades], ["trade-engine.mjs", tradeEngine], ["worker.mjs", tradeWorker]]) {
      const file = join(directory, name);
      await writeFile(file, source, "utf8");
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Trade Gold is quoted and settled by the server", () => {
  assert.ok(html.includes('<option value="XAU">XAU — Gold</option>'), "Gold must remain selectable even when absent from the crypto market feed");
  assert.ok(html.includes("BINANCE:XAUUSDT.P"), "Gold selection must update the chart to the Gold market");
  assert.ok(tradeEngine.includes('if (symbol === "XAU")'), "The server must use its dedicated Gold quote path");
  assert.ok(tradeEngine.includes('symbol=XAUUSDT'), "The server must request the Gold/USDT market quote");
  assert.ok(tradeEngine.includes('ASSETS = new Set([...Object.keys(PRICE_IDS), "XAU"])'), "Gold must be allowed by server-side trade validation");
  assert.ok(serverTrades.includes('request("/v1/trades", { method: "POST"'), "Gold trades must use the same authenticated server endpoint");
  assert.ok(supportChat.includes("Choose Trade Gold on Home"), "The assistant must explain the Gold shortcut");
  assert.ok(supportChat.includes("Onchain market tools focus on cryptocurrency and Gold"), "The assistant must answer the Stocks topic accurately");
});

test("Admin trade-control help matches the enforced global and per-user priority", () => {
  assert.ok(admin.includes("A global forced Win/Loss applies to all accounts. Per-user outcome settings apply when the global setting is Market-Based."), "Admin help must describe the actual precedence");
  assert.ok(admin.includes("Win result (%)") && admin.includes("Loss result (%)"), "Admin percentages must be described as result percentages, not chances");
});

test("long listings start with four items and keep More/Less controls", () => {
  for (const marker of [
    'id="homeCoinCount">Showing top 4 coins',
    'id="marketListCount">Showing top 4 coins',
    'id="depositCoinCount">Showing 4 coins',
    'id="withdrawCoinCount">Showing 4 coins',
    'id="signalCountLabel" class="muted tiny">Showing up to 4 coin pairs',
    'const coinPickerExpanded={deposit:4,withdraw:4}',
    'let signalVisibleCount=4',
    'let category="crypto",limit=4,selectedAsset=null',
    'assets.slice(0,4)',
    'items.length>4&&!hidden',
  ]) {
    assert.ok(html.includes(marker), "Expected four-item listing behavior: " + marker);
  }
  assert.ok(html.includes('id="quickActionCount">Showing 4 quick actions'));
  assert.ok(html.includes('id="homeActivePairsToggle"'), "Active Coin Pairs keeps its More/Less toggle");
});

test("signed-in users receive live right-side account notifications by default", () => {
  assert.ok(html.includes('id="ocNotificationBell"'), "Expected a notification bell in the right-side header");
  assert.ok(html.includes('id="ocNotificationCount"'), "Expected an unread notification badge");
  assert.ok(html.includes("accountNotificationsInitialized"), "Existing notifications must not be replayed as new alerts on initial load");
  assert.ok(html.includes('snap.docChanges().filter(change=>change.type==="added")'), "New account notifications must trigger automatically from Firestore snapshots");
  assert.ok(html.includes('host.id="ocAccountNotificationToast"'), "New account updates must display a visible alert");
  assert.ok(html.includes('right:18px;left:auto;transform:none'), "Account alerts must be positioned on the right side");
  assert.ok(html.includes('badge.hidden=unread===0'), "The unread badge must update from the live notification feed");
  assert.ok(html.includes('data-notification-type=\\""+n.notificationType+"\\"'), "Account and market alerts must share one clickable list");
  assert.ok(html.includes('openedNotificationKey=openedNotificationKey===key?null:key'), "Only one notification detail may be open at a time");
  assert.ok(html.includes('setDoc(doc(db,"userNotificationReads",user.uid,"items",type==="market"?id:"account_"+id),{readAt:serverTimestamp()},{merge:true})'), "Market and account read receipts must be stored privately per user");
  assert.ok(html.includes('accountReadById.has("account_"+n.id)'), "Account notification read receipts must persist independently of notification snapshots");
  assert.ok(html.includes('stopMarketAlertReads=onSnapshot(collection(db,"userNotificationReads",user.uid,"items")'), "Market alert read states must synchronize live");
  assert.ok(html.includes('card.addEventListener("click",()=>{void activate();})'), "Tapping a notification must open its details and mark it read");
  assert.ok(html.includes('onAuthStateChanged(auth,user=>{byId("ocNotificationBell")?.classList.toggle("hidden",!user);renderUserNotifications(user||null);});'), "Every signed-in account must automatically subscribe to notifications");
});

test("account notifications use live event alerts without explanatory preference copy", () => {
  assert.ok(!html.includes("Automatically enabled for every registered account"), "Remove the explanatory always-on copy from the user profile");
  assert.ok(!html.includes("Live in-app notifications are automatically enabled for every registered account."), "Do not show notification preference explanations");
  assert.ok(!html.includes('id="profileNotificationsSection"'), "The empty notification preference panel should not remain in the profile");
  assert.ok(html.includes('kind:"kyc_submitted"'), "A successful KYC submission must create a user alert");
  assert.ok(admin.includes("kind:'account_status'"), "Admin account activation and suspension must create user alerts");
  assert.ok(admin.includes("kind:action==='approve'?'kyc_approved':'kyc_rejected'"), "KYC approval and rejection must create user alerts");
  assert.ok(!html.includes('id="prefNotifications"') && !html.includes('id="prefAllNotifications"'), "Users must not be able to disable required in-app account notifications");
  assert.ok(!html.includes('localStorage.setItem("oc_notification_preferences"'), "In-app notification delivery must not depend on a per-device preference");
});

test("KYC documents use private Firestore storage without Firebase Storage", () => {
  assert.ok(html.includes("async function compressKycImage(file)"), "KYC images must be compressed before saving");
  assert.ok(html.includes('doc(db,"kycSubmissions",user.uid,"documents","front")'), "Front ID must use a private Firestore subdocument");
  assert.ok(html.includes('doc(db,"kycSubmissions",user.uid,"documents","back")'), "Back ID must use a private Firestore subdocument");
  assert.ok(!html.includes("firebase-storage.js") && !html.includes("uploadBytes"), "The public KYC flow must not depend on Firebase Storage");
  assert.ok(admin.includes("getDoc(doc(db,'kycSubmissions',record.id,'documents',spec.side))"), "Admin review must fetch each ID image only when details are opened");
  assert.ok(!admin.includes("firebase-storage.js") && !admin.includes("getBytes("), "The admin review must not depend on Firebase Storage");
});
