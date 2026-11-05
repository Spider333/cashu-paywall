// The crash-safe token top-up (PRD 6.6): every mint call is recorded before it is made.
import { getTokenMetadata, isMintOperationError } from "@cashu/cashu-ts";
import type { Ctx } from "./context.js";
import { hostOf, normalizeMintUrl } from "./context.js";
import { sha256Hex } from "./crypto.js";
import { PaywallError } from "./errors.js";
import { hashKey, isEcashKey, newKey, type EcashKey } from "./keys.js";
import { paymentRequest } from "./requests.js";
import { errorFields } from "./redact.js";
import {
  COUNTER_BLOCK, D1CounterSource, bindKeyToMint, creditBatch, failOp, getKeyRow, getOpByInput, insertKeyStmt, insertOpStmt,
  newOpId, proofY, sats, sumSats, totalHeld, type KeyRow,
} from "./store.js";
import { NUT_ALREADY_SPENT, getWallet } from "./wallet.js";

export interface TopupResult {
  key?: EcashKey;
  kid: string;
  creditedSats: number;
  feeSats: number;
  balanceSats: number;
  mint: string;
  opId: string;
}

/** Looks up a key for a money-in or money-out call. Throws KEY_INVALID / KEY_FROZEN. */
export async function requireKey(ctx: Ctx, key: string): Promise<{ row: KeyRow; kid: string }> {
  if (!isEcashKey(key)) throw new PaywallError("ECASH_KEY_INVALID");
  const { keyHash, kid } = await hashKey(ctx.cfg.keyPepper, key);
  const row = await getKeyRow(ctx, keyHash);
  if (!row) throw new PaywallError("ECASH_KEY_INVALID");
  if (row.status === "frozen") throw new PaywallError("ECASH_KEY_FROZEN");
  return { row, kid };
}

/** NUT-10 well-known secrets (P2PK, HTLC) carry spending conditions this server can't satisfy. */
function isLockedSecret(secret: string): boolean {
  if (!secret.startsWith("[")) return false;
  try {
    const v = JSON.parse(secret) as unknown;
    return Array.isArray(v) && typeof v[0] === "string";
  } catch {
    return false;
  }
}

