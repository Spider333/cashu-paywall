import type { Ctx } from "./context.js";
import { hmacHex } from "./crypto.js";

/**
 * Classes the library limits. With a single Cloudflare Rate Limiting binding every class shares its
 * limit/period; the key is namespaced by class so they count separately.
 */
export type RateClass = "topup" | "lightning" | "keys" | "badkey" | "call";

/** True = allowed. No limiter configured = always allowed. Keys are HMACs, so no raw IP or key reaches the limiter. */
export async function rateLimit(ctx: Ctx, cls: RateClass, id: string): Promise<boolean> {
  const rl = ctx.cfg.rateLimiter;
  if (!rl) return true;
  const key = `${cls}:${(await hmacHex(ctx.cfg.keyPepper, `rl:${cls}:${id}`)).slice(0, 32)}`;
  try {
    return (await rl.limit({ key })).success;
  } catch {
    return true; // a broken limiter must not take the paywall down
  }
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Real-IP") ?? "unknown";
}
