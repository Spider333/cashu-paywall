// cashu-paywall: charge per call in Cashu ecash on Cloudflare Workers (prepaid eck_ keys, X-Cashu, NUT-24 402, Lightning top-up).
import { balance, createKey, type BalanceInfo } from "./core/balance.js";
import { buildCtx, type Ctx, type PaywallConfig, type RateLimiter } from "./core/context.js";
import { credit, debit, type DebitResult } from "./core/debit.js";
import { isEcashKey, type EcashKey } from "./core/keys.js";
import { checkLightningTopup, startLightningTopup, type LightningTopup, type LightningTopupStatus } from "./core/lightning.js";
import { refund, type RefundResult } from "./core/refund.js";
import { paymentRequest } from "./core/requests.js";
import { topupWithToken, type TopupResult } from "./core/topup.js";
import { runScheduled, type CronReport } from "./cron/index.js";
import { protect, topupFromHeader, withPaymentHeaders, type PaidHandler } from "./http/protect.js";
import { handleRoutes } from "./http/routes.js";
import { errorResponse } from "./http/json.js";

export { PaywallError, isPaywallError, errorBody, type PaywallErrorCode } from "./core/errors.js";
export { redact, type PaywallLogger } from "./core/redact.js";
export { MIGRATIONS_SQL } from "./core/migrations-sql.js";
export { normalizeMintUrl } from "./core/context.js";
export type {
  PaywallConfig, RateLimiter, EcashKey, BalanceInfo, TopupResult, LightningTopup, LightningTopupStatus, DebitResult, RefundResult,
  CronReport, PaidHandler,
};

export interface Paywall {
  readonly config: Readonly<PaywallConfig>;
  isEcashKey(value: string | null | undefined): value is EcashKey;
  createKey(): Promise<{ key: EcashKey; kid: string }>;
  balance(key: EcashKey): Promise<BalanceInfo>;
  topupWithToken(token: string, key?: EcashKey): Promise<TopupResult>;
  startLightningTopup(amountSats: number, key?: EcashKey): Promise<LightningTopup>;
  checkLightningTopup(opId: string): Promise<LightningTopupStatus>;
  debit(key: EcashKey, amountSats: number): Promise<DebitResult>;
  credit(key: EcashKey, amountSats: number, reason: "data_source_error"): Promise<void>;
  refund(key: EcashKey): Promise<RefundResult>;
  paymentRequest(amountSats: number, opts?: { description?: string }): string;
  handleRoutes(request: Request): Promise<Response | null>;
  protect(handler: PaidHandler, opts: { priceSats: number; description?: string }): (request: Request) => Promise<Response>;
  scheduled(controller: { cron: string; scheduledTime: number }): Promise<CronReport>;
  /**
   * For servers that guard their own routes (like the demo's /mcp): tops up from an `X-Cashu` header (with an optional
   * bearer key) and returns the key to use, or null when the request has no `X-Cashu` header. Throws PaywallError.
   */
  topupFromRequest(request: Request): Promise<{ key: EcashKey; created?: EcashKey; kid: string; balanceSats: number } | null>;
  /** Adds `X-Ecash-Key` (only when created), `X-Ecash-Balance` and `X-Ecash-Kid` to a response. */
  withPaymentHeaders(res: Response, h: { key?: EcashKey; kid: string; balanceSats: number }): Response;
  /** Turns any error into the shared JSON error response (status, Retry-After, X-Cashu when paying would fix it). */
  errorResponse(e: unknown): Response;
  /** Public URL of the top-up page (basePath under publicBaseUrl). */
  readonly topupUrl: string;
  /** Normalised accepted mints. */
  readonly mints: readonly string[];
}

/** Cheap (no network): build it per request from `env`. */
export function createPaywall(config: PaywallConfig): Paywall {
  const ctx: Ctx = buildCtx(config);
  return {
    config,
    isEcashKey,
    createKey: () => createKey(ctx),
    balance: (key) => balance(ctx, key),
    topupWithToken: (token, key) => topupWithToken(ctx, token, key),
    startLightningTopup: (amount, key) => startLightningTopup(ctx, amount, key),
    checkLightningTopup: (opId) => checkLightningTopup(ctx, opId),
    debit: (key, amount) => debit(ctx, key, amount),
    credit: (key, amount, reason) => credit(ctx, key, amount, reason),
    refund: (key) => refund(ctx, key),
    paymentRequest: (amount, opts) => paymentRequest(ctx, amount, opts),
    handleRoutes: (request) => handleRoutes(ctx, request),
    protect: (handler, opts) => protect(ctx, handler, opts),
    scheduled: (controller) => runScheduled(ctx, controller),
    topupFromRequest: (request) => topupFromHeader(ctx, request),
    withPaymentHeaders,
    errorResponse: (e) => errorResponse(ctx, e),
    topupUrl: `${ctx.publicBaseUrl}${ctx.basePath}`,
    mints: ctx.mints,
  };
}
