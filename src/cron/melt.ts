// Daily melt (PRD 6.7): move earned sats (held - owed - keep) to the operator's Lightning address via LNURL-pay.
import { isMintOperationError, MeltQuoteState } from "@cashu/cashu-ts";
import type { Ctx } from "../core/context.js";
import { hostOf } from "../core/context.js";
import { errorFields } from "../core/redact.js";
import {
  CHANGE_OFFSET, COUNTER_BLOCK, D1CounterSource, KEEP_OFFSET, failOp, insertOpStmt, newOpId, openProofs, releaseProofs,
  reserveProofs, sats, sealProofStmts, selectProofs, spendReservedStmt, sumSats,
} from "../core/store.js";
import { getWallet } from "../core/wallet.js";

export type MeltOutcome =
  | { melted: { mint: string; amountSats: number; feeSats: number; opId: string } }
  | { skipped: { mint: string; reason: string } };

class MeltAbort extends Error {}

/** LUD-16 Lightning address -> LUD-06 payRequest -> a bolt11 invoice for `amountSats`. */
async function invoiceFromAddress(ctx: Ctx, address: string, amountSats: number): Promise<string> {
  const [name, domain] = address.split("@") as [string, string];
  const getJson = async (url: string): Promise<Record<string, unknown>> => {
    const res = await ctx.fetch(url, { headers: { Accept: "application/json" }, redirect: "manual" });
    if (!res.ok) throw new MeltAbort(`lnurl_http_${res.status}`);
    const j = (await res.json()) as unknown;
    if (!j || typeof j !== "object") throw new MeltAbort("lnurl_bad_json");
    return j as Record<string, unknown>;
  };
  const meta = await getJson(`https://${domain.toLowerCase()}/.well-known/lnurlp/${encodeURIComponent(name)}`);
  if (meta.status === "ERROR" || meta.tag !== "payRequest" || typeof meta.callback !== "string") throw new MeltAbort("lnurl_not_pay_request");
  const callback = new URL(meta.callback);
  if (callback.protocol !== "https:") throw new MeltAbort("lnurl_callback_not_https");
  const msat = amountSats * 1000;
  if (typeof meta.minSendable === "number" && msat < meta.minSendable) throw new MeltAbort("lnurl_below_min_sendable");
  if (typeof meta.maxSendable === "number" && msat > meta.maxSendable) throw new MeltAbort("lnurl_above_max_sendable");
  callback.searchParams.set("amount", String(msat));
  const pay = await getJson(callback.toString());
  if (pay.status === "ERROR" || typeof pay.pr !== "string") throw new MeltAbort("lnurl_no_invoice");
  return pay.pr;
}

export async function meltMint(ctx: Ctx, mintUrl: string, unspent: number, owed: number): Promise<MeltOutcome> {
  const address = ctx.melt.lightningAddress;
  if (!address) return { skipped: { mint: mintUrl, reason: "melt disabled" } };
  const meltable = unspent - owed - ctx.melt.keepSats;
  if (meltable < ctx.melt.minSats) return { skipped: { mint: mintUrl, reason: "below threshold" } };

  try {
    const wallet = await getWallet(ctx, mintUrl);
    // First guess: leave ~1% (min 2 sats) for the Lightning fee reserve and a few sats for input fees.
    let amount = meltable - Math.max(2, Math.ceil(meltable * 0.01)) - 2;
    for (let attempt = 0; attempt < 3 && amount > 0; attempt++) {
      const pr = await invoiceFromAddress(ctx, address, amount);
      const quote = await wallet.createMeltQuoteBolt11(pr);
      // A Lightning address server must hand back an invoice for exactly what we asked. Anything else: abort.
      if (sats(quote.amount) !== amount) throw new MeltAbort("invoice_amount_mismatch");
      const need = amount + sats(quote.fee_reserve);
      let picked = await selectProofs(ctx, mintUrl, need);
      let inputFee = picked ? sats(wallet.getFeesForProofs(picked.map((p) => ({ id: p.keyset_id })))) : 0;
      // The pre-swap to the exact amount pays input fees too: budget them twice (swap + melt).
      if (picked) picked = await selectProofs(ctx, mintUrl, need + 2 * inputFee + 2);
      inputFee = picked ? sats(wallet.getFeesForProofs(picked.map((p) => ({ id: p.keyset_id })))) : inputFee;
      const total = need + 2 * inputFee + 2;
      if (!picked || total > meltable) {
        amount -= Math.max(1, total - meltable);
        continue;
      }
      return await runMelt(ctx, wallet, mintUrl, quote, picked, amount);
    }
    return { skipped: { mint: mintUrl, reason: "could not size the invoice within the meltable amount" } };
  } catch (e) {
    const reason = e instanceof MeltAbort ? e.message : "melt_error";
    ctx.log.error("ecash_melt_aborted", { mint_host: hostOf(mintUrl), reason, ...(e instanceof MeltAbort ? {} : errorFields(e)) });
    return { skipped: { mint: mintUrl, reason } };
  }
}

