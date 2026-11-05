# Changelog

## 0.1.0 (unreleased)

First version.

- `createPaywall()` for Cloudflare Workers + D1: prepaid `eck_` keys (only their HMAC is stored), an atomic per-call debit, and credit back.
- Token top-up (`topupWithToken`, `POST /ecash/topup`, `X-Cashu` header), crash-safe: the op is written before the mint call; NUT-13 deterministic outputs with counters in D1; `UNIQUE` claim on the token's inputs; sealed (AES-GCM) proofs at rest.
- NUT-24: `protect()` answers `402` with `X-Cashu: creqA…` (or `creqB` via `requestEncoding`) and serves the retry that pays; `400` for the wrong mint, unit or amount, or a locked token.
- Lightning top-up: NUT-04 mint quotes (NUT-20 locked when the mint supports it), a server-rendered page at `/ecash` with a QR code and a strict CSP, and a status poll that credits once.
- Refund as a fresh token (`refund`, `POST /ecash/refund`, `ecash_refund`).
- Cron: a recovery job (NUT-07 checkstate + NUT-09 restore), a daily melt to a Lightning address via LNURL-pay (it checks the invoice amount), cleanup of never-funded keys, and a held ≥ owed invariant check.
- Self-healing when NUT-13 counters go backwards (mint codes 10002/11008): skip ahead and retry.
- `cashu-paywall/mcp`: `registerEcashTools` (`ecash_topup`, `ecash_balance`, `ecash_refund`), `chargeToolCall`, `withEcashCharge` (with `refundOn`), `ecashToolError`.
- `redact()` and a redacting default logger; `MIGRATIONS_SQL`.
- `examples/demo-worker`: nut facts over NUT-24 and MCP, on testnut.
