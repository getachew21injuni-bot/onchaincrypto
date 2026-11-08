import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyFirebaseIdToken } from "../workers/wallet-api/src/auth.js";

const projectId = "onchaincrypto-d976b";
const b64url = value => Buffer.from(value).toString("base64url");

function makeToken(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  jwk.kid = "test-" + Math.random().toString(36).slice(2);
  jwk.use = "sig";
  jwk.alg = "RS256";
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: jwk.kid };
  const claims = {
    aud: projectId,
    iss: `https://securetoken.google.com/${projectId}`,
    sub: "test-user-uid",
    iat: now,
    exp: now + 3600,
    auth_time: now,
    email: "member@example.com",
    email_verified: true,
    ...overrides
  };
  const signingInput = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claims));
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return {
    token: signingInput + "." + b64url(signature),
    fetchImpl: async () => new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=60" }
    })
  };
}

describe("wallet API Firebase token authentication", () => {
  it("accepts a correctly signed token for this Firebase project", async () => {
    const { token, fetchImpl } = makeToken();
    const user = await verifyFirebaseIdToken(token, projectId, fetchImpl);
    assert.equal(user.uid, "test-user-uid");
    assert.equal(user.emailVerified, true);
  });

  it("rejects a token issued for a different project", async () => {
    const { token, fetchImpl } = makeToken({ aud: "another-project" });
    await assert.rejects(() => verifyFirebaseIdToken(token, projectId, fetchImpl), /different project/);
  });

  it("rejects expired tokens", async () => {
    const { token, fetchImpl } = makeToken({ exp: Math.floor(Date.now() / 1000) - 1 });
    await assert.rejects(() => verifyFirebaseIdToken(token, projectId, fetchImpl), /expired/);
  });

  it("rejects a token whose signature was modified", async () => {
    const { token, fetchImpl } = makeToken();
    const altered = token.slice(0, -2) + "aa";
    await assert.rejects(() => verifyFirebaseIdToken(altered, projectId, fetchImpl), /signature|key is not recognized/);
  });
});
