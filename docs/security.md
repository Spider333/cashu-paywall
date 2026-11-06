# Security model

cashu-paywall is unaudited. It has only been run against the test mint `testnut.cashu.space`, whose Lightning is fake. Read this page before you point it at a mint that holds real sats.

To report a problem, see [SECURITY.md](../SECURITY.md).

## What you are trusting

- **The mint.** Between a top-up and the next melt, the Worker holds ecash: a claim on a third-party mint. If the mint disappears or refuses to honour its notes, the pot is gone. Paid calls keep working, because a debit never touches the mint, but refunds and melts fail.
- **The operator.** Whoever runs the Worker holds every user's float and the three secrets. Users trust the operator the way they trust any prepaid service.
- **Cloudflare.** Your D1 database, your secrets and the Worker runtime live there.

## Secrets

| Secret | What a leak gives an attacker |
|---|---|
| `walletSeed` (128 hex characters) | Every NUT-13 output the Worker ever made. Together with the counter ranges in `ecash_ops` (or by scanning), an attacker can restore the signatures from the mint (NUT-09) and spend the unspent pot. Treat it like the pot itself. Back it up offline: without it, a crash between the mint and D1 can't be recovered. |
| `proofKey` (base64 of 32 bytes) | Lets someone who also has a copy of D1 open the sealed proofs in `ecash_proofs` and spend them. |
| `keyPepper` (32+ characters) | Lets someone who also has a copy of D1 check guesses against `key_hash`. Keys are 32 random bytes, so guessing is not practical, but use a pepper you use for nothing else. |

A D1 leak alone gives an attacker neither keys nor spendable proofs.

## Threats and what stops them

### Double spend of an incoming token

- The token is swapped at the mint before any credit. After the swap the token is spent, so nobody else can use it, including its sender.
- Before the swap, the token's input set is claimed locally: `ecash_ops.input_id` is the SHA-256 of the sorted proof `Y`s, with a `UNIQUE` constraint. Two parallel submissions of the same token can't both reach the mint (live test T-TOP-3: 5 concurrent submissions, exactly 1 credit).
- A token the mint reports as spent (NUT error 11001) is answered with `400 ECASH_TOKEN_SPENT` and credits nothing.

### Crash between the mint and D1

The dangerous moment is after the mint has signed new outputs and before D1 records them.

- Every mint call that creates outputs is written to `ecash_ops`, with a reserved NUT-13 counter range, before the call.
- Outputs are derived from `walletSeed` and that counter range, so they can be rebuilt with a NUT-09 restore.
- The recovery cron (every 10 minutes) settles any op pending for more than 15 minutes. It uses NUT-07 checkstate to see whether the inputs were spent and NUT-09 restore to recover our outputs.
- Credit is applied at most once: the key is credited only in the same transaction that flips the op from `pending` to `done`, guarded by a claim id.
- The client sees `503 ECASH_PENDING` and is told to retry with the same token or check the balance. A key created by that request is returned in the error, because it is shown nowhere else.

Live tests T-REC-1 to T-REC-3 inject a crash before the swap, after the swap, and after a refund swap, and check the outcome after recovery.

### Replay

- **Tokens:** a spent token is refused by the mint, and a token already submitted here is refused by the `UNIQUE` claim before the mint is asked.
- **Keys:** an `eck_` key is a bearer secret. Anyone who has it can spend its credit or refund it. Keys are read only from the `Authorization` header, never from the URL, and only their HMAC is stored. Serve the Worker over HTTPS only.
- **Payment requests:** a `creqA`/`creqB` request is a price quote, not a credential. Replaying one does nothing.
- **Lightning status polls:** the op is `done` after the first successful mint, so a second poll returns the result without minting again.
- **Refunds:** the balance is zeroed with a conditional update (`WHERE balance = B`) in the same transaction as the refund op, so a second refund or a racing debit finds nothing to take.

### Stolen keys

A stolen key is stolen credit, as with any bearer token. The design limits the damage:

- the per-key cap (`maxBalanceSats`, default 50,000 sats) bounds what one key can hold;
- the holder can refund at any time, which moves the credit out of reach;
- an operator can freeze a key with `UPDATE ecash_keys SET status = 'frozen' WHERE kid = ?` (there is no API for this yet);
- keys are shown once and never logged.

### Logs

