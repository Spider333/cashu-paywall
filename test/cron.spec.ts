// Cron without a mint: T-MELT-2, T-MELT-4, T-REC-4, cleanup.
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { fundedKey, makePaywall } from "./helpers";

const db = () => env.DB_REC;
const DAILY = { cron: "0 3 * * *", scheduledTime: Date.now() };

async function wipe() {
  for (const t of ["ecash_keys", "ecash_proofs", "ecash_ops", "ecash_counters", "ecash_mint_cache"])
    await db().prepare(`DELETE FROM ${t}`).run();
}

/** Fake pot rows (never opened: the melt decides to skip before touching them). */
async function fakePot(amounts: number[]) {
  let i = 0;
  for (const a of amounts) {
    await db()
      .prepare(
        "INSERT INTO ecash_proofs (y, mint_url, keyset_id, amount, sealed, created_at, updated_at) VALUES (?, 'https://testnut.cashu.space', 'k', ?, 'x', 0, 0)",
      )
      .bind(`y${i++}-${crypto.randomUUID()}`, a)
      .run();
  }
}

function capture() {
  const lines: Array<[string, string, Record<string, unknown>]> = [];
  return {
    lines,
    logger: {
      info: (e: string, f: Record<string, unknown>) => lines.push(["info", e, f]),
      warn: (e: string, f: Record<string, unknown>) => lines.push(["warn", e, f]),
      error: (e: string, f: Record<string, unknown>) => lines.push(["error", e, f]),
    },
  };
}

beforeEach(wipe);

describe("T-MELT-4 no address", () => {
  it("lightningAddress unset -> skipped 'melt disabled', invariant ok", async () => {
    await fakePot([2048, 1024]);
    const pw = makePaywall(db());
    const r = await pw.scheduled(DAILY);
    expect(r.melted).toEqual([]);
    expect(r.skipped).toEqual([{ mint: "https://testnut.cashu.space", reason: "melt disabled" }]);
    expect(r.invariantOk).toBe(true);
  });
});

describe("T-MELT-2 never melts user float", () => {
  it("pot 3,000, owed 2,800 -> skipped 'below threshold', no proofs reserved, no LNURL call", async () => {
    await fakePot([2048, 512, 256, 128, 32, 16, 8]);
    await fundedKey(db(), 2800);
    let calls = 0;
    const pw = makePaywall(db(), {
      melt: { lightningAddress: "demo@ln.example", minSats: 2000, keepSats: 500 },
      fetch: async () => {
        calls++;
        throw new Error("no network in this test");
      },
    });
    const r = await pw.scheduled(DAILY);
    expect(r.skipped).toEqual([{ mint: "https://testnut.cashu.space", reason: "below threshold" }]);
    expect(r.invariantOk).toBe(true);
    const reserved = await db()
      .prepare("SELECT COUNT(*) AS n FROM ecash_proofs WHERE state != 'unspent'")
      .first<{ n: number }>();
    expect(reserved!.n).toBe(0);
    expect(calls).toBe(0);
  });
});

describe("T-REC-4 invariant", () => {
  it("a balance corrupted upward -> invariantOk false, melts skipped, error log", async () => {
    await fakePot([2048, 1024]);
    const key = await fundedKey(db(), 100);
    await db().prepare("UPDATE ecash_keys SET balance = balance + 100000").run();
    const cap = capture();
    const pw = makePaywall(db(), { logger: cap.logger, melt: { lightningAddress: "demo@ln.example" } });
    const r = await pw.scheduled(DAILY);
    expect(r.invariantOk).toBe(false);
    expect(r.melted).toEqual([]);
    expect(r.skipped[0]!.reason).toMatch(/invariant broken/);
    expect(cap.lines.some(([lvl, ev]) => lvl === "error" && ev === "ecash_invariant_broken")).toBe(true);
    expect(key).toBeTruthy();
  });
});

describe("cleanup", () => {
  it("deletes never-funded keys older than 7 days, keeps funded and recent ones", async () => {
    const old = Date.now() - 8 * 24 * 3600 * 1000;
    const pwOld = makePaywall(db(), { now: () => old });
    const stale = await pwOld.createKey();
    const fundedOld = await fundedKey(db(), 5, { now: () => old });
    const pw = makePaywall(db());
    const fresh = await pw.createKey();
    const r = await pw.scheduled(DAILY);
    expect(r.deletedEmptyKeys).toBe(1);
    await expect(pw.balance(stale.key)).rejects.toMatchObject({ code: "ECASH_KEY_INVALID" });
    expect((await pw.balance(fresh.key)).balanceSats).toBe(0);
    expect((await pw.balance(fundedOld)).balanceSats).toBe(5);
  });
  it("the 10-minute cron runs recovery only (no melt, no cleanup)", async () => {
    const pw = makePaywall(db(), { melt: { lightningAddress: "demo@ln.example" } });
    const r = await pw.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() });
    expect(r).toEqual({ recovered: 0, melted: [], skipped: [], invariantOk: true, deletedEmptyKeys: 0 });
  });
});

describe("recovery can't be starved", () => {
  it("ops that can't finish move to the back of the queue, so the next run reaches the others", async () => {
    const old = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < 25; i++) {
      await db()
        .prepare(
          "INSERT INTO ecash_ops (op_id, kind, status, mint_url, input_id, amount, counter_start, counter_count, created_at, updated_at) VALUES (?, 'topup_lightning', 'pending', 'https://testnut.cashu.space', ?, 10, 1, 64, ?, ?)",
        )
        .bind(crypto.randomUUID(), `q${i}`, old, old + i)
        .run();
    }
    const down = makePaywall(db(), {
      fetch: async () => {
        throw new TypeError("mint down (simulated)");
      },
    });
    await down.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() });
    const untouched = await db()
      .prepare("SELECT COUNT(*) AS n FROM ecash_ops WHERE updated_at < ?")
      .bind(old + 1000)
      .first<{ n: number }>();
    expect(untouched!.n).toBe(5); // 20 attempted and moved back; the 5 behind them come first next time
    const firstNext = await db()
      .prepare("SELECT input_id FROM ecash_ops WHERE status = 'pending' ORDER BY updated_at LIMIT 1")
      .first<{ input_id: string }>();
    expect(firstNext!.input_id).toBe("q20");
  });
});
