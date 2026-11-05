import { JSONInt, MintOperationError, NetworkError, HttpResponseError } from "@cashu/cashu-ts";
import type { RequestFn, RequestOptions } from "@cashu/cashu-ts";

/** Default per-request timeout for mint calls, in ms. */
export const MINT_TIMEOUT_MS = 15_000;

/**
 * A cashu-ts RequestFn built on an injectable `fetch`.
 *
 * Why not the cashu-ts default: it passes `cache` and `credentials` RequestInit fields, and it reads the
 * global `fetch` only, so tests could not swap in a fake mint. This one sends only what workerd needs and
 * keeps the cashu-ts error contract (MintOperationError with the NUT code on a 400 JSON error,
 * NetworkError on transport failures, HttpResponseError otherwise).
 */
export function createMintRequest(fetchFn: typeof fetch, timeoutMs = MINT_TIMEOUT_MS): RequestFn {
  const request = async <T>(args: RequestOptions): Promise<T> => {
    const { endpoint, requestBody, headers, method } = args;
    const body = requestBody ? JSONInt.stringify(requestBody) : undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      // .call(globalThis): workerd throws "Illegal invocation" when the global fetch is called unbound.
      res = await fetchFn.call(globalThis, endpoint, {
        method: method ?? (body ? "POST" : "GET"),
        body,
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (e) {
      throw new NetworkError(controller.signal.aborted ? "Mint request timed out" : "Mint request failed", { cause: e });
    } finally {
      clearTimeout(timer);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new NetworkError("Mint response could not be read", { cause: e });
    }
    if (res.status >= 300 && res.status < 400) throw new HttpResponseError("Mint redirected; not followed", res.status);
    if (!res.ok) {
      let parsed: unknown;
      try {
        parsed = JSONInt.parse(text);
      } catch {
        parsed = undefined;
      }
      if (parsed && typeof parsed === "object") {
        const p = parsed as { code?: unknown; detail?: unknown };
        if (typeof p.code === "number") {
          throw new MintOperationError(p.code, typeof p.detail === "string" ? p.detail : "mint error");
        }
      }
      throw new HttpResponseError("Mint HTTP error", res.status);
    }
    try {
      return JSONInt.parse(text) as T;
    } catch (e) {
      throw new HttpResponseError("Mint returned bad JSON", res.status, { cause: e });
    }
  };
  return request as RequestFn;
}
