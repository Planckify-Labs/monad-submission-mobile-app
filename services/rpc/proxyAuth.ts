/**
 * Attaches the rpc-proxy bearer to RPC calls — and only to rpc-proxy.
 *
 * The proxy requires `Authorization: Bearer <PROXY_API_KEY>` on its data plane.
 * The key must NOT be sprayed at every RPC endpoint: a provider that receives an
 * unexpected bearer rejects the request outright (Alchemy answers 401), so a
 * blanket header would break every direct-to-provider call, and it would leak
 * our token into third-party logs.
 *
 * Which origin is "ours" isn't hardcoded — the backend tells us. `rpcUrl` in the
 * `/blockchains` feed *is* the proxy URL, so `buildChainConfigFromBlockchain`
 * registers that origin as it builds each chain. Anything else (viem's built-in
 * defaults, a public fallback, a bundler) gets no header.
 */

const proxyOrigins = new Set<string>();

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Called with each `rpcUrl` the backend hands us. */
export function registerProxyOrigin(rpcUrl: string | undefined): void {
  const origin = originOf(rpcUrl);
  if (origin) proxyOrigins.add(origin);
}

export function isProxyUrl(url: string | undefined): boolean {
  const origin = originOf(url);
  return origin !== null && proxyOrigins.has(origin);
}

/**
 * Headers for an RPC request to `url`. Empty unless `url` is the proxy, or no
 * key is configured — the proxy disables auth when its own key is unset, so an
 * absent key is a valid local-dev setup rather than an error.
 */
export function proxyAuthHeaders(
  url: string | undefined,
): Record<string, string> {
  if (!isProxyUrl(url)) return {};
  const key = process.env.EXPO_PUBLIC_RPC_PROXY_API_KEY?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
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
