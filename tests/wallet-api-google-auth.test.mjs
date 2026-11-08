import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { getFirestoreAccessToken } from "../workers/wallet-api/src/google-auth.js";

describe("Firestore service-account OAuth", () => {
  it("signs a short-lived datastore-scoped assertion and exchanges it for an access token", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
    let requestCount = 0;
    const fetchImpl = async (url, options) => {
      requestCount++;
      assert.equal(String(url), "https://oauth2.googleapis.com/token");
      assert.equal(options.method, "POST");
      const params = new URLSearchParams(options.body);
      assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const assertion = params.get("assertion");
      const [headerPart, payloadPart, signaturePart] = assertion.split(".");
      const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
      const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
      assert.equal(header.alg, "RS256");
      assert.equal(claims.iss, "wallet-worker@example.iam.gserviceaccount.com");
      assert.equal(claims.scope, "https://www.googleapis.com/auth/datastore");
      assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
      assert.ok(claims.exp - claims.iat <= 3600);
      assert.equal(verify("RSA-SHA256", Buffer.from(headerPart + "." + payloadPart), publicKey, Buffer.from(signaturePart, "base64url")), true);
      return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const serviceAccount = {
      client_email: "wallet-worker@example.iam.gserviceaccount.com",
      private_key: privatePem,
      token_uri: "https://oauth2.googleapis.com/token"
    };
    const token = await getFirestoreAccessToken(JSON.stringify(serviceAccount), fetchImpl);
    assert.equal(token, "test-access-token");
    assert.equal(requestCount, 1);
  });

  it("rejects an unapproved OAuth token endpoint", async () => {
    await assert.rejects(
      () => getFirestoreAccessToken({
        client_email: "wallet-worker@example.iam.gserviceaccount.com",
        private_key: "not-used",
        token_uri: "https://attacker.example/token"
      }),
      /unapproved|approved/
    );
  });
});
