// T-LOG-1: the whole flow (top-up, debit, 402, refund, Lightning, melt, errors) with console captured: no secrets.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { createPaywall } from "../../src/index";
import { TEST_CFG, TESTNUT } from "../helpers";
import { Faucet, testWallet } from "./faucet";

const faucet = new Faucet();
const captured: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];

beforeAll(async () => {
  await faucet.load();
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    const orig = console[m].bind(console);
    spies.push(vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      orig(...args);
    }));
  }
});
afterAll(() => spies.forEach((s) => s.mockRestore()));

const FORBIDDEN: Array<[string, RegExp]> = [
  ["cashu token", /cashu[AB][A-Za-z0-9_\-+/=]{16,}/],
  ["eck_ key", /eck_[A-Za-z0-9_-]{8,}/],
  ["payment request", /creq[ab][a-z0-9]{16,}/i],
  ["bolt11", /ln(bc|tb|bcrt)[0-9a-z]{20,}/i],
  ["64-hex", /[0-9a-f]{64}/i],
];

describe("T-LOG-1 no secrets in logs", () => {
  it("runs every money path with the default console logger and finds none of the forbidden patterns", async () => {
    const issuer = testWallet();
    await issuer.loadMint();
    const lnurl: typeof fetch = async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.host !== "ln.example") return fetch(input, init);
      if (url.pathname.startsWith("/.well-known/lnurlp/")) return Response.json({ tag: "payRequest", callback: "https://ln.example/cb", minSendable: 1000, maxSendable: 1e9, metadata: "[]" });
      const q = await issuer.createMintQuoteBolt11(Number(url.searchParams.get("amount")) / 1000);
      return Response.json({ pr: q.request });
    };
    // No `logger` passed: the library's default console logger (with redaction) is what we inspect.
    const pw = createPaywall({
      db: env.DB_LOG, keyPepper: TEST_CFG.keyPepper, proofKey: TEST_CFG.proofKey, walletSeed: Array.from(crypto.getRandomValues(new Uint8Array(64)), (b) => b.toString(16).padStart(2, "0")).join(""),
      mints: [TESTNUT], publicBaseUrl: "https://paywall.test", priceSats: 5, fetch: lnurl,
      melt: { lightningAddress: "demo@ln.example", minSats: 1000, keepSats: 100 },
    });
    const guarded = pw.protect(async () => Response.json({ ok: true }), { priceSats: 5 });
    const get = (h: Record<string, string>) => guarded(new Request("https://paywall.test/x", { headers: h }));

    expect((await get({})).status).toBe(402);
    const t1 = await faucet.token(30);
    const r1 = await get({ "X-Cashu": t1 });
    expect(r1.status).toBe(200);
    const key = r1.headers.get("X-Ecash-Key")!;
    expect((await get({ Authorization: `Bearer ${key}` })).status).toBe(200);
    expect((await get({ "X-Cashu": t1 })).status).toBe(400); // spent
    expect((await get({ "X-Cashu": "cashuBgarbagegarbagegarbage" })).status).toBe(400);
    expect((await get({ Authorization: "Bearer eck_" + "x".repeat(43) })).status).toBe(401);

    const refund = await pw.handleRoutes(new Request("https://paywall.test/ecash/refund", { method: "POST", headers: { Authorization: `Bearer ${key}` } }));
    expect(refund!.status).toBe(200);

    const ln = await pw.startLightningTopup(1500);
    await new Promise((r) => setTimeout(r, 4000));
    let st = await pw.checkLightningTopup(ln.opId);
    for (let i = 0; i < 10 && st.state === "UNPAID"; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      st = await pw.checkLightningTopup(ln.opId);
    }
    expect(st.state).toBe("CREDITED");
    expect((await pw.debit(ln.key!, 1500)).ok).toBe(true); // all revenue, so the melt has something to move
    const report = await pw.scheduled({ cron: "0 3 * * *", scheduledTime: Date.now() });
    expect(report.melted.length).toBe(1);

    const all = captured.join("\n");
    expect(all).toContain("ecash_topup");
    expect(all).toContain("ecash_refund");
    expect(all).toContain("ecash_melt");
    for (const [name, re] of FORBIDDEN) {
      const m = re.exec(all);
      expect(m, `${name} leaked into logs: ${m?.[0]?.slice(0, 12)}…`).toBeNull();
    }
  });
});
