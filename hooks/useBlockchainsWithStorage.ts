import { useQuery } from "@tanstack/react-query";
import { blockchainApi } from "@/api/endpoints/blockchains";
import type {
  TBlockchain,
  TUseBlockchainsWithStorageOptions,
} from "@/api/types/blockchain";
import { storage } from "@/lib/storage/mmkv";
import {
  BLOCKCHAIN_STORAGE_KEY,
  BLOCKCHAIN_TIMESTAMP_KEY,
} from "@/services/blockchains/cache";
import { filterSupportedBlockchains } from "@/services/walletKit/chainSupport";

const OFFLINE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — offline fallback only
const STALE_TIME = 5 * 60 * 1000; // 5 min — React Query freshness window

// Server-filtered paths: these options hit the `/search` endpoint and
// can't be served from the single-payload MMKV cache. Everything else
// falls through to "fetch the whole catalogue, filter in memory",
// matching `useTokens`.
function isServerFilteredQuery(
  options?: TUseBlockchainsWithStorageOptions,
): boolean {
  if (!options) return false;
  return Boolean(
    options.forceRefresh ||
      options.name ||
      options.chainId ||
      options.isEVM !== undefined ||
      options.cursor ||
      options.take ||
      options.isNativeCurrency,
  );
}

function filterBlockchains(
  blockchains: TBlockchain[],
  options?: TUseBlockchainsWithStorageOptions,
): TBlockchain[] {
  if (!options) return blockchains;
  return blockchains.filter((b) => {
    if (options.isActive !== undefined && b.isActive !== options.isActive)
      return false;
    return true;
  });
}

function readCachedBlockchains(): TBlockchain[] | undefined {
  const raw = storage.getString(BLOCKCHAIN_STORAGE_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as TBlockchain[];
  } catch {
    return undefined;
  }
}

function readCacheTimestamp(): number {
  const raw = storage.getString(BLOCKCHAIN_TIMESTAMP_KEY);
  return raw ? Number.parseInt(raw, 10) || 0 : 0;
}

async function fetchAndCacheBlockchains(): Promise<TBlockchain[]> {
  const response = await blockchainApi.getBlockchainList();
  // Synchronous MMKV writes — persist the full catalogue so every
  // `useBlockchainsWithStorage({...})` consumer can seed its
  // `initialData` from the same bundle without per-filter cache entries.
  storage.set(BLOCKCHAIN_STORAGE_KEY, JSON.stringify(response));
  storage.set(BLOCKCHAIN_TIMESTAMP_KEY, Date.now().toString());
  return response;
}

/**
 * Optimistic blockchain catalogue hook. Reads the last-known
 * `/blockchains` payload synchronously from MMKV via `initialData` so
 * consumers (ChainSelector, wallet derivation, agent router) render
 * real rows on frame 0 instead of the `isLoading: true` spinner path
 * that the previous AsyncStorage-inside-queryFn layer forced.
 *
 * React Query still runs a background refetch under `STALE_TIME` to
 * reconcile against the server; the MMKV snapshot rehydrates on next
 * launch via the regular write path in `fetchAndCacheBlockchains`.
 *
 * Server-filtered variants (name / chainId / isEVM / …) bypass the
 * cache — they're keyed off user input / chain selection and must be
 * a fresh round-trip.
 */
export const useBlockchainsWithStorage = (
  options?: TUseBlockchainsWithStorageOptions,
) => {
  const serverFiltered = isServerFilteredQuery(options);

  return useQuery<TBlockchain[]>({
    queryKey: ["blockchains", options],
    initialData: () => {
      if (serverFiltered) return undefined;
      const cached = readCachedBlockchains();
      if (!cached) return undefined;
      return filterBlockchains(cached, options);
    },
    initialDataUpdatedAt: () => (serverFiltered ? 0 : readCacheTimestamp()),
    queryFn: async () => {
      if (serverFiltered) {
        return await blockchainApi.searchBlockchains(options);
      }
      try {
        const fresh = await fetchAndCacheBlockchains();
        return filterBlockchains(fresh, options);
      } catch (err) {
        // Offline / transient network failure: serve whatever's in MMKV
        // while the request is recoverable. 24h TTL matches gcTime.
        const cached = readCachedBlockchains();
        const ts = readCacheTimestamp();
        if (cached && Date.now() - ts < OFFLINE_CACHE_TTL) {
          return filterBlockchains(cached, options);
        }
        throw err;
      }
    },
    // Chain lockdown (Monad Metropolis build) is applied at the read, not
    // in the cache: the MMKV bundle keeps every row, so nothing is lost
    // when the flag flips. Identity when the flag is off.
    select: filterSupportedBlockchains,
    staleTime: STALE_TIME,
    gcTime: OFFLINE_CACHE_TTL,
    refetchOnMount: true,
    refetchOnReconnect: "always",
  });
};

export const useNativeTokensWithStorage = (
  options?: TUseBlockchainsWithStorageOptions,
) => {
  const {
    data: blockchains,
    isLoading,
    error,
  } = useBlockchainsWithStorage(options);

  const nativeTokens =
    blockchains?.flatMap(
      (blockchain) =>
        blockchain.tokens?.filter((token) => token.isNativeCurrency) || [],
    ) || [];

  return {
    data: nativeTokens,
    isLoading,
    error,
  };
};

export const useBlockchainByChainId = (chainId: number) => {
  const { data: blockchains, isLoading, error } = useBlockchainsWithStorage();

  const blockchain = blockchains?.find((chain) => chain.chainId === chainId);

  return {
    data: blockchain,
    isLoading,
    error,
  };
};

export const useNativeTokenForChainId = (chainId: number) => {
  const {
    data: blockchain,
    isLoading,
    error,
  } = useBlockchainByChainId(chainId);

  const nativeToken = blockchain?.tokens?.find(
    (token) => token.isNativeCurrency,
  );

  return {
    data: nativeToken,
    isLoading,
    error,
  };
};
