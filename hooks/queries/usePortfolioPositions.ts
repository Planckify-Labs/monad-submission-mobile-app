/**
 * Externally-discovered DeFi positions — protocol positions this wallet holds
 * that were NOT opened in-app, grouped per protocol.
 *
 * These are tracked, not managed: there is no in-app withdraw path for them,
 * and their values are the indexer's estimate rather than an on-chain read.
 * Surfaces must say so.
 *
 * Same cached/refresh contract as `useDiscoveredAssets`: automatic refetches
 * are free, `refreshFromSource()` is the user's pull-to-refresh.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { portfolioApi } from "@/api/endpoints/portfolio";
import type {
  TPortfolioChainSelector,
  TPortfolioEnvelope,
  TPortfolioPosition,
} from "@/api/types/portfolio";

const STALE_TIME = 60 * 60 * 1000;

export const portfolioPositionsQueryKeys = {
  list: (chains: readonly TPortfolioChainSelector[] | undefined) =>
    [
      "portfolio",
      "defi-positions",
      chains ? [...chains].sort().join(",") : "all",
    ] as const,
};

/** One protocol's worth of positions, which is how the UI groups them. */
export interface PortfolioPositionGroup {
  /** Kebab-case protocol slug, or `"other"` when the indexer had none. */
  dappId: string;
  protocolName: string;
  logoUrl: string | null;
  positions: TPortfolioPosition[];
  /** Sum of position values, excluding borrowed rows (those are liabilities). */
  totalValueUsd: number;
}

function groupByProtocol(
  positions: TPortfolioPosition[],
): PortfolioPositionGroup[] {
  const groups = new Map<string, PortfolioPositionGroup>();

  for (const position of positions) {
    const key = position.dappId ?? "other";
    const existing = groups.get(key);
    const group: PortfolioPositionGroup = existing ?? {
      dappId: key,
      protocolName: position.protocolName ?? position.dappId ?? "Other",
      logoUrl: position.logoUrl,
      positions: [],
      totalValueUsd: 0,
    };

    group.positions.push(position);
    if (position.status !== "borrowed" && position.valueUsd !== null) {
      group.totalValueUsd += position.valueUsd;
    }
    if (!group.logoUrl && position.logoUrl) group.logoUrl = position.logoUrl;

    groups.set(key, group);
  }

  return [...groups.values()].sort((a, b) => b.totalValueUsd - a.totalValueUsd);
}

export interface UsePortfolioPositionsOptions {
  chains?: TPortfolioChainSelector[];
  enabled?: boolean;
}

export function usePortfolioPositions({
  chains,
  enabled = true,
}: UsePortfolioPositionsOptions = {}) {
  const queryClient = useQueryClient();
  const queryKey = portfolioPositionsQueryKeys.list(chains);

  const query = useQuery<TPortfolioEnvelope<TPortfolioPosition[]>>({
    queryKey,
    queryFn: () => portfolioApi.getDefiPositions({ chains }),
    enabled,
    staleTime: STALE_TIME,
    refetchInterval: (q) =>
      q.state.data?.status === "indexing" ? 2500 : false,
  });

  const refresh = useMutation({
    mutationFn: () => portfolioApi.getDefiPositions({ chains, refresh: true }),
    onSuccess: (fresh) => queryClient.setQueryData(queryKey, fresh),
  });

  const refreshFromSource = useCallback(async () => {
    try {
      await refresh.mutateAsync();
    } catch {
      // Keep the existing list on screen; nothing useful to tell the user.
    }
  }, [refresh]);

  const positions = useMemo(() => query.data?.data ?? [], [query.data]);
  const groups = useMemo(() => groupByProtocol(positions), [positions]);

  return {
    positions,
    groups,
    status: query.data?.status ?? "ready",
    fetchedAt: query.data?.fetchedAt,
    isLoading: query.isLoading,
    isRefreshing: refresh.isPending,
    refreshFromSource,
  };
}
