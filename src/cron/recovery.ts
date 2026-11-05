// Recovery job (PRD 6.6): finish or roll back any op left pending for more than 15 minutes.
import { CheckStateEnum, MeltQuoteState } from "@cashu/cashu-ts";
import type { Ctx } from "../core/context.js";
import { settleLightningOp } from "../core/lightning.js";
import { errorFields } from "../core/redact.js";
import { giveBackRefund } from "../core/refund.js";
import {
  COUNTER_BLOCK, creditBatch, failOp, openProofs, opDetail, releaseProofs, sealProofStmts, spendReservedStmt, sumSats,
  type OpRow, type ProofRow,
} from "../core/store.js";
import { getWallet } from "../core/wallet.js";

export const STUCK_AFTER_MS = 15 * 60 * 1000;

export async function recoverStuckOps(ctx: Ctx): Promise<number> {
  const stuck = await ctx.db
    .prepare("SELECT * FROM ecash_ops WHERE status = 'pending' AND updated_at < ? ORDER BY updated_at LIMIT 20")
    .bind(ctx.now() - STUCK_AFTER_MS)
    .all<OpRow>();
  let recovered = 0;
  for (const op of stuck.results) {
    try {
      if (await recoverOp(ctx, op)) recovered++;
    } catch (e) {
      ctx.log.warn("ecash_recovery_retry_later", { op_id: op.op_id, kind: op.kind, ...errorFields(e) });
    }
  }
  return recovered;
}

async function restoreOutputs(ctx: Ctx, op: OpRow) {
  const wallet = await getWallet(ctx, op.mint_url);
  const r = await wallet.restore(op.counter_start!, op.counter_count ?? COUNTER_BLOCK, { keysetId: op.keyset_id ?? undefined });
  if (r.proofs.length === 0) return r.proofs;
  // Keep only outputs that are still unspent at the mint (a restore returns everything the mint ever signed).
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
      return s.state !== "UNPAID";
    }
    case "refund": {
      const reserved = await ctx.db.prepare("SELECT * FROM ecash_proofs WHERE op_id = ? AND state = 'reserved'").bind(op.op_id).all<ProofRow>();
      let anySpent = false;
      if (reserved.results.length > 0) {
        const inputs = await openProofs(ctx, reserved.results);
        const states = await wallet.checkProofsStates(inputs);
        if (states.some((s) => s.state === CheckStateEnum.PENDING)) return false;
        anySpent = states.some((s) => s.state === CheckStateEnum.SPENT);
      }
      if (!anySpent) {
        await releaseProofs(ctx, op.op_id);
      } else {
        // The swap happened but the user never received the token: our outputs (send and keep) go back to the pot.
        const proofs = await restoreOutputs(ctx, op);
        await ctx.db.batch([spendReservedStmt(ctx, op.op_id), ...(await sealProofStmts(ctx, op.mint_url, proofs, op.op_id))]);
      }
      await giveBackRefund(ctx, op.key_hash!, op.amount);
      await failOp(ctx, op.op_id, anySpent ? "recovered_restored" : "recovered_unspent", false);
      ctx.log.info("ecash_recovered", { op_id: op.op_id, kind: op.kind, outcome: anySpent ? "restored_and_given_back" : "given_back" });
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
      if (q.state === MeltQuoteState.PAID) {
        const change = await restoreOutputs(ctx, op);
        await ctx.db.batch([
          spendReservedStmt(ctx, op.op_id),
          ...(await sealProofStmts(ctx, op.mint_url, change, op.op_id)),
          ctx.db
            .prepare(
              `UPDATE ecash_ops SET status = 'done', updated_at = ?2, detail = json_set(COALESCE(detail, '{}'), '$.preimage', ?3, '$.recovered', 1)
                WHERE op_id = ?1 AND status = 'pending'`,
            )
            .bind(op.op_id, ctx.now(), q.payment_preimage ?? null),
        ]);
        ctx.log.info("ecash_recovered", { op_id: op.op_id, kind: op.kind, outcome: "melt_paid" });
        return true;
      }
      // UNPAID: the Lightning payment did not happen. The pre-swap may have, so check our inputs before releasing.
      const reserved = await ctx.db.prepare("SELECT * FROM ecash_proofs WHERE op_id = ? AND state = 'reserved'").bind(op.op_id).all<ProofRow>();
      const inputs = reserved.results.length ? await openProofs(ctx, reserved.results) : [];
      const states = inputs.length ? await wallet.checkProofsStates(inputs) : [];
      if (states.some((s) => s.state === CheckStateEnum.PENDING)) return false;
      if (states.some((s) => s.state === CheckStateEnum.SPENT)) {
        const proofs = await restoreOutputs(ctx, op);
        await ctx.db.batch([spendReservedStmt(ctx, op.op_id), ...(await sealProofStmts(ctx, op.mint_url, proofs, op.op_id))]);
      } else {
        await releaseProofs(ctx, op.op_id);
      }
      await failOp(ctx, op.op_id, "melt_unpaid", false);
      ctx.log.info("ecash_recovered", { op_id: op.op_id, kind: op.kind, outcome: "melt_released" });
      return true;
    }
  }
}
