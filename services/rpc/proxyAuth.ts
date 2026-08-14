/**
 * Attaches the rpc-proxy bearer to RPC calls — and only to rpc-proxy.
 *
 * The proxy requires `Authorization: Bearer <token>` on its data plane. The
 * token must NOT be sprayed at every RPC endpoint: a provider that receives an
 * unexpected bearer rejects the request outright (Alchemy answers 401), so a
 * blanket header would break every direct-to-provider call, and it would leak
 * our credential into third-party logs.
 *
 * Which origin is "ours" isn't hardcoded — the backend tells us. `rpcUrl` in the
 * `/blockchains` feed *is* the proxy URL, so `buildChainConfigFromBlockchain`
 * registers that origin as it builds each chain. Anything else (viem's built-in
 * defaults, a public fallback, a bundler) gets no header.
 *
 * The token itself is minted per-device at runtime rather than baked into the
 * bundle; `proxyToken.ts` explains why, and holds the cache this module reads.
 */

import { currentProxyToken, ensureProxyToken } from "./proxyToken";

const proxyOrigins = new Set<string>();

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Called with each `rpcUrl` the backend hands us.
 *
 * Learning the origin is also the trigger to mint a token for it: there is no
 * earlier moment when we know where our proxy lives, and no later one that
 * happens reliably before the first RPC call. Fire-and-forget, because every
 * caller is building a chain config synchronously and a mint failure must
 * degrade to a 401 rather than block chain setup.
 */
export function registerProxyOrigin(rpcUrl: string | undefined): void {
  const origin = originOf(rpcUrl);
  if (!origin) return;
  proxyOrigins.add(origin);
  void ensureProxyToken(origin);
}

export function isProxyUrl(url: string | undefined): boolean {
  const origin = originOf(url);
  return origin !== null && proxyOrigins.has(origin);
}

/**
 * Headers for an RPC request to `url`. Empty unless `url` is the proxy and we
 * hold a live token for it.
 *
 * An empty result is a normal state, not an error: it covers the window before
 * the first mint completes, and a local proxy running with `PROXY_API_KEY`
 * unset, which serves unauthenticated callers on purpose.
 */
export function proxyAuthHeaders(
  url: string | undefined,
): Record<string, string> {
  const origin = originOf(url);
  if (!origin || !proxyOrigins.has(origin)) return {};
  const token = currentProxyToken(origin);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * `fetchOptions` for a viem `http()` transport. Returns undefined when there is
 * nothing to add, so the transport keeps its default behaviour untouched.
 */
export function rpcFetchOptions(
  url: string | undefined,
): { fetchOptions: { headers: Record<string, string> } } | undefined {
  const headers = proxyAuthHeaders(url);
  return Object.keys(headers).length > 0
    ? { fetchOptions: { headers } }
    : undefined;
}

/** The URL a viem chain will actually be called on. */
export function chainRpcUrl(chain: {
  rpcUrls?: { default?: { http?: readonly string[] } };
}): string | undefined {
  return chain?.rpcUrls?.default?.http?.[0];
}
