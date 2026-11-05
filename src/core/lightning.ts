// Lightning top-up (PRD 6.5 D): a NUT-04 mint quote, NUT-20 locked when the mint supports it. The quote id never
// leaves the server: the browser only sees our op id.
import { MintQuoteState, isMintOperationError } from "@cashu/cashu-ts";
import type { Ctx } from "./context.js";
import { hostOf, topupUrl } from "./context.js";
import { PaywallError } from "./errors.js";
import { hashKey, newKey, type EcashKey } from "./keys.js";
import { errorFields } from "./redact.js";
import {
  COUNTER_BLOCK, D1CounterSource, creditBatch, failOp, getKeyRow, getOp, insertKeyStmt, insertOpStmt, newOpId, opDetail,
  sats, sumSats, totalHeld, type OpRow,
} from "./store.js";
import { requireKey } from "./topup.js";
import { NUT_QUOTE_ISSUED, getWallet, isCounterReuse, nut20Key, skipCounterAhead } from "./wallet.js";

export interface LightningTopup {
  opId: string;
  key?: EcashKey;
  kid: string;
  invoice: string;
  amountSats: number;
  /** Unix ms, or null when the mint sets no expiry. */
  expiresAt: number | null;
  statusUrl: string;
}

export type LightningTopupStatus =
  | { state: "UNPAID" | "EXPIRED"; opId: string }
  | { state: "CREDITED"; opId: string; kid: string; balanceSats: number };

export async function startLightningTopup(ctx: Ctx, amountSats: number, key?: EcashKey): Promise<LightningTopup> {
  if (!Number.isSafeInteger(amountSats) || amountSats < ctx.limits.minTopupSats) {
    throw new PaywallError("ECASH_AMOUNT_TOO_LOW", { details: { min_topup_sats: ctx.limits.minTopupSats } });
  }
  if (amountSats > ctx.limits.maxTopupSats) throw new PaywallError("ECASH_AMOUNT_TOO_HIGH", { details: { max_topup_sats: ctx.limits.maxTopupSats } });

  let keyHash: string;
  let kid: string;
  let created: EcashKey | undefined;
  let mintUrl = ctx.mints[0]!;
  if (key !== undefined) {
    const k = await requireKey(ctx, key);
    ({ kid } = k);
    keyHash = k.row.key_hash;
    if (k.row.balance + amountSats > ctx.limits.maxBalanceSats) throw new PaywallError("ECASH_BALANCE_CAP", { details: { max_balance_sats: ctx.limits.maxBalanceSats } });
    if (k.row.mint_url) {
      if (!ctx.mints.includes(k.row.mint_url)) throw new PaywallError("ECASH_MINT_MISMATCH", { details: { key_mint: k.row.mint_url } });
      mintUrl = k.row.mint_url;
    }
  } else {
    if (amountSats > ctx.limits.maxBalanceSats) throw new PaywallError("ECASH_BALANCE_CAP", { details: { max_balance_sats: ctx.limits.maxBalanceSats } });
    created = newKey();
    ({ keyHash, kid } = await hashKey(ctx.cfg.keyPepper, created));
  }
  if ((await totalHeld(ctx)) + amountSats > ctx.limits.maxTotalHeldSats) throw new PaywallError("ECASH_POT_FULL");

  const wallet = await getWallet(ctx, mintUrl);
  const locked = wallet.getMintInfo().isSupported(20).supported;
  let quote;
  try {
    quote = locked
      ? await wallet.createLockedMintQuote(amountSats, (await nut20Key(ctx)).pubkey)
      : await wallet.createMintQuoteBolt11(amountSats);
  } catch (e) {
    ctx.log.warn("ecash_ln_quote_failed", { kid, mint_host: hostOf(mintUrl), ...errorFields(e) });
    throw new PaywallError("ECASH_MINT_UNAVAILABLE");
  }
  // Creating a quote moves no money, so the op is written right after it (the quote id is its input_id).
  const range = await new D1CounterSource(ctx.db).reserve(wallet.keysetId, COUNTER_BLOCK);
  const opId = newOpId();
  const expiresAt = quote.expiry ? quote.expiry * 1000 : null;
  const opStmt = insertOpStmt(ctx, {
    op_id: opId, kind: "topup_lightning", key_hash: keyHash, mint_url: mintUrl, input_id: quote.quote, amount: amountSats,
    keyset_id: wallet.keysetId, counter_start: range.start, counter_count: range.count, detail: { locked, expires_at: expiresAt },
  });
  if (created) await ctx.db.batch([insertKeyStmt(ctx, keyHash, kid, mintUrl), opStmt]);
  else {
    await ctx.db.prepare("UPDATE ecash_keys SET mint_url = ?1 WHERE key_hash = ?2 AND mint_url IS NULL").bind(mintUrl, keyHash).run();
    await opStmt.run();
  }
  ctx.log.info("ecash_ln_quote", { kid, op_id: opId, mint_host: hostOf(mintUrl), amount: amountSats });
  return {
    opId, ...(created ? { key: created } : {}), kid, invoice: quote.request, amountSats, expiresAt,
    statusUrl: `${topupUrl(ctx)}/lightning/${opId}`,
  };
}

