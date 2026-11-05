// Cron live against testnut: T-MELT-1, T-MELT-3, T-REC-1..3.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { CheckStateEnum, MintQuoteState } from "@cashu/cashu-ts";
import { PaywallError, type PaywallConfig } from "../../src/index";
import { keyRow, makePaywall } from "../helpers";
import { Faucet, claim, testWallet } from "./faucet";

const faucet = new Faucet();
const DAILY = { cron: "0 3 * * *", scheduledTime: Date.now() };
const LATER = () => Date.now() + 16 * 60 * 1000; // past the 15-minute recovery threshold

beforeAll(async () => {
  await faucet.load();
});

async function wipe(db: D1Database) {
  for (const t of ["ecash_keys", "ecash_proofs", "ecash_ops", "ecash_mint_cache"]) await db.prepare(`DELETE FROM ${t}`).run();
}

/** LNURL-pay stub for demo@ln.example: invoices come from fresh testnut mint quotes (so testnut settles internally). */
function lnurlStub(opts: { skew?: number } = {}) {
  const issuer = testWallet();
  const quotes: string[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host === "ln.example") {
      if (url.pathname === "/.well-known/lnurlp/demo") {
        return Response.json({ tag: "payRequest", callback: "https://ln.example/cb", minSendable: 1000, maxSendable: 100_000_000, metadata: "[]" });
      }
      if (url.pathname === "/cb") {
        await issuer.loadMint();
        const sats = Number(url.searchParams.get("amount")) / 1000 + (opts.skew ?? 0);
        const q = await issuer.createMintQuoteBolt11(sats);
        quotes.push(q.quote);
        return Response.json({ pr: q.request, routes: [] });
      }
      return new Response("not found", { status: 404 });
    }
    return fetch(input, init);
  };
  return { fetch: f, quotes, issuer };
}

function capture() {
  const lines: Array<[string, string, Record<string, unknown>]> = [];
  const push = (l: string) => (e: string, f: Record<string, unknown>) => lines.push([l, e, f]);
  return { lines, logger: { info: push("info"), warn: push("warn"), error: push("error") } };
}