async function runMelt(
  ctx: Ctx, wallet: Awaited<ReturnType<typeof getWallet>>, mintUrl: string,
  quote: Awaited<ReturnType<typeof wallet.createMeltQuoteBolt11>>, picked: NonNullable<Awaited<ReturnType<typeof selectProofs>>>, amount: number,
): Promise<MeltOutcome> {
  const opId = newOpId();
  const range = await new D1CounterSource(ctx.db).reserve(wallet.keysetId, COUNTER_BLOCK);
  await insertOpStmt(ctx, {
    op_id: opId, kind: "melt", key_hash: null, mint_url: mintUrl, input_id: `melt:${quote.quote}`, amount,
    keyset_id: wallet.keysetId, counter_start: range.start, counter_count: range.count, detail: { quote: quote.quote },
  }).run();
  if (!(await reserveProofs(ctx, picked, opId))) {
    await failOp(ctx, opId, "reserve_conflict", false);
    return { skipped: { mint: mintUrl, reason: "proofs busy, retry next run" } };
  }
  const inputs = await openProofs(ctx, picked);
  const inputSum = sumSats(inputs);
  try {
    // Swap to the exact amount + fee reserve first (outputs at +0 / +KEEP_OFFSET), then melt (change at +CHANGE_OFFSET).
    const { send, keep } = await wallet.send(amount + sats(quote.fee_reserve), inputs, { includeFees: true, keysetId: wallet.keysetId }, {
      send: { type: "deterministic", counter: range.start },
      keep: { type: "deterministic", counter: range.start + KEEP_OFFSET },
    });
    const res = await wallet.meltProofsBolt11(quote, send, { keysetId: wallet.keysetId }, { type: "deterministic", counter: range.start + CHANGE_OFFSET });
    if (res.quote.state !== MeltQuoteState.PAID) {
      // PENDING (or an odd UNPAID): leave the op to the recovery job, which checks the quote and the inputs.
      ctx.log.warn("ecash_melt_pending", { op_id: opId, mint_host: hostOf(mintUrl), state: res.quote.state });
      return { skipped: { mint: mintUrl, reason: `melt ${res.quote.state.toLowerCase()}` } };
    }
    const fee = inputSum - amount - sumSats(keep) - sumSats(res.change);
    await ctx.db.batch([
      spendReservedStmt(ctx, opId),
      ...(await sealProofStmts(ctx, mintUrl, [...keep, ...res.change], opId)),
      ctx.db
        .prepare(
          `UPDATE ecash_ops SET status = 'done', fee = ?2, updated_at = ?3,
                  detail = json_set(COALESCE(detail, '{}'), '$.preimage', ?4)
            WHERE op_id = ?1 AND status = 'pending'`,
        )
        .bind(opId, fee, ctx.now(), res.quote.payment_preimage ?? null),
    ]);
    ctx.log.info("ecash_melt", { op_id: opId, mint_host: hostOf(mintUrl), amount, fee });
    return { melted: { mint: mintUrl, amountSats: amount, feeSats: fee, opId } };
  } catch (e) {
    if (isMintOperationError(e)) {
      // The mint refused before anything moved (e.g. the pre-swap). The recovery job double-checks the inputs, so the
      // op stays pending only when the outcome is unknown.
      const states = await wallet.checkProofsStates(inputs).catch(() => null);
      if (states && states.every((s) => s.state === "UNSPENT")) {
        await releaseProofs(ctx, opId);
        await failOp(ctx, opId, `nut_${e.code}`, false);
      }
    }
    ctx.log.error("ecash_melt_failed", { op_id: opId, mint_host: hostOf(mintUrl), ...errorFields(e) });
    return { skipped: { mint: mintUrl, reason: "melt failed" } };
  }
}
