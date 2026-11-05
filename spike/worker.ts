// Day-1 spike (PRD risk 4): does cashu-ts 4.13.0 run inside workerd, and what does the top-up path cost?
// GET /spike  -> mint (testnut auto-pays) -> receive (deterministic, NUT-13) -> send -> melt -> restore, plus D1 RETURNING.
import {
  Wallet, Mint, getEncodedToken, getTokenMetadata, MintQuoteState, createEphemeralCounterSource, isMintOperationError,
} from "@cashu/cashu-ts";
import { createMintRequest } from "../src/core/mint-request";

interface Env { DB: D1Database }

const MINT = "https://testnut.cashu.space";

async function timed<T>(name: string, out: Record<string, number>, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  out[name] = Math.round((performance.now() - t0) * 10) / 10;
  return r;
}

let netMs = 0; // time spent waiting on the mint's network, so CPU ~= wall - net
const countingFetch: typeof fetch = async (input, init) => {
  const t0 = performance.now();
  try { return await fetch(input, init); } finally { netMs += performance.now() - t0; }
};

function newWallet(seed?: Uint8Array) {
  const mint = new Mint(MINT, { customRequest: createMintRequest(countingFetch) });
  return new Wallet(mint, { unit: "sat", bip39seed: seed, counterSource: createEphemeralCounterSource() });
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/clock") {
      // Does the clock advance during pure CPU work in this runtime? (In production it only moves on I/O.)
      const t0 = performance.now();
      let x = 0;
      for (let i = 0; i < 5e7; i++) x = (x + i) % 1000003;
      return Response.json({ cpuLoopMs: performance.now() - t0, x });
    }
    if (url.pathname === "/d1") {
      await env.DB.exec("CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, b INTEGER NOT NULL CHECK (b >= 0))");
      await env.DB.prepare("INSERT OR REPLACE INTO t (k, b) VALUES ('a', 100)").run();
      const ms: Record<string, number> = {};
      const r = await timed("debit", ms, () =>
        env.DB.prepare("UPDATE t SET b = b - ?1 WHERE k = 'a' AND b >= ?1 RETURNING b").bind(10).all<{ b: number }>());
      const none = await env.DB.prepare("UPDATE t SET b = b - ?1 WHERE k = 'a' AND b >= ?1 RETURNING b").bind(1000).all();
      return Response.json({ returning: r.results, changes: r.meta.changes, noneChanges: none.meta.changes, noneRows: none.results.length, ms });
    }
    if (url.pathname === "/cpu") {
      // Top-up path CPU: wall time of receive() minus time awaiting the mint. Several rounds (warm isolate).
      const payer = newWallet();
      await payer.loadMint();
      const seed = crypto.getRandomValues(new Uint8Array(64));
      const rounds: Array<Record<string, number>> = [];
      const amount = Number(url.searchParams.get("amount") ?? 100);
      for (let i = 0; i < 4; i++) {
        const q = await payer.createMintQuoteBolt11(amount);
        let st = await payer.checkMintQuoteBolt11(q.quote);
        while (st.state === MintQuoteState.UNPAID) { await new Promise((r) => setTimeout(r, 400)); st = await payer.checkMintQuoteBolt11(q.quote); }
        const proofs = await payer.mintProofsBolt11(amount, q.quote);
        const token = getEncodedToken({ mint: MINT, proofs, unit: "sat" });
        const w = newWallet(seed);
        const tc = performance.now(); netMs = 0;
        w.loadMintFromCache(payer.getMintInfo().cache, payer.keyChain.cache);
        const meta = getTokenMetadata(token);
        const cacheAndDecode = performance.now() - tc;
        const t0 = performance.now(); netMs = 0;
        const got = await w.receive(token, { keysetId: w.keysetId }, { type: "deterministic", counter: 100 * (i + 1) });
        const wall = performance.now() - t0; const net = netMs;
        const t1 = performance.now(); netMs = 0;
        const sent = await w.send(Math.floor(amount / 2), got, { includeFees: false }, { send: { type: "deterministic", counter: 5000 + 100 * i }, keep: { type: "deterministic", counter: 9000 + 100 * i } });
        const swall = performance.now() - t1; const snet = netMs;
        const td = performance.now();
        await env.DB.exec("CREATE TABLE IF NOT EXISTS p (y TEXT PRIMARY KEY, sealed TEXT NOT NULL)");
        const tdw = performance.now();
        await env.DB.batch(got.map((p) => env.DB.prepare("INSERT OR REPLACE INTO p (y, sealed) VALUES (?, ?)").bind(p.secret, p.C)));
        const d1 = performance.now() - tdw;
        rounds.push({ proofsIn: proofs.length, outputs: got.length, tokenAmount: Number(meta.amount.toNumber()),
          cacheAndDecodeMs: r1(cacheAndDecode), receiveWallMs: r1(wall), receiveNetMs: r1(net), receiveCpuMs: r1(wall - net),
          sendWallMs: r1(swall), sendNetMs: r1(snet), sendCpuMs: r1(swall - snet), d1BatchWallMs: r1(d1), sentOutputs: sent.send.length + sent.keep.length,
          tableMs: r1(tdw - td) });
      }
      return Response.json({ rounds });
    }
    if (url.pathname !== "/spike") return new Response("not found", { status: 404 });

    const ms: Record<string, number> = {};
    const notes: Record<string, unknown> = {};
    const payer = newWallet();
    await timed("payer.loadMint", ms, () => payer.loadMint());
    const q = await timed("createMintQuote", ms, () => payer.createMintQuoteBolt11(100));
    let qs = await timed("checkMintQuote", ms, () => payer.checkMintQuoteBolt11(q.quote));
    const tPaid = Date.now();
    while (qs.state === MintQuoteState.UNPAID && Date.now() - tPaid < 20_000) {
      await new Promise((r) => setTimeout(r, 500));
      qs = await payer.checkMintQuoteBolt11(q.quote);
    }
    notes.paidAfterMs = Date.now() - tPaid;
    notes.quoteState = qs.state;
    if (qs.state !== MintQuoteState.PAID) return Response.json({ error: "quote not paid", qs }, { status: 500 });
    const minted = await timed("mintProofs", ms, () => payer.mintProofsBolt11(100, q.quote));
    const token = getEncodedToken({ mint: MINT, proofs: minted, unit: "sat" });
    const meta = getTokenMetadata(token);
    notes.tokenAmount = meta.amount.toString();
    notes.tokenProofs = minted.length;

    // The receiver: a deterministic wallet (NUT-13), as the paywall will run it.
    const seed = crypto.getRandomValues(new Uint8Array(64));
    const recv = newWallet(seed);
    await timed("recv.loadMint", ms, () => recv.loadMint());
    const cache = recv.keyChain.cache;
    const info = recv.getMintInfo().cache;
    // Rebuild from cache, as the paywall will on every request (no network).
    const recv2 = newWallet(seed);
    await timed("recv.loadMintFromCache", ms, async () => recv2.loadMintFromCache(info, cache));
    const fee = recv2.getFeesForProofs(minted).toNumber();
    const got = await timed("receive(swap)", ms, () =>
      recv2.receive(token, { keysetId: recv2.keysetId }, { type: "deterministic", counter: 1000 }));
    notes.received = got.reduce((s, p) => s + p.amount.toNumber(), 0);
    notes.receiveFee = fee;
    notes.receivedOutputs = got.length;

    // Same token again -> the mint's "already spent" code.
    try {
      await recv2.receive(token);
      notes.doubleSpend = "accepted?!";
    } catch (e) {
      notes.doubleSpend = isMintOperationError(e) ? { code: e.code, status: e.status } : String(e);
    }

    // Restore (NUT-09) the outputs we just made: crash recovery path.
    const restored = await timed("restore(1000,64)", ms, () => recv2.restore(1000, 64));
    notes.restored = restored.proofs.length;

    // Send (refund path).
    const sent = await timed("send(50)", ms, () =>
      recv2.send(50, got, { includeFees: false }, { send: { type: "deterministic", counter: 2000 }, keep: { type: "deterministic", counter: 2100 } }));
    notes.send = { send: sent.send.length, keep: sent.keep.length };

    // Melt: pay a testnut invoice from the keep proofs.
    const inv = await recv2.createMintQuoteBolt11(10);
    const mq = await timed("createMeltQuote", ms, () => recv2.createMeltQuoteBolt11(inv.request));
    notes.meltQuote = { amount: mq.amount.toNumber(), fee_reserve: mq.fee_reserve.toNumber() };
    const melt = await timed("meltProofs", ms, () => recv2.meltProofsBolt11(mq, sent.keep, {}, { type: "deterministic", counter: 3000 }));
    notes.melt = { state: melt.quote.state, change: melt.change.length, preimage: Boolean(melt.quote.payment_preimage) };

    // States of the spent inputs (NUT-07).
    const states = await timed("checkProofsStates", ms, () => recv2.checkProofsStates(minted));
    notes.inputStates = [...new Set(states.map((s) => s.state))];
    return Response.json({ ok: true, ms, notes });
  },
};
