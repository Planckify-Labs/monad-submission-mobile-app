/**
 * `useExitTerms` — what the approval card needs to tell the truth about getting
 * back out (§12 Q2a).
 *
 * The lockup is a property of the RESOLVED target, not of the tool arguments,
 * so this re-fetches the pool by id (the same authoritative row the executor
 * re-reads before signing) and asks the chain's safety provider. The model is
 * not in this path at any point: it supplies `pool_id` and nothing else, which
 * is the §11 Layer-0 rule.
 *
 * Returns `unknown` for anything it cannot establish, including a pool with no
 * resolved target. The card must render that as a refusal to promise liquidity,
 * never as silence.
 */

import { useQuery } from "@tanstack/react-query";
import { strategiesApi } from "@/api/endpoints/strategies";
import type { Namespace } from "@/services/chains/types";
import { getChainSafetyProvider } from "./registry";
import type { ExitTerms } from "./types";

export { exitTermsNotice, formatExitDelay } from "./exitCopy";

const UNKNOWN: ExitTerms = { kind: "unknown" };

/**
 * Resolve a pool's exit terms. Exported separately from the hook so the
 * executor and tests can call it without React.
 */
export async function fetchExitTerms(poolId: string): Promise<ExitTerms> {
  const opportunity = await strategiesApi.getPool(poolId).catch(() => null);
  const target = opportunity?.depositTarget;
  // No resolved target means the pool is Manual anyway; there is nothing to
  // characterise and nothing to deposit into.
  if (!opportunity || !target) return UNKNOWN;

  const provider = getChainSafetyProvider(opportunity.namespace as Namespace);
  // A namespace with no provider has no provider-backed safety at all — the
  // Layer-3 check treats that the same way, so stay consistent rather than
  // showing a scary "unknown" for chains the gate does not police.
  if (!provider) return { kind: "instant" };
  if (!provider.readExitTerms) return UNKNOWN;

  return provider
    .readExitTerms(target, opportunity.chainId)
    .catch(() => UNKNOWN);
}

/**
 * Card-side hook. Disabled without a `poolId` — a legacy slug-routed deposit
 * has no pool row to read, and the Layer-3 check exempts it for the same
 * reason (it predates the pipeline).
 */
export function useExitTerms(poolId: string | undefined) {
  return useQuery({
    queryKey: ["defi", "exit-terms", poolId],
    queryFn: () => fetchExitTerms(poolId as string),
    enabled: !!poolId,
    // The lockup is read from chain state that can change (a cooldown is
    // mutable), so this is short-lived by design — the card should not show a
    // duration the protocol has since raised.
    staleTime: 30_000,
    retry: 1,
  });
}
