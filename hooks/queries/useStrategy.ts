import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  strategiesApi,
  type TCreateStrategyPayload,
  type TOpportunitySearchParams,
} from "@/api/endpoints/strategies";
import type { TBlockchain } from "@/api/types/blockchain";
import type {
  RiskTier,
  TOpportunity,
  TStrategyPosition,
  TUserStrategy,
} from "@/api/types/strategy";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import { storage } from "@/lib/storage/mmkv";
import { enrichPositionLive } from "@/services/defi/positions/enrich";

const QKEY = {
  strategy: ["strategy"] as const,
  positions: ["strategy", "positions"] as const,
  opportunities: (params: TOpportunitySearchParams = {}) =>
    ["strategy", "opportunities", params] as const,
  protocols: (tier?: RiskTier) => ["strategy", "protocols", tier] as const,
};

// MMKV keys. Two entries per query: payload + write timestamp. The
// timestamp is wired into React Query's `initialDataUpdatedAt` so the
// background refetch obeys `staleTime` even when the very first paint
// comes from cache.
const KEY = {
  strategy: "strategies:user",
  strategyTs: "strategies:user:ts",
  positions: "strategies:positions",
  positionsTs: "strategies:positions:ts",
  opportunities: (params: TOpportunitySearchParams = {}) =>
    `strategies:opportunities:${JSON.stringify(params)}`,
  opportunitiesTs: (params: TOpportunitySearchParams = {}) =>
    `strategies:opportunities:${JSON.stringify(params)}:ts`,
};

const STALE_TIME = 60 * 1000;
const OFFLINE_CACHE_TTL = 24 * 60 * 60 * 1000;

const isNotFound = (err: unknown): boolean => {
  const status = (err as { response?: { status?: number } } | null)?.response
    ?.status;
  return status === 404;
};

