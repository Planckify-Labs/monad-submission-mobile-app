/**
 * Canonical Solana RPC resolver. Every adapter / inspector / broadcast
 * path consumes `getSolanaRpc(cluster)`; nobody calls `createSolanaRpc`
 * themselves. Per solana-adapter-spec §4.12 + §10.4 inv 20:
 *
 *   URL resolution order:
 *     1. `EXPO_PUBLIC_SOLANA_{MAINNET,DEVNET,TESTNET}_RPC` (dev override).
 *     2. First-party proxy: `${EXPO_PUBLIC_API_URL}/solana/{cluster}/rpc`.
 *     3. Public default (`https://api.{cluster}.solana.com`) — __DEV__ only.
 *
 * Never ships provider API keys. A production build with the env override
 * set logs a boot warn (inv 20).
 */

import type {
  Rpc,
  RpcSubscriptions,
  SolanaRpcApi,
  SolanaRpcSubscriptionsApi,
} from "@solana/kit";
import {
  createDefaultRpcTransport,
  createSolanaRpc,
  createSolanaRpcFromTransport,
} from "@solana/kit";
import type { SolanaCluster } from "@/services/chains/solana/payloads";
import { proxyAuthHeaders } from "./proxyAuth";

type CacheKey = string;
type CacheEntry = { value: unknown; expiresAt: number };

const MAX_CACHE_ENTRIES = 200;
const RETRY_BASE_MS = 250;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_MAX_TOTAL_MS = 3000;

const TTL_MS: Record<string, number> = {
  getLatestBlockhash: 1_000,
  getAccountInfo: 2_000,
  getMinimumBalanceForRentExemption: 5 * 60 * 1_000,
};

// Methods that must NEVER be cached — every call sees fresh state.
const NEVER_CACHE: ReadonlySet<string> = new Set([
  "simulateTransaction",
  "sendTransaction",
  "getSignatureStatuses",
  "getTransaction",
  "getSignaturesForAddress",
  "requestAirdrop",
]);

const cache = new Map<CacheKey, CacheEntry>();
const rpcByCluster = new Map<SolanaCluster, Rpc<SolanaRpcApi>>();
const subsByCluster = new Map<
  SolanaCluster,
  RpcSubscriptions<SolanaRpcSubscriptionsApi> | undefined
>();

function envKey(cluster: SolanaCluster, suffix: "RPC" | "RPC_SUBSCRIPTIONS") {
  const slug =
    cluster === "mainnet-beta"
      ? "MAINNET"
      : cluster === "devnet"
        ? "DEVNET"
        : "TESTNET";
  return `EXPO_PUBLIC_SOLANA_${slug}_${suffix}`;
}

let warnedAboutOverride = false;

function resolveUrl(cluster: SolanaCluster): string {
  const env = (process.env as Record<string, string | undefined>) ?? {};
  const override = env[envKey(cluster, "RPC")];
  if (override) {
    const isProd = typeof __DEV__ !== "undefined" ? !__DEV__ : true;
    if (isProd && !warnedAboutOverride) {
      warnedAboutOverride = true;
      console.warn(
        `[solanaRpcPool] production build with ${envKey(cluster, "RPC")} override — ensure the URL is a trusted proxy (no API keys in the bundle, §10.4 inv 20).`,
      );
    }
    return override;
  }
  const apiBase = env.EXPO_PUBLIC_API_URL;
  if (apiBase) return `${apiBase.replace(/\/+$/, "")}/solana/${cluster}/rpc`;
  // `typeof __DEV__ === "undefined"` covers Node/test runs; RN defines it.
  const isDev = typeof __DEV__ === "undefined" ? true : !!__DEV__;
  if (isDev) return `https://api.${cluster}.solana.com`;
  throw new Error(
    "no Solana RPC URL available — set EXPO_PUBLIC_API_URL or an override",
  );
}

function resolveSubsUrl(cluster: SolanaCluster): string | undefined {
  const env = (process.env as Record<string, string | undefined>) ?? {};
  const override = env[envKey(cluster, "RPC_SUBSCRIPTIONS")];
  return override || undefined;
}

/**
 * Wrap an `Rpc` so send()-style calls are routed through our retry + cache
 * layer. `@solana/kit` uses a lazy method-call pattern: `rpc.getAccountInfo(x).send()`.
 * We intercept at the outer proxy level — creating per-method wrappers that
 * return an object whose `.send()` returns the cached or retried value.
 */
