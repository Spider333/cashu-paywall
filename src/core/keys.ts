import { base64urlEncode, hmacHex } from "./crypto.js";

export type EcashKey = `eck_${string}`;

const KEY_RE = /^eck_[A-Za-z0-9_-]{43}$/;

/** True only for a well-formed `eck_` key (PRD 6.4). Never touches the database. */
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

/** Reads `Authorization: Bearer <value>`. Only the header is read, never the query string (PRD N-7). */
export function bearerFrom(request: Request): string | null {
  const h = request.headers.get("Authorization");
  if (!h) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1]! : h.trim();
}
