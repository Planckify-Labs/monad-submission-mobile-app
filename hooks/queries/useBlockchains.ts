import { useQuery } from "@tanstack/react-query";
import { blockchainApi } from "@/api/endpoints/blockchains";
import type { TBlockchain } from "@/api/types/blockchain";
import { storage } from "@/lib/storage/mmkv";
import {
  BLOCKCHAIN_STORAGE_KEY as BLOCKCHAINS_KEY,
  BLOCKCHAIN_TIMESTAMP_KEY as BLOCKCHAINS_TIMESTAMP_KEY,
} from "@/services/blockchains/cache";

const OFFLINE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours — offline fallback only
const STALE_TIME = 5 * 60 * 1000; // 5 minutes — after this, fetch from API on next mount

interface TUseBlockchainsOptions {
  name?: string;
  chainId?: number;
  isEVM?: boolean;
  isActive?: boolean;
  take?: number;
  cursor?: string;
}

export const useBlockchains = (options?: TUseBlockchainsOptions) => {
  const isFiltered = Boolean(
    options?.name ||
      options?.chainId ||
      options?.isEVM !== undefined ||
      options?.isActive !== undefined ||
      options?.cursor ||
      options?.take,
  );

  return useQuery<TBlockchain[]>({
    queryKey: ["blockchains", options],
    queryFn: async () => {
      if (isFiltered) {
        return await blockchainApi.searchBlockchains(options);
      }

      const cachedRaw = storage.getString(BLOCKCHAINS_KEY);
      const timestampStr = storage.getString(BLOCKCHAINS_TIMESTAMP_KEY);
      const now = Date.now();
      const timestamp = timestampStr ? parseInt(timestampStr, 10) : 0;

      // Fast path: cache is still fresh (< 5 min) — no network needed
      if (cachedRaw && now - timestamp < STALE_TIME) {
        return JSON.parse(cachedRaw) as TBlockchain[];
      }

      // Cache is stale or missing — fetch from API
      try {
        const response = await blockchainApi.getBlockchainList();
        storage.set(BLOCKCHAINS_KEY, JSON.stringify(response));
        storage.set(BLOCKCHAINS_TIMESTAMP_KEY, Date.now().toString());
        return response;
      } catch (error) {
        // Offline fallback: serve any MMKV data available, regardless of age
        if (cachedRaw) {
          return JSON.parse(cachedRaw) as TBlockchain[];
        }
        throw error;
      }
    },
    staleTime: STALE_TIME,
    gcTime: OFFLINE_CACHE_TTL,
    refetchOnMount: true,
  });
};

export const useNativeTokens = (options?: TUseBlockchainsOptions) => {
  const { data: blockchains, isLoading, error } = useBlockchains(options);

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
