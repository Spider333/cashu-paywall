# cashu-paywall demo Worker

A tiny Cloudflare Worker that sells "nut facts" (one line per Cashu NUT spec) for **test sats**:

| Route | Price | What it does |
|---|---|---|
| `GET /` | free | JSON index: price, accepted mints, routes, "test sats only" |
| `GET /api/nut-fact?nut=24` | 5 sats over NUT-24 | one fact as JSON; no `nut` = random; a NUT not in the list = `400` before any payment |
| `/ecash/*` | free | the library's top-up page, top-up, balance, refund, keys, info |
| `POST /mcp` | per tool | MCP over Streamable HTTP (stateless). `Authorization: Bearer eck_…` or `X-Cashu: cashuB…` |

MCP tools: `nut_fact` and `echo` (5 sats each; a `nut_fact` for a NUT not in the list is credited back), plus the free `ecash_topup`, `ecash_balance` and `ecash_refund`.

It accepts only `https://testnut.cashu.space`, whose Lightning is fake: its invoices pay themselves. No real money moves unless you add a real mint.

## Run it locally (no Cloudflare account)

From the repo root:

```sh
npm install
npm run build                 # the demo uses the library's dist/
cd examples/demo-worker
npm run dev-vars              # writes .dev.vars with fresh local secrets (mode 600, gitignored, never printed)
npm run db:local              # wrangler d1 migrations apply cashu-paywall-demo --local
npm run dev                   # wrangler dev on http://localhost:8787
```

Then, from the repo root, run the whole demo script (402 → pay → MCP → drain → top up → refund → Lightning) in one go:

```sh
node scripts/demo-check.mjs http://localhost:8787
```

Trigger the crons locally:

```sh
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+3+*+*+*"     # daily: recovery, melt ("melt disabled"), cleanup
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/10+*+*+*+*"  # recovery only
```

The Worker logs the cron report (`invariantOk: true`, `skipped: [{ reason: "melt disabled" }]` while no Lightning address is set).

To serve `creqB` (NUT-26) payment requests instead of `creqA`: `npx wrangler dev --var ECASH_REQUEST_ENCODING:creqB`.

Tests (live against testnut): `npx tsc --noEmit && npx vitest run`.

## The demo script (60 to 90 s, test sats)

```sh
DEMO=http://localhost:8787            # or the deployed URL
curl -si "$DEMO/api/nut-fact?nut=24"  # 402, x-cashu: creqA…

TOKEN=$(npm run -s demo:token -- 20)  # from the repo root: a fresh 20-sat testnut token
curl -si -H "X-Cashu: $TOKEN" "$DEMO/api/nut-fact?nut=24"
# 200, the NUT-24 fact, x-ecash-key: eck_…, x-ecash-balance: 14 (20 − 1 fee − 5)

claude mcp add --transport http cashu-demo "$DEMO/mcp" --header "Authorization: Bearer eck_…"
# Ask Claude: "Get the nut fact for NUT-18, echo 'hello nut', then show my ecash balance."
# Two debits of 5 sats. Keep asking until a call fails with ECASH_INSUFFICIENT_BALANCE
# (it carries a payment_request and the topup_url). Then ask for ecash_refund and paste
# the token into Cashu.me (with the testnut mint added).
```

## Deploy to your own Cloudflare account

Needs Workers **Paid** for top-ups: a swap takes ~80–160 ms of CPU, over the Free plan's 10 ms. Paid calls fit either plan.

```sh
npx wrangler whoami                                   # confirm the account first
npx wrangler d1 create cashu-paywall-demo             # put the printed id in wrangler.jsonc
npx wrangler d1 migrations apply cashu-paywall-demo --remote
npx wrangler secret put ECASH_KEY_PEPPER              # openssl rand -hex 32
npx wrangler secret put ECASH_PROOF_KEY               # openssl rand -base64 32
npx wrangler secret put ECASH_WALLET_SEED             # 64 random bytes as hex; BACK IT UP offline
npx wrangler deploy                                   # then set ECASH_PUBLIC_URL to the printed URL and deploy again
```

Keep the three secrets in a file only you can read (`chmod 600`), never in the repo. `ECASH_MELT_LN_ADDRESS` is unset on purpose: melting stays off until you name a Lightning address. The caps are lower than the library's defaults: 5,000 sats per key, 20,000 in total.

Take it down: `npx wrangler delete`, then `npx wrangler d1 delete cashu-paywall-demo`. On testnut nothing of value is lost.

## What the demo never does

No company data. No network calls except to the mint (and to a Lightning address, if you set one). No accounts, emails, cookies or analytics. No real money unless you add a real mint.
