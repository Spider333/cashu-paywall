# cashu-paywall demo Worker

A small Cloudflare Worker that sells "nut facts" (one line per Cashu NUT spec) for **test sats**.

| Route | Price | What it does |
|---|---|---|
| `GET /` | free | JSON index: price, accepted mints, routes |
| `GET /api/nut-fact?nut=24` | 5 sats over NUT-24 | one fact as JSON. No `nut` gives a random one. A NUT not in the list is a `400` before any payment |
| `/ecash/*` | free | the library's top-up page, top-up, balance, refund, keys, info |
| `POST /mcp` | per tool | MCP over Streamable HTTP, stateless. `Authorization: Bearer eck_…` or `X-Cashu: cashuB…` |

MCP tools: `nut_fact` and `echo` cost 5 sats each (a `nut_fact` for a NUT not in the list is credited back). `ecash_topup`, `ecash_balance` and `ecash_refund` are free.

It accepts only `https://testnut.cashu.space`, whose Lightning is fake: its invoices pay themselves. No real money moves unless you add a real mint.

## Run it locally

No Cloudflare account needed. From the repo root:

```sh
npm install
npm run build                 # the demo uses the library's dist/
cd examples/demo-worker
npm run dev-vars              # writes .dev.vars with fresh secrets (mode 600, gitignored, never printed)
npm run db:local              # applies the D1 migration locally
npm run dev                   # wrangler dev on http://localhost:8787
```

To serve `creqB` (NUT-26) payment requests instead of `creqA`: `npx wrangler dev --var ECASH_REQUEST_ENCODING:creqB`.

Tests (live against testnut): `npm run typecheck && npm test`.

## Walkthrough

Captured on 6 Nov 2026 against a fresh clone. Commands run from the repo root while `npm run dev` is running. Long tokens are cut with `…`.

### 1. 402, pay, 200

```
$ curl -si "localhost:8787/api/nut-fact?nut=24"
HTTP/1.1 402 Payment Required
X-Cashu: creqApmFpaGFjYmY1Yzg3YWEFYXVjc2F0YW2BeBtodHRwczovL3Rlc3RudXQuY2FzaHUuc3BhY2VhZHdPbmUgQ2FzaHUgTlVULCBvbmUgbGluZWFz9Q==
…
{"error":"Payment required: pay with a Cashu token in the X-Cashu header.","code":"ECASH_PAYMENT_REQUIRED",…,"price_sats":5,"unit":"sat","mints":["https://testnut.cashu.space"],…}

$ TOKEN=$(npm run -s demo:token -- 20)        # a fresh 20-sat testnut token, 668 characters
$ curl -si -H "X-Cashu: $TOKEN" "localhost:8787/api/nut-fact?nut=24"
HTTP/1.1 200 OK
X-Ecash-Balance: 14
X-Ecash-Key: eck_A2_uML0N0eHoY4ffPuZfhtRcST6ExilR_ng5nTAZS8c
X-Ecash-Kid: c56bd006ae18705a

{"nut":24,"title":"HTTP 402 Payment Required","url":"https://github.com/cashubtc/nuts/blob/main/24.md"}
```

20 sats in, 1 sat swap fee, 5 sats for the call, 14 left on the new key.

### 2. The MCP tools

In Claude Code, add the demo with the key from step 1:

```sh
claude mcp add --transport http cashu-demo http://localhost:8787/mcp --header "Authorization: Bearer eck_A2_uML0N0eHoY4ffPuZfhtRcST6ExilR_ng5nTAZS8c"
```

Then ask: "Get the nut fact for NUT-18, echo 'hello nut', then show my ecash balance."

The transcript below was not captured in Claude Code, which isn't installed on the machine we used. It shows the same Streamable HTTP `tools/call` requests Claude Code sends, posted with curl to `/mcp` with the same `Authorization` header. Each line is the tool's text result:

