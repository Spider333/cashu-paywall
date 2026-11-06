# bench

Two small measurements behind [docs/performance.md](../docs/performance.md).

| Script | What it measures | Needs |
|---|---|---|
| `npm run bench:cpu [-- <rounds>]` | CPU time (`process.cpuUsage`) of the cashu-ts calls behind a top-up (`receive`) and a refund (`send`), in Node 22, with the same wallet settings as the library | network access to `testnut.cashu.space` (test sats) |
| `npm run bench:bundle` | Size of a minimal Worker that uses the library, bundled and minified by esbuild, raw and gzipped | `npm run build` first |

Neither script touches a real mint or money. `bench:cpu` mints test tokens from testnut, whose Lightning is fake.

Sample output (6 Nov 2026, DigitalOcean "DO-Regular" VM, 4 vCPU, Node 22.23.4):

```
$ node bench/bundle.mjs
library (createPaywall + protect)     316 KB raw   99 KB gzipped
library + cashu-paywall/mcp          1031 KB raw  266 KB gzipped

$ node bench/cpu.mjs 5
node v22.23.4, 5 rounds after 1 warm-up, mint https://testnut.cashu.space
mint HTTP GET /v1/keys   median 6.0 ms  min 4.5  max 8.2  (no curve math)
receive 100 sats         median 337.6 ms  min 323.8  max 380.6  (3 proofs in, 4 out)
receive 1000 sats        median 598.8 ms  min 578.7  max 752.4  (6 proofs in, 8 out)
send (refund) 1000 sats  median 416.5 ms  min 394.5  max 431.2  (8 proofs in, 12 out)
```
