import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";

const html = await readFile("public/index.html", "utf8");

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


test("visitor support uses an isolated Firebase session and submits through the admin inbox", () => {
  assert.ok(html.includes('initializeApp(config,"visitor-support")'), "Guest support must use a separate Firebase app");
  assert.ok(html.includes("const guestAuth=getAuth(guestApp),guestDb=getFirestore(guestApp);"), "Guest support must not change the main login session");
  assert.ok(html.includes("signInAnonymously(guestAuth)"), "Guest support must authenticate its own visitor session");
  assert.ok(html.includes("writeBatch(guestDb)"), "Guest support must write the ticket and first message together");
  assert.ok(html.includes("signInAnonymously, signOut"), "Guest auth methods must be imported");
  assert.ok(html.includes("addDoc, writeBatch"), "Firestore batch writer must be imported");
  assert.ok(html.includes("Tap Talk to Agent below to send a private message"), "Bot must direct support requests to the Talk to Agent form");
  assert.equal((html.match(/id="ocVisitorSupportBot"/g) || []).length, 1, "Only one visitor support bot should be present");
});
