// Cross-check of the workerd numbers: CPU time (process.cpuUsage, excludes network waits) per wallet call in Node 22.
import { Wallet, getEncodedToken, MintQuoteState } from "@cashu/cashu-ts";
const MINT = "https://testnut.cashu.space";
const cpu = async (fn) => { const c0 = process.cpuUsage(); const r = await fn(); const c = process.cpuUsage(c0); return [r, (c.user + c.system) / 1000]; };
const payer = new Wallet(MINT); await payer.loadMint();
const seed = crypto.getRandomValues(new Uint8Array(64));
for (const det of [true, false]) for (let i = 0; i < 3; i++) {
  const q = await payer.createMintQuoteBolt11(100);
  let st = await payer.checkMintQuoteBolt11(q.quote);
  while (st.state === MintQuoteState.UNPAID) { await new Promise(r => setTimeout(r, 400)); st = await payer.checkMintQuoteBolt11(q.quote); }
  const proofs = await payer.mintProofsBolt11(100, q.quote);
  const token = getEncodedToken({ mint: MINT, proofs, unit: "sat" });
  const w = new Wallet(MINT, det ? { bip39seed: seed } : {});
  w.loadMintFromCache(payer.getMintInfo().cache, payer.keyChain.cache);
  const [got, ms] = await cpu(() => w.receive(token, {}, det ? { type: "deterministic", counter: 100 * (i + 1) + (det ? 0 : 5000) } : undefined));
  console.log(JSON.stringify({ deterministic: det, round: i, outputs: got.length, receiveCpuMs: ms.toFixed(1) }));
}
