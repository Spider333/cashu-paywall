import type { Ctx } from "./context.js";
import { PaywallError } from "./errors.js";
import { hashKey, isEcashKey, newKey, type EcashKey } from "./keys.js";
import { getKeyRow, insertKeyStmt } from "./store.js";

export interface BalanceInfo {
  kid: string;
  balanceSats: number;
  mint: string | null;
  calls: number;
  createdAt: number;
  lastUsedAt: number | null;
}

export async function balance(ctx: Ctx, key: EcashKey): Promise<BalanceInfo> {
  if (!isEcashKey(key)) throw new PaywallError("ECASH_KEY_INVALID");
  const { keyHash } = await hashKey(ctx.cfg.keyPepper, key);
  const row = await getKeyRow(ctx, keyHash);
  if (!row) throw new PaywallError("ECASH_KEY_INVALID");
  if (row.status === "frozen") throw new PaywallError("ECASH_KEY_FROZEN");
  return { kid: row.kid, balanceSats: row.balance, mint: row.mint_url, calls: row.calls, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}

/** A new 0-credit key. The key itself is returned once and never stored. */
export async function createKey(ctx: Ctx): Promise<{ key: EcashKey; kid: string }> {
  const key = newKey();
  const { keyHash, kid } = await hashKey(ctx.cfg.keyPepper, key);
  await insertKeyStmt(ctx, keyHash, kid, null).run();
  ctx.log.info("ecash_key_created", { kid });
  return { key, kid };
}