/** Polled by the page. When the quote is paid, mints and credits once (a second poll finds the op done). */
export async function checkLightningTopup(ctx: Ctx, opId: string): Promise<LightningTopupStatus> {
  if (typeof opId !== "string" || !/^[0-9a-f-]{36}$/.test(opId)) throw notFound();
  const op = await getOp(ctx, opId);
  if (!op || op.kind !== "topup_lightning") throw notFound();
  return settleLightningOp(ctx, op);
}

function notFound(): PaywallError {
  return new PaywallError("ECASH_TOKEN_INVALID", { message: "Unknown Lightning top-up.", httpStatus: 404 });
}

async function credited(ctx: Ctx, op: OpRow): Promise<LightningTopupStatus> {
  const k = op.key_hash ? await getKeyRow(ctx, op.key_hash) : null;
  return { state: "CREDITED", opId: op.op_id, kid: k?.kid ?? "", balanceSats: k?.balance ?? 0 };
}

/** Shared by the status poll and the recovery job. */
export async function settleLightningOp(ctx: Ctx, op: OpRow): Promise<LightningTopupStatus> {
  if (op.status === "done") return credited(ctx, op);
  if (op.status === "failed") return { state: "EXPIRED", opId: op.op_id };
  const wallet = await getWallet(ctx, op.mint_url);
  let quote;
  try {
    quote = await wallet.checkMintQuoteBolt11(op.input_id!);
  } catch (e) {
    ctx.log.warn("ecash_ln_check_failed", { op_id: op.op_id, ...errorFields(e) });
    throw new PaywallError("ECASH_MINT_UNAVAILABLE");
  }
  const paid = quote.amount_paid !== undefined ? sats(quote.amount_paid) >= op.amount : quote.state !== MintQuoteState.UNPAID;
  if (!paid) {
    const exp = opDetail(op).expires_at;
    if (typeof exp === "number" && ctx.now() > exp) {
      await failOp(ctx, op.op_id, "expired", false);
      return { state: "EXPIRED", opId: op.op_id };
    }
    return { state: "UNPAID", opId: op.op_id };
  }
  const issued = quote.amount_issued !== undefined ? sats(quote.amount_issued) >= op.amount : quote.state === MintQuoteState.ISSUED;
  const locked = opDetail(op).locked === true;
  let proofs;
  if (!issued) {
    try {
      proofs = await wallet.mintProofsBolt11(op.amount, quote, {
        keysetId: op.keyset_id ?? undefined, ...(locked ? { privkey: (await nut20Key(ctx)).privkey } : {}),
      }, { type: "deterministic", counter: op.counter_start! });
    } catch (e) {
      if (isCounterReuse(e)) {
        // Nothing was issued. Skip the counter ahead, give this op a fresh block, and let the next poll mint.
        const keysetId = op.keyset_id ?? wallet.keysetId;
        await skipCounterAhead(ctx, keysetId, op.counter_start ?? 0);
        const range = await new D1CounterSource(ctx.db).reserve(keysetId, COUNTER_BLOCK);
        await ctx.db.prepare("UPDATE ecash_ops SET counter_start = ?2, counter_count = ?3 WHERE op_id = ?1 AND status = 'pending'")
          .bind(op.op_id, range.start, range.count).run();
        throw new PaywallError("ECASH_PENDING");
      }
      if (!(isMintOperationError(e) && e.code === NUT_QUOTE_ISSUED)) {
        ctx.log.warn("ecash_ln_mint_failed", { op_id: op.op_id, ...errorFields(e) });
        throw new PaywallError("ECASH_PENDING");
      }
    }
  }
  if (!proofs) {
    // Already issued (a crash after minting, or a racing poll): rebuild our outputs from the seed (NUT-09).
    const r = await wallet.restore(op.counter_start!, op.counter_count ?? COUNTER_BLOCK, { keysetId: op.keyset_id ?? undefined });
    proofs = r.proofs;
  }
  const amount = sumSats(proofs);
  if (amount <= 0) throw new PaywallError("ECASH_PENDING");
  await creditBatch(ctx, op, proofs, amount, 0);
  const fresh = (await getOp(ctx, op.op_id))!;
  ctx.log.info("ecash_topup_lightning", { op_id: op.op_id, mint_host: hostOf(op.mint_url), amount });
  return credited(ctx, fresh);
}
