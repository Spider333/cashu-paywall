import { balance, createKey, type BalanceInfo } from "./core/balance.js";
import { buildCtx, type Ctx, type PaywallConfig, type RateLimiter } from "./core/context.js";
import { credit, debit, type DebitResult } from "./core/debit.js";
import { isEcashKey, type EcashKey } from "./core/keys.js";
import {
  checkLightningTopup,
  startLightningTopup,
  type LightningTopup,
  type LightningTopupStatus,
} from "./core/lightning.js";
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
  PaywallConfig,
  RateLimiter,
  EcashKey,
  BalanceInfo,
  TopupResult,
  LightningTopup,
  LightningTopupStatus,
  DebitResult,
  RefundResult,
  CronReport,
  PaidHandler,
};

/** A paywall bound to one D1 database and config. Every method is safe to call from a Worker's fetch or scheduled handler. */
export interface Paywall {
  /** The config this paywall was created with. */
  readonly config: Readonly<PaywallConfig>;
  /** True only for a well-formed `eck_` key. Never reads the database. */
  isEcashKey(value: string | null | undefined): value is EcashKey;
  /** Creates a key with 0 credit. The key is returned once and never stored, only its HMAC. */
  createKey(): Promise<{ key: EcashKey; kid: string }>;
  /** The key's credit and usage. Throws `ECASH_KEY_INVALID` or `ECASH_KEY_FROZEN`. */
  balance(key: EcashKey): Promise<BalanceInfo>;
  /**
   * Swaps a Cashu token at its mint and credits its value minus the swap fee to `key`, or to a new key when `key` is
   * omitted (returned as `TopupResult.key`). Crash-safe: the operation is recorded before the mint is called.
   */
  topupWithToken(token: string, key?: EcashKey): Promise<TopupResult>;
  /** Creates a Lightning invoice (NUT-04 mint quote) that credits `key`, or a new key, once paid. */
  startLightningTopup(amountSats: number, key?: EcashKey): Promise<LightningTopup>;
  /** Checks a Lightning top-up and, the first time it finds the invoice paid, mints and credits. */
  checkLightningTopup(opId: string): Promise<LightningTopupStatus>;
  /** Takes `amountSats` off the key in one atomic D1 statement. Never calls the mint. */
  debit(key: EcashKey, amountSats: number): Promise<DebitResult>;
  /** Gives back an earlier debit, for a paid call that failed on your side. */
  credit(key: EcashKey, amountSats: number, reason: "data_source_error"): Promise<void>;
  /** Empties the key and returns its credit minus the mint's swap fee as a fresh Cashu token. */
  refund(key: EcashKey): Promise<RefundResult>;
  /** An in-band NUT-18 (`creqA`) or NUT-26 (`creqB`) payment request for `amountSats` from the accepted mints. */
  paymentRequest(amountSats: number, opts?: { description?: string }): string;
  /** Serves the routes under `basePath` (default `/ecash`). Returns null for any other path. */
  handleRoutes(request: Request): Promise<Response | null>;
  /**
   * Wraps a handler behind NUT-24: `402` with `X-Cashu: creqA…` when unpaid, served after a debit when the request
   * carries a token in `X-Cashu` or `Authorization: Bearer eck_…` with enough credit.
   */
  protect(
    handler: PaidHandler,
    opts: { priceSats: number; description?: string },
  ): (request: Request) => Promise<Response>;
  /**
   * The cron entry point. Every run settles stuck operations and checks that the pot covers all balances. The daily
   * cron `0 3 * * *` also melts surplus sats to `melt.lightningAddress` and deletes never-funded keys older than 7 days.
   */
  scheduled(controller: { cron: string; scheduledTime: number }): Promise<CronReport>;
  /**
   * For servers that guard their own routes (like the demo's /mcp): tops up from an `X-Cashu` header (with an optional
   * bearer key) and returns the key to use, or null when the request has no `X-Cashu` header. Throws PaywallError.
   */
  topupFromRequest(
    request: Request,
  ): Promise<{ key: EcashKey; created?: EcashKey; kid: string; balanceSats: number } | null>;
  /** Adds `X-Ecash-Key` (only when created), `X-Ecash-Balance` and `X-Ecash-Kid` to a response. */
  withPaymentHeaders(res: Response, h: { key?: EcashKey; kid: string; balanceSats: number }): Response;
  /** Turns any error into the shared JSON error response (status, Retry-After, X-Cashu when paying would fix it). */
  errorResponse(e: unknown): Response;
  /** Public URL of the top-up page (basePath under publicBaseUrl). */
  readonly topupUrl: string;
  /** Normalised accepted mints. */
  readonly mints: readonly string[];
}

/**
 * Validates the config and returns a paywall. No network and no database access, so it is cheap enough to call once
 * per request from `env`. Throws a plain Error on a bad config.
 */
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