function readJson<T>(key: string): T | undefined {
  const raw = storage.getString(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function readTs(key: string): number {
  const raw = storage.getString(key);
  return raw ? Number.parseInt(raw, 10) || 0 : 0;
}

function writeJson(key: string, tsKey: string, value: unknown): void {
  storage.set(key, JSON.stringify(value));
  storage.set(tsKey, Date.now().toString());
}

// `null` is a valid cached value here (user has no strategy, 404).
// Keeping it explicit so cold-start renders can skip the spinner.
function readCachedStrategy(): TUserStrategy | null | undefined {
  return readJson<TUserStrategy | null>(KEY.strategy);
}

export const useUserStrategy = (enabled = true) => {
  return useQuery<TUserStrategy | null>({
    queryKey: QKEY.strategy,
    initialData: () => readCachedStrategy(),
    initialDataUpdatedAt: () => readTs(KEY.strategyTs),
    queryFn: async () => {
      try {
        const fresh = await strategiesApi.getStrategy();
        writeJson(KEY.strategy, KEY.strategyTs, fresh);
        return fresh;
      } catch (err) {
        if (isNotFound(err)) {
          // Persist the "no strategy yet" answer too so the next cold
          // start doesn't pay another 404 round-trip on the home tile.
          writeJson(KEY.strategy, KEY.strategyTs, null);
          return null;
        }
        // Offline / transient failure: serve last good payload within TTL.
        const cached = readCachedStrategy();
        if (
          cached !== undefined &&
          Date.now() - readTs(KEY.strategyTs) < OFFLINE_CACHE_TTL
        ) {
          return cached;
        }
        throw err;
      }
    },
    enabled,
    retry: (failureCount, err) => {
      if (isNotFound(err)) return false;
      return failureCount < 1;
    },
    staleTime: STALE_TIME,
    gcTime: OFFLINE_CACHE_TTL,
  });
};

function chainConfigForPosition(
  blockchains: TBlockchain[] | undefined,
  chainId: number,
) {
  const blockchain = blockchains?.find((b) => b.chainId === chainId);
  return blockchain ? buildChainConfigFromBlockchain(blockchain) : undefined;
}

/**
 * `walletAddress`/`blockchains` drive the same live on-chain-read + USD
 * price enrichment `defi_list_positions` does in chat
 * (`services/agent-executors/defi/reads.ts`) — both go through
 * `services/defi/positions/enrich.ts` so the Strategies tab and the chat
 * card never diverge. Omit them (or leave `blockchains` empty) and this
 * degrades gracefully to the DB snapshot, same as a failed on-chain read.
 */
export const useStrategyPositions = (
  enabled = true,
  walletAddress?: string,
  blockchains?: TBlockchain[],
) => {
  return useQuery<TStrategyPosition[]>({
    queryKey: [...QKEY.positions, walletAddress],
    initialData: () => readJson<TStrategyPosition[]>(KEY.positions),
    initialDataUpdatedAt: () => readTs(KEY.positionsTs),
    queryFn: async () => {
      try {
        const fresh = await strategiesApi.getPositions();
        const enriched = walletAddress
          ? await Promise.all(
              fresh.map(async (position) => {
                const live = await enrichPositionLive(
                  {
                    protocolSlug: position.protocolSlug,
                    chainId: position.chainId,
                    poolId: position.poolId,
                    assetSymbol: position.assetSymbol,
                    assetContract: position.assetContract,
                    amountAtDeposit: position.amountAtDeposit,
                    amountAtDepositUsd:
                      Number(position.amountAtDepositUsd) || 0,
                    status: position.status,
                  },
                  walletAddress,
                  chainConfigForPosition(blockchains, position.chainId),
                );
                if (live.currentAmountRaw === null) return position;
                strategiesApi
                  .refreshPosition(position.id, {
                    currentAmountRaw: live.currentAmountRaw,
                    currentAmountUsd: live.currentAmountUsd ?? undefined,
                  })
                  .catch(() => undefined);
                return {
                  ...position,
                  currentAmountRaw: live.currentAmountRaw,
                  currentAmountUsd:
                    live.currentAmountUsd !== null
                      ? String(live.currentAmountUsd)
                      : position.currentAmountUsd,
                };
              }),
            )
          : fresh;
        writeJson(KEY.positions, KEY.positionsTs, enriched);
        return enriched;
      } catch (err) {
        const cached = readJson<TStrategyPosition[]>(KEY.positions);
        if (
          cached &&
          Date.now() - readTs(KEY.positionsTs) < OFFLINE_CACHE_TTL
        ) {
          return cached;
        }
        throw err;
      }
    },
    enabled,
    staleTime: STALE_TIME,
    gcTime: OFFLINE_CACHE_TTL,
  });
};

export const useStrategyOpportunities = (
  params: TOpportunitySearchParams = {},
  enabled = true,
) => {
  const payloadKey = KEY.opportunities(params);
  const tsKey = KEY.opportunitiesTs(params);
  return useQuery<TOpportunity[]>({
    queryKey: QKEY.opportunities(params),
    initialData: () => readJson<TOpportunity[]>(payloadKey),
    initialDataUpdatedAt: () => readTs(tsKey),
    queryFn: async () => {
      try {
        const fresh = await strategiesApi.getOpportunities(params);
        writeJson(payloadKey, tsKey, fresh);
        return fresh;
      } catch (err) {
        const cached = readJson<TOpportunity[]>(payloadKey);
        if (cached && Date.now() - readTs(tsKey) < OFFLINE_CACHE_TTL) {
          return cached;
        }
        throw err;
      }
    },
    enabled,
    staleTime: STALE_TIME,
    gcTime: OFFLINE_CACHE_TTL,
  });
};

export const useStrategyProtocols = (tier?: RiskTier, enabled = true) => {
  return useQuery({
    queryKey: QKEY.protocols(tier),
    queryFn: () => strategiesApi.getProtocols(tier),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
};

export const useCreateStrategyMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: TCreateStrategyPayload) =>
      strategiesApi.createStrategy(payload),
    onSuccess: (created) => {
      queryClient.setQueryData(QKEY.strategy, created);
      writeJson(KEY.strategy, KEY.strategyTs, created);
      queryClient.invalidateQueries({ queryKey: QKEY.positions });
    },
  });
};

export const useUpdateStrategyMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<
    TUserStrategy,
    unknown,
    Partial<TCreateStrategyPayload>,
    { previous: TUserStrategy | null | undefined }
  >({
    mutationFn: (payload) => strategiesApi.updateStrategy(payload),
    onMutate: async (payload) => {
      // Cancel any in-flight strategy refetch so it doesn't clobber the
      // optimistic update.
      await queryClient.cancelQueries({ queryKey: QKEY.strategy });
      const previous = queryClient.getQueryData<TUserStrategy | null>(
        QKEY.strategy,
      );
      if (previous) {
        const optimistic = { ...previous, ...payload } as TUserStrategy;
        queryClient.setQueryData(QKEY.strategy, optimistic);
        writeJson(KEY.strategy, KEY.strategyTs, optimistic);
      }
      return { previous };
    },
    onError: (_err, _payload, ctx) => {
      // Roll back both the in-memory cache and MMKV so a failed save
      // doesn't leave a stale optimistic value behind on the next cold
      // start.
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(QKEY.strategy, ctx.previous);
        writeJson(KEY.strategy, KEY.strategyTs, ctx.previous);
      }
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(QKEY.strategy, updated);
      writeJson(KEY.strategy, KEY.strategyTs, updated);
      // Tier may have moved → opportunities list is filtered by tier.
      // Don't invalidate `["strategy"]` (prefix match) or `["strategy",
      // "positions"]` — the strategy was just set with the server's
      // authoritative payload, and positions don't depend on tier
      // changes. Extra invalidation triggers redundant refetches that
      // erode the optimistic-feel of the settings save.
      queryClient.invalidateQueries({
        queryKey: ["strategy", "opportunities"],
      });
    },
  });
};
