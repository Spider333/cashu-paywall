import type { Ctx } from "../core/context.js";
import { topupUrl } from "../core/context.js";
import { PaywallError, errorBody } from "../core/errors.js";
import type { TopupResult } from "../core/topup.js";
import type { RefundResult } from "../core/refund.js";
import type { BalanceInfo } from "../core/balance.js";
import { paymentRequest } from "../core/requests.js";
import { errorFields } from "../core/redact.js";

export const NO_STORE = { "Cache-Control": "no-store" };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE, ...headers } });
}

/** Any error -> the shared JSON error body with the right status and Retry-After. Unknown errors become ECASH_INTERNAL. */
export function errorResponse(ctx: Ctx, e: unknown, extraHeaders: Record<string, string> = {}): Response {
  const pe = toPaywallError(ctx, e);
  const headers: Record<string, string> = { ...extraHeaders };
  if (pe.httpStatus === 429) headers["Retry-After"] = "60";
  if (pe.httpStatus === 503) headers["Retry-After"] = "30";
  if (pe.paymentRequest) headers["X-Cashu"] = pe.paymentRequest;
  return json(errorBody(pe, topupUrl(ctx)), pe.httpStatus, headers);
}

export function toPaywallError(ctx: Ctx, e: unknown): PaywallError {
  if (e instanceof PaywallError) return e;
  ctx.log.error("ecash_internal_error", errorFields(e));
  return new PaywallError("ECASH_INTERNAL");
}

export function topupJson(ctx: Ctx, r: TopupResult, priceSats = ctx.priceSats): Record<string, unknown> {
  return {
    ...(r.key ? { key: r.key, warning: "Save this key now; it is shown once." } : {}),
    kid: r.kid,
    credited_sats: r.creditedSats,
    fee_sats: r.feeSats,
    balance_sats: r.balanceSats,
    mint: r.mint,
    calls_left: priceSats > 0 ? Math.floor(r.balanceSats / priceSats) : null,
    price_sats_per_call: priceSats,
    op_id: r.opId,
  };
}

export function balanceJson(ctx: Ctx, b: BalanceInfo, priceSats = ctx.priceSats): Record<string, unknown> {
  return {
    kid: b.kid,
    balance_sats: b.balanceSats,
    price_sats_per_call: priceSats,
    calls_left: priceSats > 0 ? Math.floor(b.balanceSats / priceSats) : null,
    mint: b.mint,
    accepted_mints: ctx.mints,
    calls: b.calls,
    topup_url: topupUrl(ctx),
    payment_request: paymentRequest(ctx, ctx.suggestedTopupSats),
  };
}

export function refundJson(r: RefundResult): Record<string, unknown> {
  return {
    token: r.token,
    amount_sats: r.amountSats,
    fee_sats: r.feeSats,
    balance_sats: 0,
    mint: r.mint,
    op_id: r.opId,
    warning: "This token is money. Paste it into a Cashu wallet now; anyone who sees it can claim it.",
  };
}
