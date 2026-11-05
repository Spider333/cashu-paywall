// M2 live: crash-safe token top-up and refund against testnut (T-TOP-1..3, 5, 7; T-REF-1..2; sealed proofs).
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getEncodedToken, getPubKeyFromPrivKey } from "@cashu/cashu-ts";
import { PaywallError, type EcashKey } from "../../src/index";
import { keyHash, keyRow, makePaywall } from "../helpers";
import { Faucet, claim, mintProofs, testWallet } from "./faucet";

const db = () => env.DB_TOP;
const faucet = new Faucet();
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof PaywallError ? e.code : String(e);
  }
};

beforeAll(async () => {
  await faucet.load();
});

describe("T-TOP-1 / T-TOP-2 top-up and double spend", () => {
  let token: string;
  let key: EcashKey;
  it("T-TOP-1: a 100-sat token creates a key with credit = 100 - fee", async () => {
    const pw = makePaywall(db());
    token = await faucet.token(100);
    const fee = faucet.feeFor(token);
    const r = await pw.topupWithToken(token);
    expect(r.key).toMatch(/^eck_[A-Za-z0-9_-]{43}$/);
    key = r.key!;
    expect(r.feeSats).toBeGreaterThanOrEqual(1);
    expect(r.feeSats).toBe(fee);
    expect(r.creditedSats).toBe(100 - r.feeSats);
    expect(r.balanceSats).toBe(r.creditedSats);
    const all = JSON.stringify((await db().prepare("SELECT * FROM ecash_keys").all()).results);
    expect(all).not.toContain(key);
    expect(all).toContain(await keyHash(key));
  });
  it("T-TOP-2: the same token again -> ECASH_TOKEN_SPENT, balance unchanged", async () => {
    const pw = makePaywall(db());
    const before = (await keyRow(db(), key))!.balance;
    expect(await codeOf(pw.topupWithToken(token, key))).toBe("ECASH_TOKEN_SPENT");
    expect(await codeOf(pw.topupWithToken(token))).toBe("ECASH_TOKEN_SPENT");
    expect((await keyRow(db(), key))!.balance).toBe(before);
  });
  it("a token already spent at the mint (not here) -> ECASH_TOKEN_SPENT via NUT code 11001", async () => {
    const pw = makePaywall(db());
    const t = await faucet.token(10);
    await claim(t); // someone else swaps it first
    expect(await codeOf(pw.topupWithToken(t))).toBe("ECASH_TOKEN_SPENT");
  });
});

describe("T-TOP-3 same token in parallel", () => {
  it("5 concurrent submissions -> exactly 1 success, credited once", async () => {
    const pw = makePaywall(db());
    const { key } = await pw.createKey();
    const t = await faucet.token(50);
    const codes = await Promise.all(Array.from({ length: 5 }, () => codeOf(pw.topupWithToken(t, key))));
    expect(codes.filter((c) => c === "ok").length).toBe(1);
    expect(codes.every((c) => ["ok", "ECASH_TOKEN_SPENT", "ECASH_PENDING"].includes(c))).toBe(true);
    const row = await keyRow(db(), key);
    expect(row!.balance).toBe(50 - faucet.feeFor(t));
    const ops = await db().prepare("SELECT COUNT(*) AS n FROM ecash_ops WHERE key_hash = ? AND status = 'done'").bind(await keyHash(key)).first<{ n: number }>();
    expect(ops!.n).toBe(1);
  });
});

describe("T-TOP-5 / T-TOP-7 unit and lock", () => {
  it("T-TOP-5: a testnut usd token -> ECASH_UNIT_NOT_ALLOWED", async () => {
    const usd = testWallet("usd");
    await usd.loadMint();
    const proofs = await mintProofs(usd, 5);
    const t = getEncodedToken({ mint: "https://testnut.cashu.space", proofs, unit: "usd" });
    expect(await codeOf(makePaywall(db()).topupWithToken(t))).toBe("ECASH_UNIT_NOT_ALLOWED");
  });
  it("T-TOP-7: a token P2PK-locked to a random pubkey -> ECASH_TOKEN_LOCKED, and no swap", async () => {
    const priv = crypto.getRandomValues(new Uint8Array(32));
    const pub = Array.from(getPubKeyFromPrivKey(priv), (b) => b.toString(16).padStart(2, "0")).join("");
    const t = await faucet.token(10, { p2pkPubkey: pub });
    const count = async () => (await db().prepare("SELECT COUNT(*) AS n FROM ecash_ops").first<{ n: number }>())!.n;
    const before = await count();
    expect(await codeOf(makePaywall(db()).topupWithToken(t))).toBe("ECASH_TOKEN_LOCKED");
    expect(await count()).toBe(before); // rejected before any op was written or mint call made
  });
});

describe("sealed proofs at rest", () => {
  it("no secret or C value appears in clear in ecash_proofs", async () => {
    const pw = makePaywall(db());
    const t = await faucet.token(20);
    const decoded = faucet.wallet.decodeToken(t);
    await pw.topupWithToken(t);
    const rows = (await db().prepare("SELECT * FROM ecash_proofs").all<{ sealed: string; amount: number }>()).results;
    expect(rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(rows);
    for (const p of decoded.proofs) {
      expect(dump).not.toContain(p.secret);
      expect(dump).not.toContain(p.C);
    }
    expect(dump).not.toMatch(/"secret"|"C":/);
  });
});

describe("T-REF-1 / T-REF-2 refund", () => {
  it("T-REF-1: refund of 88 sats -> token worth 88 - fee, balance 0, a second wallet receives it", async () => {
    const pw = makePaywall(db());
    const t = await faucet.token(89);
    const r = await pw.topupWithToken(t);
    expect(r.creditedSats).toBe(89 - faucet.feeFor(t));
    expect(r.creditedSats).toBe(88);
    const ref = await pw.refund(r.key!);
    expect(ref.token).toMatch(/^cashuB/);
    expect(ref.feeSats).toBeGreaterThanOrEqual(1);
    expect(ref.amountSats).toBe(88 - ref.feeSats);
    expect(faucet.wallet.decodeToken(ref.token).proofs.reduce((s, p) => s + p.amount.toNumber(), 0)).toBe(88 - ref.feeSats);
    expect((await pw.balance(r.key!)).balanceSats).toBe(0);
    const got = await claim(ref.token);
    expect(got).toBe(ref.amountSats - faucet.feeFor(ref.token));
    // The key stays valid with 0 credit, and a second refund has nothing to give.
    expect(await codeOf(pw.refund(r.key!))).toBe("ECASH_NOTHING_TO_REFUND");
  });

  it("T-REF-2: 10 parallel debits racing 1 refund -> debited + refunded + fee = start, never negative", async () => {
    const pw = makePaywall(db());
    const t = await faucet.token(100);
    const r = await pw.topupWithToken(t);
    const start = r.balanceSats;
    const [refundRes, ...debits] = await Promise.all([
      pw.refund(r.key!).then((x) => x, (e) => e as PaywallError),
      ...Array.from({ length: 10 }, () => pw.debit(r.key!, 5)),
    ]);
    const debited = debits.filter((d) => d.ok).length * 5;
    const row = await keyRow(db(), r.key!);
    expect(row!.balance).toBeGreaterThanOrEqual(0);
    if (refundRes instanceof PaywallError) {
      // The refund lost every race: then nothing was refunded and the balance holds the rest.
      expect(debited + row!.balance).toBe(start);
    } else {
      expect(debited + refundRes.amountSats + refundRes.feeSats + row!.balance).toBe(start);
    }
  });
});
