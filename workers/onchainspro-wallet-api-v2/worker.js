import { createTradeEngine } from "./trade-engine.js";



// OnChainSpro trusted wallet API v2 — wallet and server-side Quick Trade API.

//

// This Worker exposes authenticated wallet reads, audited administrator USDT adjustments, and server-owned Quick Trade lifecycle.

// Conversions, transfers, deposits and withdrawals remain disabled until their

// server-side business rules and source records are migrated. Never trust client-supplied P/L.



const PROJECT_ID = "onchaincrypto-d976b";



const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;



const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;



const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";



const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {

   status,

   headers: {

      "content-type": "application/json; charset=utf-8",

      "cache-control": "no-store",

      ...headers

   }

});



const b64u = bytes => {

   let s = "";

   for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);

   return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

};



function decode64(value) {

   if (!/^[A-Za-z0-9_-]+$/.test(value)) {

      throw new Error("Malformed token.");

   }



   const s = value.replace(/-/g, "+").replace(/_/g, "/");



   return Uint8Array.from(

      atob(s + "=".repeat((4 - s.length % 4) % 4)),

      c => c.charCodeAt(0)

   );

}



const decodePart = part =>

   JSON.parse(new TextDecoder().decode(decode64(part)));



function pemDer(pem) {

   const body = String(pem || "").replace(

      /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,

      ""

   );



   // FIX: normalize Base64 and remove trailing padding before validation.

   const normalized = body

      .replace(/\+/g, "-")

      .replace(/\//g, "_")

      .replace(/=+$/g, "");



   return decode64(normalized);

}



async function verifyUserToken(token) {

   const parts = String(token || "").split(".");



   if (parts.length !== 3) {

      throw new Error("A valid Firebase sign-in token is required.");

   }



   const head = decodePart(parts[0]);

   const claims = decodePart(parts[1]);



   if (head.alg !== "RS256" || !head.kid) {

      throw new Error("Unsupported token signature.");

   }



   const response = await fetch(JWKS_URL, {

      cf: { cacheTtl: 300 }

   });



   if (!response.ok) {

      throw new Error("Firebase token verification is temporarily unavailable.");

   }



   const keys = await response.json();



   const jwk = keys.keys?.find(

      k => k.kid === head.kid && k.alg === "RS256"

   );



   if (!jwk) {

      throw new Error("Firebase token signing key was not found.");

   }



   const key = await crypto.subtle.importKey(

      "jwk",

      jwk,

      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },

      false,

      ["verify"]

   );



   const valid = await crypto.subtle.verify(

      "RSASSA-PKCS1-v1_5",

      key,

      decode64(parts[2]),

      new TextEncoder().encode(parts[0] + "." + parts[1])

   );



   const now = Math.floor(Date.now() / 1000);



   if (

      !valid ||

      claims.iss !== ISSUER ||

      claims.aud !== PROJECT_ID ||

      typeof claims.sub !== "string" ||

      !claims.sub ||

      claims.sub.length > 128 ||

      !Number.isFinite(claims.exp) ||

      claims.exp <= now ||

      !Number.isFinite(claims.iat) ||

      claims.iat > now + 60 ||

      now - claims.iat > 3600

   ) {

      throw new Error("Firebase sign-in token is invalid or expired.");

   }



   return claims;

}



