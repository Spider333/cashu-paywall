# Contributing

Issues and pull requests are welcome. For anything that touches money paths (top-up, refund, melt, recovery), open an issue first so we can agree on the approach.

## Setup

You need Node 22.4 or newer (cashu-ts 4.13.0 requires it) and npm 10.

```sh
git clone https://github.com/Spider333/cashu-paywall.git
cd cashu-paywall
npm install
npm run build
```

The repo's `.npmrc` sets `legacy-peer-deps=true`. Without it, npm 10.9 fails while resolving vitest 4.1's optional browser peer dependencies. `vite` is listed as a dev dependency for the same reason.

## Tests

| Command | What runs | Network |
|---|---|---|
| `npm run typecheck` | `tsc` on the library, then on the tests | no |
| `npm test` | unit tests in the Workers vitest pool, on a local D1 (miniflare) | no |
| `npm run test:testnut` | live tests against `testnut.cashu.space`: top-ups, refunds, the 402 flow, Lightning, melt, crash recovery, log redaction | yes, test sats |
| `cd examples/demo-worker && npm run typecheck && npm test` | the demo Worker, live against testnut | yes, test sats |
| `npm run demo:check -- http://localhost:8787` | the whole demo script against a running demo ([examples/demo-worker](examples/demo-worker)) | yes, test sats |
| `npm run format:check` | Prettier | no |

testnut's Lightning is fake: its invoices pay themselves, so the live tests cost nothing. testnut is sometimes slow, and the live suites allow up to 120 s per test.

Test names start with an id (`T-DEB-1`, `T-TOP-3`, `T-REC-2` and so on) from the original test plan. Keep the id when you change a test, and add a new one for a new case.

CI runs the typecheck, the unit tests and the format check on every push to `main` and every pull request. The live suites run only when started by hand (Actions → ci → Run workflow), so CI doesn't depend on testnut being up.

## Before you open a pull request

- `npm run format`, `npm run typecheck`, `npm test`, and `npm run test:testnut` if you touched anything that talks to a mint.
- A test for every bug fix. Money-path changes need a live test, and a crash test if they add a new mint call.
- Nothing that logs a token, key, payment request, invoice or secret. `test/testnut/logs.spec.ts` (T-LOG-1) checks this.
- `CHANGELOG.md` updated under "Unreleased".

## Layout

| Path | Contents |
|---|---|
| `src/core/` | keys, debit, top-up, Lightning, refund, wallet, D1 statements, redaction |
| `src/cron/` | recovery, melt, the daily job |
| `src/http/` | `protect()`, the `/ecash` routes and page |
| `src/mcp/` | the `cashu-paywall/mcp` adapter |
| `migrations/` | the D1 schema. `src/core/migrations-sql.ts` is generated from it by `npm run gen` (part of `npm run build`) |
| `sql/drop-all.sql` | drops every table. Not a migration |
| `test/` | unit tests. `test/testnut/` has the live tests |
| `bench/` | CPU and bundle-size measurements ([docs/performance.md](docs/performance.md)) |
| `scripts/` | `demo-check.mjs` (the demo script as a check), `testnut-token.mjs` (`npm run demo:token`), `gen-migrations.mjs` |
| `examples/demo-worker/` | the demo Worker |
