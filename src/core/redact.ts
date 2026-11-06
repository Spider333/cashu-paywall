// No token, key, payment request, invoice or secret may reach a log line. Everything logged goes through redact().

const PATTERNS: RegExp[] = [
  /cashu[AB][A-Za-z0-9_\-+/=]{16,}/g, // Cashu tokens (v3 cashuA, v4 cashuB)
  /eck_[A-Za-z0-9_-]{8,}/g, // our bearer keys
  /creq[ab][a-z0-9_\-+/=]{16,}/gi, // NUT-18 creqA and NUT-26 CREQB1 payment requests
  /ln(?:bcrt|bc|tbs|tb|sb)[0-9a-z]{20,}/gi, // bolt11 invoices (mainnet, testnet, signet, regtest)
  /\b[0-9a-f]{64,}\b/gi, // 64+ hex: secrets, seeds, preimages, C values
];

/** Masks Cashu tokens, eck_ keys, payment requests, bolt11 invoices and 64-hex secrets. */
export function redact(value: string): string {
  let out = value;
  for (const re of PATTERNS) out = out.replace(re, (m) => `${m.slice(0, 5)}…[redacted]`);
  return out;
}

/** A structured logger: one event name plus fields per call. */
export interface PaywallLogger {
  info(event: string, fields: Record<string, unknown>): void;
  warn(event: string, fields: Record<string, unknown>): void;
  error(event: string, fields: Record<string, unknown>): void;
}

function redactDeep(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redact(v);
  if (typeof v === "bigint") return v.toString();
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = redactDeep(x, depth + 1);
  return out;
}

/** Wraps any logger so every field goes through `redact()` first. */
export function safeLogger(inner?: PaywallLogger): PaywallLogger {
  const base: PaywallLogger = inner ?? {
    info: (event, fields) => console.log(JSON.stringify({ level: "info", event, ...fields })),
    warn: (event, fields) => console.warn(JSON.stringify({ level: "warn", event, ...fields })),
    error: (event, fields) => console.error(JSON.stringify({ level: "error", event, ...fields })),
  };
  const wrap =
    (fn: (e: string, f: Record<string, unknown>) => void) => (event: string, fields: Record<string, unknown>) => {
      try {
        fn(redact(event), redactDeep(fields) as Record<string, unknown>);
      } catch {
        // logging must never break a payment
      }
    };
  return { info: wrap(base.info.bind(base)), warn: wrap(base.warn.bind(base)), error: wrap(base.error.bind(base)) };
}

/** What may be logged about an error from cashu-ts or the network: class, HTTP status, NUT code. Never its message. */
export function errorFields(e: unknown): Record<string, unknown> {
  if (!e || typeof e !== "object") return { err: typeof e };
  const o = e as { name?: unknown; status?: unknown; code?: unknown; constructor?: { name?: string } };
  const out: Record<string, unknown> = { err: typeof o.name === "string" ? o.name : (o.constructor?.name ?? "Error") };
  if (typeof o.status === "number") out.status = o.status;
  if (typeof o.code === "number" || typeof o.code === "string") out.nut_code = o.code;
  return out;
}
