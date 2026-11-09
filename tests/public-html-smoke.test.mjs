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
  for (const id of ["marketRows", "priceChart", "timedTradeChart", "timedBoardChart", "timedResultBoard", "timedBoardClose", "withdrawNetwork", "withdrawAddressCheck"]) {
    assert.ok(html.includes('id="' + id + '"') || html.includes("id='" + id + "'"), "Missing required element: " + id);
  }
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
  assert.ok(html.includes("active, verified address is displayed for the exact asset and network"));
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

test("one shared Onchain assistant serves visitors and signed-in users", () => {
  assert.ok(!html.includes("ocVisitorSupportBot"), "The duplicate visitor-only bot shell must be removed");
  assert.ok(!html.includes("oc-visitor-support-bot-script"), "The duplicate visitor-only answer script must be removed");
  assert.ok(supportChat.includes('btn.id="oc-support-button"'), "The shared assistant must create one launcher");
  assert.ok(supportChat.includes('box.id="oc-chat"'), "The shared assistant must create one chat panel");
  assert.ok(supportChat.includes("function botAnswer(q)"), "One shared knowledge engine must answer visitor and signed-in questions");
  assert.ok(supportChat.includes("Welcome to Onchain! Ask about Markets"), "The shared assistant must show one welcome message");
  assert.ok(supportChat.includes("Sign in to start a conversation with our support team."), "Visitors must be guided to sign in before agent contact");
  assert.ok(supportChat.includes('addBubble(botAnswer(q),"bot")'), "All questions must use the same powered information answers");
  assert.ok(!supportChat.includes("mailto:")&&!supportChat.includes("support@onchainspro.com"), "The floating assistant must not expose direct email contact");
  assert.ok(!supportChat.includes("signInAnonymously"), "Opening the visitor assistant must not create a login session");
  assert.ok(!supportChat.includes("if(!user||user.isAnonymous)newTicket()"), "Visitors must not be routed into agent ticket creation");
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
  assert.ok(html.includes("Market-linked Quick Trades with clear results and automatic Onchain wallet updates."));
  assert.ok(html.includes('form.classList.remove("oc-stage-complete","oc-stage-running");form.classList.add("oc-stage-config");'));
  assert.ok(html.includes('document.getElementById("timedBoardClose")?.addEventListener("click"'));
  assert.ok(html.includes('if(board)board.style.display="none";'));
});

test("Quick Trade commits the wallet update before displaying the completed result", () => {
  const start = html.indexOf("function startTimedPaper(");
  const end = html.indexOf("function finishedSymbolSafe", start);
  assert.ok(start >= 0 && end > start, "Expected the Quick Trade execution flow");
  const flow = html.slice(start, end);
  assert.ok(flow.includes("await window.ocCommitQuickTradeResult("), "Wallet and trade history must be committed to Firestore");
  assert.ok(flow.indexOf("await window.ocCommitQuickTradeResult(") < flow.indexOf('const board=$("timedResultBoard")'), "Show the result only after the cloud commit succeeds");
  assert.ok(flow.includes("renderWallet()"), "Refresh wallet display after the saved balance change");
  assert.ok(html.includes("const before=asset==="), "Apply each balance adjustment to the latest cloud balance inside the transaction");
  assert.ok(html.includes("tx.set(ref,{uid:user.uid,balance:nextBalance,holdings,history:nextHistory,updatedAt:serverTimestamp()},{merge:true})"), "Save balance, holdings and result history together");
});

test("Quick Trade confirmation uses one validator and waits for account wallet readiness", () => {
  assert.ok(html.includes('if(typeof window.ocValidateQuickTradeForm==="function")window.ocValidateQuickTradeForm();'), "Estimate refreshes must not override trade validation");
  assert.ok(html.includes('const walletReady=!!currentUser?.uid&&window.ocTradeCloudReadyUid===currentUser.uid;'), "Confirmation must use the wallet readiness bridge across script scopes");
  assert.ok(html.includes('const currentUser=window.ocFirebaseAuth?.currentUser;if(!currentUser?.uid||window.ocTradeCloudReadyUid!==currentUser.uid)'), "Trade start must use the published Firebase auth and wallet state");
  const start = html.slice(html.indexOf("function startTimedPaper(direction){"), html.indexOf("function finishedSymbolSafe()", html.indexOf("function startTimedPaper(direction){")));
  assert.ok(start.includes("window.ocFirebaseAuth?.currentUser"), "Trade start must read Firebase Auth from the shared window bridge");
  assert.ok(!start.includes("auth.currentUser") && !start.includes("tradeCloudReadyUid!=="), "Classic trade code must not reference module-only Firebase variables");
  assert.ok(html.includes("const blocked=!walletReady||!tradingEnabled||!Number.isFinite(stake)"), "The shared validator must block until wallet restore succeeds and admin trading access is enabled");
  assert.ok((html.match(/window\.ocValidateQuickTradeForm\?\.\(\);/g) || []).length >= 3, "Wallet restore success and failure must refresh the confirmation state");
});


