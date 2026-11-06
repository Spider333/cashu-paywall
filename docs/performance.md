# Performance

Two questions matter on Cloudflare Workers: how much CPU each request uses (the Free plan allows 10 ms per request, Paid allows 30 s by default), and how big the bundle is. Short answer: a paid call is cheap, a top-up or refund is not, so a Worker that takes payments needs Workers Paid. The bundle is small.

All numbers below were measured on 6 Nov 2026 on the development VM: DigitalOcean "DO-Regular", 4 vCPU, Node 22.23.4, against `testnut.cashu.space`. They are estimates from that machine, not from Cloudflare's edge.

## Where the CPU goes

| Request | Work | Mint calls |
|---|---|---|
| Paid call (bearer key) | one D1 `UPDATE … RETURNING`, one HMAC-SHA256 of the key | none |
| Token top-up, NUT-24 retry | decode, swap: blind the new outputs, then unblind and verify the mint's signatures (DLEQ) | 1 |
| Refund | swap the selected pot proofs into a token and change | 1 |
| Lightning top-up poll, once paid | mint the proofs | 1 or 2 |
| Daily melt | pre-swap, then melt | 3 or more |

The secp256k1 math in cashu-ts (`@noble/curves`, pure JavaScript) dominates every request that touches the mint. Its cost grows with the number of proofs in and out. The library uses minimal splits (`denominationTarget: 1`), which makes a few more outputs than the default and keeps every op's outputs inside its 64-counter block.

## Measurement 1: CPU in Node

`npm run bench:cpu` ([bench/cpu.mjs](../bench/cpu.mjs)) mints test tokens and times `wallet.receive` and `wallet.send` with `process.cpuUsage()`, which counts CPU only, not time waiting on the mint. One warm-up round, then 5 counted rounds:

```
$ node bench/cpu.mjs 5
node v22.23.4, 5 rounds after 1 warm-up, mint https://testnut.cashu.space
mint HTTP GET /v1/keys   median 6.0 ms  min 4.5  max 8.2  (no curve math)
receive 100 sats         median 337.6 ms  min 323.8  max 380.6  (3 proofs in, 4 out)
receive 1000 sats        median 598.8 ms  min 578.7  max 752.4  (6 proofs in, 8 out)
send (refund) 1000 sats  median 416.5 ms  min 394.5  max 431.2  (8 proofs in, 12 out)
```

The first row is a plain mint request with no curve math. It shows that Node's HTTP client accounts for about 6 ms. The rest is cashu-ts.

## Measurement 2: CPU in workerd

The first prototype ran the same calls inside a Worker under local `wrangler dev`, and estimated CPU as wall time minus the time spent waiting on `fetch`. That works locally because local workerd lets the clock run during CPU work: a busy loop of 5×10⁷ iterations reported 264 ms. Deployed Workers don't let the clock move during CPU work, so the method only works locally.

The prototype is not in the tree any more. It is at commit `b06b5ea` (`git show b06b5ea:spike/worker.ts`), and was re-run for this page. Four rounds each, default splits:

| Operation | CPU estimate (min to max) |
|---|---|
| `receive` of a 100-sat token (3 proofs in, 4 out) | 82 to 95 ms |
| `receive` of a 1,000-sat token (6 proofs in, 8 out) | 134 to 278 ms |
| `send` from the 100-sat proofs (9 outputs) | 73 to 83 ms |
| `send` from the 1,000-sat proofs (16 outputs) | 97 to 167 ms |
| `loadMintFromCache` + `getTokenMetadata` (no network) | 2 to 8 ms |
| D1 batch insert of the new proofs (wall time, local SQLite) | 15 to 37 ms, mostly I/O |

## What this means

- **Paid calls fit any plan.** One D1 statement and one HMAC per call, well under 1 ms of CPU.
- **Top-ups, refunds and melts don't fit the Free plan.** Even the lower workerd estimate (82 ms for the smallest top-up) is 8 times the Free plan's 10 ms. Use Workers Paid. Its default limit of 30 s CPU per request leaves plenty of room.
- **The two measurements disagree by a factor of 3 to 4.** Node's figure is CPU of the whole process, and workerd's is wall time minus network wait on a local runtime. We have not pinned down the difference. Cloudflare's edge CPUs are likely faster than this VM. The only number that settles it is the CPU time Cloudflare reports for a deployed Worker, which this project has not measured yet because nothing has been deployed.

## Bundle size

`npm run bench:bundle` ([bench/bundle.mjs](../bench/bundle.mjs)) bundles a minimal Worker with esbuild (minified ESM, workerd conditions):

```
$ node bench/bundle.mjs
library (createPaywall + protect)     316 KB raw   99 KB gzipped
library + cashu-paywall/mcp          1031 KB raw  266 KB gzipped
```

The second line adds the MCP adapter, `@modelcontextprotocol/sdk` and zod. Workers allow 3 MB (Free) and 10 MB (Paid) after compression, so both fit with room to spare.

## Caveats

- One VM, one day, one mint. testnut is a cdk-mintd instance with a fake Lightning backend.
- Node and local workerd are both stand-ins for Cloudflare's runtime.
- The workerd prototype used cashu-ts default splits. The library uses minimal splits, which means more outputs and slightly more CPU per swap.
- A mint with more keysets, or tokens with more proofs, cost more.
