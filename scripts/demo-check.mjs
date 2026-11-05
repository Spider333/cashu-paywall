#!/usr/bin/env node
// Runs the demo script (PRD 7.7) against a running demo and prints PASS/FAIL per step.
// Usage: node scripts/demo-check.mjs [http://localhost:8787]   (test sats only: tokens come from testnut)
// Keys and tokens are shortened in the output; the refund token is claimed by a throwaway wallet to prove it is real.
import { Wallet, MintQuoteState, getEncodedToken, decodePaymentRequest } from "@cashu/cashu-ts";

const DEMO = (process.argv[2] ?? "http://localhost:8787").replace(/\/+$/, "");
const MINT = "https://testnut.cashu.space";
const short = (s) => (s ? `${String(s).slice(0, 10)}…` : String(s));
let failures = 0;
const check = (name, ok, info = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  (${info})` : ""}`);
};

const wallet = new Wallet(MINT, { denominationTarget: 1 });
await wallet.loadMint();
async function token(amount) {
  const q = await wallet.createMintQuoteBolt11(amount);
  let s = await wallet.checkMintQuoteBolt11(q.quote);
  while (s.state === MintQuoteState.UNPAID) { await new Promise((r) => setTimeout(r, 500)); s = await wallet.checkMintQuoteBolt11(q.quote); }
  return getEncodedToken({ mint: MINT, proofs: await wallet.mintProofsBolt11(amount, q.quote), unit: "sat" });
}
const fee = (t) => wallet.getFeesForProofs(wallet.decodeToken(t).proofs).toNumber();
let id = 1;
async function mcp(method, params, headers = {}) {
  const res = await fetch(`${DEMO}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
  });
  return { res, json: await res.json() };
}
const tool = async (name, args, headers) => {
  const r = await mcp("tools/call", { name, arguments: args }, headers);
  return { ...r, body: r.json.result ? JSON.parse(r.json.result.content[0].text) : null, isError: r.json.result?.isError === true };
};

// 1. No payment -> 402 + X-Cashu: creqA…
const r402 = await fetch(`${DEMO}/api/nut-fact?nut=24`);
const creq = r402.headers.get("x-cashu");
const pr = creq ? decodePaymentRequest(creq) : null;
check("1. GET /api/nut-fact?nut=24 -> 402 with X-Cashu", r402.status === 402 && /^(creqA|CREQB1)/.test(creq ?? ""), `status ${r402.status}, ${short(creq)}`);
check("   payment request decodes with cashu-ts (a=5, u=sat, m=[testnut])",
  pr?.amount?.toNumber() === 5 && pr?.unit === "sat" && JSON.stringify(pr?.mints) === JSON.stringify([MINT]),
  `a=${pr?.amount?.toString()} u=${pr?.unit} m=${JSON.stringify(pr?.mints)}`);

// 2. Pay with ecash -> 200
const t20 = await token(20);
const r200 = await fetch(`${DEMO}/api/nut-fact?nut=24`, { headers: { "X-Cashu": t20 } });
const fact = await r200.json();
const key = r200.headers.get("x-ecash-key");
const bal = Number(r200.headers.get("x-ecash-balance"));
check("2. retry with X-Cashu: <20-sat token> -> 200 + the NUT-24 fact", r200.status === 200 && fact.nut === 24, `${fact.title}`);
check("   X-Ecash-Key and X-Ecash-Balance = 20 - fee - 5", /^eck_/.test(key ?? "") && bal === 20 - fee(t20) - 5, `key ${short(key)}, balance ${bal}`);

// 3. The same key over MCP (what Claude Code sends with --transport http)
const auth = { Authorization: `Bearer ${key}` };
const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "demo-check", version: "0" } }, auth);
check("3. MCP initialize", init.res.status === 200 && !!init.json.result?.serverInfo, init.json.result?.serverInfo?.name);
const list = await mcp("tools/list", {}, auth);
check("   tools/list (free)", list.json.result?.tools?.length === 5, list.json.result?.tools?.map((t) => t.name).join(", "));
const b0 = (await tool("ecash_balance", {}, auth)).body.balance_sats;
const f18 = await tool("nut_fact", { nut: 18 }, auth);
const b1 = (await tool("ecash_balance", {}, auth)).body.balance_sats;
const echo = await tool("echo", { text: "hello nut" }, auth);
const b2 = (await tool("ecash_balance", {}, auth)).body.balance_sats;
check("   nut_fact(18) and echo('hello nut') each cost exactly 5 sats", f18.body?.nut === 18 && echo.body?.text === "hello nut" && b0 - b1 === 5 && b1 - b2 === 5, `${b0} -> ${b1} -> ${b2}`);

// 4. Run out -> ECASH_INSUFFICIENT_BALANCE with a payment request and the top-up URL; then ecash_topup restores service
let last;
for (let i = 0; i < 10; i++) { last = await tool("echo", { text: `drain ${i}` }, auth); if (last.isError) break; }
check("4. a drained key -> isError ECASH_INSUFFICIENT_BALANCE", last.isError && last.body.code === "ECASH_INSUFFICIENT_BALANCE", `balance ${last.body.balance_sats}`);
let decodes = false;
try { decodes = decodePaymentRequest(last.body.payment_request).unit === "sat"; } catch { decodes = false; }
check("   ...with a decodable payment_request and a topup_url", decodes && /\/ecash$/.test(last.body.topup_url ?? ""), last.body.topup_url);
const t15 = await token(15);
const up = await tool("ecash_topup", { token: t15 }, auth);
const again = await tool("echo", { text: "back" }, auth);
check("   ecash_topup with a fresh token restores service", !up.isError && up.body.credited_sats === 15 - fee(t15) && !again.isError, `credited ${up.body.credited_sats}`);

// 5. Refund -> a token a Cashu wallet can claim
const ref = await tool("ecash_refund", {}, auth);
check("5. ecash_refund -> cashuB token + warning, balance 0", !ref.isError && /^cashuB/.test(ref.body.token ?? "") && ref.body.balance_sats === 0 && /money/.test(ref.body.warning), `amount ${ref.body.amount_sats}, fee ${ref.body.fee_sats}`);
let claimed = 0;
try { const w = new Wallet(MINT); await w.loadMint(); claimed = (await w.receive(ref.body.token)).reduce((s, p) => s + p.amount.toNumber(), 0); } catch { claimed = -1; }
check("   the refund token is claimable by another wallet (Cashu.me stand-in)", claimed > 0, `claimed ${claimed} sats`);

// 6. Lightning top-up page flow (E-1 without a browser)
const page = await fetch(`${DEMO}/ecash`);
check("6. GET /ecash -> HTML with a CSP", page.status === 200 && /default-src 'none'/.test(page.headers.get("content-security-policy") ?? ""));
const ln = await (await fetch(`${DEMO}/ecash/lightning`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount_sats: 500 }) })).json();
let st = { state: "UNPAID" };
const t0 = Date.now();
while (st.state === "UNPAID" && Date.now() - t0 < 30_000) { await new Promise((r) => setTimeout(r, 2000)); st = await (await fetch(`${DEMO}/ecash/lightning/${ln.op_id}`)).json(); }
check("   500-sat invoice, testnut auto-pays -> 'Credited: 500 sats'", /^lnbc/.test(ln.invoice ?? "") && st.state === "CREDITED" && st.balance_sats === 500, `${st.state} ${st.balance_sats ?? ""}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
