# NUT-24 in cashu-paywall

[NUT-24](https://github.com/cashubtc/nuts/blob/main/24.md) defines HTTP 402 for Cashu: the server answers `402 Payment Required` with a payment request in an `X-Cashu` header, and the client retries with a token in the same header. `paywall.protect()` implements the server side. This page maps the flow onto the specs, lists every status code and header, and notes the questions the spec leaves open.

Specs read on 6 Nov 2026 from `cashubtc/nuts` `main`: [24.md](https://github.com/cashubtc/nuts/blob/main/24.md), [18.md](https://github.com/cashubtc/nuts/blob/main/18.md), [26.md](https://github.com/cashubtc/nuts/blob/main/26.md) and the [README](https://github.com/cashubtc/nuts/blob/main/README.md) support table.

## The flow

1. **No payment.** The server answers `402` with `X-Cashu: <payment request>`. NUT-24: "HTTP servers may respond with the HTTP status code 402 and an `X-Cashu` header containing a payment request, encoded in either NUT-18 `creqA` or NUT-26 `creqB` formats."
2. **The request** decodes to `a` = the route's price, `u` = `sat`, `m` = the mint allowlist, a random `i`, and an optional description `d`. It has no `t` (transport), because NUT-24 expects an in-band payment ("there is no transport field since we expect an in-band payment"), and no `nut10` lock.
3. **The client retries** with `X-Cashu: cashuB…`. NUT-24: "the client may retry the request with a `cashuB` token in the `X-Cashu` header as payment." Legacy `cashuA` tokens are accepted too.
4. **The server checks the token before any mint call:** mint in `m`, unit `sat`, not locked (NUT-10 P2PK or HTLC secrets are refused), within the size and amount caps.
5. **The server swaps the token at the mint** (NUT-03), credits the value minus the swap fee to a new prepaid key, debits the price and runs the handler.
6. **The response** is the handler's, with `X-Ecash-Key` (the new key), `X-Ecash-Balance` (credit left after this call) and `X-Ecash-Kid`. The client can spend the rest with `Authorization: Bearer eck_…`.

`protect()` also accepts `Authorization: Bearer eck_…` alone (debit an existing key) and both headers together (top up that key with the token, then debit).

## creqA or creqB

| | creqA (NUT-18) | creqB (NUT-26) |
|---|---|---|
| Encoding | `"creqA" + base64_urlsafe(CBOR(request))` | `"creqb1" + bech32m(TLV(request))`, uppercase recommended |
| What the library emits | `creqA…` | `CREQB1…` |
| Config | `requestEncoding: "creqA"` (default) | `requestEncoding: "creqB"` |
| Wallets listed in the NUTs README | cashu-ts, Cashu.me, cdk, Minibits, Sovran | Nutshell, cdk, cashu-ts, Sovran |

NUT-24 says "Wallets MUST support both formats", but the README lists `creqB` support in fewer wallets than `creqA`, and Cashu.me and Minibits list NUT-18 only. So the library defaults to `creqA`. Both encodings are built with cashu-ts `PaymentRequest` and tested: the unit tests decode both, and `scripts/demo-check.mjs` passes against the demo with either.

## Status codes

| Status | Code | When | NUT-24 says |
|---|---|---|---|
| 402 | `ECASH_PAYMENT_REQUIRED` | no `X-Cashu` and no bearer key | the 402 response itself |
| 402 | `ECASH_PAYMENT_REQUIRED` (body has `balance_sats`) | a bearer key with too little credit | not covered; treated like no payment |
| 400 | `ECASH_MINT_NOT_ALLOWED` | token from a mint not in `m` | 400 |
| 400 | `ECASH_UNIT_NOT_ALLOWED` | unit is not `sat` | 400 |
| 400 | `ECASH_AMOUNT_TOO_LOW` | value after the swap fee is below the price | 400 ("an insufficient amount") |
| 400 | `ECASH_TOKEN_LOCKED` | NUT-10 P2PK or HTLC secret | 400 ("insufficient locking conditions") |
| 400 | `ECASH_TOKEN_SPENT` | mint says spent, or this token was already used here | not covered; our choice |
| 400 | `ECASH_TOKEN_INVALID` | not decodable, too long, too many proofs, rejected by the mint | not covered; our choice |
| 400 | `ECASH_AMOUNT_TOO_HIGH`, `ECASH_BALANCE_CAP`, `ECASH_MINT_MISMATCH` | caps, or a bearer key bound to another mint | not covered |
| 401 | `ECASH_KEY_INVALID` | malformed or unknown bearer key | not covered |
| 403 | `ECASH_KEY_FROZEN` | the operator froze the key | not covered |
| 429 | `ECASH_RATE_LIMITED` | rate limited, with `Retry-After: 60` | not covered |
| 503 | `ECASH_MINT_UNAVAILABLE` | mint unreachable before the swap; the token was not spent. `Retry-After: 30` | not covered |
| 503 | `ECASH_PENDING` | swap outcome unknown; settles within 15 minutes. `Retry-After: 30` | not covered |
| 503 | `ECASH_POT_FULL` | the custody cap is reached until the next melt. `Retry-After: 30` | not covered |
| 500 | `ECASH_INTERNAL` | a bug, or the protected handler threw (the debit is credited back) | not covered |

Every error has the same JSON body: `{ "error", "code", "retryable", "payment_request"?, "topup_url"?, … }`. A 402 also carries `price_sats`, `unit` and `mints`.

## Headers

| Header | Direction | Meaning |
|---|---|---|
| `X-Cashu: creqA…` / `CREQB1…` | response | NUT-24 payment request, on every 402 |
| `X-Cashu: cashuB…` | request | NUT-24 payment |
| `Authorization: Bearer eck_…` | request | pay from an existing prepaid key (not part of NUT-24) |
| `X-Ecash-Key` | response | a key created by this request. Shown once. Also sent on errors such as `ECASH_PENDING` when the request created a key |
| `X-Ecash-Balance` | response | credit left on the key, in sats |
| `X-Ecash-Kid` | response | the key's public id |
| `Retry-After` | response | on 429 (60) and 503 (30) |

## Interop

- **cashu-ts** decodes both encodings and makes the tokens in every test here. It is the only wallet code this project has run.
- **Wallets with NUT-18:** a user can decode the `creqA` from a 402 (the page at `GET /ecash` also shows it as a QR code), make a token for that amount from one of the listed mints, and send it. The README lists cashu-ts, Cashu.me, cdk, Minibits and Sovran. We have not tested any wallet app against this server.
- **NUT-24 clients:** the README table lists no wallet and no mint for NUT-24 as of 6 Nov 2026. A client that pays automatically today has to be written; [`scripts/demo-check.mjs`](../scripts/demo-check.mjs) shows the 402 → token → retry loop in about 20 lines with cashu-ts.
- **Agents over MCP** don't use the 402. They call the `ecash_topup` tool, or connect to `/mcp` with an `X-Cashu` header, which the demo accepts in the same way.

## Spec questions

These came up while implementing NUT-24. They are worth raising upstream.

1. **Gross or net amount.** NUT-24 says the token must be "greater than or equal to the `a` amount". NUT-18 defines `a` as "the amount of the requested payment, net of input fees". This library follows NUT-18: the value left after the mint's swap fee must cover the price. A wallet that reads NUT-24 alone and pays exactly `a` gets a 400.
2. **Change.** NUT-24 does not say what happens to an overpayment. This library keeps the excess as credit on a new key and returns it in `X-Ecash-Key`, which is not standard. A client that ignores that header loses the excess.
3. **What a successful paid response looks like.** NUT-24 has no success status or response header. A client can't tell from the protocol whether its token was used.
4. **Spent, invalid and unreachable.** NUT-24 names 400 for four cases (mint, unit, amount, locking). A spent token, a token that doesn't decode, and a mint that can't be reached aren't covered. This library uses 400 for the first two and `503` with `Retry-After` for the third, where the token was not spent and the client should retry with the same token.
5. **Spelling of the encoding.** NUT-24 writes `creqB`. The NUT-26 prefix is `creqb1`, uppercase `CREQB1` recommended. A client looking for the literal `creqB` will miss it.
6. **Newer NUT-18 fields.** NUT-18 now also has `mp` (advisory mint list), `sm` (supported methods) and a per-method fee `mf`. NUT-24 lists only `a`, `u`, `m` and `nut10`. This library sets none of the newer fields, so its mint list is strict.
