// MCP adapter without a mint: T-MCP-2 (balance), T-MCP-4 (charge helpers), tool metadata.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { decodePaymentRequest } from "@cashu/cashu-ts";
import { fundedKey, keyRow, makePaywall } from "./helpers";
import { connect } from "./mcp-helpers";

const db = () => env.DB_MCP;

describe("T-MCP-2 ecash_balance", () => {
  it("89 sats at price 10 -> 89 / 8 calls left, decodable payment request, free", async () => {
    const pw = makePaywall(db());
    const key = await fundedKey(db(), 89);
    const { call } = await connect(pw, key, 10);
    const r = await call("ecash_balance");
    expect(r.isError).toBe(false);
    expect(r.body.balance_sats).toBe(89);
    expect(r.body.calls_left).toBe(8);
    expect(r.body.price_sats_per_call).toBe(10);
    expect(r.body.accepted_mints).toEqual(["https://testnut.cashu.space"]);
    expect(r.body.topup_url).toBe("https://paywall.test/ecash");
    const pr = decodePaymentRequest(r.body.payment_request);
    expect(pr.unit).toBe("sat");
    expect(pr.mints).toEqual(["https://testnut.cashu.space"]);
    expect((await keyRow(db(), key))!.balance).toBe(89);
  });
  it("no key -> ECASH_KEY_INVALID tool error", async () => {
    const { call } = await connect(makePaywall(db()), null);
    const r = await call("ecash_balance");
    expect(r.isError).toBe(true);
    expect(r.body.code).toBe("ECASH_KEY_INVALID");
  });
});

describe("T-MCP-4 chargeToolCall / withEcashCharge", () => {
  it("3 sats at price 10 -> ECASH_INSUFFICIENT_BALANCE with payment_request and topup_url, handler never runs", async () => {
    const pw = makePaywall(db());
    const key = await fundedKey(db(), 3);
    const c = await connect(pw, key, 10);
    const r = await c.call("paid_ok");
    expect(r.isError).toBe(true);
    expect(r.body.code).toBe("ECASH_INSUFFICIENT_BALANCE");
    expect(r.body.price_sats).toBe(10);
    expect(r.body.balance_sats).toBe(3);
    expect(r.body.payment_request).toMatch(/^creqA/);
    expect(decodePaymentRequest(r.body.payment_request).amount?.toNumber()).toBe(100);
    expect(r.body.topup_url).toBe("https://paywall.test/ecash");
    expect(r.body.how_to_pay).toMatch(/ecash_topup/);
    expect(c.ran()).toBe(0);
  });
  it("20 sats and a handler throwing a refundOn-matched error -> balance back to 20", async () => {
    const pw = makePaywall(db());
    const key = await fundedKey(db(), 20);
    const c = await connect(pw, key, 10);
    const r = await c.call("paid_matched");
    expect(r.isError).toBe(true);
    expect(c.ran()).toBe(1);
    expect((await keyRow(db(), key))!.balance).toBe(20);
  });
  it("20 sats and an unmatched error -> balance 10 (the debit stands)", async () => {
    const pw = makePaywall(db());
    const key = await fundedKey(db(), 20);
    const c = await connect(pw, key, 10);
    const r = await c.call("paid_unmatched");
    expect(r.isError).toBe(true);
    expect(r.body.error).not.toContain("boom"); // internal error text is not echoed
    expect((await keyRow(db(), key))!.balance).toBe(10);
  });
  it("a successful paid call debits exactly the price", async () => {
    const pw = makePaywall(db());
    const key = await fundedKey(db(), 25);
    const c = await connect(pw, key, 10);
    expect((await c.call("paid_ok")).isError).toBe(false);
    expect((await keyRow(db(), key))!.balance).toBe(15);
  });
});

describe("tool metadata (PRD 6.5 A)", () => {
  it("descriptions > 80 chars, parameters described in 15+ chars, annotations set", async () => {
    const pw = makePaywall(db());
    const { client } = await connect(pw, null);
    const { tools } = await client.listTools();
    const ecash = tools.filter((t) => t.name.startsWith("ecash_"));
    expect(ecash.map((t) => t.name).sort()).toEqual(["ecash_balance", "ecash_refund", "ecash_topup"]);
    for (const t of ecash) {
      expect(t.description!.length).toBeGreaterThan(80);
      for (const p of Object.values((t.inputSchema.properties ?? {}) as Record<string, { description?: string }>)) {
        expect((p.description ?? "").length).toBeGreaterThanOrEqual(15);
      }
    }
    const byName = Object.fromEntries(ecash.map((t) => [t.name, t.annotations]));
    expect(byName.ecash_topup).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(byName.ecash_balance).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
    expect(byName.ecash_refund).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });
});
