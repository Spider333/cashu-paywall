import { createPaywall, type PaywallConfig, type EcashKey } from "../src/index";
import { hashKey } from "../src/core/keys";

export const TESTNUT = "https://testnut.cashu.space";

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (n: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n))));

/** Fresh random pepper, proof key and seed per test run: nothing sensitive is checked in. */
export const TEST_CFG = { keyPepper: hex(32), proofKey: b64(32), walletSeed: hex(64) };

export type Overrides = Partial<PaywallConfig>;

export const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * One NUT-13 seed per database: a seed's counters live in that database, so two databases sharing a seed would derive
 * the same outputs (the library recovers from that, see T-CTR-1, but tests should not depend on it).
 */
const seeds = new Map<D1Database, string>();
function seedFor(db: D1Database): string {
  let s = seeds.get(db);
  if (!s) seeds.set(db, (s = hex(64)));
  return s;
}

export function makePaywall(db: D1Database, o: Overrides = {}) {
  return createPaywall({
    db, keyPepper: TEST_CFG.keyPepper, proofKey: TEST_CFG.proofKey, walletSeed: seedFor(db),
    mints: [TESTNUT], publicBaseUrl: "https://paywall.test", priceSats: 10, logger: quietLogger,
    ...o,
  });
}

export async function keyHash(key: EcashKey): Promise<string> {
  return (await hashKey(TEST_CFG.keyPepper, key)).keyHash;
}

/** A key with `balance` sats bound to testnut, set directly in D1 (for debit tests that need no mint). */
export async function fundedKey(db: D1Database, balance: number, o: Overrides = {}): Promise<EcashKey> {
  const pw = makePaywall(db, o);
  const { key } = await pw.createKey();
  await db.prepare("UPDATE ecash_keys SET balance = ?, credited_total = ?, mint_url = ? WHERE key_hash = ?")
    .bind(balance, balance, TESTNUT, await keyHash(key)).run();
  return key;
}

/** A fake Cloudflare-style rate limiter: `limit` hits per key per window. */
export function fakeLimiter(limit: number) {
  const hits = new Map<string, number>();
  return {
    limit: async ({ key }: { key: string }) => {
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return { success: n <= limit };
    },
  };
}

export async function keyRow(db: D1Database, key: EcashKey) {
  return db.prepare("SELECT * FROM ecash_keys WHERE key_hash = ?").bind(await keyHash(key)).first<{ balance: number; calls: number; mint_url: string | null }>();
}
