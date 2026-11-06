# Changelog

## 0.1.0 (unreleased)

First release. Tested against `testnut.cashu.space` only. Unaudited.

### Library (`cashu-paywall`)

- `createPaywall()` for Cloudflare Workers with D1: prepaid `eck_` keys (only an HMAC is stored), an atomic per-call debit in one SQL statement, and `credit()` to give a debit back.
- Token top-up (`topupWithToken`, `POST /ecash/topup`, or an `X-Cashu` header). It is written to `ecash_ops` before the mint is called, claims the token's inputs with a `UNIQUE` constraint, derives outputs from a NUT-13 seed with counters in D1, and stores proofs sealed with AES-256-GCM.
- NUT-24: `protect()` answers `402` with `X-Cashu: creqA…` (NUT-18), or `CREQB1…` (NUT-26) with `requestEncoding: "creqB"`, and serves the retry that pays. Wrong mint, unit or amount, and locked tokens, get a `400`. The excess stays on a new key returned in `X-Ecash-Key`.
- Lightning top-up: NUT-04 mint quotes, locked with NUT-20 when the mint supports it. A server-rendered page at `/ecash` with a QR code and a strict CSP. A status poll that mints and credits once.
- Refund as a fresh Cashu token (`refund`, `POST /ecash/refund`).
- Crons: a recovery job for all four operation kinds (NUT-07 checkstate, NUT-09 restore), a daily melt to a Lightning address over LNURL-pay that checks the invoice amount (off by default), cleanup of never-funded keys, and a held ≥ owed check that blocks melts when it fails.
- Recovery from NUT-13 counters going backwards (mint error 10002 or 11008): skip ahead and retry.
- Caps on top-up size, balance per key and total held. Optional rate limiting through a Cloudflare Rate Limiting binding.
- `redact()` and a default logger that redacts every field. `MIGRATIONS_SQL`, `sql/drop-all.sql`.

### MCP adapter (`cashu-paywall/mcp`)

- `registerEcashTools()`: free `ecash_topup`, `ecash_balance` and `ecash_refund` tools.
- `withEcashCharge()` to price a tool, with `refundOn` to give the charge back on chosen errors. `chargeToolCall()` and `ecashToolError()` for custom tools.

### Demo and tooling

- `examples/demo-worker`: "nut facts" for test sats over NUT-24 (`GET /api/nut-fact`) and MCP (`nut_fact`, `echo`).
- `npm run demo:check` runs the whole demo script against a running demo. `npm run demo:token` prints a testnut token.
- `npm run bench:cpu` and `npm run bench:bundle`.
- Docs: how it works, integration, security model, NUT-24 notes, performance.
