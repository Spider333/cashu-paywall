// Regression tests for the code-review findings (5 Nov 2026): unused send inputs, double give-back, the PENDING key.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { CheckStateEnum } from "@cashu/cashu-ts";
import { PaywallError } from "../../src/index";
import { keyRow, makePaywall, openRows } from "../helpers";
import { Faucet, claim, potMatchesMint } from "./faucet";

const faucet = new Faucet();
const db = () => env.DB_REF;
const LATER = () => Date.now() + 16 * 60 * 1000;
beforeAll(async () => {
  await faucet.load();
  // DB_REF's tables were dropped by the rollback test in another run; recreate them if needed.
  const t = await db().prepare("SELECT name FROM sqlite_master WHERE name = 'ecash_keys'").first();
  if (!t) for (const m of env.TEST_MIGRATIONS) for (const q of m.queries) await db().prepare(q).run();
});
beforeEach(async () => {
  for (const t of ["ecash_keys", "ecash_proofs", "ecash_ops", "ecash_mint_cache"])
    await db().prepare(`DELETE FROM ${t}`).run();
});

describe("review #1: inputs the wallet didn't use come back to the pot", () => {
  it("a refund that sends a subset of the reserved proofs keeps the rest unspent, and D1 matches the mint", async () => {
    const pw = makePaywall(db());
    const t = await faucet.token(25); // 25 - 1 fee = 24 = 16 + 8
    const top = await pw.topupWithToken(t);
    expect(top.balanceSats).toBe(24);
    expect((await pw.debit(top.key!, 7)).ok).toBe(true); // B = 17: picks 16 + 8, sends 16 (exact)
    const ref = await pw.refund(top.key!);
    expect(ref.amountSats).toBe(17 - ref.feeSats);
    const pot = await potMatchesMint(db(), openRows);
    // Everything we hold is still unspent at the mint, and nothing vanished: pot = 24 - sent - fee paid at the mint.
    expect(pot).toBe(24 - ref.amountSats - ref.feeSats);
    const held = await db()
      .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM ecash_proofs WHERE state = 'unspent'")
      .first<{ s: number }>();
    expect(held!.s).toBe(pot);
    expect(await claim(ref.token)).toBeGreaterThan(0);
  });
});

describe("review #2: overlapping recovery runs give a refund back once", () => {
  it("the 03:00 daily cron and the */10 cron recover the same crashed refund: balance back exactly once", async () => {
    const pw = makePaywall(db());
    const top = await pw.topupWithToken(await faucet.token(89)); // 88
    expect((await pw.debit(top.key!, 10)).ok).toBe(true);
    const crash = makePaywall(db(), {
      testHooks: {
        afterSwap: () => {
          throw new Error("simulated crash");
        },
      },
    });
    await expect(crash.refund(top.key!)).rejects.toThrow(/simulated crash/);
    const later = makePaywall(db(), { now: LATER });
    const [a, b] = await Promise.all([
      later.scheduled({ cron: "0 3 * * *", scheduledTime: Date.now() }),
      later.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }),
    ]);
    expect(a.recovered + b.recovered).toBeGreaterThanOrEqual(1);
    expect((await keyRow(db(), top.key!))!.balance).toBe(78);
    const pot = await potMatchesMint(db(), openRows);
    expect(pot).toBeGreaterThanOrEqual(78);
    expect(a.invariantOk && b.invariantOk).toBe(true);
  });
});

describe("review #3: a key created by a PENDING top-up is handed back", () => {
  it("swap times out on a new key -> 503 PENDING carries X-Ecash-Key; recovery credits that key", async () => {
    const flaky: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const res = await fetch(input, init); // the swap DOES reach the mint...
      if (url.endsWith("/v1/swap")) throw new TypeError("connection reset after send (simulated)"); // ...but the answer is lost
      return res;
    };
    // Warm the D1 mint cache with a normal top-up, so the only mint call the flaky fetch sees is the swap.
    await makePaywall(db()).topupWithToken(await faucet.token(5));
    const pw = makePaywall(db(), { fetch: flaky });
    const t = await faucet.token(30);
    const res = await pw.protect(async () => new Response("ok"), { priceSats: 5 })(
      new Request("https://paywall.test/x", { headers: { "X-Cashu": t } }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, string>;
    expect(body.code).toBe("ECASH_PENDING");
    const key = res.headers.get("X-Ecash-Key")!;
    expect(key).toMatch(/^eck_/);
    expect(body.key).toBe(key);
    // The token really was swapped: the payer can't spend it again...
    const states = await faucet.wallet.checkProofsStates(faucet.wallet.decodeToken(t).proofs);
    expect(states.every((s) => s.state === CheckStateEnum.SPENT)).toBe(true);
    // ...and recovery puts the credit on the key the caller was given.
    const r = await makePaywall(db(), { now: LATER }).scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() });
    expect(r.recovered).toBe(1);
    expect((await pw.balance(key as `eck_${string}`)).balanceSats).toBe(30 - faucet.feeFor(t));
    expect(PaywallError).toBeTruthy();
  });
});
