#!/usr/bin/env node
// CPU time of the cashu-ts calls behind a top-up and a refund, in Node 22.
// process.cpuUsage() counts CPU only (all threads of the process), so time spent waiting on the mint is excluded.
// Uses testnut (test sats, fake Lightning). Usage: npm run bench:cpu [-- <rounds>]
import { MintQuoteState, Wallet, getEncodedToken } from "@cashu/cashu-ts";

const MINT = process.env.TESTNUT_URL ?? "https://testnut.cashu.space";
const ROUNDS = Number(process.argv[2] ?? 5);

async function cpuMs(fn) {
  const start = process.cpuUsage();
  const result = await fn();
  const used = process.cpuUsage(start);
  return [result, (used.user + used.system) / 1000];
}

const payer = new Wallet(MINT, { denominationTarget: 1 });
await payer.loadMint();

async function mintToken(amount) {
  const quote = await payer.createMintQuoteBolt11(amount);
  let state = await payer.checkMintQuoteBolt11(quote.quote);
  while (state.state === MintQuoteState.UNPAID) {
    await new Promise((r) => setTimeout(r, 400));
    state = await payer.checkMintQuoteBolt11(quote.quote);
  }
  const proofs = await payer.mintProofsBolt11(amount, quote.quote);
  return { token: getEncodedToken({ mint: MINT, proofs, unit: "sat" }), inputs: proofs.length };
}

// Same wallet settings as the library: NUT-13 deterministic outputs, minimal splits.
const receiver = new Wallet(MINT, { denominationTarget: 1, bip39seed: crypto.getRandomValues(new Uint8Array(64)) });
receiver.loadMintFromCache(payer.getMintInfo().cache, payer.keyChain.cache);
let counter = 1;

const samples = { "mint HTTP GET /v1/keys": [], "receive 100 sats": [], "receive 1000 sats": [], "send (refund) 1000 sats": [] };
const shapes = {};

// Round 0 warms up the JIT and is not counted.
for (let round = 0; round <= ROUNDS; round++) {
  // Baseline: one mint round trip with no curve math, to show what Node's HTTP client (TLS, JSON) costs on its own.
  const [, httpMs] = await cpuMs(() => payer.mint.getKeys());
  if (round > 0) samples["mint HTTP GET /v1/keys"].push(httpMs);
  shapes["mint HTTP GET /v1/keys"] = "no curve math";

  for (const amount of [100, 1000]) {
    const { token, inputs } = await mintToken(amount);
    const [proofs, ms] = await cpuMs(() => receiver.receive(token, {}, { type: "deterministic", counter }));
    counter += 64;
    if (round > 0) samples[`receive ${amount} sats`].push(ms);
    shapes[`receive ${amount} sats`] = `${inputs} proofs in, ${proofs.length} out`;

    if (amount === 1000) {
      const sendAmount = 1000 - 20;
      const [res, sendMs] = await cpuMs(() =>
        receiver.send(sendAmount, proofs, { includeFees: false }, {
          send: { type: "deterministic", counter },
          keep: { type: "deterministic", counter: counter + 32 },
        }),
      );
      counter += 64;
      if (round > 0) samples["send (refund) 1000 sats"].push(sendMs);
      shapes["send (refund) 1000 sats"] = `${proofs.length} proofs in, ${res.send.length + res.keep.length} out`;
    }
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
console.log(`node ${process.version}, ${ROUNDS} rounds after 1 warm-up, mint ${MINT}`);
for (const [op, xs] of Object.entries(samples)) {
  console.log(
    `${op.padEnd(24)} median ${median(xs).toFixed(1)} ms  min ${Math.min(...xs).toFixed(1)}  max ${Math.max(...xs).toFixed(1)}  (${shapes[op]})`,
  );
}
