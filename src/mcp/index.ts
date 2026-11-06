// cashu-paywall/mcp: in-band ecash tools for an MCP server, and the per-call charge helpers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PaywallError, errorBody, type EcashKey, type Paywall } from "../index.js";

/** Options for `registerEcashTools`. */
export interface EcashToolOptions {
  /** How the adapter finds the caller's key, e.g. a closure over the request's bearer key. */
  getKey: (extra: unknown) => EcashKey | null;
  /** Shown by ecash_balance and used for calls_left. */
  priceSats: number;
  /** Prefix for the three tool names. Default `ecash_`. */
  toolNamePrefix?: string;
}

const text = (body: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

function asPaywallError(e: unknown): PaywallError {
  return e instanceof PaywallError ? e : new PaywallError("ECASH_INTERNAL");
}

/** A PaywallError as an `isError: true` tool result carrying the shared JSON error body. */
export function ecashToolError(error: PaywallError, topupUrl?: string): CallToolResult {
  return text(errorBody(error, topupUrl), true);
}

const callsLeft = (balance: number, price: number) => (price > 0 ? Math.floor(balance / price) : null);

/** Registers ecash_topup, ecash_balance and ecash_refund. All three are free (never debited). */
export function registerEcashTools(server: McpServer, paywall: Paywall, opts: EcashToolOptions): void {
  const p = opts.toolNamePrefix ?? "ecash_";
  const price = opts.priceSats;
  const fail = (e: unknown) => ecashToolError(asPaywallError(e), paywall.topupUrl);

  server.registerTool(
    `${p}topup`,
    {
      description:
        "Add credit to your ecash key by paying with a Cashu token (cashuB… or cashuA…) from an accepted mint. " +
        "The token is swapped at the mint and its value, minus the mint's small fee, becomes credit for paid tools. This call itself is free.",
      inputSchema: {
        token: z.string().min(1).max(8192).describe("A Cashu ecash token string (cashuB… or legacy cashuA…) from one of the accepted mints, at most 8,192 characters."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ token }, extra) => {
      try {
        const key = opts.getKey(extra);
        const r = await paywall.topupWithToken(token, key ?? undefined);
        return text({
          ...(r.key ? { key: r.key, warning: "Save this key now; it is shown once." } : {}),
          kid: r.kid, credited_sats: r.creditedSats, fee_sats: r.feeSats, balance_sats: r.balanceSats, mint: r.mint,
          calls_left: callsLeft(r.balanceSats, price), price_sats_per_call: price,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    `${p}balance`,
    {
      description:
        "Show the credit left on your ecash key, the price per paid call, how many calls that buys, the accepted mints, " +
        "and a payment request plus a top-up link for adding more. Free and read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (extra) => {
      try {
        const key = opts.getKey(extra);
        if (!key) throw new PaywallError("ECASH_KEY_INVALID");
        const b = await paywall.balance(key);
        return text({
          kid: b.kid, balance_sats: b.balanceSats, price_sats_per_call: price, calls_left: callsLeft(b.balanceSats, price),
          mint: b.mint, accepted_mints: paywall.mints, topup_url: paywall.topupUrl,
          payment_request: paywall.paymentRequest(paywall.config.suggestedTopupSats ?? 10 * Math.max(1, price)),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    `${p}refund`,
    {
      description:
        "Empty your ecash key and get the remaining credit back as a fresh Cashu token, minus the mint's swap fee. " +
        "The token is money: paste it into a Cashu wallet right away. The key stays valid with zero credit.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (extra) => {
      try {
        const key = opts.getKey(extra);
        if (!key) throw new PaywallError("ECASH_KEY_INVALID");
        const r = await paywall.refund(key);
        return text({
          token: r.token, amount_sats: r.amountSats, fee_sats: r.feeSats, balance_sats: 0, mint: r.mint,
          warning: "This token is money. Paste it into a Cashu wallet now; anyone who sees it can claim it.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}

/** Debit before running a paid tool. On failure, `result` is the tool error to return as is. */
export async function chargeToolCall(
  paywall: Paywall, key: EcashKey, priceSats: number,
): Promise<{ ok: true; balanceSats: number } | { ok: false; result: CallToolResult }> {
  const d = await paywall.debit(key, priceSats);
  if (d.ok) return { ok: true, balanceSats: d.balanceSats };
  const body = errorBody(d.error, paywall.topupUrl);
  if (d.error.code === "ECASH_INSUFFICIENT_BALANCE") {
    body.price_sats = priceSats;
    body.topup_url = paywall.topupUrl;
    body.how_to_pay = "Call ecash_topup with a Cashu token from an accepted mint, or open topup_url to pay by Lightning.";
  }
  return { ok: false, result: text(body, true) };
}

/** Wraps a tool handler: debit, run, and credit the debit back on a thrown error matched by `refundOn`. */
export function withEcashCharge<A>(
  paywall: Paywall,
  opts: { getKey: (extra: unknown) => EcashKey | null; priceSats: number; refundOn?: (e: unknown) => boolean },
  handler: (args: A, extra: unknown) => Promise<CallToolResult>,
): (args: A, extra: unknown) => Promise<CallToolResult> {
  return async (args, extra) => {
    const key = opts.getKey(extra);
    if (!key) return ecashToolError(new PaywallError("ECASH_KEY_INVALID"), paywall.topupUrl);
    const charge = await chargeToolCall(paywall, key, opts.priceSats);
    if (!charge.ok) return charge.result;
    try {
      return await handler(args, extra);
    } catch (e) {
      if (opts.refundOn?.(e)) {
        await paywall.credit(key, opts.priceSats, "data_source_error");
        return text({ error: e instanceof Error ? e.message : "The tool failed.", refunded_sats: opts.priceSats }, true);
      }
      return text({ error: "The tool failed.", code: "ECASH_INTERNAL", charged_sats: opts.priceSats }, true);
    }
  };
}
