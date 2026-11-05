// Day-1 spike inside the Workers vitest pool: cashu-ts mints and swaps against testnut from workerd.
import { describe, expect, it } from "vitest";
import { Mint, Wallet, getEncodedToken, MintQuoteState, createEphemeralCounterSource } from "@cashu/cashu-ts";
import { env } from "cloudflare:test";
import { createMintRequest } from "../../src/core/mint-request";

describe("spike: cashu-ts in workerd (vitest pool)", () => {
  it("mints, receives deterministically and D1 RETURNING works", async () => {
    const mk = (seed?: Uint8Array) =>
      new Wallet(new Mint("https://testnut.cashu.space", { customRequest: createMintRequest(fetch) }), {
        bip39seed: seed, counterSource: createEphemeralCounterSource(),
      });
    const payer = mk();
    await payer.loadMint();
    const q = await payer.createMintQuoteBolt11(50);
    let st = await payer.checkMintQuoteBolt11(q.quote);
    while (st.state === MintQuoteState.UNPAID) { await new Promise((r) => setTimeout(r, 400)); st = await payer.checkMintQuoteBolt11(q.quote); }
    const proofs = await payer.mintProofsBolt11(50, q.quote);
    const token = getEncodedToken({ mint: "https://testnut.cashu.space", proofs, unit: "sat" });
    const recv = mk(crypto.getRandomValues(new Uint8Array(64)));
    recv.loadMintFromCache(payer.getMintInfo().cache, payer.keyChain.cache);
    const t0 = performance.now();
    const got = await recv.receive(token, {}, { type: "deterministic", counter: 7 });
    const wall = performance.now() - t0;
    const total = got.reduce((s, p) => s + p.amount.toNumber(), 0);
    expect(total).toBe(50 - recv.getFeesForProofs(proofs).toNumber());
    const r = await env.DB.prepare("INSERT INTO ecash_counters (keyset_id, next) VALUES ('x', 1) ON CONFLICT(keyset_id) DO UPDATE SET next = next + 64 RETURNING next").all<{ next: number }>();
    expect(r.meta.changes).toBe(1);
    expect(r.results[0]!.next).toBe(1);
    console.log(`[spike] pool receive wall ${wall.toFixed(0)} ms for ${got.length} outputs`);
  });
});
