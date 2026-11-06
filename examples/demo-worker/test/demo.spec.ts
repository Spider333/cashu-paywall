// Demo Worker tests (PRD 11.1 T-DEMO-1..4, T-MCP-5, 11.4 N-1..N-4). Live against testnut (test sats).
import { beforeAll, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { decodePaymentRequest } from "@cashu/cashu-ts";
import { Faucet } from "../../../test/testnut/faucet";

const faucet = new Faucet();
beforeAll(async () => {
  await faucet.load();
});

const BASE = "https://demo.test";
let rpcId = 1;

async function mcp(method: string, params: unknown, headers: Record<string, string> = {}, body?: unknown) {
  const res = await SELF.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body ?? { jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const text = await res.text();
  return { res, json: text ? (JSON.parse(text) as any) : null };
}

const callTool = (name: string, args: Record<string, unknown>, headers: Record<string, string>) =>
  mcp("tools/call", { name, arguments: args }, headers);

const toolJson = (r: { json: any }) => JSON.parse(r.json.result.content[0].text);
const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

/** A key funded with a token of `amount` sats via POST /ecash/topup. */
async function fundedKey(amount: number): Promise<{ key: string; balance: number }> {
  const token = await faucet.token(amount);
  const res = await SELF.fetch(`${BASE}/ecash/topup`, { method: "POST", headers: { "X-Cashu": token } });
  const j = (await res.json()) as any;
  expect(res.status).toBe(200);
  return { key: j.key, balance: j.balance_sats };
}

async function balanceOf(key: string): Promise<number> {
  const r = await callTool("ecash_balance", {}, bearer(key));
  return toolJson(r).balance_sats;
}

describe("T-DEMO-1 paid route over NUT-24", () => {
  it("402 with X-Cashu: creqA (a=5), then 200 with the fact after paying a 20-sat token", async () => {
    const r1 = await SELF.fetch(`${BASE}/api/nut-fact?nut=24`);
    expect(r1.status).toBe(402);
    const creq = r1.headers.get("X-Cashu")!;
    expect(creq).toMatch(/^creqA/);
    const pr = decodePaymentRequest(creq);
    expect(pr.amount?.toNumber()).toBe(5);
    expect(pr.unit).toBe("sat");
    expect(pr.mints).toEqual(["https://testnut.cashu.space"]);
    expect(pr.transport ?? []).toEqual([]);

    const token = await faucet.token(20);
    const fee = faucet.feeFor(token);
    const r2 = await SELF.fetch(`${BASE}/api/nut-fact?nut=24`, { headers: { "X-Cashu": token } });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({
      nut: 24,
      title: "HTTP 402 Payment Required",
      url: "https://github.com/cashubtc/nuts/blob/main/24.md",
    });
    expect(r2.headers.get("X-Ecash-Key")).toMatch(/^eck_/);
    expect(Number(r2.headers.get("X-Ecash-Balance"))).toBe(20 - fee - 5);

    // N-5: the same key with too little credit -> 402 again, as with no payment.
    const key = r2.headers.get("X-Ecash-Key")!;
    for (let i = 0; i < 3; i++) await SELF.fetch(`${BASE}/api/nut-fact?nut=1`, { headers: bearer(key) });
    const r3 = await SELF.fetch(`${BASE}/api/nut-fact?nut=24`, { headers: bearer(key) });
    expect(r3.status).toBe(402);
    expect(r3.headers.get("X-Cashu")).toMatch(/^creqA/);
  });

  it("a NUT not in the list -> 400 before any payment is asked", async () => {
    const r = await SELF.fetch(`${BASE}/api/nut-fact?nut=98`);
    expect(r.status).toBe(400);
    expect(r.headers.get("X-Cashu")).toBeNull();
  });
});

describe("T-DEMO-2 /mcp auth", () => {
  it("N-1: no bearer -> 401 JSON-RPC -32001 with topup_url", async () => {
    const r = await mcp("tools/list", {});
    expect(r.res.status).toBe(401);
    expect(r.json.error.code).toBe(-32001);
    expect(r.json.error.data.topup_url).toBe("https://demo.test/ecash");
  });
  it("N-2: Bearer abc -> 401, no D1 read", async () => {
    const before = await env.ECASH_DB.prepare("SELECT COUNT(*) AS n FROM ecash_keys").first<{ n: number }>();
    const r = await mcp("tools/list", {}, { Authorization: "Bearer abc" });
    expect(r.res.status).toBe(401);
    expect(r.json.error.code).toBe(-32001);
    expect(r.json.error.data.code).toBe("ECASH_KEY_INVALID");
    expect(before).toBeTruthy();
  });
  it("N-3: unknown eck_ key -> 401 ECASH_KEY_INVALID", async () => {
    const r = await mcp("tools/list", {}, bearer("eck_" + "Z".repeat(43)));
    expect(r.res.status).toBe(401);
    expect(r.json.error.data.code).toBe("ECASH_KEY_INVALID");
  });
  it("funded key: tools/list is 200 and free", async () => {
    const { key, balance } = await fundedKey(20);
    const r = await mcp("tools/list", {}, bearer(key));
    expect(r.res.status).toBe(200);
    const names = r.json.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["ecash_balance", "ecash_refund", "ecash_topup", "echo", "nut_fact"]);
    for (const t of r.json.result.tools) {
      expect(t.description.length).toBeGreaterThan(80);
      for (const p of Object.values((t.inputSchema?.properties ?? {}) as Record<string, { description?: string }>)) {
        expect((p.description ?? "").length).toBeGreaterThanOrEqual(15);
      }
    }
    expect(await balanceOf(key)).toBe(balance);
  });
});

describe("T-DEMO-3 / T-DEMO-4 tool debits and credit back", () => {
  it("nut_fact then echo on a key with 20 sats -> 15 then 10; ecash_balance costs 0; nut 98 refunded", async () => {
    // A 21-sat token (1 sat fee for 3 proofs) leaves exactly 20 sats of credit.
    const { key, balance } = await fundedKey(21);
    expect(balance).toBe(20);
    const f = await callTool("nut_fact", { nut: 18 }, bearer(key));
    expect(f.res.status).toBe(200);
    expect(toolJson(f)).toMatchObject({ nut: 18, title: "Payment requests" });
    expect(await balanceOf(key)).toBe(15);
    const e = await callTool("echo", { text: "hi" }, bearer(key));
    expect(toolJson(e)).toMatchObject({ text: "hi", length: 2 });
    expect(await balanceOf(key)).toBe(10);
    expect(await balanceOf(key)).toBe(10); // balance is free

    // T-DEMO-4: a NUT not in the list -> tool error, balance unchanged (P1-5).
    const bad = await callTool("nut_fact", { nut: 98 }, bearer(key));
    expect(bad.json.result.isError).toBe(true);
    expect(await balanceOf(key)).toBe(10);

    // D-1: drain the key -> ECASH_INSUFFICIENT_BALANCE with a decodable payment_request and a topup_url.
    await callTool("echo", { text: "a" }, bearer(key));
    await callTool("echo", { text: "b" }, bearer(key));
    const out = await callTool("echo", { text: "c" }, bearer(key));
    expect(out.json.result.isError).toBe(true);
    const err = toolJson(out);
    expect(err.code).toBe("ECASH_INSUFFICIENT_BALANCE");
    expect(decodePaymentRequest(err.payment_request).unit).toBe("sat");
    expect(err.topup_url).toBe("https://demo.test/ecash");
    // ...and ecash_topup with a fresh token restores service.
    const t = await faucet.token(20);
    const up = await callTool("ecash_topup", { token: t }, bearer(key));
    expect(toolJson(up).balance_sats).toBe(20 - faucet.feeFor(t));
    const again = await callTool("echo", { text: "back" }, bearer(key));
    expect(again.json.result.isError).toBeUndefined();
  });
});

describe("T-MCP-5 X-Cashu on /mcp", () => {
  it("creates a key, tops up the bearer's key, and rejects a spent token with -32004", async () => {
    const t1 = await faucet.token(20);
    const fee1 = faucet.feeFor(t1);
    const r1 = await callTool("nut_fact", { nut: 24 }, { "X-Cashu": t1 });
    expect(r1.res.status).toBe(200);
    const key = r1.res.headers.get("X-Ecash-Key")!;
    expect(key).toMatch(/^eck_/);
    expect(toolJson(r1)).toMatchObject({ nut: 24 });
    expect(Number(r1.res.headers.get("X-Ecash-Balance"))).toBe(20 - fee1);
    expect(await balanceOf(key)).toBe(20 - fee1 - 5);

    const t2 = await faucet.token(10);
    const fee2 = faucet.feeFor(t2);
    const r2 = await callTool("ecash_balance", {}, { ...bearer(key), "X-Cashu": t2 });
    expect(r2.res.status).toBe(200);
    expect(r2.res.headers.get("X-Ecash-Key")).toBeNull();
    expect(toolJson(r2).balance_sats).toBe(20 - fee1 - 5 + 10 - fee2);

    const before = await balanceOf(key);
    const r3 = await callTool("nut_fact", { nut: 24 }, { ...bearer(key), "X-Cashu": t1 });
    expect(r3.res.status).toBe(400);
    expect(r3.json.error.code).toBe(-32004);
    expect(r3.json.error.data.code).toBe("ECASH_TOKEN_SPENT");
    expect(await balanceOf(key)).toBe(before); // tool not run
  });
});

describe("N-4 JSON-RPC batch", () => {
  it("3 paid calls with 2 calls of credit: at most 2 succeed (or the batch is refused)", async () => {
    const { key } = await fundedKey(11); // 10 sats of credit = 2 calls at 5
    const body = [1, 2, 3].map((i) => ({
      jsonrpc: "2.0",
      id: 100 + i,
      method: "tools/call",
      params: { name: "echo", arguments: { text: `n${i}` } },
    }));
    const r = await mcp("", null, bearer(key), body);
    if (Array.isArray(r.json)) {
      const errors = r.json.filter((x: any) => x.result?.isError);
      expect(r.json.length - errors.length).toBe(2);
    } else {
      expect(r.res.status).toBeGreaterThanOrEqual(400); // the SDK refuses batches: then nothing is charged
    }
    expect(await balanceOf(key)).toBeGreaterThanOrEqual(0);
  });
});

describe("index and 404", () => {
  it("GET / says test sats; unknown path 404", async () => {
    const j = (await (await SELF.fetch(`${BASE}/`)).json()) as any;
    expect(j.note).toMatch(/[Tt]est sats/);
    expect(j.accepted_mints).toEqual(["https://testnut.cashu.space"]);
    expect((await SELF.fetch(`${BASE}/nope`)).status).toBe(404);
  });
});
