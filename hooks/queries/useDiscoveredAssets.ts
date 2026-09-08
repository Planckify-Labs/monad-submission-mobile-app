/**
 * Discovered assets — which tokens a wallet actually holds, including ones
 * absent from the curated backend registry.
 *
 * This hook returns asset IDENTITY, never balances. Consumers merge it into
 * their token list and keep reading balances on-chain exactly as before, so a
 * third party's number is never rendered as the user's balance.
 *
 * ## The cached/refresh split
 *
 * The endpoint is cache-first by default. React Query's automatic refetches
 * (staleTime expiry, remount, reconnect) therefore cost nothing upstream.
 * Only `refreshFromSource()` sends `refresh=true`, and it is meant to be wired
 * to a user's pull-to-refresh.
 *
 * Wiring `<RefreshControl onRefresh>` to plain `refetch()` is the mistake to
 * avoid: it would re-serve the same cached payload and look like a no-op.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { portfolioApi } from "@/api/endpoints/portfolio";
import type {
  TDiscoveredAsset,
  TPortfolioChainSelector,
  TPortfolioEnvelope,
} from "@/api/types/portfolio";

/** Matches the server's discovery TTL, so we don't refetch more often than
 *  the cache behind it can possibly change. */
const STALE_TIME = 12 * 60 * 60 * 1000;

export const discoveredAssetsQueryKeys = {
  all: ["portfolio", "discovered-assets"] as const,
  list: (chains: readonly TPortfolioChainSelector[] | undefined) =>
    [
      "portfolio",
      "discovered-assets",
      chains ? [...chains].sort().join(",") : "all",
    ] as const,
};

export interface UseDiscoveredAssetsOptions {
  chains?: TPortfolioChainSelector[];
  enabled?: boolean;
}

export function useDiscoveredAssets({
  chains,
  enabled = true,
}: UseDiscoveredAssetsOptions = {}) {
  const queryClient = useQueryClient();
  const queryKey = discoveredAssetsQueryKeys.list(chains);

  const query = useQuery<TPortfolioEnvelope<TDiscoveredAsset[]>>({
    queryKey,
    // No `refresh` here: this is the free, cache-first path.
    queryFn: () => portfolioApi.getDiscoveredAssets({ chains }),
    enabled,
    staleTime: STALE_TIME,
    // An "indexing" answer means the wallet is still being indexed upstream;
    // poll until it resolves rather than leaving the user on a stale list.
    refetchInterval: (q) =>
      q.state.data?.status === "indexing" ? 2500 : false,
  });

  const refresh = useMutation({
    mutationFn: () =>
      portfolioApi.getDiscoveredAssets({ chains, refresh: true }),
    onSuccess: (fresh) => {
      // Write straight into the cache so the list updates without a second
      // (cache-first, therefore stale) round trip.
      queryClient.setQueryData(queryKey, fresh);
    },
  });

  const refreshFromSource = useCallback(async () => {
    try {
      await refresh.mutateAsync();
    } catch {
      // A failed refresh leaves the existing list on screen. Nothing to tell
      // the user: they still see their assets, just not newer ones.
    }
  }, [refresh]);

  return {
    assets: query.data?.data ?? [],
    status: query.data?.status ?? "ready",
    fetchedAt: query.data?.fetchedAt,
    fromCache: query.data?.fromCache ?? false,
    /** True when the last refresh was rate-limited and cache was served. */
    throttled: query.data?.throttled ?? false,
    isLoading: query.isLoading,
    isRefreshing: refresh.isPending,
    refreshFromSource,
  };
}