function wrapRpc(
  cluster: SolanaCluster,
  raw: Rpc<SolanaRpcApi>,
): Rpc<SolanaRpcApi> {
  return new Proxy(raw as unknown as Record<string, unknown>, {
    get(target, prop: string) {
      const method = target[prop];
      if (typeof method !== "function") return method;
      return (...args: unknown[]) => {
        const call = (method as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );
        if (!call || typeof call !== "object" || !("send" in call)) return call;
        return {
          ...(call as object),
          send: () =>
            invokeWithCache(cluster, prop, args, () =>
              (call as { send: () => Promise<unknown> }).send(),
            ),
        };
      };
    },
  }) as unknown as Rpc<SolanaRpcApi>;
}

async function invokeWithCache(
  cluster: SolanaCluster,
  method: string,
  args: unknown[],
  send: () => Promise<unknown>,
): Promise<unknown> {
  const cacheable = TTL_MS[method] !== undefined && !NEVER_CACHE.has(method);
  const cacheKey: CacheKey | null = cacheable
    ? `${cluster}|${method}|${safeStringify(args)}`
    : null;

  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }

  const value = await retry429(send);

  if (cacheKey) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      // Simple FIFO eviction — insertion order iterable on Map.
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(cacheKey, {
      value,
      expiresAt: Date.now() + TTL_MS[method]!,
    });
  }
  return value;
}

async function retry429<T>(send: () => Promise<T>): Promise<T> {
  const started = Date.now();
  let attempt = 0;
  let delay = RETRY_BASE_MS;
  let lastErr: unknown;
  while (attempt < RETRY_MAX_ATTEMPTS) {
    try {
      return await send();
    } catch (err) {
      lastErr = err;
      if (!isRateLimited(err)) throw err;
      attempt += 1;
      if (attempt >= RETRY_MAX_ATTEMPTS) break;
      const elapsed = Date.now() - started;
      const remaining = RETRY_MAX_TOTAL_MS - elapsed;
      if (remaining <= 0) break;
      await sleep(Math.min(delay, remaining));
      delay *= 2;
    }
  }
  throw lastErr;
}

function isRateLimited(err: unknown): boolean {
  if (!err) return false;
  const e = err as { status?: number; code?: number; message?: string };
  if (e.status === 429 || e.code === 429) return true;
  if (typeof e.message === "string" && /429|rate.?limit/i.test(e.message))
    return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
  } catch {
    return String(v);
  }
}

export function getSolanaRpc(cluster: SolanaCluster): Rpc<SolanaRpcApi> {
  const existing = rpcByCluster.get(cluster);
  if (existing) return existing;
  const raw = rpcFactory(resolveUrl(cluster));
  const wrapped = wrapRpc(cluster, raw);
  rpcByCluster.set(cluster, wrapped);
  return wrapped;
}

export function getSolanaRpcSubscriptions(
  cluster: SolanaCluster,
): RpcSubscriptions<SolanaRpcSubscriptionsApi> | undefined {
  if (subsByCluster.has(cluster)) return subsByCluster.get(cluster);
  const url = resolveSubsUrl(cluster);
  // P1 default: no subscriptions. `undefined` signals the caller to poll.
  // Wiring WS requires `createSolanaRpcSubscriptions` + transport plumbing
  // not yet vetted for React Native; revisit when WS-backed confirmation
  // lands (spec §4.12 note).
  subsByCluster.set(cluster, url ? undefined : undefined);
  return undefined;
}

/**
 * Default factory: `createSolanaRpc` with the rpc-proxy bearer attached
 * when (and only when) the URL is an origin the backend feed registered.
 *
 * `createSolanaRpc(url)` sends no custom headers at all, so a Solana RPC
 * behind our authenticated proxy answered 401 to everything. Same defect
 * the EVM bridge had; `proxyAuthHeaders` being origin-gated is what
 * keeps the key off a public endpoint like `api.mainnet-beta.solana.com`.
 */
function defaultRpcFactory(url: string): Rpc<SolanaRpcApi> {
  const headers = proxyAuthHeaders(url);
  if (Object.keys(headers).length === 0) return createSolanaRpc(url);
  return createSolanaRpcFromTransport(
    // `headers` is branded to forbid the hop-by-hop names a browser
    // controls; `Authorization` is not one of them, and the cast is only
    // to satisfy that brand from a plain record.
    createDefaultRpcTransport({
      url,
      headers: headers as Parameters<
        typeof createDefaultRpcTransport
      >[0]["headers"],
    }),
  );
}

/** Test-only — inject a fake RPC factory in place of @solana/kit. */
let rpcFactory: (url: string) => Rpc<SolanaRpcApi> = defaultRpcFactory;
export function __setRpcFactoryForTests(
  factory: (url: string) => Rpc<SolanaRpcApi>,
): void {
  rpcFactory = factory;
  rpcByCluster.clear();
}

export function clearSolanaRpcCache(): void {
  cache.clear();
  rpcByCluster.clear();
  subsByCluster.clear();
  warnedAboutOverride = false;
}
