import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../workers/wallet-api/index.js", import.meta.url), "utf8");

describe("read-only reconciliation Worker safeguards", () => {
  it("uses configured admin allowlisting rather than source-code email addresses", () => {
    assert.match(source, /env\.ADMIN_EMAILS/);
    assert.doesNotMatch(source, /DEFAULT_ADMIN_EMAILS|globalThis\.__adminEmails/);
  });

  it("does not contain Firestore write endpoints or write methods", () => {
    assert.doesNotMatch(source, /documents:commit|documents\/[^\s`"]+/);
    assert.doesNotMatch(source, /method:\s*["'](?:PATCH|PUT|DELETE)["']/i);
  });

  it("requires Firebase token verification before the reconciliation route", () => {
    assert.match(source, /verifyFirebaseIdToken/);
    assert.match(source, /claims\.iss !== FIREBASE_ISSUER/);
    assert.match(source, /claims\.aud !== PROJECT_ID/);
    assert.match(source, /claims\.sub/);
    assert.match(source, /Administrator access is required/);
  });

  it("returns a compact read-only report rather than raw wallet history", () => {
    assert.match(source, /readOnly:\s*true/);
    assert.match(source, /ledgerChecks/);
    assert.doesNotMatch(source, /history:\s*wallet\.history/);
  });
});
