// NUT-24 protect() and the top-up page, without a mint: T-402-1, T-402-2, T-LN-3, routes.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { decodePaymentRequest } from "@cashu/cashu-ts";
import { fundedKey, keyHash, makePaywall } from "./helpers";

const db = () => env.DB_402;
const fortune = async () => Response.json({ fortune: "Don't trust, verify." });

describe("T-402-1 / T-402-2 402 without payment", () => {
  it("402 with X-Cashu: creqA decoding to a=5, u=sat, m=[allowlist], no transport, no nut10", async () => {
    const pw = makePaywall(db());
    const res = await pw.protect(fortune, { priceSats: 5 })(new Request("https://paywall.test/fortune"));
    expect(res.status).toBe(402);
    const h = res.headers.get("X-Cashu")!;
    expect(h).toMatch(/^creqA/);
    const pr = decodePaymentRequest(h);
    expect(pr.amount?.toNumber()).toBe(5);
    expect(pr.unit).toBe("sat");
    expect(pr.mints).toEqual(["https://testnut.cashu.space"]);
    expect(pr.transport ?? []).toEqual([]);
    expect(pr.nut10).toBeUndefined();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      code: "ECASH_PAYMENT_REQUIRED",
      price_sats: 5,
      unit: "sat",
      mints: ["https://testnut.cashu.space"],
      topup_url: "https://paywall.test/ecash",
    });
    expect(body.payment_request).toBe(h);
  });
  it("creqB option -> header starts CREQB1 and cashu-ts decodes it", async () => {
    const pw = makePaywall(db(), { requestEncoding: "creqB" });
    const res = await pw.protect(fortune, { priceSats: 5 })(new Request("https://paywall.test/fortune"));
    expect(res.status).toBe(402);
    const h = res.headers.get("X-Cashu")!;
    expect(h.startsWith("CREQB1")).toBe(true);
    const pr = decodePaymentRequest(h);
    expect(pr.amount?.toNumber()).toBe(5);
    expect(pr.unit).toBe("sat");
    expect(pr.mints).toEqual(["https://testnut.cashu.space"]);
  });
});

describe("protect() with a bearer key (no mint)", () => {
  it("T-402-4: bearer with >= 5 -> 200 and balance - 5", async () => {
    const pw = makePaywall(db());
    const key = await fundedKey(db(), 12);
    const res = await pw.protect(fortune, { priceSats: 5 })(
      new Request("https://paywall.test/fortune", { headers: { Authorization: `Bearer ${key}` } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Ecash-Balance")).toBe("7");
    expect(res.headers.get("X-Ecash-Key")).toBeNull();
    expect((await pw.balance(key)).balanceSats).toBe(7);
  });
  it("N-5: too little credit -> 402 with X-Cashu, as with no payment", async () => {
    const pw = makePaywall(db());
    const key = await fundedKey(db(), 4);
    const res = await pw.protect(fortune, { priceSats: 5 })(
      new Request("https://paywall.test/fortune", { headers: { Authorization: `Bearer ${key}` } }),
    );
    expect(res.status).toBe(402);
    expect(res.headers.get("X-Cashu")).toMatch(/^creqA/);
  });
  it("malformed key -> 401; frozen key -> 403; N-7: key in the query string is ignored", async () => {
    const pw = makePaywall(db());
    const h = pw.protect(fortune, { priceSats: 5 });
    expect(
      (await h(new Request("https://paywall.test/fortune", { headers: { Authorization: "Bearer nope" } }))).status,
    ).toBe(401);
    const key = await fundedKey(db(), 50);
    await db()
      .prepare("UPDATE ecash_keys SET status = 'frozen' WHERE key_hash = ?")
      .bind(await keyHash(key))
      .run();
    const frozen = await h(
      new Request("https://paywall.test/fortune", { headers: { Authorization: `Bearer ${key}` } }),
    );
    expect(frozen.status).toBe(403);
    const q = await h(new Request(`https://paywall.test/fortune?key=${key}&authorization=Bearer%20${key}`));
    expect(q.status).toBe(402);
  });
  it("a handler that throws gives the debit back and answers 500", async () => {
    const pw = makePaywall(db());
    const key = await fundedKey(db(), 10);
    const res = await pw.protect(
      async () => {
        throw new Error("upstream down");
      },
      { priceSats: 5 },
    )(new Request("https://paywall.test/fortune", { headers: { Authorization: `Bearer ${key}` } }));
    expect(res.status).toBe(500);
    expect((await pw.balance(key)).balanceSats).toBe(10);
  });
});

describe("T-LN-3 top-up page and routes", () => {
  it("GET /ecash -> 200 HTML, CSP header, QR SVG, no external scripts", async () => {
    const pw = makePaywall(db());
    const res = (await pw.handleRoutes(new Request("https://paywall.test/ecash")))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    const html = await res.text();
    expect(html).toContain("<svg");
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(
      /https?:\/\/(?!testnut\.cashu\.space|paywall\.test|www\.w3\.org\/2000\/svg)[a-z0-9.-]+\//i,
    );
    const nonce = /nonce-([A-Za-z0-9_-]+)/.exec(csp)![1];
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
  it("GET /ecash/info, POST /ecash/keys, GET /ecash/balance, unknown sub-route, other paths -> null", async () => {
    const pw = makePaywall(db());
    const info = (await (await pw.handleRoutes(new Request("https://paywall.test/ecash/info")))!.json()) as Record<
      string,
      any
    >;
    expect(info).toMatchObject({
      unit: "sat",
      mints: ["https://testnut.cashu.space"],
      price_sats: 10,
      nuts: [4, 5, 7, 9, 13, 18, 24],
    });
    expect(info.payment_request).toMatch(/^creqA/);
    const k = (await (await pw.handleRoutes(
      new Request("https://paywall.test/ecash/keys", { method: "POST" }),
    ))!.json()) as Record<string, any>;
    expect(k.key).toMatch(/^eck_/);
    expect(k.balance_sats).toBe(0);
    const b = (await pw.handleRoutes(
      new Request("https://paywall.test/ecash/balance", { headers: { Authorization: `Bearer ${k.key}` } }),
    ))!;
    expect(b.status).toBe(200);
    expect(((await b.json()) as Record<string, any>).balance_sats).toBe(0);
    const nob = (await pw.handleRoutes(new Request("https://paywall.test/ecash/balance")))!;
    expect(nob.status).toBe(401);
    expect((await pw.handleRoutes(new Request("https://paywall.test/ecash/nope")))!.status).toBe(404);
    expect(await pw.handleRoutes(new Request("https://paywall.test/other"))).toBeNull();
    expect(await pw.handleRoutes(new Request("https://paywall.test/ecashy"))).toBeNull();
  });
  it("P1-2: POST /ecash/keys is limited per IP", async () => {
    const { fakeLimiter } = await import("./helpers");
    const pw = makePaywall(db(), { rateLimiter: fakeLimiter(5) });
    const codes = [];
    for (let i = 0; i < 6; i++) {
      codes.push(
        (await pw.handleRoutes(
          new Request("https://paywall.test/ecash/keys", {
            method: "POST",
            headers: { "CF-Connecting-IP": "198.51.100.9" },
          }),
        ))!.status,
      );
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });
  it("an unknown Lightning op id -> 404", async () => {
    const pw = makePaywall(db());
    const r = (await pw.handleRoutes(new Request(`https://paywall.test/ecash/lightning/${crypto.randomUUID()}`)))!;
    expect(r.status).toBe(404);
  });
});
