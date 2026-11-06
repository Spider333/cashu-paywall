// Small WebCrypto helpers: HMAC, SHA-256, AES-GCM sealing, base64url. No secrets are ever returned in errors.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64Decode(s: string): Uint8Array {
  return base64urlDecode(s.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string | Uint8Array): Promise<CryptoKey> {
  const id = typeof secret === "string" ? `s:${secret}` : `b:${toHex(secret)}`;
  let k = hmacKeys.get(id);
  if (!k) {
    const raw = typeof secret === "string" ? enc.encode(secret) : secret;
    k = crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    if (hmacKeys.size > 32) hmacKeys.clear();
    hmacKeys.set(id, k);
  }
  return k;
}

export async function hmacHex(secret: string | Uint8Array, message: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(message));
  return toHex(new Uint8Array(sig));
}

/** AES-256-GCM sealing for proofs at rest. Output: base64url(iv || ciphertext). */
export class Sealer {
  private key: Promise<CryptoKey>;

  constructor(proofKeyBase64: string) {
    const raw = base64Decode(proofKeyBase64);
    if (raw.length !== 32) throw new Error("proofKey must be 32 bytes, base64-encoded");
    this.key = crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  async seal(plaintext: string, aad: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await this.key, enc.encode(plaintext));
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), 12);
    return base64urlEncode(out);
  }

  async open(sealed: string, aad: string): Promise<string> {
    const bytes = base64urlDecode(sealed);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: enc.encode(aad) }, await this.key, bytes.slice(12));
    return dec.decode(pt);
  }
}

export function randomId(): string {
  return crypto.randomUUID();
}
