// MCP adapter live: T-MCP-1 (ecash_topup) and T-MCP-3 (ecash_refund) against testnut.
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { keyRow, makePaywall } from "../helpers";
import { connect } from "../mcp-helpers";
import { Faucet, claim } from "./faucet";

const db = () => env.DB_MCP;
const faucet = new Faucet();
beforeAll(async () => {
  await faucet.load();
});

describe("T-MCP-1 ecash_topup", () => {
  it("credits 100 - fee to a 0-sat key, the call is free; the same token again -> ECASH_TOKEN_SPENT", async () => {
    const pw = makePaywall(db());
    const { key } = await pw.createKey();
    const { call } = await connect(pw, key, 10);
    const token = await faucet.token(100);
    const fee = faucet.feeFor(token);
    const r = await call("ecash_topup", { token });
    expect(r.isError).toBe(false);
    expect(r.body.credited_sats).toBe(100 - fee);
    expect(r.body.fee_sats).toBe(fee);
    const row = await keyRow(db(), key);
    expect(r.body.balance_sats).toBe(row!.balance);
    expect(row!.balance).toBe(100 - fee); // not debited
    expect(r.body.calls_left).toBe(Math.floor(row!.balance / 10));
    expect(r.body.key).toBeUndefined(); // the key existed already
    const again = await call("ecash_topup", { token });
    expect(again.isError).toBe(true);
    expect(again.body.code).toBe("ECASH_TOKEN_SPENT");
    expect((await keyRow(db(), key))!.balance).toBe(100 - fee);
  });
  it("no key (keyless session) -> a key is created and returned with the warning", async () => {
    const pw = makePaywall(db());
    const { call } = await connect(pw, null, 10);
    const r = await call("ecash_topup", { token: await faucet.token(30) });
    expect(r.body.key).toMatch(/^eck_/);
    expect(r.body.warning).toMatch(/shown once/);
  });
});

describe("T-MCP-3 ecash_refund", () => {
  it("88 sats -> a token worth 88 - fee that a second wallet receives; then ECASH_NOTHING_TO_REFUND with no mint call", async () => {
    const pw = makePaywall(db());
    const t = await faucet.token(89);
    const top = await pw.topupWithToken(t);
    expect(top.balanceSats).toBe(88);
    const { call } = await connect(pw, top.key!, 10);
    const r = await call("ecash_refund");
    expect(r.isError).toBe(false);
    expect(r.body.amount_sats).toBe(88 - r.body.fee_sats);
    expect(r.body.balance_sats).toBe(0);
    expect(r.body.warning).toMatch(/This token is money/);
    expect(await claim(r.body.token)).toBe(r.body.amount_sats - faucet.feeFor(r.body.token));

    let mintCalls = 0;
    const counting = makePaywall(db(), { fetch: async (i, init) => { mintCalls++; return fetch(i, init); } });
    const second = await connect(counting, top.key!, 10);
    const r2 = await second.call("ecash_refund");
    expect(r2.isError).toBe(true);
    expect(r2.body.code).toBe("ECASH_NOTHING_TO_REFUND");
    expect(mintCalls).toBe(0);
  });
});
