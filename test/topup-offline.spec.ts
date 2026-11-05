// Policy checks that must reject a token BEFORE any mint call (T-TOP-4, T-TOP-6, T-TOP-8, T-REF-3, N-9).
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { Amount, getEncodedToken } from "@cashu/cashu-ts";
import { PaywallError } from "../src/index";
import { TESTNUT, fundedKey, makePaywall } from "./helpers";

const db = () => env.DB;
const KEYSET = "017bc604aaa08e9b58804bdd552286f15d75ebdaa3d1bccc2a52fc7406b4040fda"; // testnut sat keyset (shape only)
const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

/** A well-formed token with made-up proofs: decodable, never valid at a mint. */
function fakeToken(amount: number, mint = TESTNUT, unit = "sat", secret?: string): string {
  return getEncodedToken({ mint, unit, proofs: [{ id: KEYSET, amount: Amount.from(amount), secret: secret ?? hex(32), C: "02" + hex(32) }] });
}

function noMint() {
  const calls: string[] = [];
  const f: typeof fetch = async (input) => {
    calls.push(String(input instanceof Request ? input.url : input));
    throw new Error("no mint call allowed in this test");
  };
  return { calls, fetch: f };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof PaywallError ? e.code : `other: ${String(e)}`;
  }
}

describe("T-TOP-4 wrong mint", () => {
  it("a token from a mint not on the allowlist -> ECASH_MINT_NOT_ALLOWED, no mint call", async () => {
    const m = noMint();
    const pw = makePaywall(db(), { fetch: m.fetch });
    expect(await code(pw.topupWithToken(fakeToken(100, "https://fake-mint.example")))).toBe("ECASH_MINT_NOT_ALLOWED");
    expect(m.calls).toEqual([]);
  });
});

describe("T-TOP-6 caps", () => {
  it("above max top-up -> ECASH_AMOUNT_TOO_HIGH", async () => {
    const m = noMint();
    const pw = makePaywall(db(), { fetch: m.fetch, limits: { maxTopupSats: 50 } });
    expect(await code(pw.topupWithToken(fakeToken(100)))).toBe("ECASH_AMOUNT_TOO_HIGH");
    expect(m.calls).toEqual([]);
  });
  it("a top-up pushing the key over its max balance -> ECASH_BALANCE_CAP", async () => {
    const m = noMint();
    const key = await fundedKey(db(), 100);
    const pw = makePaywall(db(), { fetch: m.fetch, limits: { maxBalanceSats: 150 } });
    expect(await code(pw.topupWithToken(fakeToken(100), key))).toBe("ECASH_BALANCE_CAP");
    expect(m.calls).toEqual([]);
  });
  it("the pot at its cap -> ECASH_POT_FULL (503)", async () => {
    const m = noMint();
    const pw = makePaywall(db(), { fetch: m.fetch, limits: { maxTotalHeldSats: 50 } });
    const err = await pw.topupWithToken(fakeToken(100)).catch((e) => e as PaywallError);
    expect(err).toBeInstanceOf(PaywallError);
    expect((err as PaywallError).code).toBe("ECASH_POT_FULL");
    expect((err as PaywallError).httpStatus).toBe(503);
    expect(m.calls).toEqual([]);
  });
  it("below the min top-up -> ECASH_AMOUNT_TOO_LOW", async () => {
    const m = noMint();
    const pw = makePaywall(db(), { fetch: m.fetch, limits: { minTopupSats: 10 } });
    expect(await code(pw.topupWithToken(fakeToken(5)))).toBe("ECASH_AMOUNT_TOO_LOW");
  });
  it("a usd token -> ECASH_UNIT_NOT_ALLOWED before any mint call", async () => {
    const m = noMint();
    const pw = makePaywall(db(), { fetch: m.fetch });
    expect(await code(pw.topupWithToken(fakeToken(5, TESTNUT, "usd")))).toBe("ECASH_UNIT_NOT_ALLOWED");
    expect(m.calls).toEqual([]);
  });
  it("a P2PK-locked secret -> ECASH_TOKEN_LOCKED before any mint call", async () => {
    const m = noMint();
    const pw = makePaywall(db(), { fetch: m.fetch });
    const secret = JSON.stringify(["P2PK", { nonce: hex(16), data: "02" + hex(32), tags: [] }]);
    expect(await code(pw.topupWithToken(fakeToken(5, TESTNUT, "sat", secret)))).toBe("ECASH_TOKEN_LOCKED");
    expect(m.calls).toEqual([]);
  });
});

describe("T-TOP-8 garbage", () => {
  it("'cashuBnotatoken' and a 9,000-char string -> ECASH_TOKEN_INVALID", async () => {
    const m = noMint();
    const pw = makePaywall(db(), { fetch: m.fetch });
    expect(await code(pw.topupWithToken("cashuBnotatoken"))).toBe("ECASH_TOKEN_INVALID");
    expect(await code(pw.topupWithToken("cashuB" + "a".repeat(9_000)))).toBe("ECASH_TOKEN_INVALID");
    expect(await code(pw.topupWithToken("hello"))).toBe("ECASH_TOKEN_INVALID");
    expect(m.calls).toEqual([]);
  });
  it("N-9: a huge X-Cashu header -> 400 ECASH_TOKEN_INVALID before decoding", async () => {
    const m = noMint();
    const pw = makePaywall(db(), { fetch: m.fetch });
    const h = pw.protect(async () => new Response("served"), { priceSats: 5 });
    const res = await h(new Request("https://paywall.test/x", { headers: { "X-Cashu": "cashuB" + "x".repeat(20_000) } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("ECASH_TOKEN_INVALID");
    expect(m.calls).toEqual([]);
  });
  it("too many proofs -> ECASH_TOKEN_INVALID", async () => {
    const m = noMint();
    const pw = makePaywall(db(), { fetch: m.fetch, limits: { maxProofsPerToken: 2 } });
    const t = getEncodedToken({
      mint: TESTNUT, unit: "sat",
      proofs: [1, 2, 4].map((a) => ({ id: KEYSET, amount: Amount.from(a), secret: hex(32), C: "02" + hex(32) })),
    });
    expect(await code(pw.topupWithToken(t))).toBe("ECASH_TOKEN_INVALID");
  });
});

describe("T-REF-3 nothing to refund", () => {
  it("a key with 0 sats -> ECASH_NOTHING_TO_REFUND, no mint call", async () => {
    const m = noMint();
    const pw = makePaywall(db(), { fetch: m.fetch });
    const { key } = await pw.createKey();
    expect(await code(pw.refund(key))).toBe("ECASH_NOTHING_TO_REFUND");
    const funded0 = await fundedKey(db(), 0);
    expect(await code(pw.refund(funded0))).toBe("ECASH_NOTHING_TO_REFUND");
    expect(m.calls).toEqual([]);
  });
});

describe("config validation", () => {
  it("rejects weak or malformed secrets", () => {
    expect(() => makePaywall(db(), { keyPepper: "short" })).toThrow(/keyPepper/);
    expect(() => makePaywall(db(), { walletSeed: "abcd" })).toThrow(/walletSeed/);
    expect(() => makePaywall(db(), { proofKey: "AAAA" })).toThrow(/proofKey/);
    expect(() => makePaywall(db(), { mints: [] })).toThrow(/mint/);
    expect(() => makePaywall(db(), { mints: ["http://insecure.example"] })).toThrow(/https/);
  });
});