- Every log line goes through `redact()`, which masks Cashu tokens (`cashuA…`, `cashuB…`), `eck_` keys, `creqA`/`CREQB1` payment requests, bolt11 invoices and any run of 64 or more hex characters.
- Errors from cashu-ts and the network are logged as class name, HTTP status and NUT error code only. Mint error bodies can echo proofs, so their message is never logged.
- Rate-limit keys are HMACs of the client IP or the key's `kid`, so no raw IP reaches the limiter.
- Live test T-LOG-1 runs a token top-up, a debit, a 402, a refund, a Lightning top-up and a melt with `console` captured, and fails if any of those patterns appears.

### The top-up page

`GET /ecash` is server-rendered with one inline script, allowed by a per-response nonce. Its headers are `Content-Security-Policy: default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…'; img-src data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. No external resources, cookies or analytics. A key is written into the page, never into a URL.

### Mints and Lightning address servers

- Only mints on the allowlist are accepted. Their URLs must be `https://` (or `http://localhost` for local testing).
- Mint requests time out after 15 seconds and never follow redirects.
- The melt asks the Lightning address server for an invoice and then checks that the mint's melt quote is for exactly the amount asked. A server that returns an invoice for a different amount aborts the melt. The LNURL callback must be `https://`.

### Custody at the mint

Holding user float you refund on request is the edge closest to custody rules (for example MiCA in the EU). The library keeps the pot small by default:

- a custody cap on everything held, across all keys;
- a per-key balance cap;
- a daily melt that moves earnings out (once you set a Lightning address).

This is not legal advice. Get your own before raising the caps for real money.

## Caps and rate limits

| Limit | Default | Config |
|---|---|---|
| Minimum top-up | 1 sat | `limits.minTopupSats` |
| Maximum top-up | 50,000 sats | `limits.maxTopupSats` |
| Maximum balance per key | 50,000 sats | `limits.maxBalanceSats` |
| Maximum held in total (custody cap) | 200,000 sats | `limits.maxTotalHeldSats` |
| Maximum token length | 8,192 characters | `limits.maxTokenChars` |
| Maximum proofs per token | 64 | `limits.maxProofsPerToken` |
| Request body on `/ecash/*` | 16,384 bytes | fixed |

The demo sets lower caps: 5,000 sats per key and 20,000 in total.

Rate limiting needs a [Cloudflare Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) passed as `rateLimiter`. **Without one, nothing is rate limited.** The library counts five classes separately by prefixing the limiter key:

| Class | Counted per | Applied to |
|---|---|---|
| `topup` | client IP | `POST /ecash/topup`, an `X-Cashu` header on a protected route |
| `lightning` | client IP | `POST /ecash/lightning` |
| `keys` | client IP | `POST /ecash/keys` |
| `badkey` | client IP | a malformed or unknown `eck_` key |
| `call` | key (`kid`) | every debit |

One binding has one limit and period, so all five classes share it (the demo uses 30 per 60 seconds). Use a separate binding per class if you need different limits; that would need a small change to the library.

The client IP comes from `CF-Connecting-IP`, falling back to `X-Real-IP`. Behind something other than Cloudflare, make sure those headers can't be set by the client.

## What is not protected

- **The code is unaudited.** It has run only against testnut.
- **A failing or dishonest mint** loses the pot. The caps limit how much.
- **Bearer keys.** Whoever holds a key holds its credit. There is no binding of a key to a client.
- **Refund tokens are money in transit.** An in-band refund passes the token through the client. Over MCP it also passes through the model's context and the client's logs. The tool output warns about this.
- **No rate limiting by default**, and one binding means one shared limit (see above).
- **`GET /ecash/lightning/:op_id` is not rate limited**, because the page polls it every 3 seconds. Op ids are random UUIDs, so the cost is extra mint load, not a leak.
- **Denial of service through the mint.** Each top-up makes the Worker call the mint. Rate limits are the only brake.
- **One mint per key.** A key is bound to the mint of its first credit. A top-up from another mint is refused with `ECASH_MINT_MISMATCH`.
- **The operator.** Nothing stops an operator from keeping the pot.

## Why melting is off by default

The daily melt pays sats out over Lightning, and a Lightning payment can't be undone. The library won't guess where to send money, so `melt.lightningAddress` has no default. Until you set one, the daily cron reports `melt disabled` and moves nothing. Other reasons:

- on the test mint there is nothing real to melt;
- the Lightning address server learns how much you earn and when;
- a melt should only run once you have checked the invariant reports for a while and trust the numbers.

When you turn it on, the melt only moves the surplus (held − owed − `keepSats`), skips amounts below `minSats` (default 2,000), aborts on an invoice amount mismatch, and is skipped entirely when the held ≥ owed invariant is broken.
