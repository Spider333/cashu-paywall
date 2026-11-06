import type { RequestFn } from "@cashu/cashu-ts";
import { Sealer, fromHex } from "./crypto.js";
import { createMintRequest } from "./mint-request.js";
import { safeLogger, type PaywallLogger } from "./redact.js";

/** The shape of a Cloudflare Rate Limiting binding. Return `success: false` to refuse the request. */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

/** Options for `createPaywall`. See docs/integration.md for the full table with defaults. */
export interface PaywallConfig {
  /** D1 database with the schema from migrations/0001_init.sql. */
  db: D1Database;
  /** HMAC secret for `eck_` keys, at least 32 characters. Use one you use for nothing else. */
  keyPepper: string;
  /** Base64 of 32 random bytes. AES-256-GCM key that seals proofs at rest. */
  proofKey: string;
  /** 64-byte seed as 128 hex characters, for NUT-13 deterministic outputs. One seed per database. Back it up offline. */
  walletSeed: string;
  /** Allowlist of mint URLs. Tokens from any other mint are refused before the mint is called. */
  mints: string[];
  /** Only `"sat"` is supported. */
  unit?: "sat";
  /** Default price per call, used by the helpers and the top-up page. Default 1. */
  priceSats?: number;
  /** Absolute public URL of the Worker, used to build `topup_url`. */
  publicBaseUrl: string;
  /** Path the top-up routes live under. Default `/ecash`. */
  basePath?: string;
  /** Payment request encoding: `"creqA"` (NUT-18, default, more wallets) or `"creqB"` (NUT-26). */
  requestEncoding?: "creqA" | "creqB";
  /** Amount asked for in payment requests attached to errors and on the page. Default 10 × `priceSats`. */
  suggestedTopupSats?: number;
  /** Caps. Defaults: 1 / 50,000 / 50,000 / 200,000 sats, 8,192 characters, 64 proofs. */
  limits?: {
    minTopupSats?: number;
    maxTopupSats?: number;
    /** Most credit one key can hold. */
    maxBalanceSats?: number;
    /** Custody cap: most ecash held across all keys. Top-ups past it get `ECASH_POT_FULL`. */
    maxTotalHeldSats?: number;
    maxTokenChars?: number;
    maxProofsPerToken?: number;
  };
  /** A Cloudflare Rate Limiting binding. Without one, nothing is rate limited. */
  rateLimiter?: RateLimiter;
  /** Daily melt of surplus sats to a Lightning address. Off unless `lightningAddress` is set. */
  melt?: {
    /** `name@domain` (LNURL-pay). Unset means no melting. */
    lightningAddress?: string;
    /** Skip the melt when less than this would move. Default 2,000. */
    minSats?: number;
    /** Sats left in the pot beyond what keys are owed. Default 500. */
    keepSats?: number;
  };
  /** Structured logger. Every field passes through `redact()` first. Default: one JSON line per event on `console`. */
  logger?: PaywallLogger;
  /** `fetch` used for mint and LNURL calls. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Clock in Unix ms. Default `Date.now`. */
  now?: () => number;
  /** @internal Test-only crash hooks. A hook that throws simulates a crash at that point (recovery tests). */
  testHooks?: TestHooks;
}

/** @internal */
export interface TestHooks {
  beforeSwap?(kind: "topup_token" | "refund"): void | Promise<void>;
  afterSwap?(kind: "topup_token" | "refund"): void | Promise<void>;
}

export interface Ctx {
  cfg: PaywallConfig;
  db: D1Database;
  mints: string[];
  basePath: string;
  publicBaseUrl: string;
  priceSats: number;
  suggestedTopupSats: number;
  encoding: "creqA" | "creqB";
  limits: Required<NonNullable<PaywallConfig["limits"]>>;
  melt: { lightningAddress?: string; minSats: number; keepSats: number };
  seed: Uint8Array;
  sealer: Sealer;
  log: PaywallLogger;
  now: () => number;
  fetch: typeof fetch;
  mintRequest: RequestFn;
  hooks: TestHooks;
}

