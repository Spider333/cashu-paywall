export type PaywallErrorCode =
  | "ECASH_TOKEN_INVALID" | "ECASH_MINT_NOT_ALLOWED" | "ECASH_UNIT_NOT_ALLOWED"
  | "ECASH_AMOUNT_TOO_LOW" | "ECASH_AMOUNT_TOO_HIGH" | "ECASH_BALANCE_CAP"
  | "ECASH_TOKEN_SPENT" | "ECASH_TOKEN_LOCKED" | "ECASH_MINT_MISMATCH"
  | "ECASH_INSUFFICIENT_BALANCE" | "ECASH_PAYMENT_REQUIRED"
  | "ECASH_KEY_INVALID" | "ECASH_KEY_FROZEN" | "ECASH_NOTHING_TO_REFUND"
  | "ECASH_RATE_LIMITED" | "ECASH_MINT_UNAVAILABLE" | "ECASH_PENDING"
  | "ECASH_POT_FULL" | "ECASH_INTERNAL";

/** HTTP status and retry flag per code (PRD 6.9). */
const TABLE: Record<PaywallErrorCode, [number, boolean, string]> = {
  ECASH_TOKEN_INVALID: [400, false, "Not a valid Cashu token."],
  ECASH_MINT_NOT_ALLOWED: [400, false, "This token's mint is not accepted here."],
  ECASH_UNIT_NOT_ALLOWED: [400, false, "Only sat tokens are accepted."],
  ECASH_AMOUNT_TOO_LOW: [400, false, "The token is worth too little."],
  ECASH_AMOUNT_TOO_HIGH: [400, false, "The token is worth more than the maximum top-up."],
  ECASH_BALANCE_CAP: [400, false, "This top-up would push the key over its maximum balance."],
  ECASH_TOKEN_SPENT: [400, false, "This token was already spent."],
  ECASH_TOKEN_LOCKED: [400, false, "This token has a spending condition this server can't meet."],
  ECASH_MINT_MISMATCH: [400, false, "This key holds credit from another mint."],
  ECASH_NOTHING_TO_REFUND: [400, false, "Nothing to refund: the balance is zero or below the mint's fee."],
  ECASH_KEY_INVALID: [401, false, "Missing, malformed or unknown ecash key."],
  ECASH_PAYMENT_REQUIRED: [402, false, "Payment required: pay with a Cashu token in the X-Cashu header."],
  ECASH_INSUFFICIENT_BALANCE: [402, false, "Not enough ecash credit for this call."],
  ECASH_KEY_FROZEN: [403, false, "This key is frozen."],
  ECASH_RATE_LIMITED: [429, true, "Too many requests. Try again shortly."],
  ECASH_INTERNAL: [500, true, "Internal error."],
  ECASH_MINT_UNAVAILABLE: [503, true, "The mint can't be reached right now. Your token was not spent; try again."],
  ECASH_PENDING: [503, true, "Received; the outcome is not final yet. It settles within 15 minutes, retry with the same token or check your balance."],
  ECASH_POT_FULL: [503, true, "This server holds as much ecash as it is allowed to. Try again after its next payout."],
};

export class PaywallError extends Error {
  readonly code: PaywallErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly paymentRequest?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: PaywallErrorCode,
    opts: { message?: string; paymentRequest?: string; details?: Record<string, unknown>; httpStatus?: number } = {},
  ) {
    const [status, retryable, message] = TABLE[code];
    super(opts.message ?? message);
    this.name = "PaywallError";
    this.code = code;
    this.httpStatus = opts.httpStatus ?? status;
    this.retryable = retryable;
    if (opts.paymentRequest) this.paymentRequest = opts.paymentRequest;
    if (opts.details) this.details = opts.details;
  }
}

export function isPaywallError(e: unknown): e is PaywallError {
  return e instanceof PaywallError;
}

/** The shared JSON error body (PRD 6.5). `topupUrl` is added only when paying would fix the error. */
export function errorBody(e: PaywallError, topupUrl?: string): Record<string, unknown> {
  const body: Record<string, unknown> = { error: e.message, code: e.code, retryable: e.retryable };
  if (e.paymentRequest) {
    body.payment_request = e.paymentRequest;
    if (topupUrl) body.topup_url = topupUrl;
  }
  if (e.details) Object.assign(body, e.details);
  return body;
}
