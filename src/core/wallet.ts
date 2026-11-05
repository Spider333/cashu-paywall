// Builds a cashu-ts Wallet per mint: deterministic (NUT-13) with the D1 counter source, mint info and keys cached in D1 for 1 h.
import { JSONInt, Mint, NetworkError, Wallet, getPubKeyFromPrivKey, isMintOperationError } from "@cashu/cashu-ts";
import type { GetInfoResponse, KeyChainCache } from "@cashu/cashu-ts";
import type { Ctx } from "./context.js";
import { fromHex, hmacHex, toHex } from "./crypto.js";
import { PaywallError } from "./errors.js";
import { errorFields } from "./redact.js";
import { D1CounterSource } from "./store.js";

const CACHE_TTL_MS = 60 * 60 * 1000;

export async function getWallet(ctx: Ctx, mintUrl: string): Promise<Wallet> {
  const mint = new Mint(mintUrl, { customRequest: ctx.mintRequest });
  // denominationTarget 1 = minimal splits, so one op's outputs always fit its COUNTER_BLOCK (and a restore finds them all).
  const wallet = new Wallet(mint, { unit: "sat", bip39seed: ctx.seed, counterSource: new D1CounterSource(ctx.db), denominationTarget: 1 });
  const row = await ctx.db
    .prepare("SELECT info_json, keys_json, fetched_at FROM ecash_mint_cache WHERE mint_url = ?")
    .bind(mintUrl)
    .first<{ info_json: string; keys_json: string; fetched_at: number }>();
  if (row && ctx.now() - row.fetched_at < CACHE_TTL_MS) {
    try {
      wallet.loadMintFromCache(JSONInt.parse(row.info_json) as GetInfoResponse, JSONInt.parse(row.keys_json) as KeyChainCache);
      return wallet;
    } catch {
      // stale or incompatible cache: fall through and refetch
    }
  }
  try {
    await wallet.loadMint();
  } catch (e) {
    ctx.log.warn("ecash_mint_unavailable", { mint_host: new URL(mintUrl).host, ...errorFields(e) });
    throw new PaywallError("ECASH_MINT_UNAVAILABLE");
  }
  await ctx.db
    .prepare(
      `INSERT INTO ecash_mint_cache (mint_url, info_json, keys_json, fetched_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(mint_url) DO UPDATE SET info_json = ?2, keys_json = ?3, fetched_at = ?4`,
    )
    .bind(mintUrl, JSONInt.stringify(wallet.getMintInfo().cache), JSONInt.stringify(wallet.keyChain.cache), ctx.now())
    .run();
  return wallet;
}

/** NUT-20 key for locked mint quotes, derived from the wallet seed (so it survives restarts and needs no extra secret). */
export async function nut20Key(ctx: Ctx): Promise<{ privkey: string; pubkey: string }> {
  const privkey = await hmacHex(ctx.seed, "cashu-paywall/nut20/v1");
  return { privkey, pubkey: toHex(getPubKeyFromPrivKey(fromHex(privkey))) };
}

/** True for errors where the mint may or may not have acted (network, timeout, 5xx): the outcome is unknown. */
export function outcomeUnknown(e: unknown): boolean {
  if (isMintOperationError(e)) return false;
  return true;
}

export function isNetworkError(e: unknown): boolean {
  return e instanceof NetworkError;
}

/** NUT error codes we act on (confirmed on testnut 5 Nov 2026: 11001 for spent). */
export const NUT_ALREADY_SPENT = 11001;
export const NUT_QUOTE_ISSUED = 20002;
