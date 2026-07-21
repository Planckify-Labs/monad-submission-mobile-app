/**
 * Cookie forwarding for cookie-gated custom-chain RPC proxies (Phase 2,
 * Option A). Some dApps serve their `wallet_addEthereumChain` RPC behind their
 * own login session (e.g. `app.idrx.co/api/rpc/bsc`). The WebView holds those
 * cookies — including HttpOnly session cookies, which are NOT readable via
 * `document.cookie` — but our native viem/fetch has a separate, empty cookie
 * jar, so the RPC 401s. We read the WebView's cookie store (WKHTTPCookieStore
 * on iOS via `useWebKit`, Android WebView CookieManager) and forward a
 * `Cookie` header on the native fetch, alongside the forwarded `Origin`.
 *
 * STRICTLY same-origin (enforced by callers): cookies are only ever forwarded
 * when the RPC URL's origin equals the dApp origin, so one site's session is
 * never leaked to a third-party RPC. Custom chains are already the untrusted
 * tier (results capped "unverified"), so this lowers no trusted surface.
 *
 * Degrades to "" when the native module isn't in the binary yet (before the
 * EAS rebuild that ships it, or under the test harness) — cookie forwarding is
 * simply inert until then; nothing crashes.
 */
type CookieManagerLike = {
  get(
    url: string,
    useWebKit?: boolean,
  ): Promise<Record<string, { value?: string }>>;
};

// Resolved lazily and cached. `undefined` = not tried yet, `null` = native
// module absent from this binary. A STATIC import throws at module-eval when
// the native side isn't linked (Invariant Violation), crashing the whole
// add/switch flow before any try/catch can guard it — so we `require` it
// on first use inside a try/catch instead, matching the repo's
// `require(...) as typeof import(...)` pattern (permissionGrantStore, lido).
let cookieManager: CookieManagerLike | null | undefined;

function getCookieManager(): CookieManagerLike | null {
  if (cookieManager !== undefined) return cookieManager;
  try {
    const mod = require("@react-native-cookies/cookies") as {
      default?: CookieManagerLike;
    } & CookieManagerLike;
    cookieManager = mod.default ?? mod;
  } catch {
    // Native module not in the binary yet (before the EAS rebuild), or under
    // the test harness — degrade to no-cookie.
    cookieManager = null;
  }
  return cookieManager;
}

// In-memory ONLY. Session cookies are never written to disk (not MMKV, which
// is unencrypted; not SecureStore — persisting a secret the OS cookie store
// already manages is a worse lifecycle + a second attack surface). The OS
// WebView cookie store is the source of truth; this is a short-lived copy for
// the sync serving path, bounded by a TTL so a rotated/expired cookie is not
// reused and no copy lingers after the user leaves a dApp.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: string; ts: number }>();

function serialize(
  cookies: Record<string, { value?: string }> | null | undefined,
): string {
  if (!cookies) return "";
  return Object.entries(cookies)
    .filter(([, c]) => typeof c?.value === "string" && c.value.length > 0)
    .map(([name, c]) => `${name}=${c.value}`)
    .join("; ");
}

/**
 * True when it is safe to forward the dApp's cookies to `rpcUrl`: the RPC must
 * be the dApp's OWN origin (never leak one site's session to a third party)
 * AND HTTPS (never send a session cookie over plaintext). Callers gate every
 * cookie attach on this.
 */
export function canForwardCookies(rpcUrl: string, origin: string): boolean {
  try {
    const u = new URL(rpcUrl);
    return u.origin === origin && u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Read + cache the WebView cookies for an origin. Call from async paths (the
 * switch reachability probe, the add health-check) and to warm the cache for
 * the synchronous serving path. Returns "" (and keeps the last cache entry) on
 * any failure.
 */
export async function refreshDappCookies(origin: string): Promise<string> {
  const mgr = getCookieManager();
  if (!mgr) return cachedDappCookies(origin) ?? "";
  try {
    const cookies = await mgr.get(origin, true);
    const header = serialize(cookies);
    if (header) cache.set(origin, { value: header, ts: Date.now() });
    else cache.delete(origin);
    return header;
  } catch {
    return cachedDappCookies(origin) ?? "";
  }
}

/** Last-known cookies for an origin (TTL-bounded), for the sync serving path. */
export function cachedDappCookies(origin: string): string | null {
  const entry = cache.get(origin);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(origin);
    return null;
  }
  return entry.value;
}

/** Drop cached cookies (e.g. on dApp disconnect / navigation away). */
export function clearDappCookies(origin?: string): void {
  if (origin) cache.delete(origin);
  else cache.clear();
}