export async function topupWithToken(
  ctx: Ctx, token: string, key?: EcashKey, opts: { minCreditSats?: number } = {},
): Promise<TopupResult> {
  // 1. Size and shape (no network).
  if (typeof token !== "string") throw new PaywallError("ECASH_TOKEN_INVALID");
  token = token.trim();
  if (token.length === 0 || token.length > ctx.limits.maxTokenChars) throw new PaywallError("ECASH_TOKEN_INVALID");
  if (!/^cashu[AB]/.test(token)) throw new PaywallError("ECASH_TOKEN_INVALID");
  let meta: ReturnType<typeof getTokenMetadata>;
  let mintUrl: string;
  let amount: number;
  try {
    meta = getTokenMetadata(token);
    mintUrl = normalizeMintUrl(meta.mint);
    amount = sats(meta.amount);
  } catch {
    throw new PaywallError("ECASH_TOKEN_INVALID");
  }
  const secrets = meta.incompleteProofs.map((p) => p.secret);
  if (secrets.length === 0 || amount === 0) throw new PaywallError("ECASH_TOKEN_INVALID");

  // 2. Policy checks before any mint call.
  if (!ctx.mints.includes(mintUrl)) throw new PaywallError("ECASH_MINT_NOT_ALLOWED", { details: { mints: ctx.mints } });
  if ((meta.unit ?? "sat") !== "sat") throw new PaywallError("ECASH_UNIT_NOT_ALLOWED");
  if (secrets.length > ctx.limits.maxProofsPerToken) throw new PaywallError("ECASH_TOKEN_INVALID", { message: "The token has too many proofs." });
  if (amount < ctx.limits.minTopupSats) throw new PaywallError("ECASH_AMOUNT_TOO_LOW", { details: { min_topup_sats: ctx.limits.minTopupSats } });
  if (amount > ctx.limits.maxTopupSats) throw new PaywallError("ECASH_AMOUNT_TOO_HIGH", { details: { max_topup_sats: ctx.limits.maxTopupSats } });
  if (secrets.some(isLockedSecret)) throw new PaywallError("ECASH_TOKEN_LOCKED");

  // 3. Key: validate and bind an existing one, or prepare a new one (inserted with the op in step 4).
  let keyHash: string;
  let kid: string;
  let created: EcashKey | undefined;
  let balanceBefore = 0;
  if (key !== undefined) {
    const k = await requireKey(ctx, key);
    kid = k.kid;
    keyHash = k.row.key_hash;
    balanceBefore = k.row.balance;
    if (balanceBefore + amount > ctx.limits.maxBalanceSats) throw new PaywallError("ECASH_BALANCE_CAP", { details: { max_balance_sats: ctx.limits.maxBalanceSats } });
    const bound = k.row.mint_url ?? (await bindKeyToMint(ctx, keyHash, mintUrl))?.mint_url;
    if (bound !== mintUrl) throw new PaywallError("ECASH_MINT_MISMATCH", { details: { key_mint: bound } });
  } else {
    if (amount > ctx.limits.maxBalanceSats) throw new PaywallError("ECASH_BALANCE_CAP", { details: { max_balance_sats: ctx.limits.maxBalanceSats } });
    created = newKey();
    ({ keyHash, kid } = await hashKey(ctx.cfg.keyPepper, created));
  }
  if ((await totalHeld(ctx)) + amount > ctx.limits.maxTotalHeldSats) throw new PaywallError("ECASH_POT_FULL");

  // The wallet (mint info + keys, usually from the D1 cache). Unreachable mint -> MINT_UNAVAILABLE, nothing spent.
  const wallet = await getWallet(ctx, mintUrl);
  // Decode (short keyset ids need the mint's keysets) and price the swap. A keyset we haven't cached yet (key rotation):
  // refresh from the mint once, then decide.
  const decodeAndFee = () => {
    const d = wallet.decodeToken(token);
    return { decoded: d, fee: sats(wallet.getFeesForProofs(d.proofs)) };
  };
  let priced: ReturnType<typeof decodeAndFee>;
  try {
    priced = decodeAndFee();
  } catch {
    try {
      await wallet.loadMint(true);
      priced = decodeAndFee();
    } catch {
      throw new PaywallError("ECASH_TOKEN_INVALID", { message: "The token could not be read with its mint's keysets." });
    }
  }
  const { decoded, fee } = priced;
  const minCredit = Math.max(1, opts.minCreditSats ?? 1);
  if (amount - fee < minCredit) {
    throw new PaywallError("ECASH_AMOUNT_TOO_LOW", { details: { amount_sats: amount, fee_sats: fee, min_credit_sats: minCredit } });
  }

  // 4. Claim the token locally: input_id is UNIQUE, so one token reaches the mint at most once from here.
  const ys = secrets.map(proofY).sort();
  const inputId = await sha256Hex(ys.join(""));
  const keysetId = wallet.keysetId;
  const range = await new D1CounterSource(ctx.db).reserve(keysetId, COUNTER_BLOCK);
  const opId = newOpId();
  const opStmt = insertOpStmt(ctx, {
    op_id: opId, kind: "topup_token", key_hash: keyHash, mint_url: mintUrl, input_id: inputId, amount,
    keyset_id: keysetId, counter_start: range.start, counter_count: range.count, detail: { ys },
  });
  try {
    if (created) await ctx.db.batch([insertKeyStmt(ctx, keyHash, kid, mintUrl), opStmt]);
    else await opStmt.run();
  } catch (e) {
    if (!/UNIQUE/i.test(String((e as Error)?.message))) throw e;
    const prior = await getOpByInput(ctx, inputId);
    if (prior?.status === "pending") throw new PaywallError("ECASH_PENDING");
    throw new PaywallError("ECASH_TOKEN_SPENT");
  }

  // 5. Swap at the mint, outputs derived from the seed at the reserved counters (recoverable by NUT-09 restore).
  await ctx.hooks.beforeSwap?.("topup_token");
  let proofs;
  try {
    proofs = await wallet.receive(decoded, { keysetId }, { type: "deterministic", counter: range.start });
  } catch (e) {
    if (isMintOperationError(e)) {
      const spent = e.code === NUT_ALREADY_SPENT;
      await failOp(ctx, opId, spent ? "ECASH_TOKEN_SPENT" : `nut_${e.code}`, !spent);
      ctx.log.info("ecash_topup_rejected", { kid, op_id: opId, mint_host: hostOf(mintUrl), ...errorFields(e) });
      if (spent) throw new PaywallError("ECASH_TOKEN_SPENT");
      throw new PaywallError("ECASH_TOKEN_INVALID", { message: "The mint rejected this token." });
    }
    // Network failure, timeout, 5xx: the mint may or may not have swapped. Leave the op pending for the recovery job.
    ctx.log.warn("ecash_topup_pending", { kid, op_id: opId, mint_host: hostOf(mintUrl), ...errorFields(e) });
    throw new PaywallError("ECASH_PENDING");
  }
  await ctx.hooks.afterSwap?.("topup_token");

  // 6. Credit batch (one transaction): proofs in, key credited, op done.
  const credited = sumSats(proofs);
  const realFee = amount - credited;
  try {
    await creditBatch(ctx, { op_id: opId, mint_url: mintUrl, key_hash: keyHash }, proofs, credited, realFee);
  } catch (e) {
    ctx.log.error("ecash_credit_failed", { kid, op_id: opId, ...errorFields(e) });
    throw new PaywallError("ECASH_PENDING");
  }
  const after = await getKeyRow(ctx, keyHash);
  ctx.log.info("ecash_topup", { kid, op_id: opId, mint_host: hostOf(mintUrl), amount, fee: realFee, balance_after: after?.balance });
  return {
    ...(created ? { key: created } : {}),
    kid, creditedSats: credited, feeSats: realFee, balanceSats: after?.balance ?? balanceBefore + credited, mint: mintUrl, opId,
  };
}

/** The payment request attached to errors that paying would fix. */
export function topupRequest(ctx: Ctx): string {
  return paymentRequest(ctx, ctx.suggestedTopupSats);
}
