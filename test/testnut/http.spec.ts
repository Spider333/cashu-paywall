// NUT-24 and Lightning live against testnut: T-402-3, T-402-5, T-402-6, T-LN-1, T-LN-2, E-3.
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getEncodedToken, getPubKeyFromPrivKey } from "@cashu/cashu-ts";
import { makePaywall, keyRow } from "../helpers";
import { Faucet, claim, mintProofs, testWallet } from "./faucet";

const db = () => env.DB_LN;
const faucet = new Faucet();
beforeAll(async () => {
  await faucet.load();
});
const fortune = async () => Response.json({ fortune: "Don't trust, verify." });
const req = (headers: Record<string, string>) => new Request("https://paywall.test/fortune", { headers });

describe("T-402-3 retry with a token", () => {
  it("X-Cashu with an 8-sat token -> 200, X-Ecash-Key, X-Ecash-Balance = 8 - fee - 5", async () => {
    const pw = makePaywall(db());
    const t = await faucet.token(8);
    const fee = faucet.feeFor(t);
    const res = await pw.protect(fortune, { priceSats: 5 })(req({ "X-Cashu": t }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fortune: "Don't trust, verify." });
    expect(res.headers.get("X-Ecash-Key")).toMatch(/^eck_/);
    expect(Number(res.headers.get("X-Ecash-Balance"))).toBe(8 - fee - 5);
    expect(res.headers.get("X-Ecash-Kid")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("T-402-5 400 cases", () => {
  it("wrong mint, usd unit, 3-sat token, locked token -> 400 each with the matching code", async () => {
    const pw = makePaywall(db());
    const h = pw.protect(fortune, { priceSats: 5 });
    const codeOf = async (r: Response) => [r.status, ((await r.json()) as { code: string }).code];

    // Wrong mint: a real testnut token re-labelled with another mint URL never reaches any mint.
    const real = faucet.wallet.decodeToken(await faucet.token(10));
    const wrongMint = getEncodedToken({ mint: "https://other-mint.example", proofs: real.proofs, unit: "sat" });
    expect(await codeOf(await h(req({ "X-Cashu": wrongMint })))).toEqual([400, "ECASH_MINT_NOT_ALLOWED"]);

    const usd = testWallet("usd");
    await usd.loadMint();
    const usdToken = getEncodedToken({ mint: "https://testnut.cashu.space", proofs: await mintProofs(usd, 10), unit: "usd" });
    expect(await codeOf(await h(req({ "X-Cashu": usdToken })))).toEqual([400, "ECASH_UNIT_NOT_ALLOWED"]);

    const small = await faucet.token(3);
    expect(await codeOf(await h(req({ "X-Cashu": small })))).toEqual([400, "ECASH_AMOUNT_TOO_LOW"]);
    expect(await claim(small)).toBeGreaterThan(0); // the 3-sat token was NOT taken

    const pub = Array.from(getPubKeyFromPrivKey(crypto.getRandomValues(new Uint8Array(32))), (b) => b.toString(16).padStart(2, "0")).join("");
    const locked = await faucet.token(10, { p2pkPubkey: pub });
    expect(await codeOf(await h(req({ "X-Cashu": locked })))).toEqual([400, "ECASH_TOKEN_LOCKED"]);
  });
});

describe("T-402-6 mint down", () => {
  it("swap times out -> 503, Retry-After: 30, op pending, token not spent", async () => {
    // Pass mint info and keys through to testnut; make the swap itself fail like a timeout.
    const flaky: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/v1/swap")) throw new TypeError("network timeout (simulated)");
      return fetch(input, init);
    };
    await makePaywall(db()).topupWithToken(await faucet.token(5)); // warm the mint cache: only the swap goes to the flaky fetch
    const pw = makePaywall(db(), { fetch: flaky });
    const t = await faucet.token(10);
    const res = await pw.protect(fortune, { priceSats: 5 })(req({ "X-Cashu": t }));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(((await res.json()) as { code: string }).code).toBe("ECASH_PENDING");
    const op = await db().prepare("SELECT status FROM ecash_ops WHERE kind = 'topup_token' ORDER BY created_at DESC LIMIT 1").first<{ status: string }>();
    expect(op!.status).toBe("pending");
    expect(await claim(t)).toBe(10 - faucet.feeFor(t)); // still the payer's money
  });
  it("mint unreachable before the swap -> 503 ECASH_MINT_UNAVAILABLE, nothing written", async () => {
    const down: typeof fetch = async () => { throw new TypeError("connection refused (simulated)"); };
    const pw = makePaywall(env.DB_REC, { fetch: down });
    const t = await faucet.token(10);
    const res = await pw.protect(fortune, { priceSats: 5 })(req({ "X-Cashu": t }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("ECASH_MINT_UNAVAILABLE");
  });
});

describe("T-LN-1 / T-LN-2 Lightning top-up", () => {
  it("quote -> invoice, new key, status_url, no quote id; paid -> CREDITED 200 once", async () => {
    const pw = makePaywall(db());
    const res = (await pw.handleRoutes(new Request("https://paywall.test/ecash/lightning", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount_sats: 200 }),
    })))!;
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, any>;
    expect(j.invoice).toMatch(/^lnbc/);
    expect(j.key).toMatch(/^eck_/);
    expect(j.amount_sats).toBe(200);
    expect(j.status_url).toBe(`https://paywall.test/ecash/lightning/${j.op_id}`);
    expect(j.qr_svg).toContain("<svg");
    const op = await db().prepare("SELECT input_id, detail FROM ecash_ops WHERE op_id = ?").bind(j.op_id).first<{ input_id: string; detail: string }>();
    expect(JSON.stringify(j)).not.toContain(op!.input_id); // the quote id never leaves the server
    expect(JSON.parse(op!.detail).locked).toBe(true); // NUT-20 locked quote (P1-4)

    const poll = async () => (await (await pw.handleRoutes(new Request(j.status_url)))!.json()) as Record<string, any>;
    let s = await poll();
    const t0 = Date.now();
    while (s.state === "UNPAID" && Date.now() - t0 < 30_000) {
      await new Promise((r) => setTimeout(r, 1000));
      s = await poll();
    }
    expect(s.state).toBe("CREDITED");
    expect(s.balance_sats).toBe(200);
    const again = await poll();
    expect(again).toMatchObject({ state: "CREDITED", balance_sats: 200 });
    // Two racing polls on a fresh op can't double-credit either.
    const ops = await db().prepare("SELECT COUNT(*) AS n FROM ecash_ops WHERE op_id = ? AND status = 'done'").bind(j.op_id).first<{ n: number }>();
    expect(ops!.n).toBe(1);
    expect((await keyRow(db(), j.key))!.balance).toBe(200);
    expect((await pw.balance(j.key)).balanceSats).toBe(200);
  });

  it("racing polls on a paid quote credit exactly once", async () => {
    const pw = makePaywall(db());
    const { key } = await pw.createKey();
    const ln = await pw.startLightningTopup(50, key);
    await new Promise((r) => setTimeout(r, 5000)); // testnut marks it paid after ~3 s
    const results = await Promise.all(Array.from({ length: 4 }, () => pw.checkLightningTopup(ln.opId).catch((e) => e)));
    expect(results.some((r) => r.state === "CREDITED")).toBe(true);
    const final = await pw.checkLightningTopup(ln.opId);
    expect(final).toMatchObject({ state: "CREDITED", balanceSats: 50 });
    expect((await pw.balance(key)).balanceSats).toBe(50);
  });

  it("E-3: an expired, unpaid invoice -> EXPIRED and no credit", async () => {
    // testnut pays everything, so the status check is faked to UNPAID and the clock moved past expiry.
    const unpaid: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const res = await fetch(input, init);
      if (/\/v1\/mint\/quote\/bolt11\/[^/]+$/.test(url) && (init?.method ?? "GET") === "GET") {
        const q = (await res.json()) as Record<string, unknown>;
        return Response.json({ ...q, state: "UNPAID", amount_paid: 0, amount_issued: 0 });
      }
      return res;
    };
    const later = Date.now() + 3 * 60 * 60 * 1000;
    const start = makePaywall(db());
    const ln = await start.startLightningTopup(30);
    const pw = makePaywall(db(), { fetch: unpaid, now: () => later });
    expect(await pw.checkLightningTopup(ln.opId)).toEqual({ state: "EXPIRED", opId: ln.opId });
    expect((await start.balance(ln.key!)).balanceSats).toBe(0);
  });
});
