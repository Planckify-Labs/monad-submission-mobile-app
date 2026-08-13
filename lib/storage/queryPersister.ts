import type {
  PersistedClient,
  Persister,
} from "@tanstack/react-query-persist-client";
import { queryCache } from "./mmkv";

const CACHE_KEY = "REACT_QUERY_CACHE";

// Query keys that should never be persisted — real-time, polling, or wallet data
// Wallet queries are always reloaded from expo-secure-store on app start, so
// persisting them to MMKV (unencrypted) is both unnecessary and a security concern.
const EXCLUDED_QUERY_KEYS: string[] = [
  "auth", // nonces are single-use — never cache stale nonces across sessions
  "wallet-balance", // live on-chain balance (15s polling)
  "wallets", // reloaded from expo-secure-store on every start
  "active-wallet", // reloaded from expo-secure-store
  "active-wallet-index", // reloaded from expo-secure-store
  "active-chain", // reloaded from expo-secure-store
  "deposit", // point deposit status polling
  "status", // redemption status polling
];

const shouldExclude = (queryKey: readonly unknown[]): boolean => {
  return queryKey.some((segment) =>
    EXCLUDED_QUERY_KEYS.includes(segment as string),
  );
};

/**
 * Debounce helper — collapses rapid successive calls into a single call fired
 * `delay` ms after the last invocation.  This prevents the JS thread from
 * being blocked by repeated JSON.stringify + MMKV writes every time a query
 * observer mounts during a screen navigation.
 */
function debounce<T extends (...args: any[]) => void>(fn: T, delay: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<T>) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  }) as T;
}

// TWV-2026-057 Tier 1 — last-resort guard against writing key material
// to disk. `EXCLUDED_QUERY_KEYS` above is a DENYLIST: it protects the
// query keys we knew about when we wrote it, and silently fails open for
// any future query that happens to carry a wallet object. MMKV is not
// encrypted, so failing open means a plaintext seed on disk.
//
// The wallet service now strips key material before it ever reaches
// React Query, so this should never fire. It is here so that if that
// invariant is ever broken upstream, the failure is a dropped cache
// write and a dev warning rather than a seed leak. Cost is one substring
// scan of a string we already had to build.
const SECRET_MARKERS = ['"privateKey"', '"seedPhrase"', '"mnemonic"'];

const writeToMMKV = (client: PersistedClient) => {
  try {
    const serialized = JSON.stringify(client);
    const leaked = SECRET_MARKERS.find((m) => serialized.includes(m));
    if (leaked) {
      if (__DEV__) {
        console.error(
          `[queryPersister] refusing to persist: payload contains ${leaked}. ` +
            "Wallet key material must never reach the query cache — see the " +
            "secret-vault note in services/walletService.ts.",
        );
      }
      return;
    }
    queryCache.set(CACHE_KEY, serialized);
  } catch {
    // Silently ignore serialization failures (e.g. circular refs)
  }
};

// Debounce writes by 2 s — navigation mounts multiple queries in quick
// succession; batching them into one write keeps the JS thread free.
const debouncedWrite = debounce(writeToMMKV, 2000);

export const mmkvPersister: Persister = {
  persistClient(client: PersistedClient) {
    debouncedWrite(client);
  },
  restoreClient() {
    try {
      const data = queryCache.getString(CACHE_KEY);
      if (!data) return undefined;
      return JSON.parse(data) as PersistedClient;
    } catch {
      return undefined;
    }
  },
  removeClient() {
    queryCache.remove(CACHE_KEY);
  },
};

// Used in dehydrateOptions.shouldDehydrateQuery to filter persisted queries
export const shouldPersistQuery = (query: {
  queryKey: readonly unknown[];
  state: { status: string };
}): boolean => {
  if (query.state.status !== "success") return false;
  return !shouldExclude(query.queryKey);
};
