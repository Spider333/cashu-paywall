// Keys, HMAC, schema, atomic debit, rate-limit hook, redaction (no mint needed).
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { MIGRATIONS_SQL, redact, normalizeMintUrl } from "../src/index";
import { fakeLimiter, fundedKey, keyHash, makePaywall } from "./helpers";

const db = () => env.DB;

describe("T-DEB-1 atomic debit", () => {
  for (let round = 1; round <= 20; round++) {
    it(`50 parallel debits on 100 sats at price 10 -> exactly 10 succeed (round ${round})`, async () => {
      const pw = makePaywall(db());
      const key = await fundedKey(db(), 100);
      const results = await Promise.all(Array.from({ length: 50 }, () => pw.debit(key, 10)));
      const ok = results.filter((r) => r.ok);
      const insufficient = results.filter((r) => !r.ok && r.error.code === "ECASH_INSUFFICIENT_BALANCE");
      expect(ok.length).toBe(10);
      expect(insufficient.length).toBe(40);
      const b = await pw.balance(key);
      expect(b.balanceSats).toBe(0);
      expect(b.calls).toBe(10);
    });
  }
});

describe("T-DEB-2 unknown / frozen key", () => {
  it("unknown well-formed key -> ECASH_KEY_INVALID", async () => {
    const pw = makePaywall(db());
    const r = await pw.debit(("eck_" + "A".repeat(43)) as `eck_${string}`, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ECASH_KEY_INVALID");
  });
  it("frozen key -> ECASH_KEY_FROZEN, balance untouched", async () => {
    const pw = makePaywall(db());
    const key = await fundedKey(db(), 50);
    await db()
      .prepare("UPDATE ecash_keys SET status = 'frozen' WHERE key_hash = ?")
      .bind(await keyHash(key))
      .run();
    const r = await pw.debit(key, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ECASH_KEY_FROZEN");
    const row = await db()
      .prepare("SELECT balance FROM ecash_keys WHERE key_hash = ?")
      .bind(await keyHash(key))
      .first<{ balance: number }>();
    expect(row!.balance).toBe(50);
  });
  it("insufficient balance carries a payment request", async () => {
    const pw = makePaywall(db());
    const key = await fundedKey(db(), 3);
    const r = await pw.debit(key, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("ECASH_INSUFFICIENT_BALANCE");
      expect(r.error.paymentRequest).toMatch(/^creqA/);
      expect(r.error.details).toMatchObject({ balance_sats: 3, price_sats: 10 });
    }
  });
});

describe("keys", () => {
  it("format, hash-only storage, kid", async () => {
    const pw = makePaywall(db());
    const { key, kid } = await pw.createKey();
    expect(key).toMatch(/^eck_[A-Za-z0-9_-]{43}$/);
    expect(key.length).toBe(47);
    expect(kid).toMatch(/^[0-9a-f]{16}$/);
    const rows = await db().prepare("SELECT * FROM ecash_keys WHERE kid = ?").bind(kid).all();
    expect(rows.results.length).toBe(1);
    expect(JSON.stringify(rows.results)).not.toContain(key);
    expect(rows.results[0]!.key_hash).toBe(await keyHash(key));
  });
  it("isEcashKey rejects malformed values", () => {
    const pw = makePaywall(db());
    for (const v of ["", "abc", "eck_short", "sk-" + "a".repeat(43), "eck_" + "a".repeat(42) + "!", null, undefined]) {
      expect(pw.isEcashKey(v as string)).toBe(false);
    }
  });
  it("malformed key: no DB read", async () => {
    let reads = 0;
    const real = db();
    const counting = new Proxy(real, {
      get: (t, p) =>
        p === "prepare"
          ? (sql: string) => {
              reads++;
              return t.prepare(sql);
            }
          : Reflect.get(t, p),
    });
    const pw = makePaywall(counting as D1Database);
    const r = await pw.debit("eck_bad" as `eck_${string}`, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ECASH_KEY_INVALID");
    expect(reads).toBe(0);
  });
});

describe("key isolation", () => {
  it("parallel calls on key A never change key B", async () => {
    const pw = makePaywall(db());
    const a = await fundedKey(db(), 100);
    const b = await fundedKey(db(), 100);
    await Promise.all(Array.from({ length: 30 }, () => pw.debit(a, 5)));
    const bb = await pw.balance(b);
    expect(bb.balanceSats).toBe(100);
    expect(bb.calls).toBe(0);
    expect((await pw.balance(a)).balanceSats).toBe(0);
  });
});

describe("credit back", () => {
  it("gives a debit back", async () => {
    const pw = makePaywall(db());
    const key = await fundedKey(db(), 20);
    await pw.debit(key, 10);
    await pw.credit(key, 10, "data_source_error");
    const b = await pw.balance(key);
    expect(b.balanceSats).toBe(20);
    expect(b.calls).toBe(0);
  });
});

describe("11.5 data and migration", () => {
  it("MIGRATIONS_SQL byte-equals migrations/0001_init.sql", () => {
    expect(MIGRATIONS_SQL).toBe(env.MIGRATION_FILE_SQL);
  });
  it("migration applied: all tables exist", async () => {
    const t = await db()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ecash_%' ORDER BY name")
      .all<{ name: string }>();
    expect(t.results.map((r) => r.name)).toEqual([
      "ecash_counters",
      "ecash_keys",
      "ecash_mint_cache",
      "ecash_ops",
      "ecash_proofs",
    ]);
  });
  it("CHECK rejects a negative balance and a unit other than sat", async () => {
    await expect(
      db().prepare("INSERT INTO ecash_keys (key_hash, kid, balance, created_at) VALUES ('neg1', 'neg1', -1, 0)").run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db().prepare("INSERT INTO ecash_keys (key_hash, kid, unit, created_at) VALUES ('usd1', 'usd1', 'usd', 0)").run(),
    ).rejects.toThrow(/CHECK/);
  });
  it("duplicate input_id rejected", async () => {
    const ins = (id: string) =>
      db()
        .prepare(
          "INSERT INTO ecash_ops (op_id, kind, status, mint_url, input_id, amount, created_at, updated_at) VALUES (?, 'topup_token', 'pending', 'm', 'dup-input', 1, 0, 0)",
        )
        .bind(id);
    await ins("op-a").run();
    await expect(ins("op-b").run()).rejects.toThrow(/UNIQUE/);
  });
  it("sql/drop-all.sql drops every ecash_* table", async () => {
    // Its own database, so the other tests keep their tables.
    const d = env.DB_REF;
    for (const s of env.ROLLBACK_SQL.split(";")
      .map((x) => x.replace(/--.*$/gm, "").trim())
      .filter(Boolean))
      await d.prepare(s).run();
    const t = await d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ecash_%'").all();
    expect(t.results.length).toBe(0);
  });
});

describe("redact", () => {
  it("masks tokens, keys, payment requests, invoices and 64-hex", () => {
    const s = [
      "cashuBo2FteBtodHRwczovL3Rlc3RudXQuY2FzaHUuc3BhY2VhdWNzYXRhdIGiYWlI",
      "cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHBzOi8vdGVzdG51dC5jYXNodS5zcGFjZSJ9XX0",
      "eck_q3J8Hn2kLmPqRsTuVwXyZaBcDeFgHiJkLmNoPqRsTu1",
      "creqApWF0gaNhdGVub3N0cmFheKlucHJvZmlsZTFxeTI4d3VtbjhnaGo3dW45ZDNzaGp0",
      "CREQB1QYQQWER9D4HNZQ4XEMMNZAQE9XVZ6GDQAFUSE3XVDQ",
      "lnbc1u1p4w6phedqqpp543gzhltrv66usa7usgkg2294rq6hva3ymzdth235lfw5fxlmkk9q",
      "a".repeat(64),
      "0123456789abcdef".repeat(8),
    ];
    const out = redact(s.join(" | "));
    for (const x of s) expect(out).not.toContain(x);
    expect(out).toContain("[redacted]");
    expect(redact("kid 3f9a0123456789ab op 9e4f")).toBe("kid 3f9a0123456789ab op 9e4f");
  });
});

describe("T-RL-1 rate limits", () => {
  it("11th top-up in a minute from one IP -> 429", async () => {
    const pw = makePaywall(db(), { rateLimiter: fakeLimiter(10) });
    const req = () =>
      new Request("https://paywall.test/ecash/topup", {
        method: "POST",
        headers: { "CF-Connecting-IP": "203.0.113.7", "X-Cashu": "cashuBnotatoken" },
      });
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await pw.handleRoutes(req()))!.status);
    expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true); // garbage token, but each attempt counts
    expect(codes[10]).toBe(429);
    const last = await pw.handleRoutes(req());
    expect(last!.headers.get("Retry-After")).toBe("60");
    expect(((await last!.json()) as { code: string }).code).toBe("ECASH_RATE_LIMITED");
  });
});

describe("mint URL normalisation", () => {
  it("trailing slash and uppercase host match the allowlist", () => {
    expect(normalizeMintUrl("https://TestNut.Cashu.Space/")).toBe("https://testnut.cashu.space");
    const pw = makePaywall(db(), { mints: ["https://TESTNUT.cashu.space/"] });
    expect(pw.mints).toEqual(["https://testnut.cashu.space"]);
  });
});