describe("melt", () => {
  const db = () => env.DB_MELT;
  beforeEach(() => wipe(db()));

  /** A pot of ~3,000 sats that is all revenue: top up 3,000 + fee, then spend it all. */
  async function potOf3000(o: Partial<PaywallConfig>) {
    const pw = makePaywall(db(), o);
    const t = await faucet.token(3002);
    const r = await pw.topupWithToken(t);
    expect(r.balanceSats).toBe(3002 - faucet.feeFor(t));
    expect((await pw.debit(r.key!, r.balanceSats - 3000 > 0 ? r.balanceSats - 3000 : 1)).ok).toBe(true);
    return { pw, key: r.key!, left: (await pw.balance(r.key!)).balanceSats, pot: r.creditedSats };
  }

  it("T-MELT-1: pot 3,000, owed 0, keep 500, min 2,000 -> melts <= 2,500 and pays the invoice", async () => {
    const stub = lnurlStub();
    const { pw, key, left, pot } = await potOf3000({ fetch: stub.fetch, melt: { lightningAddress: "demo@ln.example", minSats: 2000, keepSats: 500 } });
    expect((await pw.debit(key, left)).ok).toBe(true);
    const r = await pw.scheduled(DAILY);
    expect(r.invariantOk).toBe(true);
    expect(r.skipped).toEqual([]);
    expect(r.melted.length).toBe(1);
    expect(r.melted[0]!.amountSats).toBeLessThanOrEqual(2500);
    expect(r.melted[0]!.amountSats).toBeGreaterThanOrEqual(2000);
    const op = await db().prepare("SELECT * FROM ecash_ops WHERE op_id = ?").bind(r.melted[0]!.opId).first<{ status: string; detail: string; kind: string }>();
    expect(op!.kind).toBe("melt");
    expect(op!.status).toBe("done");
    const detail = JSON.parse(op!.detail);
    expect("preimage" in detail).toBe(true); // stored when the mint returns one (testnut's fake wallet may return null)
    // The target invoice's testnut mint quote turned PAID (internal settlement).
    await stub.issuer.loadMint();
    const q = await stub.issuer.checkMintQuoteBolt11(stub.quotes.at(-1)!);
    expect([MintQuoteState.PAID, MintQuoteState.ISSUED]).toContain(q.state);
    // What is left in the pot still covers what is owed (0) and is above the keep buffer minus fees.
    const held = await db().prepare("SELECT COALESCE(SUM(amount),0) AS s FROM ecash_proofs WHERE state = 'unspent'").first<{ s: number }>();
    expect(held!.s).toBeGreaterThan(0);
    expect(held!.s).toBeLessThanOrEqual(1000);
    // Review #1: nothing vanished. D1's pot matches the mint and equals pot before - melted - fees.
    const { potMatchesMint } = await import("./faucet");
    const { openRows } = await import("../helpers");
    expect(await potMatchesMint(db(), openRows)).toBe(held!.s);
    expect(held!.s).toBe(pot - r.melted[0]!.amountSats - r.melted[0]!.feeSats);
    console.log(`[T-MELT-1] melted ${r.melted[0]!.amountSats} sats, fee ${r.melted[0]!.feeSats}, left ${held!.s}, preimage ${detail.preimage === null ? "null (testnut)" : "present"}`);
  });

  it("T-MELT-3: the LNURL server returns an invoice for a different amount -> aborted, logged, no melt", async () => {
    const stub = lnurlStub({ skew: 1 });
    const cap = capture();
    const { pw, key, left } = await potOf3000({ fetch: stub.fetch, logger: cap.logger, melt: { lightningAddress: "demo@ln.example", minSats: 2000, keepSats: 500 } });
    expect((await pw.debit(key, left)).ok).toBe(true);
    const r = await pw.scheduled(DAILY);
    expect(r.melted).toEqual([]);
    expect(r.skipped).toEqual([{ mint: "https://testnut.cashu.space", reason: "invoice_amount_mismatch" }]);
    expect(cap.lines.some(([l, e, f]) => l === "error" && e === "ecash_melt_aborted" && f.reason === "invoice_amount_mismatch")).toBe(true);
    const ops = await db().prepare("SELECT COUNT(*) AS n FROM ecash_ops WHERE kind = 'melt'").first<{ n: number }>();
    expect(ops!.n).toBe(0);
    const reserved = await db().prepare("SELECT COUNT(*) AS n FROM ecash_proofs WHERE state != 'unspent'").first<{ n: number }>();
    expect(reserved!.n).toBe(0);
  });
});

