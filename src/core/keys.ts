import { base64urlEncode, hmacHex } from "./crypto.js";

/** A prepaid bearer key: `eck_` + 43 base64url characters (32 random bytes). */
export type EcashKey = `eck_${string}`;

const KEY_RE = /^eck_[A-Za-z0-9_-]{43}$/;

/** True only for a well-formed `eck_` key. Never touches the database, so a malformed key costs no D1 read. */
export function isEcashKey(value: string | null | undefined): value is EcashKey {
  return typeof value === "string" && KEY_RE.test(value);
}

/** 32 random bytes as base64url after the `eck_` prefix: 47 characters in all. */
export function newKey(): EcashKey {
  return `eck_${base64urlEncode(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** hex(HMAC-SHA256(pepper, key)) and its 16-hex `kid`, which is safe to log and show. */
export async function hashKey(pepper: string, key: EcashKey): Promise<{ keyHash: string; kid: string }> {
  const keyHash = await hmacHex(pepper, key);
  return { keyHash, kid: keyHash.slice(0, 16) };
}

/** Reads `Authorization: Bearer <value>`. Only the header is read, never the query string, so keys stay out of URLs and access logs. */
export function bearerFrom(request: Request): string | null {
  const h = request.headers.get("Authorization");
  if (!h) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1]! : h.trim();
}
