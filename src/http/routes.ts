// basePath/* routes (PRD 6.5 D): page, lightning, topup, balance, refund, keys, info.
import type { Ctx } from "../core/context.js";
import { balance, createKey } from "../core/balance.js";
import { PaywallError } from "../core/errors.js";
import { bearerFrom, isEcashKey, type EcashKey } from "../core/keys.js";
import { checkLightningTopup, startLightningTopup } from "../core/lightning.js";
import { clientIp, rateLimit } from "../core/ratelimit.js";
import { refund } from "../core/refund.js";
import { paymentRequest } from "../core/requests.js";
import { topupWithToken } from "../core/topup.js";
import { balanceJson, errorResponse, json, refundJson, topupJson } from "./json.js";
import { pageResponse, qrSvg } from "./page.js";

const MAX_BODY = 16_384;

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const len = Number(request.headers.get("Content-Length") ?? "0");
  if (len > MAX_BODY) throw new PaywallError("ECASH_TOKEN_INVALID", { message: "Request body too large." });
  const text = await request.text();
  if (text.length > MAX_BODY) throw new PaywallError("ECASH_TOKEN_INVALID", { message: "Request body too large." });
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    throw new PaywallError("ECASH_TOKEN_INVALID", { message: "Body must be JSON." });
  }
}

/** The bearer key if present. A present-but-malformed key is an error (counted against the bad-key limit). */
async function optionalKey(ctx: Ctx, request: Request): Promise<EcashKey | undefined> {
  const b = bearerFrom(request);
  if (b === null) return undefined;
  if (!isEcashKey(b)) {
    if (!(await rateLimit(ctx, "badkey", clientIp(request)))) throw new PaywallError("ECASH_RATE_LIMITED");
    throw new PaywallError("ECASH_KEY_INVALID");
  }
  return b;
}

async function requiredKey(ctx: Ctx, request: Request): Promise<EcashKey> {
  const k = await optionalKey(ctx, request);
  if (!k) throw new PaywallError("ECASH_KEY_INVALID", { message: "Send your key as Authorization: Bearer eck_…" });
  return k;
}

export async function handleRoutes(ctx: Ctx, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const base = ctx.basePath;
  if (url.pathname !== base && !url.pathname.startsWith(base + "/")) return null;
  const sub = url.pathname.slice(base.length).replace(/\/+$/, "") || "/";
  const m = request.method.toUpperCase();
  const ip = clientIp(request);
  try {
    if (sub === "/" && (m === "GET" || m === "HEAD")) return pageResponse(ctx);

    if (sub === "/info" && m === "GET") {
      return json({
        unit: "sat", mints: ctx.mints, price_sats: ctx.priceSats, limits: {
          min_topup_sats: ctx.limits.minTopupSats, max_topup_sats: ctx.limits.maxTopupSats, max_balance_sats: ctx.limits.maxBalanceSats,
          max_token_chars: ctx.limits.maxTokenChars, max_proofs_per_token: ctx.limits.maxProofsPerToken,
        },
        nuts: [4, 5, 7, 9, 13, 18, 24], payment_request: paymentRequest(ctx, ctx.suggestedTopupSats),
      });
    }

    if (sub === "/topup" && m === "POST") {
      const key = await optionalKey(ctx, request);
      let token = request.headers.get("X-Cashu");
      if (token === null) token = String((await readJson(request)).token ?? "");
      if (token.length > ctx.limits.maxTokenChars) throw new PaywallError("ECASH_TOKEN_INVALID");
      if (!(await rateLimit(ctx, "topup", ip))) throw new PaywallError("ECASH_RATE_LIMITED");
      const r = await topupWithToken(ctx, token, key);
      return json(topupJson(ctx, r), 200, r.key ? { "X-Ecash-Key": r.key, "X-Ecash-Balance": String(r.balanceSats), "X-Ecash-Kid": r.kid } : { "X-Ecash-Balance": String(r.balanceSats), "X-Ecash-Kid": r.kid });
    }

    if (sub === "/lightning" && m === "POST") {
      const key = await optionalKey(ctx, request);
      const body = await readJson(request);
      const amount = Number(body.amount_sats);
      if (!Number.isSafeInteger(amount)) throw new PaywallError("ECASH_AMOUNT_TOO_LOW", { message: "amount_sats must be a whole number of sats." });
      if (!(await rateLimit(ctx, "lightning", ip))) throw new PaywallError("ECASH_RATE_LIMITED");
      const r = await startLightningTopup(ctx, amount, key);
      return json({
        op_id: r.opId, ...(r.key ? { key: r.key, warning: "Save this key now; it is shown once and activates when the invoice is paid." } : {}),
        kid: r.kid, invoice: r.invoice, amount_sats: r.amountSats, expires_at: r.expiresAt, status_url: r.statusUrl, qr_svg: qrSvg(r.invoice.toUpperCase()),
      });
    }

    const st = /^\/lightning\/([0-9a-f-]{36})$/.exec(sub);
    if (st && m === "GET") {
      const s = await checkLightningTopup(ctx, st[1]!);
      return json(s.state === "CREDITED" ? { state: s.state, kid: s.kid, balance_sats: s.balanceSats } : { state: s.state });
    }

    if (sub === "/balance" && m === "GET") {
      return json(balanceJson(ctx, await balance(ctx, await requiredKey(ctx, request))));
    }

    if (sub === "/refund" && m === "POST") {
      return json(refundJson(await refund(ctx, await requiredKey(ctx, request))));
    }

    if (sub === "/keys" && m === "POST") {
      if (!(await rateLimit(ctx, "keys", ip))) throw new PaywallError("ECASH_RATE_LIMITED");
      const k = await createKey(ctx);
      return json({ key: k.key, kid: k.kid, balance_sats: 0, warning: "Save this key now; it is shown once." });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return errorResponse(ctx, e);
  }
}
