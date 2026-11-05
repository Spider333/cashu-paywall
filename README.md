# cashu-paywall

Charge per call in [Cashu](https://cashu.space) ecash, on Cloudflare Workers and MCP servers.

- **Prepaid keys:** a caller pays with an ecash token (or a Lightning invoice) and gets a bearer key `eck_…` holding sats of credit. Every paid call takes credit off the key in one atomic D1 statement. The mint is never touched per call.
- **NUT-24 HTTP 402:** wrap any route with `paywall.protect()`. Without payment it answers `402 Payment Required` with `X-Cashu: creqA…`. A retry carrying `X-Cashu: cashuB…` is served.
- **MCP:** `cashu-paywall/mcp` adds `ecash_topup`, `ecash_balance` and `ecash_refund` tools, plus `withEcashCharge()` to price your own tools.
- **Lightning top-up page** at `/ecash` (NUT-04, NUT-20 locked quotes), refunds as a fresh token, and a daily cron that melts earned sats to your Lightning address.
- **Crash-safe:** every mint call is recorded before it is made. Outputs are deterministic (NUT-13), so a recovery job can rebuild anything the mint signed (NUT-09).

> **Status: v0.1.0, unreleased.** Tested against `testnut.cashu.space` (test sats; its Lightning is fake). Read [Custody and risks](#custody-and-risks) before you point it at a real mint.

NUTs used: 00–05, 07, 09, 10/11 (to refuse locked tokens), 12, 13, 18, 20, 24, 26.

## Install

```sh
npm install cashu-paywall
# for the MCP adapter, also:
npm install @modelcontextprotocol/sdk zod
```

Requirements: Node 22.4+ to build and test (cashu-ts 4.13.0), a Cloudflare Worker with a D1 database. `@cashu/cashu-ts` is pinned to exactly 4.13.0.

Apply the schema to your D1 database (it holds nothing else):

```sh
npx wrangler d1 execute <your-db> --local --file node_modules/cashu-paywall/migrations/0001_init.sql
# or point migrations_dir at node_modules/cashu-paywall/migrations in wrangler.jsonc
```

The same SQL is exported as `MIGRATIONS_SQL`.

## A paid route in a plain Worker

```ts
import { createPaywall } from "cashu-paywall";

const fortune = async () => Response.json({ fortune: "Don't trust, verify." });

const paywallFor = (env: Env) =>
  createPaywall({
    db: env.ECASH_DB,
    keyPepper: env.ECASH_KEY_PEPPER,     // secret, >= 32 chars
    proofKey: env.ECASH_PROOF_KEY,       // secret, base64 of 32 bytes (AES-GCM for proofs at rest)
    walletSeed: env.ECASH_WALLET_SEED,   // secret, 64-byte seed as hex. BACK IT UP.
    mints: env.ECASH_MINTS.split(","),   // allowlist
    publicBaseUrl: env.ECASH_PUBLIC_URL,
    melt: { lightningAddress: env.ECASH_MELT_LN_ADDRESS }, // unset = melting off
  });

export default {
  async fetch(request, env) {
    const paywall = paywallFor(env);                 // cheap: no network
    const routed = await paywall.handleRoutes(request); // /ecash/* (page, topup, balance, refund, keys, info)
    if (routed) return routed;
    if (new URL(request.url).pathname === "/fortune") {
      return paywall.protect(fortune, { priceSats: 5 })(request);
    }
    return new Response("Not found", { status: 404 });
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(paywallFor(env).scheduled(controller));
  },
} satisfies ExportedHandler<Env>;
```

Crons: `"*/10 * * * *"` runs the recovery job, and `"0 3 * * *"` also runs the melt and the cleanup.

```sh
curl -si https://your.worker/fortune                       # 402, X-Cashu: creqA…
curl -si -H "X-Cashu: cashuB…" https://your.worker/fortune  # 200, X-Ecash-Key: eck_…, X-Ecash-Balance
curl -si -H "Authorization: Bearer eck_…" https://your.worker/fortune  # 200 while credit lasts
```

## Paid MCP tools

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEcashTools, withEcashCharge } from "cashu-paywall/mcp";

function buildServer(paywall: Paywall, key: EcashKey) {
  const server = new McpServer({ name: "my-server", version: "1.0.0" });
  const getKey = () => key; // the caller's bearer key, checked before the server is built
  server.registerTool("lookup", { description: "…", inputSchema: { q: z.string().describe("…") } },
    withEcashCharge(paywall, { getKey, priceSats: 10, refundOn: (e) => e instanceof UpstreamDown },
      async ({ q }) => ({ content: [{ type: "text", text: await lookup(q) }] })));
  registerEcashTools(server, paywall, { getKey, priceSats: 10 }); // ecash_topup / _balance / _refund, all free
  return server;
}
```

A paid tool on an empty key returns `isError: true` with `code: "ECASH_INSUFFICIENT_BALANCE"`, a `payment_request` (NUT-18) and a `topup_url`, so an agent knows how to pay. `initialize`, `tools/list` and the `ecash_*` tools cost nothing. See [`examples/demo-worker`](examples/demo-worker) for a full stateless Streamable-HTTP MCP Worker, including `X-Cashu` on `/mcp`.

## Every way to pay

| How | Request | Result |
|---|---|---|
| NUT-24 | `X-Cashu: cashuB…` on a protected route | served; `X-Ecash-Key` (when a key was created), `X-Ecash-Balance`, `X-Ecash-Kid` |
| Bearer key | `Authorization: Bearer eck_…` | debit, then served; `402` + `X-Cashu` when credit runs out |
| MCP | `ecash_topup { token }` | credit on the caller's key |
| Token top-up | `POST /ecash/topup` with `X-Cashu` or `{ "token": … }` | `{ kid, credited_sats, fee_sats, balance_sats, … }` |
| Lightning | `POST /ecash/lightning { amount_sats }`, then poll `GET /ecash/lightning/:op_id` | invoice, then `CREDITED` |
| Page | `GET /ecash` | HTML: Lightning invoice + QR, or paste a token |

Credit = token amount − the mint's swap fee. A key is shown once and can't be recovered: refund before you lose it (`POST /ecash/refund`, or `ecash_refund`).

All errors share one JSON body, `{ error, code, retryable, payment_request?, topup_url?, … }`, with these codes: `ECASH_TOKEN_INVALID`, `ECASH_MINT_NOT_ALLOWED`, `ECASH_UNIT_NOT_ALLOWED`, `ECASH_AMOUNT_TOO_LOW`, `ECASH_AMOUNT_TOO_HIGH`, `ECASH_BALANCE_CAP`, `ECASH_TOKEN_SPENT`, `ECASH_TOKEN_LOCKED`, `ECASH_MINT_MISMATCH` and `ECASH_NOTHING_TO_REFUND` (400); `ECASH_KEY_INVALID` (401); `ECASH_PAYMENT_REQUIRED` and `ECASH_INSUFFICIENT_BALANCE` (402); `ECASH_KEY_FROZEN` (403); `ECASH_RATE_LIMITED` (429); `ECASH_INTERNAL` (500); `ECASH_MINT_UNAVAILABLE`, `ECASH_PENDING` and `ECASH_POT_FULL` (503, with `Retry-After: 30`).

## Config

| Option | Default | Meaning |
|---|---|---|
| `db` | required | D1 binding with the schema |
| `keyPepper` | required | HMAC secret for `eck_` keys (use a separate pepper from your own API keys) |
| `proofKey` | required | base64 32-byte AES-GCM key: proofs are sealed at rest |
| `walletSeed` | required | 64-byte hex seed for NUT-13 outputs. **One seed per database.** Back it up offline |
| `mints` | required | allowlist of mint URLs (normalised: lowercase host, no trailing `/`) |
| `publicBaseUrl`, `basePath` | required, `/ecash` | where the top-up routes live |
| `priceSats`, `suggestedTopupSats` | 1, 10 × price | price shown by helpers; amount in in-band payment requests |
| `requestEncoding` | `"creqA"` | `"creqB"` for NUT-26 (`CREQB1…`). creqA reaches more wallets today |
| `limits` | 1 / 50,000 / 50,000 / 200,000 / 8,192 / 64 | min top-up, max top-up, max balance per key, max total held (custody cap), max token chars, max proofs |
| `rateLimiter` | none | a Cloudflare Rate Limiting binding (`{ limit({ key }) }`). **No limiter = no rate limiting.** Keys are namespaced per class (`topup`, `lightning`, `keys`, `badkey`, `call`) and are HMACs of the IP or key |
| `melt` | off / 2,000 / 500 | `lightningAddress` (unset = no melting), `minSats`, `keepSats` |
| `logger` | console JSON | every field goes through `redact()` first |
| `fetch`, `now` | global | injectable for tests |

## Security notes

- **Keys:** only `HMAC-SHA256(keyPepper, key)` is stored. A malformed key is rejected before any database read.
- **Proofs at rest** are sealed with AES-GCM (`proofKey`), with each proof's `Y` as associated data. A D1 leak alone doesn't leak spendable ecash.
- **Write before call:** every swap, mint, refund and melt is written to `ecash_ops` before the mint is called. Each one's NUT-13 counter range is reserved in D1. A token's input set is claimed with a `UNIQUE` constraint, so one token reaches the mint at most once from here.
- **Recovery** (`*/10` cron) settles anything pending for more than 15 minutes. It uses checkstate (NUT-07) and restore (NUT-09). Credit is applied at most once, guarded by a claim id written in the same transaction.
- **Counter safety:** if D1 is restored from a backup and the counters go backwards, the mint refuses the reused outputs (`10002`/`11008`). The library skips ahead and retries; nothing is lost. Never share a seed between two databases.
- **Locked tokens** (NUT-10/11 P2PK or HTLC) are refused before any mint call. So are tokens from mints off the allowlist, units other than `sat`, and oversized tokens.
- **Logs** never contain tokens, keys, payment requests, invoices, proofs or 64-hex secrets. A test (T-LOG-1) runs the whole flow and checks this. Errors from cashu-ts are logged as class, HTTP status and NUT code only.
- **The page** is server-rendered with a strict CSP: one nonce'd inline script, no external resources, no cookies.
- **Refund tokens are money.** An in-band refund passes the token through the client (and, for MCP, the model's context and logs). The tool output says so.

## Custody and risks

Between a top-up and the next melt, your Worker holds ecash: a claim on a third-party mint. If the mint fails, the pot is lost. Service credit keeps working (debits never touch the mint), but refunds and melts fail. Keep it small:

- accept one well-known mint, and never a mint that calls itself test-only or warns it may rug;
- keep the custody cap (`maxTotalHeldSats`) and the per-key cap low, and set a melt address so earnings leave daily;
- back up `walletSeed` offline. Losing both the seed and the database loses the pot.

Taking ecash for your own service is a merchant accepting a payment. Holding user float that you refund is the edge closest to custody rules (e.g. MiCA). That's why balances stay capped. This is not legal advice: get your own before raising the caps for real money.

## Performance on Workers

A paid call is one D1 write and well under a millisecond of CPU. A top-up, refund or melt runs secp256k1 math in cashu-ts. The day-1 spike measured about **80–160 ms of CPU** per swap on a small VM (an estimate; Cloudflare's CPUs are faster). That doesn't fit the Workers Free plan's 10 ms CPU limit, so run money-in/money-out on **Workers Paid**. The bundle is about 77 KB gzipped.

## Develop

```sh
npm install
npm run build          # dist/ (ESM + types)
npm run typecheck
npm test               # unit tests in the Workers vitest pool (miniflare D1), no network
npm run test:testnut   # live tests against testnut.cashu.space (test sats)
npm run demo:token -- 20   # print a fresh 20-sat testnut token
```

## Try the demo locally

```sh
npm install && npm run build
cd examples/demo-worker
npm run dev-vars       # fresh local secrets in .dev.vars (gitignored)
npm run db:local       # apply the migration to a local D1
npm run dev            # http://localhost:8787
# in another shell, from the repo root:
node scripts/demo-check.mjs http://localhost:8787   # runs the whole demo script, PASS/FAIL per step
```

A live demo URL will be added here once it is deployed.

## License

MIT. Built with AI assistance (Claude), reviewed and owned by the author.
