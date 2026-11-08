export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "online",
        service: "OnChainCrypto Deposit Verifier",
        firebase: Boolean(env.FIREBASE_PROJECT_ID),
        credentials: Boolean(env.FIREBASE_SERVICE_ACCOUNT),
        network: "TRON",
        asset: "USDT TRC20"
      }, { headers: corsHeaders });
    }

    return Response.json({
      service: "OnChainCrypto Deposit Verifier",
      status: "ready",
      message: "Deposit verification endpoint is being configured."
    }, { headers: corsHeaders });
  }
};
