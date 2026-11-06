# Integration

How to add cashu-paywall to a Cloudflare Worker, then to an MCP server on a Worker. [`examples/demo-worker`](../examples/demo-worker) is a complete working example of both.

Start on the test mint `https://testnut.cashu.space`. Its Lightning is fake, so nothing you do there costs or earns real sats.

## Add it to a Worker

### 1. Install

```sh
npm install cashu-paywall
```

`@cashu/cashu-ts` is pinned to 4.13.0 and installed with it. The library runs in workerd without any compatibility flags.

### 2. Create the D1 database and apply the schema

```sh
npx wrangler d1 create my-paywall-db
```

Add the binding to `wrangler.jsonc`, and point `migrations_dir` at the package's migrations:

```jsonc
"d1_databases": [
  {
    "binding": "ECASH_DB",
    "database_name": "my-paywall-db",
    "database_id": "<id printed by d1 create>",
    "migrations_dir": "node_modules/cashu-paywall/migrations"
  }
]
```

```sh
npx wrangler d1 migrations apply my-paywall-db --local    # then --remote when you deploy
```

The schema is five `ecash_*` tables ([how-it-works.md](how-it-works.md#the-d1-tables)). Use a database that holds nothing else. The same SQL is exported as `MIGRATIONS_SQL` if you apply schemas from code.

### 3. Create the three secrets

```sh
openssl rand -hex 32        # ECASH_KEY_PEPPER: HMAC secret for keys
openssl rand -base64 32     # ECASH_PROOF_KEY: AES-GCM key for proofs at rest
openssl rand -hex 64        # ECASH_WALLET_SEED: NUT-13 seed. Back it up offline.
```

For local development put them in `.dev.vars` (and keep that file out of git). For a deployed Worker use `npx wrangler secret put <NAME>` for each. [security.md](security.md#secrets) explains what each one protects. Never share one wallet seed between two databases.

### 4. Create the paywall and serve its routes

```ts
import { createPaywall } from "cashu-paywall";

interface Env {
  ECASH_DB: D1Database;
  ECASH_KEY_PEPPER: string;
  ECASH_PROOF_KEY: string;
  ECASH_WALLET_SEED: string;
  ECASH_RL?: RateLimit;
}

const paywallFor = (env: Env) =>
  createPaywall({
    db: env.ECASH_DB,
    keyPepper: env.ECASH_KEY_PEPPER,
    proofKey: env.ECASH_PROOF_KEY,
    walletSeed: env.ECASH_WALLET_SEED,
    mints: ["https://testnut.cashu.space"],
    publicBaseUrl: "https://my-worker.example.workers.dev",
    priceSats: 5,
    rateLimiter: env.ECASH_RL,
  });

export default {
  async fetch(request, env) {
    const paywall = paywallFor(env); // no network, no database: build it per request
    const routed = await paywall.handleRoutes(request); // GET /ecash, POST /ecash/topup, …
    if (routed) return routed;

    if (new URL(request.url).pathname === "/fortune") {
      return paywall.protect(async () => Response.json({ fortune: "Don't trust, verify." }), { priceSats: 5 })(request);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(paywallFor(env).scheduled(controller));
  },
} satisfies ExportedHandler<Env>;
```

`handleRoutes` serves everything under `basePath` (default `/ecash`) and returns `null` for any other path:

| Route | Does |
|---|---|
| `GET /ecash` | top-up page: Lightning invoice with a QR code, or paste a token |
| `GET /ecash/info` | accepted mints, price, limits, a payment request |
| `POST /ecash/topup` | token in `X-Cashu` or `{ "token": "cashuB…" }`, optional bearer key |
| `POST /ecash/lightning` | `{ "amount_sats": 500 }`, optional bearer key. Returns an invoice and a `status_url` |
| `GET /ecash/lightning/:op_id` | `UNPAID`, `EXPIRED` or `CREDITED` |
| `GET /ecash/balance` | bearer key required |
| `POST /ecash/refund` | bearer key required. Returns a Cashu token |
| `POST /ecash/keys` | a new key with 0 credit |

`protect(handler, { priceSats })` wraps any route in NUT-24 ([nut-24.md](nut-24.md)). If your handler throws, the debit is credited back and the client gets a 500. For a custom flow, call `paywall.debit(key, sats)` yourself: it returns `{ ok: true, balanceSats }` or `{ ok: false, error }` and never calls the mint.

### 5. Add the crons

```jsonc
"triggers": { "crons": ["0 3 * * *", "*/10 * * * *"] }
```

`*/10 * * * *` runs the recovery job and the invariant check. `0 3 * * *` (UTC) also runs the melt (when a Lightning address is set) and deletes never-funded keys older than 7 days. Locally, trigger them with:

```sh
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+3+*+*+*"
```

`scheduled()` returns a `CronReport`. Log it, or alert on `invariantOk: false`.

### 6. Add a rate limiter

Without a limiter nothing is rate limited. Add a [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) and pass it as `rateLimiter`:

```jsonc
"ratelimits": [{ "name": "ECASH_RL", "namespace_id": "1001", "simple": { "limit": 30, "period": 60 } }]
```

The library counts top-ups, Lightning invoices, key creation and bad keys per client IP, and paid calls per key. They share the binding's limit ([security.md](security.md#caps-and-rate-limits)).

### 7. Check the CPU plan

A paid call is one D1 statement. A top-up, refund or melt runs secp256k1 math in cashu-ts, which takes far more than the Workers Free plan's 10 ms of CPU per request. Run a Worker that takes payments on Workers Paid. Numbers in [performance.md](performance.md).

## Add it to an MCP server

The adapter is a separate entry point. It needs the MCP SDK and zod as peer dependencies:

```sh
npm install @modelcontextprotocol/sdk zod
```

### 1. Find the caller's key before building the server

The demo builds a fresh stateless `McpServer` for each request, with the caller's key in a closure. Read the key from `Authorization: Bearer eck_…`, or accept an `X-Cashu` token, which creates or tops up a key in the same request:

```ts
const top = await paywall.topupFromRequest(request);  // null when there is no X-Cashu header
const key = top?.key ?? bearerKeyFrom(request);       // your own header parsing, checked with paywall.isEcashKey
```

`topupFromRequest` throws a `PaywallError` for a bad token. The demo turns those into JSON-RPC errors on `/mcp`: `-32001` unauthorized, `-32002` rate limited, `-32004` payment invalid, with the JSON error body as `error.data`. When the request created a key, add it to the response with `paywall.withPaymentHeaders(res, { key: top.created, kid: top.kid, balanceSats: top.balanceSats })`: it is shown only once.

### 2. Register the tools

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EcashKey, Paywall } from "cashu-paywall";
import { registerEcashTools, withEcashCharge } from "cashu-paywall/mcp";
import { z } from "zod";

class UpstreamDown extends Error {}

function buildServer(paywall: Paywall, key: EcashKey) {
  const server = new McpServer({ name: "my-server", version: "1.0.0" });
  const getKey = () => key;

  server.registerTool(
    "lookup",
    { description: "Looks something up. Costs 10 sats of ecash credit.", inputSchema: { q: z.string() } },
    withEcashCharge(paywall, { getKey, priceSats: 10, refundOn: (e) => e instanceof UpstreamDown }, async ({ q }: { q: string }) => ({
      content: [{ type: "text", text: await lookup(q) }],
    })),
  );

  registerEcashTools(server, paywall, { getKey, priceSats: 10 }); // ecash_topup, ecash_balance, ecash_refund (free)
  return server;
}
```

- `withEcashCharge` debits before the handler runs. If credit is short it returns an `isError: true` result with `code: "ECASH_INSUFFICIENT_BALANCE"`, a `payment_request` and a `topup_url`, and the handler doesn't run. If the handler throws an error matched by `refundOn`, the debit is credited back. Other errors keep the charge.
- `registerEcashTools` adds three free tools. `ecash_topup` takes a token, `ecash_balance` shows credit and calls left, `ecash_refund` returns the credit as a Cashu token. `toolNamePrefix` changes the `ecash_` prefix.
- `chargeToolCall(paywall, key, sats)` is the debit step on its own, for tools you don't want to wrap.

### 3. Serve it over Streamable HTTP

```ts
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const server = buildServer(paywall, key);
const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
await server.connect(transport);
return transport.handleRequest(request);
```

A client connects with the key as a header. In Claude Code:

```sh
claude mcp add --transport http my-server https://my-worker.example.workers.dev/mcp --header "Authorization: Bearer eck_…"
```

## Config

`createPaywall(config)` validates everything once and throws a plain `Error` on a bad value. The library reads no environment variables itself. The env var column is the name the demo Worker uses ([`examples/demo-worker/src/paywall.ts`](../examples/demo-worker/src/paywall.ts)).

| Option | Default | Demo env var | Meaning |
|---|---|---|---|
| `db` | required | `ECASH_DB` (D1 binding) | D1 database with the schema |
| `keyPepper` | required | `ECASH_KEY_PEPPER` (secret) | HMAC secret for `eck_` keys, at least 32 characters |
| `proofKey` | required | `ECASH_PROOF_KEY` (secret) | base64 of 32 bytes, AES-256-GCM key for proofs at rest |
| `walletSeed` | required | `ECASH_WALLET_SEED` (secret) | 64-byte NUT-13 seed as 128 hex characters. One per database. Back it up |
| `mints` | required | `ECASH_MINTS` (comma-separated) | allowlist of mint URLs, `https://` only (or `http://localhost`). Normalised: lowercase host, no trailing `/` |
| `publicBaseUrl` | required | `ECASH_PUBLIC_URL` | absolute URL of the Worker, for `topup_url` and `status_url` |
| `basePath` | `/ecash` | none | where `handleRoutes` serves the top-up routes |
| `priceSats` | `1` | `ECASH_PRICE_SATS` (demo: `5`) | price shown by the page and helpers. Each `protect()` and `withEcashCharge()` sets its own price |
| `suggestedTopupSats` | `10 × priceSats` | none | amount in the payment requests attached to errors and shown on the page |
| `requestEncoding` | `"creqA"` | `ECASH_REQUEST_ENCODING` | `"creqB"` for NUT-26 payment requests |
| `unit` | `"sat"` | none | only `"sat"` is supported |
| `limits.minTopupSats` | `1` | none | smallest top-up |
| `limits.maxTopupSats` | `50000` | none | largest single top-up |
| `limits.maxBalanceSats` | `50000` | `ECASH_MAX_BALANCE_SATS` (demo: `5000`) | most credit one key can hold |
| `limits.maxTotalHeldSats` | `200000` | `ECASH_MAX_TOTAL_HELD_SATS` (demo: `20000`) | custody cap across all keys. Top-ups past it get `ECASH_POT_FULL` until the next melt |
| `limits.maxTokenChars` | `8192` | none | longest token accepted |
| `limits.maxProofsPerToken` | `64` | none | most proofs in one token |
| `rateLimiter` | none | `ECASH_RL` (Rate Limiting binding) | no limiter means no rate limiting |
| `melt.lightningAddress` | none (melting off) | `ECASH_MELT_LN_ADDRESS` (demo: unset) | `name@domain` that receives the daily melt |
| `melt.minSats` | `2000` | `ECASH_MELT_MIN_SATS` | skip the melt when less would move |
| `melt.keepSats` | `500` | none | sats left in the pot beyond what keys are owed |
| `logger` | JSON lines on `console` | none | `{ info, warn, error }(event, fields)`. Every field goes through `redact()` first |
| `fetch` | global `fetch` | none | used for mint and LNURL calls |
| `now` | `Date.now` | none | clock in Unix ms |

## Removing it

1. Stop taking payments (remove the routes) and let users refund, or melt what is left.
2. Check the pot is empty: `SELECT state, COUNT(*), SUM(amount) FROM ecash_proofs GROUP BY state`.
3. Drop the tables with [`sql/drop-all.sql`](../sql/drop-all.sql) (`npx wrangler d1 execute <db> --file node_modules/cashu-paywall/sql/drop-all.sql`, plus `--remote` for the deployed database). It is kept out of `migrations/` so a migration run can never apply it.
