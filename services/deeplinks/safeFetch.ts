/**
 * Network discipline for everything a deep link makes the wallet fetch —
 * spec §10 S-6: only after the user's Continue, https only, 10 s
 * timeout, bounded body, no wallet-identifying headers.
 *
 * React Native's `fetch` follows redirects on its own and offers no
 * `redirect: "manual"`; the redirect cap is therefore enforced by
 * checking the final `response.url` against the policy the caller
 * passes (`sameHost`) rather than by counting hops. A cross-host or
 * downgrade redirect is refused after the fact and the body is never
 * read.
 */

import { hostnameOfHttps } from "./uri";

export const FETCH_TIMEOUT_MS = 10_000;
export const FETCH_MAX_BODY_BYTES = 64 * 1024;

export interface SafeFetchOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  /** Refuse a response whose final URL is on a different host. */
  sameHost?: boolean;
  fetchImpl?: typeof fetch;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  contentType: string | null;
  text: string;
  finalUrl: string;
}

export class SafeFetchError extends Error {
  readonly reason:
    | "not_https"
    | "timeout"
    | "network"
    | "too_large"
    | "redirected_off_host"
    | "redirected_insecure";
  constructor(reason: SafeFetchError["reason"]) {
    super(`safeFetch:${reason}`);
    this.name = "SafeFetchError";
    this.reason = reason;
  }
}

export async function safeFetch(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const host = hostnameOfHttps(url);
  if (!host) throw new SafeFetchError("not_https");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? FETCH_TIMEOUT_MS,
  );
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: opts.method ?? "GET",
      headers: {
        // Generic UA where the platform honours it; the spec accepts the
        // iOS residual (bundle name cannot be removed per request).
        "User-Agent": "TakumiPay-Wallet",
        ...(opts.headers ?? {}),
      },
      body: opts.body,
      signal: controller.signal,
      // Never send cookies or credentials to a link-supplied host.
      credentials: "omit",
    });
  } catch (e) {
    clearTimeout(timer);
    if ((e as { name?: string })?.name === "AbortError")
      throw new SafeFetchError("timeout");
    throw new SafeFetchError("network");
  }
  clearTimeout(timer);

  const finalUrl = typeof res.url === "string" && res.url ? res.url : url;
  const finalHost = hostnameOfHttps(finalUrl);
  if (!finalHost) throw new SafeFetchError("redirected_insecure");
  if (opts.sameHost && finalHost !== host)
    throw new SafeFetchError("redirected_off_host");

  const lengthHeader = res.headers.get("content-length");
  const max = opts.maxBodyBytes ?? FETCH_MAX_BODY_BYTES;
  if (lengthHeader && Number(lengthHeader) > max)
    throw new SafeFetchError("too_large");
  const text = await res.text();
  if (text.length > max) throw new SafeFetchError("too_large");

  return {
    ok: res.ok,
    status: res.status,
    contentType: res.headers.get("content-type"),
    text,
    finalUrl,
  };
}
