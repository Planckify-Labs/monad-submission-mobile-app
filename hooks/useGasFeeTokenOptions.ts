/**
 * `useGasFeeTokenOptions` — the stablecoins the user can pick as a gas
 * token, derived from LIVE provider capabilities, never a static table.
 *
 * For every chain the app surfaces (`useBlockchainsWithStorage`, so the
 * chain lockdown and testnet rows are inherited as-is) the registered
 * gas-abstraction provider is asked what fee tokens it accepts there
 * (`provider.listFeeTokens`). The per-chain answers are then grouped by
 * symbol so the Gas Settings screen can show, for each token, exactly
 * which of the user's networks it pays gas on. A chain the provider
 * doesn't serve simply contributes nothing.
 *
 * No chain namespace branching here: the provider's `supportsChain` gate
 * decides what is worth asking, and `buildChainConfigFromBlockchain`
 * does the row → config mapping like every other chain consumer.
 */

import { type QueryObserverResult, useQueries } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { TBlockchain } from "@/api/types/blockchain";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import {
  type GasFeeTokenChainRef,
  groupFeeTokenOptions,
} from "@/services/gasAbstraction/feeTokenOptions";
import { gasAbstractionRegistry } from "@/services/gasAbstraction/registry";
import type { FeeToken } from "@/services/gasAbstraction/types";
import { useBlockchainsWithStorage } from "./useBlockchainsWithStorage";
import {
  buildChainConfigFromBlockchain,
  chainCacheKey,
} from "./useWallet.helpers";

/** Capabilities change rarely; one refetch an hour is plenty. */
const FEE_TOKENS_STALE_TIME = 60 * 60 * 1000;

interface ChainProbe extends GasFeeTokenChainRef {
  chain: ChainConfig;
}

function toProbe(row: TBlockchain): ChainProbe | null {
  let chain: ChainConfig;
  try {
    chain = buildChainConfigFromBlockchain(row);
  } catch {
    // A malformed catalogue row must not take the settings screen down.
    return null;
  }
  // Only chains some provider claims (cheap sync gate) are worth a call.
  if (!gasAbstractionRegistry.resolveProvider(chain)) return null;
  return {
    key: chainCacheKey(chain),
    name: row.name,
    isTestnet: row.isTestnet ?? chain.isTestnet ?? false,
    chain,
  };
}

async function fetchFeeTokens(chain: ChainConfig): Promise<FeeToken[]> {
  const provider = gasAbstractionRegistry.resolveProvider(chain);
  if (!provider) return [];
  try {
    return await provider.listFeeTokens(chain);
  } catch (err) {
    if (__DEV__) console.warn("[useGasFeeTokenOptions] listFeeTokens", err);
    return [];
  }
}

export function useGasFeeTokenOptions() {
  const { data: blockchains, isLoading: chainsLoading } =
    useBlockchainsWithStorage({ isActive: true });

  const probes = useMemo(
    () =>
      (blockchains ?? [])
        .map(toProbe)
        .filter((p): p is ChainProbe => p !== null),
    [blockchains],
  );

  // A stable `combine` lets TanStack skip re-running it (and re-creating
  // `options`) on renders where no chain's token list changed.
  const combine = useCallback(
    (results: QueryObserverResult<FeeToken[]>[]) => {
      const tokensByKey = new Map<string, FeeToken[]>();
      results.forEach((r, i) => {
        const probe = probes[i];
        if (probe && r.data) tokensByKey.set(probe.key, r.data);
      });
      return {
        options: groupFeeTokenOptions(probes, tokensByKey),
        anyPending: results.some((r) => r.isPending),
      };
    },
    [probes],
  );

  const { options, anyPending } = useQueries({
    queries: probes.map((probe) => ({
      queryKey: ["gasFeeTokens", probe.key],
      queryFn: () => fetchFeeTokens(probe.chain),
      staleTime: FEE_TOKENS_STALE_TIME,
    })),
    combine,
  });

  return {
    options,
    /** Chains that were asked (provider-supported), for "none available" copy. */
    probedChainCount: probes.length,
    isLoading: chainsLoading || anyPending,
  };
}