/** Normalises a mint URL: lowercase scheme and host, no trailing "/". The allowlist and token mints are compared in this form. */
export function normalizeMintUrl(url: string): string {
  const u = new URL(url.trim());
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host.toLowerCase()}${path}`;
}

function intOr(v: number | undefined, d: number, name: string): number {
  const n = v ?? d;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`cashu-paywall: ${name} must be a non-negative integer`);
  return n;
}

/** Validates the config once per createPaywall call. Throws a plain Error (a deploy bug, not a user error). */
export function buildCtx(cfg: PaywallConfig): Ctx {
  if (!cfg || typeof cfg !== "object") throw new Error("cashu-paywall: config required");
  if (!cfg.db) throw new Error("cashu-paywall: db (D1 binding) required");
  if (typeof cfg.keyPepper !== "string" || cfg.keyPepper.length < 32)
    throw new Error("cashu-paywall: keyPepper must be at least 32 characters");
  if (typeof cfg.walletSeed !== "string" || !/^[0-9a-fA-F]{128}$/.test(cfg.walletSeed)) {
    throw new Error("cashu-paywall: walletSeed must be a 64-byte seed as 128 hex characters");
  }
  if (cfg.unit && cfg.unit !== "sat") throw new Error("cashu-paywall: only unit 'sat' is supported");
  const mints = (cfg.mints ?? [])
    .map((m) => m.trim())
    .filter(Boolean)
    .map(normalizeMintUrl);
  if (mints.length === 0) throw new Error("cashu-paywall: at least one mint is required");
  for (const m of mints)
    if (!m.startsWith("https://") && !m.startsWith("http://localhost"))
      throw new Error("cashu-paywall: mints must use https");
  let publicBaseUrl: string;
  try {
    publicBaseUrl = new URL(cfg.publicBaseUrl).toString().replace(/\/+$/, "");
  } catch {
    throw new Error("cashu-paywall: publicBaseUrl must be an absolute URL");
  }
  const basePath = ("/" + (cfg.basePath ?? "/ecash").replace(/^\/+|\/+$/g, "")).replace(/^\/$/, "/ecash");
  const priceSats = intOr(cfg.priceSats, 1, "priceSats");
  const l = cfg.limits ?? {};
  const limits = {
    minTopupSats: intOr(l.minTopupSats, 1, "minTopupSats"),
    maxTopupSats: intOr(l.maxTopupSats, 50_000, "maxTopupSats"),
    maxBalanceSats: intOr(l.maxBalanceSats, 50_000, "maxBalanceSats"),
    maxTotalHeldSats: intOr(l.maxTotalHeldSats, 200_000, "maxTotalHeldSats"),
    maxTokenChars: intOr(l.maxTokenChars, 8_192, "maxTokenChars"),
    maxProofsPerToken: intOr(l.maxProofsPerToken, 64, "maxProofsPerToken"),
  };
  const lightningAddress = cfg.melt?.lightningAddress?.trim() || undefined;
  if (lightningAddress && !/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(lightningAddress)) {
    throw new Error("cashu-paywall: melt.lightningAddress must look like name@domain");
  }
  const f = cfg.fetch ?? fetch;
  // Bind so workerd's global fetch is never called with a foreign `this`.
  const boundFetch: typeof fetch = (input, init) => f.call(globalThis, input, init);
  return {
    cfg,
    db: cfg.db,
    mints,
    basePath,
    publicBaseUrl,
    priceSats,
    suggestedTopupSats: intOr(cfg.suggestedTopupSats, 10 * priceSats, "suggestedTopupSats"),
    encoding: cfg.requestEncoding ?? "creqA",
    limits,
    melt: {
      lightningAddress,
      minSats: intOr(cfg.melt?.minSats, 2_000, "melt.minSats"),
      keepSats: intOr(cfg.melt?.keepSats, 500, "melt.keepSats"),
    },
    seed: fromHex(cfg.walletSeed),
    sealer: new Sealer(cfg.proofKey ?? ""),
    log: safeLogger(cfg.logger),
    now: cfg.now ?? (() => Date.now()),
    fetch: boundFetch,
    mintRequest: createMintRequest(boundFetch),
    hooks: cfg.testHooks ?? {},
  };
}

export function topupUrl(ctx: Ctx): string {
  return `${ctx.publicBaseUrl}${ctx.basePath}`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}
