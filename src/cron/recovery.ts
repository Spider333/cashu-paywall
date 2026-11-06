// Recovery job: finish or roll back any op left pending for more than 15 minutes.
// Safe to run twice at once (the 03:00 daily cron and the */10 cron overlap): every settlement is guarded by a
// conditional pending -> done/failed flip with a claim id, and proof updates are idempotent.
import { CheckStateEnum, MeltQuoteState } from "@cashu/cashu-ts";
import type { Ctx } from "../core/context.js";
import { settleLightningOp } from "../core/lightning.js";
import { errorFields } from "../core/redact.js";
import {
  COUNTER_BLOCK,
  creditBatch,
  failOp,
  failRefundAndGiveBack,
  opDetail,
  releaseProofs,
  sealProofStmts,
  settleReservedByState,
  sumSats,
  type OpRow,
} from "../core/store.js";
import { getWallet } from "../core/wallet.js";

const STUCK_AFTER_MS = 15 * 60 * 1000;
/** An unpaid Lightning quote still pending after this long is given up (most mints expire quotes within an hour). */
const LIGHTNING_GIVE_UP_MS = 24 * 60 * 60 * 1000;

export async function recoverStuckOps(ctx: Ctx): Promise<number> {
  const stuck = await ctx.db
    .prepare("SELECT * FROM ecash_ops WHERE status = 'pending' AND updated_at < ? ORDER BY updated_at LIMIT 20")
    .bind(ctx.now() - STUCK_AFTER_MS)
    .all<OpRow>();
  let recovered = 0;
  for (const op of stuck.results) {
    let done = false;
    try {
      done = await recoverOp(ctx, op);
    } catch (e) {
      ctx.log.warn("ecash_recovery_retry_later", { op_id: op.op_id, kind: op.kind, ...errorFields(e) });
    }
    if (done) recovered++;
    else {
      // Not final yet: move it to the back of the queue so 20 stuck ops can't starve the rest.
      await ctx.db
        .prepare("UPDATE ecash_ops SET updated_at = ?2 WHERE op_id = ?1 AND status = 'pending'")
        .bind(op.op_id, ctx.now())
        .run();
    }
  }
  return recovered;
}

/** Rebuilds the op's outputs from the seed (NUT-09) and keeps those still unspent at the mint. */
async function restoreOutputs(ctx: Ctx, op: OpRow) {
  const wallet = await getWallet(ctx, op.mint_url);
  const r = await wallet.restore(op.counter_start!, op.counter_count ?? COUNTER_BLOCK, {
    keysetId: op.keyset_id ?? undefined,
  });
  if (r.proofs.length === 0) return r.proofs;
  const states = await wallet.checkProofsStates(r.proofs);
  return r.proofs.filter((_, i) => states[i]?.state === CheckStateEnum.UNSPENT);
}

/** True when the op reached a final state. */
async function recoverOp(ctx: Ctx, op: OpRow): Promise<boolean> {
  const wallet = await getWallet(ctx, op.mint_url);
  switch (op.kind) {
    case "topup_token": {
      const ys = (opDetail(op).ys as string[] | undefined) ?? [];
      const res = await wallet.mint.check({ Ys: ys });
      const states = res.states.map((s) => s.state);
      if (states.includes(CheckStateEnum.PENDING)) return false;
      if (states.length > 0 && states.every((s) => s === CheckStateEnum.UNSPENT)) {
        // The swap never happened: the token is still the payer's. Free its input_id so they can submit it again.
        await failOp(ctx, op.op_id, "recovered_unspent", true);
        ctx.log.info("ecash_recovered", { op_id: op.op_id, kind: op.kind, outcome: "failed_token_unspent" });
        return true;
      }
      const proofs = await restoreOutputs(ctx, op);
      const credited = sumSats(proofs);
      if (credited === 0) {
        // Spent, but not by us (none of our outputs were signed): someone else swapped the token first.
        await failOp(ctx, op.op_id, "ECASH_TOKEN_SPENT", false);
        ctx.log.info("ecash_recovered", { op_id: op.op_id, kind: op.kind, outcome: "failed_spent_elsewhere" });
        return true;
      }
      await creditBatch(ctx, op, proofs, credited, op.amount - credited, { recovered: true });
      ctx.log.info("ecash_recovered", { op_id: op.op_id, kind: op.kind, outcome: "credited", amount: credited });
      return true;
    }
    case "topup_lightning": {
      const s = await settleLightningOp(ctx, op);
      if (s.state !== "UNPAID") return true;
      if (ctx.now() - op.created_at > LIGHTNING_GIVE_UP_MS) {
        await failOp(ctx, op.op_id, "unpaid_given_up", false);
        return true;
      }
      return false;
    }
    case "refund": {
      // Settle each reserved input by its state at the mint; unused ones go back to the pot.
      const settled = await settleReservedByState(ctx, op.op_id, wallet);
      if (!settled) return false;
      if (settled.anySpent) {
        // The swap happened but the user never received the token: our outputs (send and keep) go back to the pot.
        const proofs = await restoreOutputs(ctx, op);
        await ctx.db.batch(await sealProofStmts(ctx, op.mint_url, proofs, op.op_id));
      }
      const gaveBack = await failRefundAndGiveBack(
        ctx,
        op,
        settled.anySpent ? "recovered_restored" : "recovered_unspent",
      );
      ctx.log.info("ecash_recovered", {
        op_id: op.op_id,
        kind: op.kind,
        outcome: gaveBack ? "given_back" : "already_settled",
      });
      return true;
    }
    case "melt": {
      const quoteId = opDetail(op).quote as string | undefined;
      if (!quoteId) {
        await releaseProofs(ctx, op.op_id);
        await failOp(ctx, op.op_id, "no_quote", false);
        return true;
      }
      const q = await wallet.checkMeltQuoteBolt11(quoteId);
      if (q.state === MeltQuoteState.PENDING) return false;
      // PAID or UNPAID: settle our reserved inputs by their real state, then keep whatever outputs we got (pre-swap
      // keep, unused send, melt change).
      const settled = await settleReservedByState(ctx, op.op_id, wallet);
      if (!settled) return false;
      if (settled.anySpent) {
        const proofs = await restoreOutputs(ctx, op);
        await ctx.db.batch(await sealProofStmts(ctx, op.mint_url, proofs, op.op_id));
      }
      if (q.state === MeltQuoteState.PAID) {
        await ctx.db
          .prepare(
            `UPDATE ecash_ops SET status = 'done', updated_at = ?2, detail = json_set(COALESCE(detail, '{}'), '$.preimage', ?3, '$.recovered', 1)
              WHERE op_id = ?1 AND status = 'pending'`,
          )
          .bind(op.op_id, ctx.now(), q.payment_preimage ?? null)
          .run();
        ctx.log.info("ecash_recovered", { op_id: op.op_id, kind: op.kind, outcome: "melt_paid" });
      } else {
        await failOp(ctx, op.op_id, "melt_unpaid", false);
        ctx.log.info("ecash_recovered", { op_id: op.op_id, kind: op.kind, outcome: "melt_released" });
      }
      return true;
    }
  }
}
