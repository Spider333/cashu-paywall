// NUT-18 (creqA) / NUT-26 (creqB) payment requests. In-band (no transport), as NUT-24 says; no nut10 lock.
import { PaymentRequest } from "@cashu/cashu-ts";
import type { Ctx } from "./context.js";
import { toHex } from "./crypto.js";

export function paymentRequest(ctx: Ctx, amountSats: number, opts: { description?: string } = {}): string {
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) throw new Error("cashu-paywall: payment request amount must be a positive integer");
  const id = toHex(crypto.getRandomValues(new Uint8Array(4)));
  const pr = new PaymentRequest(undefined, id, amountSats, "sat", ctx.mints, opts.description, true);
  return ctx.encoding === "creqB" ? pr.toEncodedCreqB() : pr.toEncodedCreqA();
}