```
tools/list                    nut_fact, echo, ecash_topup, ecash_balance, ecash_refund
nut_fact {"nut":18}           {"nut":18,"title":"Payment requests","url":"https://github.com/cashubtc/nuts/blob/main/18.md"}
echo {"text":"hello nut"}     {"text":"hello nut","length":9,"served_at":"2026-11-06T10:07:23.854Z"}
echo {"text":"again"}         isError { "error": "Not enough ecash credit for this call.", "code": "ECASH_INSUFFICIENT_BALANCE",
                                "retryable": false, "payment_request": "creqApWFpaDg3ODdhOTk4YWEYMmF1Y3NhdGFtgXgbaHR0cHM6Ly90ZXN0bnV0LmNhc2h1LnNwYWNlYXP1",
                                "topup_url": "http://localhost:8787/ecash", "price_sats": 5, "balance_sats": 4,
                                "how_to_pay": "Call ecash_topup with a Cashu token from an accepted mint, or open topup_url to pay by Lightning." }
ecash_balance {}              { "kid": "c56bd006ae18705a", "balance_sats": 4, "price_sats_per_call": 5, "calls_left": 0, … }
```

Two calls at 5 sats each (14 → 9 → 4). The third call finds 4 sats, so it fails without running, and its error tells the agent how to pay. An agent would now call `ecash_topup` with a new token, or open `topup_url`.

### 3. Refund

```
ecash_refund {}               { "token": "cashuBo2FteBtodHRwczovL3Rlc3RudXQuY2FzaHUuc3BhY2Vh…", "amount_sats": 3, "fee_sats": 1, "balance_sats": 0,
                                "warning": "This token is money. Paste it into a Cashu wallet now; anyone who sees it can claim it." }
```

The 4 sats left come back as a 3-sat token (1 sat swap fee). We claimed it with a second, empty cashu-ts wallet, which paid testnut's 1-sat fee in turn:

```
claimed 2 sats into a fresh wallet
```

In a wallet app, add the testnut mint and paste the token.

### 4. The cron

```
$ curl "localhost:8787/cdn-cgi/local/scheduled?cron=0+3+*+*+*"
ok
```

The Worker logs the report:

```
{"event":"ecash_cron_report","cron":"0 3 * * *","recovered":0,"melted":[],"skipped":[{"mint":"https://testnut.cashu.space","reason":"melt disabled"}],"invariantOk":true,"deletedEmptyKeys":0}
```

`*/10 * * * *` runs recovery only. Across the whole walkthrough, the dev server's log contained no key, token, payment request or invoice.

### All of it as a check

```sh
npm run demo:check -- http://localhost:8787
```

It runs steps 1 to 3 plus a drain, a top-up over MCP and a 500-sat Lightning top-up, and prints PASS or FAIL for each of 14 checks.

## Deploy to your own Cloudflare account

Top-ups need Workers **Paid**: a swap takes far more than the Free plan's 10 ms of CPU ([docs/performance.md](../../docs/performance.md)). Paid calls fit either plan.

```sh
npx wrangler whoami                                   # confirm the account first
npx wrangler d1 create cashu-paywall-demo             # put the printed id in wrangler.jsonc
npx wrangler d1 migrations apply cashu-paywall-demo --remote
npx wrangler secret put ECASH_KEY_PEPPER              # openssl rand -hex 32
npx wrangler secret put ECASH_PROOF_KEY               # openssl rand -base64 32
npx wrangler secret put ECASH_WALLET_SEED             # openssl rand -hex 64. Back it up offline
npx wrangler deploy                                   # then set ECASH_PUBLIC_URL to the printed URL and deploy again
```

Keep the three secrets in a file only you can read (`chmod 600`), never in the repo. `ECASH_MELT_LN_ADDRESS` is unset on purpose, so melting stays off until you name a Lightning address. The caps are lower than the library's defaults: 5,000 sats per key, 20,000 in total.

To take it down: `npx wrangler delete`, then `npx wrangler d1 delete cashu-paywall-demo`. On testnut nothing of value is lost.

## What the demo never does

No company data. No network calls except to the mint, and to a Lightning address if you set one. No accounts, emails, cookies or analytics. No real money unless you add a real mint.
