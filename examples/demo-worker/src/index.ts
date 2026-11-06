// cashu-paywall demo: one NUT-24 paid route, an MCP server with two paid tools, and the library's /ecash routes.
// Test sats only (testnut) unless the operator adds a real mint.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { PaywallError, errorBody, type EcashKey, type Paywall } from "cashu-paywall";
import { findFact } from "./facts";
import { buildServer } from "./mcp";
import { getPaywall, priceOf, type Env } from "./paywall";

const REPO = "https://github.com/Spider333/cashu-paywall";

function indexJson(env: Env, paywall: Paywall) {
  return {
    name: "cashu-paywall demo",
    repo: REPO,
    price_sats: priceOf(env),
    accepted_mints: paywall.mints,
    note: "Test sats only: this demo accepts the testnut mint, whose Lightning is fake. No real money.",
    routes: {
      "GET /api/nut-fact?nut=24": `${priceOf(env)} sats over NUT-24 (HTTP 402 + X-Cashu)`,
      "POST /mcp":
        "MCP over Streamable HTTP. Authorization: Bearer eck_… (or pay with an X-Cashu header). Tools: nut_fact, echo (paid), ecash_topup, ecash_balance, ecash_refund (free)",
      "GET /ecash": "Top-up page (Lightning or a pasted Cashu token)",
      "GET /ecash/info": "Accepted mints, price, limits",
    },
  };
}

/** Errors on /mcp as JSON-RPC: -32001 unauthorized, -32002 rate limited, -32004 payment invalid. */
function rpcError(paywall: Paywall, status: number, rpcCode: number, e: PaywallError): Response {
  const data = { ...errorBody(e, paywall.topupUrl), topup_url: paywall.topupUrl };
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: rpcCode, message: e.message, data } }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...(status === 429 ? { "Retry-After": "60" } : {}),
        ...(status === 503 ? { "Retry-After": "30" } : {}),
      },
    },
  );
}

type Auth =
  | { ok: true; key: EcashKey; headers: { key?: EcashKey; kid: string; balanceSats: number } | null }
  | { ok: false; response: Response };

/** Finds the caller's key: a bearer key, or a new or topped-up one from an X-Cashu token. */
async function mcpAuth(request: Request, paywall: Paywall): Promise<Auth> {
  const bearer =
    request.headers
      .get("Authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim() ?? null;
  const hasCashu = request.headers.has("X-Cashu");
  if (!bearer && !hasCashu) {
    return {
      ok: false,
      response: rpcError(
        paywall,
        401,
        -32001,
        new PaywallError("ECASH_KEY_INVALID", {
          message: "Send Authorization: Bearer eck_… or pay with an X-Cashu header.",
        }),
      ),
    };
  }
  // A malformed bearer is rejected before any D1 read.
  if (bearer && !paywall.isEcashKey(bearer))
    return { ok: false, response: rpcError(paywall, 401, -32001, new PaywallError("ECASH_KEY_INVALID")) };
  if (hasCashu) {
    try {
      const r = await paywall.topupFromRequest(request);
      return { ok: true, key: r!.key, headers: { key: r!.created, kid: r!.kid, balanceSats: r!.balanceSats } };
    } catch (e) {
      const pe = e instanceof PaywallError ? e : new PaywallError("ECASH_INTERNAL");
      if (pe.code === "ECASH_RATE_LIMITED") return { ok: false, response: rpcError(paywall, 429, -32002, pe) };
      if (pe.code === "ECASH_KEY_INVALID") return { ok: false, response: rpcError(paywall, 401, -32001, pe) };
      return { ok: false, response: rpcError(paywall, pe.httpStatus, -32004, pe) };
    }
  }
  try {
    await paywall.balance(bearer as EcashKey); // one D1 read: does the key exist?
  } catch (e) {
    const pe = e instanceof PaywallError ? e : new PaywallError("ECASH_INTERNAL");
    return { ok: false, response: rpcError(paywall, pe.httpStatus, pe.httpStatus === 401 ? -32001 : -32004, pe) };
  }
  return { ok: true, key: bearer as EcashKey, headers: null };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const paywall = getPaywall(env);
    const routed = await paywall.handleRoutes(request); // /ecash/*
    if (routed) return routed;
    const url = new URL(request.url);
    const price = priceOf(env);

    if (url.pathname === "/" && request.method === "GET") return Response.json(indexJson(env, paywall));

    if (url.pathname === "/api/nut-fact" && request.method === "GET") {
      const fact = findFact(url.searchParams.get("nut")); // checked before any payment is asked
      if (!fact) return Response.json({ error: "No such NUT in the list." }, { status: 400 });
      return paywall.protect(async () => Response.json(fact), {
        priceSats: price,
        description: "One Cashu NUT, one line",
      })(request);
    }

    if (url.pathname === "/mcp") {
      if (request.method !== "POST") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: "Method not allowed: this server is stateless, POST only." },
          }),
          {
            status: 405,
            headers: { "Content-Type": "application/json", Allow: "POST" },
          },
        );
      }
      const auth = await mcpAuth(request, paywall);
      if (!auth.ok) return auth.response;
      const server = buildServer(paywall, auth.key, price);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      const res = await transport.handleRequest(request);
      return auth.headers ? paywall.withPaymentHeaders(res, auth.headers) : res;
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // The report holds counts, mint URLs and op ids only, no secrets. Logging it lets an operator see each cron run.
    ctx.waitUntil(
      getPaywall(env)
        .scheduled(controller)
        .then((r) => console.log(JSON.stringify({ event: "ecash_cron_report", cron: controller.cron, ...r }))),
    );
  },
} satisfies ExportedHandler<Env>;