async function serviceToken(env) {

   let account;



   try {

      account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || "");

   } catch {

      throw new Error("Worker service-account secret is invalid.");

   }



   if (

      account.project_id !== PROJECT_ID ||

      !account.client_email ||

      !account.private_key

   ) {

      throw new Error("Worker service-account configuration is invalid.");

   }



   const now = Math.floor(Date.now() / 1000);



   const header = b64u(

      new TextEncoder().encode(

         JSON.stringify({ alg: "RS256", typ: "JWT" })

      )

   );



   const payload = b64u(

      new TextEncoder().encode(

         JSON.stringify({

            iss: account.client_email,

            scope: "https://www.googleapis.com/auth/datastore",

            aud: "https://oauth2.googleapis.com/token",

            iat: now,

            exp: now + 3600

         })

      )

   );



   const unsigned = header + "." + payload;



   const key = await crypto.subtle.importKey(

      "pkcs8",

      pemDer(account.private_key),

      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },

      false,

      ["sign"]

   );



   const sig = await crypto.subtle.sign(

      "RSASSA-PKCS1-v1_5",

      key,

      new TextEncoder().encode(unsigned)

   );



   const assertion = unsigned + "." + b64u(sig);



   const response = await fetch("https://oauth2.googleapis.com/token", {

      method: "POST",

      headers: {

         "content-type": "application/x-www-form-urlencoded"

      },

      body: new URLSearchParams({

         grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",

         assertion

      })

   });



   if (!response.ok) {

      throw new Error("Google service-account authentication failed.");

   }



   const result = await response.json();



   if (!result.access_token) {

      throw new Error("Google did not issue a service token.");

   }



   return result.access_token;

}



function fromFirestore(v) {

   if (!v || typeof v !== "object") return v;



   if ("stringValue" in v) return v.stringValue;

   if ("integerValue" in v) return Number(v.integerValue);

   if ("doubleValue" in v) return v.doubleValue;

   if ("booleanValue" in v) return v.booleanValue;

   if ("timestampValue" in v) return v.timestampValue;

   if ("nullValue" in v) return null;



   if ("arrayValue" in v) {

      return (v.arrayValue.values || []).map(fromFirestore);

   }



   if ("mapValue" in v) {

      return Object.fromEntries(

         Object.entries(v.mapValue.fields || {}).map(

            ([k, x]) => [k, fromFirestore(x)]

         )

      );

   }



   return null;

}



function fieldsFromFirestore(fields) {

   return Object.fromEntries(

      Object.entries(fields || {}).map(

         ([k, v]) => [k, fromFirestore(v)]

      )

   );

}



function toFirestore(v) {

   if (v === null) return { nullValue: null };



   if (typeof v === "string") {

      return { stringValue: v };

   }



   if (typeof v === "boolean") {

      return { booleanValue: v };

   }



   if (Number.isInteger(v)) {

      return { integerValue: String(v) };

   }



   if (typeof v === "number" && Number.isFinite(v)) {

      return { doubleValue: v };

   }



   if (Array.isArray(v)) {

      return {

         arrayValue: {

            values: v.map(toFirestore)

         }

      };

   }



   if (v && typeof v === "object") {

      return {

         mapValue: {

            fields: Object.fromEntries(

               Object.entries(v).map(([k, x]) => [k, toFirestore(x)])

            )

         }

      };

   }



   throw new Error("Unsupported Firestore value.");

}



async function readWallet(token, uid) {

   const response = await fetch(

      `${ROOT}/userTradeState/${encodeURIComponent(uid)}`,

      {

         headers: {

            authorization: "Bearer " + token

         }

      }

   );



   if (response.status === 404) return null;



   if (!response.ok) {

      throw new Error("Canonical Firestore wallet read failed.");

   }



   const doc = await response.json();



   return {

      data: fieldsFromFirestore(doc.fields),

      updateTime: doc.updateTime

   };

}



