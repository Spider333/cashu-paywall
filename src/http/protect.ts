// NUT-24 on plain HTTP routes (PRD 6.5 C): 402 + X-Cashu: creqA..., then serve on a retry that pays.
import type { Ctx } from "../core/context.js";
import { topupUrl } from "../core/context.js";
import { credit, debit } from "../core/debit.js";
import { PaywallError } from "../core/errors.js";
import { bearerFrom, isEcashKey, type EcashKey } from "../core/keys.js";
import { clientIp, rateLimit } from "../core/ratelimit.js";
import { paymentRequest } from "../core/requests.js";
import { topupWithToken } from "../core/topup.js";
import { errorResponse, json } from "./json.js";

export type PaidHandler = (request: Request, paid: { kid: string; balanceSats: number }) => Promise<Response>;

export interface PaymentHeaders {
  key?: EcashKey;
  kid: string;
  balanceSats: number;
}

export function paymentRequiredResponse(ctx: Ctx, priceSats: number, description?: string, extra: Record<string, unknown> = {}): Response {
  const pr = paymentRequest(ctx, priceSats, { description });
  return json(
    {
      error: "Payment required: pay with a Cashu token in the X-Cashu header.",
      code: "ECASH_PAYMENT_REQUIRED",
      retryable: false,
      price_sats: priceSats,
      unit: "sat",
      mints: ctx.mints,
      payment_request: pr,
      topup_url: topupUrl(ctx),
      ...extra,
    },
    402,
    { "X-Cashu": pr },
  );
}

/** Adds X-Ecash-* headers to a handler's response (its headers may be immutable, so copy). */
export function withPaymentHeaders(res: Response, h: PaymentHeaders): Response {
  const out = new Response(res.body, res);
  if (h.key) out.headers.set("X-Ecash-Key", h.key);
  out.headers.set("X-Ecash-Balance", String(h.balanceSats));
  out.headers.set("X-Ecash-Kid", h.kid);
  out.headers.set("Cache-Control", "no-store");
  return out;
}

/**
 * Reads an X-Cashu token (and optional bearer) and tops up. Shared by protect() and the demo's /mcp.
 * Returns null when there is no X-Cashu header.
 */
export async function topupFromHeader(
  ctx: Ctx, request: Request, minCreditSats?: number,
): Promise<{ key: EcashKey; created?: EcashKey; kid: string; balanceSats: number } | null> {
  const token = request.headers.get("X-Cashu");
  if (token === null) return null;
  // Huge header: reject before any decode work (PRD N-9).
  if (token.length > ctx.limits.maxTokenChars) throw new PaywallError("ECASH_TOKEN_INVALID");
  const bearer = bearerFrom(request);
  if (bearer !== null && !isEcashKey(bearer)) throw new PaywallError("ECASH_KEY_INVALID");
  if (!(await rateLimit(ctx, "topup", clientIp(request)))) throw new PaywallError("ECASH_RATE_LIMITED");
  const r = await topupWithToken(ctx, token, bearer ?? undefined, { minCreditSats });
  const key = (r.key ?? bearer) as EcashKey;
  return { key, ...(r.key ? { created: r.key } : {}), kid: r.kid, balanceSats: r.balanceSats };
}

export function protect(ctx: Ctx, handler: PaidHandler, opts: { priceSats: number; description?: string }) {
  const price = opts.priceSats;
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error("cashu-paywall: protect() priceSats must be a positive integer");
  return async (request: Request): Promise<Response> => {
    let created: EcashKey | undefined;
    try {
      let key: EcashKey;
      const fromHeader = await topupFromHeader(ctx, request, price);
      if (fromHeader) {
        key = fromHeader.key;
        created = fromHeader.created;
      } else {
        const bearer = bearerFrom(request);
        if (bearer === null) return paymentRequiredResponse(ctx, price, opts.description);
        if (!isEcashKey(bearer)) {
          if (!(await rateLimit(ctx, "badkey", clientIp(request)))) throw new PaywallError("ECASH_RATE_LIMITED");
          throw new PaywallError("ECASH_KEY_INVALID");
        }
        key = bearer;
      }
      const d = await debit(ctx, key, price);
      if (!d.ok) {
        if (d.error.code === "ECASH_INSUFFICIENT_BALANCE") {
          // Same as no payment (PRD N-5), plus the balance so the client knows why.
          const res = paymentRequiredResponse(ctx, price, opts.description, { balance_sats: d.error.details?.balance_sats ?? 0 });
          return created ? withPaymentHeaders(res, { key: created, kid: "", balanceSats: Number(d.error.details?.balance_sats ?? 0) }) : res;
        }
        if (d.error.code === "ECASH_KEY_INVALID" && !(await rateLimit(ctx, "badkey", clientIp(request)))) {
          throw new PaywallError("ECASH_RATE_LIMITED");
        }
        throw d.error;
      }
      let res: Response;
      try {
        res = await handler(request, { kid: d.kid, balanceSats: d.balanceSats });
      } catch (e) {
        // A failed call does not cost sats: give the debit back, then answer 500.
        await credit(ctx, key, price, "data_source_error").catch(() => undefined);
        throw e;
      }
      return withPaymentHeaders(res, { key: created, kid: d.kid, balanceSats: d.balanceSats });
    } catch (e) {
      return errorResponse(ctx, e, created ? { "X-Ecash-Key": created } : {});
    }
  };
}
