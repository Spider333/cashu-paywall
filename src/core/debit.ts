import type { Ctx } from "./context.js";
import { PaywallError } from "./errors.js";
import { hashKey, isEcashKey, type EcashKey } from "./keys.js";
import { paymentRequest } from "./requests.js";
import { rateLimit } from "./ratelimit.js";
import { atomicDebit, getKeyRow } from "./store.js";

/** Result of `Paywall.debit`. A failed debit returns the error instead of throwing, so a hot path needs no try/catch. */
export type DebitResult =
  | { ok: true; balanceSats: number; kid: string }
  | { ok: false; error: PaywallError };

function positiveInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`cashu-paywall: ${what} must be a positive integer`);
}

/** One atomic statement per paid call. Never touches the mint. */
export async function debit(ctx: Ctx, key: EcashKey, amountSats: number): Promise<DebitResult> {
  positiveInt(amountSats, "debit amount");
  if (!isEcashKey(key)) return { ok: false, error: new PaywallError("ECASH_KEY_INVALID") };
  const { keyHash, kid } = await hashKey(ctx.cfg.keyPepper, key);
  if (!(await rateLimit(ctx, "call", kid))) return { ok: false, error: new PaywallError("ECASH_RATE_LIMITED") };
  const r = await atomicDebit(ctx, keyHash, amountSats);
  if (r.ok) {
    const balance = r.balance ?? (await getKeyRow(ctx, keyHash))?.balance ?? 0;
    return { ok: true, balanceSats: balance, kid };
  }
  const row = await ctx.db.prepare("SELECT status, balance FROM ecash_keys WHERE key_hash = ?").bind(keyHash).first<{ status: string; balance: number }>();
  if (!row) return { ok: false, error: new PaywallError("ECASH_KEY_INVALID") };
  if (row.status === "frozen") return { ok: false, error: new PaywallError("ECASH_KEY_FROZEN") };
  return {
    ok: false,
    error: new PaywallError("ECASH_INSUFFICIENT_BALANCE", {
      paymentRequest: paymentRequest(ctx, ctx.suggestedTopupSats),
      details: { price_sats: amountSats, balance_sats: row.balance },
    }),
  };
}

/** Gives back a debit (a failed paid call). Reverses the counters the debit moved. */
export async function credit(ctx: Ctx, key: EcashKey, amountSats: number, reason: "data_source_error"): Promise<void> {
  positiveInt(amountSats, "credit amount");
  if (!isEcashKey(key)) throw new PaywallError("ECASH_KEY_INVALID");
  const { keyHash, kid } = await hashKey(ctx.cfg.keyPepper, key);
  const r = await ctx.db
    .prepare(
      `UPDATE ecash_keys SET balance = balance + ?1, spent_total = MAX(spent_total - ?1, 0), calls = MAX(calls - 1, 0)
        WHERE key_hash = ?2 AND spent_total >= ?1`,
    )
    .bind(amountSats, keyHash)
    .run();
  if (r.meta.changes !== 1) throw new PaywallError("ECASH_KEY_INVALID");
  ctx.log.info("ecash_credit_back", { kid, amount: amountSats, reason });
}