async function adminAdjustment(env, token, claims, body) {

   const admins = String(env.ADMIN_EMAILS || "")

      .split(",")

      .map(x => x.trim().toLowerCase())

      .filter(Boolean);



   const email = String(claims.email || "").toLowerCase();



   if (

      !(

         claims.admin === true ||

         (

            claims.email_verified === true &&

            email &&

            admins.includes(email)

         )

      )

   ) {

      return json({ error: "Administrator access is required." }, 403);

   }



   const uid = typeof body.uid === "string" ? body.uid.trim() : "";

   const requestId = typeof body.requestId === "string"

      ? body.requestId.trim()

      : "";

   const reason = typeof body.reason === "string"

      ? body.reason.trim().slice(0, 240)

      : "";



   const delta = Number(body.deltaUSDT);



   if (

      !uid ||

      uid.length > 128 ||

      uid.includes("/") ||

      !/^[A-Za-z0-9_-]{16,100}$/.test(requestId) ||

      !reason ||

      !Number.isFinite(delta) ||

      delta === 0 ||

      Math.abs(delta) > 1000000

   ) {

      return json({

         error: "A valid UID, unique requestId, reason and non-zero USDT adjustment are required."

      }, 400);

   }



   const access = await serviceToken(env);



   const wallet = await readWallet(access, uid);



   if (!wallet || !wallet.updateTime) {

      return json({

         error: "Canonical wallet record is missing; no balance was created."

      }, 409);

   }



   const balance = Number(wallet.data?.balance);



   if (!Number.isFinite(balance) || balance < 0) {

      return json({

         error: "Canonical wallet balance is invalid."

      }, 409);

   }



   const next = Math.round((balance + delta) * 100) / 100;



   if (next < 0) {

      return json({

         error: "Insufficient USDT balance for this adjustment."

      }, 409);

   }



   const ledgerName =

      `${ROOT}/walletLedger/${encodeURIComponent(requestId)}`;



   const prior = await fetch(ledgerName, {

      headers: {

         authorization: "Bearer " + access

      }

   });



   if (prior.ok) {

      return json({

         error: "This requestId has already been processed."

      }, 409);

   }



   if (prior.status !== 404) {

      throw new Error("Could not verify transaction idempotency.");

   }



   const writes = [

      {

         update: {

            name: `${ROOT}/userTradeState/${encodeURIComponent(uid)}`,

            fields: {

               uid: toFirestore(uid),

               balance: toFirestore(next),

               holdings: toFirestore(

                  wallet.data.holdings &&

                  typeof wallet.data.holdings === "object"

                     ? wallet.data.holdings

                     : {}

               ),

               history: toFirestore(

                  Array.isArray(wallet.data.history)

                     ? wallet.data.history

                     : []

               ),

               updatedAt: {

                  timestampValue: new Date().toISOString()

               }

            }

         },

         updateMask: {

            fieldPaths: [

               "uid",

               "balance",

               "holdings",

               "history",

               "updatedAt"

            ]

         },

         currentDocument: {

            updateTime: wallet.updateTime

         }

      },

      {

         update: {

            name: ledgerName,

            fields: {

               uid: toFirestore(uid),

               type: toFirestore("admin_adjustment"),

               asset: toFirestore("USDT"),

               amount: toFirestore(delta),

               balanceBefore: toFirestore(balance),

               balanceAfter: toFirestore(next),

               reason: toFirestore(reason),

               actorUid: toFirestore(claims.sub),

               actorEmail: toFirestore(email),

               requestId: toFirestore(requestId),

               createdAt: {

                  timestampValue: new Date().toISOString()

               }

            }

         },

         currentDocument: {

            exists: false

         }

      }

   ];



   const commit = await fetch(ROOT + ":commit", {

      method: "POST",

      headers: {

         authorization: "Bearer " + access,

         "content-type": "application/json"

      },

      body: JSON.stringify({ writes })

   });



   if (commit.status === 409 || commit.status === 412) {

      return json({

         error: "Wallet changed during this request. Refresh and retry with a new requestId."

      }, 409);

   }



   if (!commit.ok) {

      throw new Error("Atomic Firestore wallet transaction failed.");

   }



   return json({

      ok: true,

      uid,

      balance: next,

      requestId,

      ledger: "walletLedger/" + requestId

   });

}




async function adminTradeMonitor(env, claims) {
  const admins = String(env.ADMIN_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  const email = String(claims.email || "").toLowerCase();
  if (!(claims.admin === true || (claims.email_verified === true && email && admins.includes(email)))) {
    return json({ error: "Administrator access is required." }, 403);
  }
  const access = await serviceToken(env);
  async function list(collectionId, field, limitCount) {
    const response = await fetch(ROOT + ":runQuery", {
      method: "POST",
      headers: { authorization: "Bearer " + access, "content-type": "application/json" },
      body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId }],
        orderBy: [{ field: { fieldPath: field }, direction: "DESCENDING" }],
        limit: limitCount
      } })
    });
    if (!response.ok) throw new Error("Administrator trade records could not be read from Firestore (" + collectionId + ").");
    const rows = await response.json();
    return (Array.isArray(rows) ? rows : []).filter(x => x.document).map(x => ({
      id: x.document.name.split("/").pop(),
      ...(fieldsFromFirestore(x.document.fields) || {})
    }));
  }
  const [activeTrades, recentTrades] = await Promise.all([
    list("activeTrades", "startedAt", 500),
    list("tradeLedger", "completedAt", 500)
  ]);
  return json({
    activeTrades: activeTrades.filter(x => x.status === "active"),
    recentTrades,
    activeCount: activeTrades.filter(x => x.status === "active").length,
    completedCount: recentTrades.length,
    asOf: new Date().toISOString()
  }, 200);
}