test("the shared external support chat module parses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "onchain-support-module-check-"));
  const file = join(directory, "support-chat.mjs");
  try {
    await writeFile(file, supportChat, "utf8");
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("all inline JavaScript modules parse", async () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const modules = scripts.filter(([, attributes, source]) =>
    /\btype\s*=\s*["']module["']/i.test(attributes) &&
    !/\bsrc\s*=/.test(attributes) &&
    source.trim()
  );
  assert.ok(modules.length > 0, "Expected inline JavaScript modules to be checked");
  const directory = await mkdtemp(join(tmpdir(), "onchain-module-check-"));
  const failures = [];
  try {
    for (let index = 0; index < modules.length; index += 1) {
      const [, attributes, source] = modules[index];
      const id = (attributes.match(/\bid\s*=\s*["']([^"']+)/i) || [])[1] || "module-" + (index + 1);
      const file = join(directory, index + ".mjs");
      await writeFile(file, source, "utf8");
      try {
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
      } catch (error) {
        failures.push(id + ": " + String(error.stderr || error.message));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.deepEqual(failures, [], failures.join("\\n"));
});

test("Quick Trade settings use the shared primary Firebase session and wait for auth readiness", () => {
  const start = html.indexOf('<script type="module" id="oc-global-demo-trade-admin">');
  const end = html.indexOf("</script>", start);
  assert.ok(start >= 0 && end > start, "Expected the trade admin module");
  const module = html.slice(start, end);
  assert.ok(module.includes('getApps().find(item=>item.name==="[DEFAULT]")'), "Trade settings must always use the primary Firebase app");
  assert.ok(module.includes("auth=window.ocFirebaseAuth||getAuth(app)"), "Trade settings must share the main app Auth instance");
  assert.ok(module.includes("const activeAuth=window.ocFirebaseAuth||auth;"), "The latest-settings read must use the shared Auth bridge");
  assert.ok(module.includes('await activeAuth.authStateReady()'), "Wait for Firebase session restoration before validating the account");
  assert.ok(module.includes("const verifiedUser=(window.ocFirebaseAuth||activeAuth).currentUser;"), "Recheck the same shared session after Firestore reads");
  assert.ok(!module.includes("visitor-support") && !module.includes("signInAnonymously"), "The trade admin module must not initialize an unused visitor Auth session");
  assert.ok(!html.includes("Could not confirm the latest account trade settings."), "Do not show technical Firebase error wording to users");
  assert.ok(html.includes("Your session needs a quick refresh. Please sign in again to continue."), "Use short, clear session guidance");
});

test("Quick Trade confirmation has one start handler and no duplicate timer binding", () => {
  assert.equal((html.match(/\$\("timedConfirmBtn"\)\.addEventListener\("click"/g) || []).length, 1, "Only one confirmation click handler should be registered");
  assert.equal((html.match(/timedTimer=setInterval\(/g) || []).length, 1, "Only one timed trade interval should be created");
  assert.ok(html.includes("if(timedPaper){"), "Prevent a second active trade from stacking on top of a running trade");
});

test("Quick Trade reads fresh admin outcome settings and atomically updates the cloud wallet", () => {
  assert.ok(html.includes("window.ocLoadLatestTradeControls=async function(uid)"), "Expected a fresh Firestore read of user and global trade controls");
  assert.ok(html.includes("latestControls=await window.ocLoadLatestTradeControls(currentUser.uid)"), "Trade confirmation must use current admin settings");
  assert.ok(html.includes("window.ocCommitQuickTradeResult=async function({funding,adjustment,resultRecord})"), "Expected a dedicated cloud trade-result commit");
  assert.ok(html.includes("return await runTransaction(db,async tx=>"), "Wallet result updates must use a Firestore transaction");
  assert.ok(html.includes("await window.ocCommitQuickTradeResult({funding:finished.funding,adjustment:balanceAdjustmentFunding,resultRecord})"), "Completed trades must commit against the latest cloud balance");
});


test("Trade Gold keeps XAU selectable, loads a fresh quote, and uses the Gold chart", () => {
  assert.ok(html.includes("async function refreshGoldMarketPrice()"), "Gold must load a current quote before confirmation");
  assert.ok(html.includes('if(sym==="XAU")return goldMarketAsset;'), "Gold must resolve through its dedicated quote object");
  assert.ok(html.includes('<option value="XAU">XAU — Gold</option>'), "Gold must remain selectable even when absent from the crypto market feed");
  assert.ok(html.includes('if(sym==="XAU"){try{await refreshGoldMarketPrice()}'), "Gold confirmation must refresh its quote before starting");
  assert.ok(html.includes('if(finished.symbol==="XAU"){try{await refreshGoldMarketPrice()}'), "Gold expiry must use a refreshed quote");
  assert.ok(html.includes("OANDA:XAUUSD"), "Gold selection must update the chart to the Gold market");
  assert.ok(supportChat.includes("Choose Trade Gold on Home"), "The assistant must explain the Gold shortcut");
  assert.ok(supportChat.includes("Onchain market tools focus on cryptocurrency and Gold"), "The assistant must answer the Stocks topic accurately");
});

test("Admin trade-control help matches the enforced global and per-user priority", () => {
  assert.ok(admin.includes("A global forced Win/Loss applies to all accounts. Per-user outcome settings apply when the global setting is Market-Based."), "Admin help must describe the actual precedence");
  assert.ok(admin.includes("Win result (%)") && admin.includes("Loss result (%)"), "Admin percentages must be described as result percentages, not chances");
});