describe("recovery", () => {
  const db = () => env.DB_REC;
  beforeEach(() => wipe(db()));
  const crash = () => {
    throw new Error("simulated crash");
  };

  it("T-REC-1: crash between swap and credit -> op pending; recovery credits once via NUT-09 restore", async () => {
    const pwCrash = makePaywall(db(), { testHooks: { afterSwap: crash } });
    const { key } = await pwCrash.createKey();
    const t = await faucet.token(50);
    const fee = faucet.feeFor(t);
    await expect(pwCrash.topupWithToken(t, key)).rejects.toThrow(/simulated crash/);
    const op = await db().prepare("SELECT status FROM ecash_ops WHERE kind = 'topup_token'").first<{ status: string }>();
    expect(op!.status).toBe("pending");
    expect((await keyRow(db(), key))!.balance).toBe(0);
    // Not yet 15 minutes: recovery leaves it alone.
    expect((await makePaywall(db()).scheduled(DAILY)).recovered).toBe(0);
    const later = makePaywall(db(), { now: LATER });
    const r = await later.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() });
    expect(r.recovered).toBe(1);
    expect(r.invariantOk).toBe(true);
    expect((await keyRow(db(), key))!.balance).toBe(50 - fee);
    const pot = await db().prepare("SELECT COALESCE(SUM(amount),0) AS s FROM ecash_proofs WHERE state = 'unspent'").first<{ s: number }>();
    expect(pot!.s).toBe(50 - fee);
    // A second run doesn't credit again.
    expect((await later.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() })).recovered).toBe(0);
    expect((await keyRow(db(), key))!.balance).toBe(50 - fee);
    // And the credited proofs are real: the key can refund them.
    const ref = await later.refund(key);
    expect(await claim(ref.token)).toBeGreaterThan(0);
  });

  it("T-REC-2: crash before the swap -> recovery marks the op failed; the token is still its owner's", async () => {
    const pwCrash = makePaywall(db(), { testHooks: { beforeSwap: crash } });
    const t = await faucet.token(20);
    await expect(pwCrash.topupWithToken(t)).rejects.toThrow(/simulated crash/);
    const later = makePaywall(db(), { now: LATER });
    expect((await later.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() })).recovered).toBe(1);
    const op = await db().prepare("SELECT status, input_id FROM ecash_ops WHERE kind = 'topup_token'").first<{ status: string; input_id: string | null }>();
    expect(op!.status).toBe("failed");
    expect(op!.input_id).toBeNull(); // the owner may submit it again
    const states = await faucet.wallet.checkProofsStates(faucet.wallet.decodeToken(t).proofs);
    expect(states.every((s) => s.state === CheckStateEnum.UNSPENT)).toBe(true);
    expect(await claim(t)).toBe(20 - faucet.feeFor(t));
  });

  it("T-REC-3: crash after the refund swap -> balance back on the key, restored proofs back in the pot", async () => {
    const pw = makePaywall(db());
    const top = await pw.topupWithToken(await faucet.token(89)); // 88 credit
    expect((await pw.debit(top.key!, 10)).ok).toBe(true); // 10 sats revenue as a fee buffer
    const B = 78;
    const pwCrash = makePaywall(db(), { testHooks: { afterSwap: crash } });
    await expect(pwCrash.refund(top.key!)).rejects.toThrow(/simulated crash/);
    expect((await keyRow(db(), top.key!))!.balance).toBe(0);
    const op = await db().prepare("SELECT status FROM ecash_ops WHERE kind = 'refund'").first<{ status: string }>();
    expect(op!.status).toBe("pending");
    const later = makePaywall(db(), { now: LATER });
    const r = await later.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() });
    expect(r.recovered).toBe(1);
    expect(r.invariantOk).toBe(true);
    expect((await keyRow(db(), top.key!))!.balance).toBe(B);
    const pot = await db().prepare("SELECT COALESCE(SUM(amount),0) AS s FROM ecash_proofs WHERE state = 'unspent'").first<{ s: number }>();
    expect(pot!.s).toBeGreaterThanOrEqual(B); // 88 in, minus the refund swap's fee
    expect(pot!.s).toBeLessThan(88);
    // The user can refund again, for real this time.
    const ref = await later.refund(top.key!);
    expect(ref.amountSats).toBe(B - ref.feeSats);
    expect(await claim(ref.token)).toBeGreaterThan(0);
  });

  it("T-CTR-1: NUT-13 counters gone backwards (D1 restored from a backup) -> skip ahead and retry, no money lost", async () => {
    const pw = makePaywall(db());
    const a = await pw.topupWithToken(await faucet.token(20));
    await db().prepare("UPDATE ecash_counters SET next = 1").run(); // simulate the restore
    const cap = capture();
    const pw2 = makePaywall(db(), { logger: cap.logger });
    const t = await faucet.token(20);
    const b = await pw2.topupWithToken(t, a.key);
    expect(b.creditedSats).toBe(20 - faucet.feeFor(t));
    expect(cap.lines.some(([l, e]) => l === "warn" && e === "ecash_counter_reused")).toBe(true);
    const ref = await pw2.refund(a.key!);
    expect(await claim(ref.token)).toBeGreaterThan(0);
  });

  it("a pending op whose mint is unreachable stays pending (retried next run)", async () => {
    const pwCrash = makePaywall(db(), { testHooks: { beforeSwap: crash } });
    await expect(pwCrash.topupWithToken(await faucet.token(5))).rejects.toThrow();
    const down = makePaywall(db(), { now: LATER, fetch: async () => { throw new TypeError("down"); } });
    await db().prepare("DELETE FROM ecash_mint_cache").run();
    expect((await down.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() })).recovered).toBe(0);
    const op = await db().prepare("SELECT status FROM ecash_ops WHERE kind = 'topup_token'").first<{ status: string }>();
    expect(op!.status).toBe("pending");
    expect(PaywallError).toBeTruthy();
  });
});