export default {

   async fetch(request, env) {

      const origin = request.headers.get("Origin") || "";



      const allowed = String(env.ALLOWED_ORIGINS || "")

         .split(",")

         .map(x => x.trim())

         .filter(Boolean);



      if (origin && !allowed.includes(origin)) {

         return json(

            { error: "Origin not allowed." },

            403,

            { vary: "Origin" }

         );

      }



      const cors = origin

         ? {

               "access-control-allow-origin": origin,

               "access-control-allow-methods": "GET, POST, OPTIONS",

               "access-control-allow-headers": "Authorization, Content-Type",

               "access-control-max-age": "600",

               vary: "Origin"

            }

         : {};



      if (request.method === "OPTIONS") {

         return new Response(null, {

            status: 204,

            headers: cors

         });

      }



      if (

         new URL(request.url).pathname === "/health" &&

         request.method === "GET"

      ) {

         return json(

            { ok: true, mode: "wallet-api-v2-server-trades" },

            200,

            cors

         );

      }



      try {

         const auth = request.headers.get("Authorization") || "";



         if (!auth.startsWith("Bearer ")) {

            return json(

               { error: "Firebase sign-in token is required." },

               401,

               cors

            );

         }



         const claims = await verifyUserToken(auth.slice(7));



         const url = new URL(request.url);

      const trades = createTradeEngine({
        ROOT,
        serviceToken: () => serviceToken(env),
        toFirestore,
        fieldsFromFirestore
      });


      if (url.pathname === "/v1/admin/trades" && request.method === "GET") {
        const result = await adminTradeMonitor(env, claims);
        const headers = new Headers(result.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        return new Response(result.body, { status: result.status, headers });
      }

      if (url.pathname === "/v1/trades" && request.method === "POST") {
        const result = await trades.create(claims.sub, await request.json());
        return json(result, 201, cors);
      }

      if (url.pathname === "/v1/trades" && request.method === "GET") {
        return json(await trades.list(claims.sub), 200, cors);
      }



         if (

            url.pathname === "/v1/wallet" &&

            request.method === "GET"

         ) {

            const access = await serviceToken(env);



            const wallet = await readWallet(access, claims.sub);



            if (!wallet) {

               return json({

                  error: "Canonical wallet record is missing; no balance was created."

               }, 404, cors);

            }



            return json({

               uid: claims.sub,

               wallet: wallet.data,

               updateTime: wallet.updateTime

            }, 200, cors);

         }



         if (

            url.pathname === "/v1/admin/adjust-usdt" &&

            request.method === "POST"

         ) {

            const result = await adminAdjustment(

               env,

               null,

               claims,

               await request.json()

            );



            const headers = new Headers(result.headers);



            for (const [k, v] of Object.entries(cors)) {

               headers.set(k, v);

            }



            return new Response(result.body, {

               status: result.status,

               headers

            });

         }



         return json({

            error: "Route not found or not enabled in this migration stage."

         }, 404, cors);



      } catch (error) {

         return json({

            error: error?.message || "Wallet API request failed."

         }, 400, cors);

      }
  },
  async scheduled(event, env, ctx) {
    const trades = createTradeEngine({
      ROOT,
      serviceToken: () => serviceToken(env),
      toFirestore,
      fieldsFromFirestore
    });
    ctx.waitUntil(trades.settleDue());
  }
};
