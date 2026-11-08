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

test("home quick actions start with four and expand on demand", () => {
  const start = html.indexOf('id="page-home"');
  const end = html.indexOf('id="page-markets"', start);
  assert.ok(start >= 0 && end > start, "Expected home and market page sections");
  const home = html.slice(start, end);
  const visible = [...home.matchAll(/class="quick-action"(?![^"]*home-quick-action-extra)/g)];
  const extra = [...home.matchAll(/class="quick-action home-quick-action-extra/g)];
  assert.equal(visible.length, 4, "Home should show four actions first");
  assert.equal(extra.length, 5, "Five extra actions should be available");
  for (const id of ["homeQuickActionMore", "homeQuickActionLess"]) {
    assert.ok(home.includes('id="' + id + '"'), "Missing control: " + id);
  }
  assert.ok(html.includes("#homeQuickActionMore"), "Expected More/Less click handling");
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
  const declaredIds = new Set([...html.matchAll(/\\bid=["']([^"']+)["']/g)].map(match => match[1]));
  const references = [...html.matchAll(/(?:\\$\\(\\s*["']([^"']+)["']\\s*\\)|getElementById\\(\\s*["']([^"']+)["']\\s*\\))\\.addEventListener/g)]
    .map(match => match[1] || match[2]);
  const missing = [...new Set(references.filter(id => !declaredIds.has(id)))];
  assert.deepEqual(missing, [], "Missing elements used by unguarded event listeners: " + missing.join(", "));
});
