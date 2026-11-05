// The only file that reads ECASH_* (PRD 7.4): maps the Worker's env to a PaywallConfig.
import { createPaywall, type Paywall, type RateLimiter } from "cashu-paywall";

export interface Env {
  ECASH_DB: D1Database;
  ECASH_KEY_PEPPER: string;
  ECASH_PROOF_KEY: string;
  ECASH_WALLET_SEED: string;
  ECASH_MINTS: string;
  ECASH_PUBLIC_URL: string;
  ECASH_PRICE_SATS: string;
  ECASH_MELT_LN_ADDRESS?: string;
  ECASH_MELT_MIN_SATS?: string;
  ECASH_MAX_BALANCE_SATS?: string;
  ECASH_MAX_TOTAL_HELD_SATS?: string;
  ECASH_RL?: RateLimiter;
}

const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));

export function priceOf(env: Env): number {
  return num(env.ECASH_PRICE_SATS) ?? 5;
}

export function getPaywall(env: Env): Paywall {
  return createPaywall({
    db: env.ECASH_DB,
    keyPepper: env.ECASH_KEY_PEPPER,
    proofKey: env.ECASH_PROOF_KEY,
    walletSeed: env.ECASH_WALLET_SEED,
    mints: env.ECASH_MINTS.split(","),
    publicBaseUrl: env.ECASH_PUBLIC_URL,
    priceSats: priceOf(env),
    limits: { maxBalanceSats: num(env.ECASH_MAX_BALANCE_SATS), maxTotalHeldSats: num(env.ECASH_MAX_TOTAL_HELD_SATS) },
    melt: { lightningAddress: env.ECASH_MELT_LN_ADDRESS || undefined, minSats: num(env.ECASH_MELT_MIN_SATS) },
    rateLimiter: env.ECASH_RL,
  });
}
