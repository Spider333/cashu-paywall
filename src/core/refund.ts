// Refund: empty the key, hand back the balance minus the mint's swap fee as a fresh token.
import { getEncodedToken, isMintOperationError } from "@cashu/cashu-ts";
import type { Ctx } from "./context.js";
import { hostOf } from "./context.js";
import { PaywallError } from "./errors.js";
import type { EcashKey } from "./keys.js";
import { errorFields } from "./redact.js";
import {
  COUNTER_BLOCK, D1CounterSource, KEEP_OFFSET, failRefundAndGiveBack, newOpId, openProofs, releaseProofs, reserveProofs,
  sats, sealProofStmts, selectProofs, spendReservedStmt, type ProofRow,
} from "./store.js";
import { requireKey } from "./topup.js";
import { getWallet, isCounterReuse, skipCounterAhead } from "./wallet.js";

class CounterReused extends Error {}

/** A finished refund. `token` is a Cashu token worth `amountSats`: it is money, so hand it to the key's owner only. */
export interface RefundResult {
  token: string;
  amountSats: number;
  feeSats: number;
  balanceSats: 0;
  mint: string;
  opId: string;
}

export async function refund(ctx: Ctx, key: EcashKey): Promise<RefundResult> {
  const { row, kid } = await requireKey(ctx, key);
  const mintUrl = row.mint_url;
  if (!mintUrl || row.balance <= 0) throw new PaywallError("ECASH_NOTHING_TO_REFUND");
  const wallet = await getWallet(ctx, mintUrl);

  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await ctx.db.prepare("SELECT balance FROM ecash_keys WHERE key_hash = ?").bind(row.key_hash).first<{ balance: number }>();
    const B = cur?.balance ?? 0;
    if (B <= 0) throw new PaywallError("ECASH_NOTHING_TO_REFUND");
    const picked = await selectProofs(ctx, mintUrl, B);
    if (!picked) {
      ctx.log.error("ecash_pot_short", { kid, mint_host: hostOf(mintUrl), amount: B });
      throw new PaywallError("ECASH_INTERNAL");
    }
    const fee = sats(wallet.getFeesForProofs(picked.map((p) => ({ id: p.keyset_id }))));
    if (B <= fee) throw new PaywallError("ECASH_NOTHING_TO_REFUND", { details: { balance_sats: B, fee_sats: fee } });

    // Zero the balance and record the op in ONE transaction: the op insert only happens if the balance is still B,
    // so a racing debit or refund makes both statements do nothing.
    const opId = newOpId();
    const keysetId = wallet.keysetId;
    const range = await new D1CounterSource(ctx.db).reserve(keysetId, COUNTER_BLOCK);
    const now = ctx.now();
    const [ins, zero] = await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO ecash_ops (op_id, kind, status, key_hash, mint_url, input_id, amount, keyset_id, counter_start, counter_count, created_at, updated_at)
           SELECT ?1, 'refund', 'pending', ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?8
            WHERE EXISTS (SELECT 1 FROM ecash_keys WHERE key_hash = ?2 AND balance = ?4 AND status = 'active')`,
        )
        .bind(opId, row.key_hash, mintUrl, B, keysetId, range.start, range.count, now),
      ctx.db
        .prepare("UPDATE ecash_keys SET balance = 0, refunded_total = refunded_total + ?1, last_used_at = ?3 WHERE key_hash = ?2 AND balance = ?1 AND status = 'active'")
        .bind(B, row.key_hash, now),
    ]);
    if (ins!.meta.changes !== 1 || zero!.meta.changes !== 1) continue; // balance moved under us: re-read and retry

    if (!(await reserveProofs(ctx, picked, opId))) {
      // Another refund or melt took some of these proofs. Undo and retry with a fresh selection.
      await failRefundAndGiveBack(ctx, { op_id: opId, key_hash: row.key_hash, amount: B }, "reserve_conflict");
      continue;
    }
    try {
      return await runRefundSwap(ctx, wallet, { opId, keyHash: row.key_hash, kid, mintUrl, B, fee, picked, counter: range.start });
    } catch (e) {
      if (!(e instanceof CounterReused) || attempt === 2) throw e instanceof CounterReused ? new PaywallError("ECASH_MINT_UNAVAILABLE") : e;
      await skipCounterAhead(ctx, keysetId, range.start); // balance and proofs were restored; retry with fresh outputs
    }
  }
  throw new PaywallError("ECASH_PENDING", { message: "The balance changed during the refund. Try again." });
}

async function runRefundSwap(
  ctx: Ctx, wallet: Awaited<ReturnType<typeof getWallet>>,
  r: { opId: string; keyHash: string; kid: string; mintUrl: string; B: number; fee: number; picked: ProofRow[]; counter: number },
): Promise<RefundResult> {
  const inputs = await openProofs(ctx, r.picked);
  const sendAmount = r.B - r.fee;
  await ctx.hooks.beforeSwap?.("refund");
  let res;
  try {
    res = await wallet.send(sendAmount, inputs, { includeFees: false, keysetId: wallet.keysetId }, {
      send: { type: "deterministic", counter: r.counter },
      keep: { type: "deterministic", counter: r.counter + KEEP_OFFSET },
    });
  } catch (e) {
    if (isMintOperationError(e)) {
      // The mint refused: nothing moved. Release the proofs and restore the balance at once.
      await releaseProofs(ctx, r.opId);
      await failRefundAndGiveBack(ctx, { op_id: r.opId, key_hash: r.keyHash, amount: r.B }, `nut_${e.code}`);
      if (isCounterReuse(e)) throw new CounterReused();
      ctx.log.error("ecash_refund_rejected", { kid: r.kid, op_id: r.opId, ...errorFields(e) });
      throw new PaywallError("ECASH_MINT_UNAVAILABLE", { message: "The mint refused the refund swap. Your balance is restored; try again later." });
    }
    ctx.log.warn("ecash_refund_pending", { kid: r.kid, op_id: r.opId, ...errorFields(e) });
    throw new PaywallError("ECASH_PENDING", { message: "The refund's outcome is unknown. If it did not go through, your balance comes back within 15 minutes." });
  }
  await ctx.hooks.afterSwap?.("refund");
  const keepStmts = await sealProofStmts(ctx, r.mintUrl, res.keep, r.opId);
  await ctx.db.batch([
    spendReservedStmt(ctx, r.opId),
    ...keepStmts,
    ctx.db
      .prepare("UPDATE ecash_ops SET status = 'done', fee = ?2, credited = 0, updated_at = ?3 WHERE op_id = ?1 AND status = 'pending'")
      .bind(r.opId, r.fee, ctx.now()),
  ]);
  const token = getEncodedToken({ mint: r.mintUrl, proofs: res.send, unit: "sat" });
  ctx.log.info("ecash_refund", { kid: r.kid, op_id: r.opId, mint_host: hostOf(r.mintUrl), amount: sendAmount, fee: r.fee, balance_after: 0 });
  return { token, amountSats: sendAmount, feeSats: r.fee, balanceSats: 0, mint: r.mintUrl, opId: r.opId };
}
