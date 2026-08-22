/**
 * `useDepositRisk` — whether the position this deposit creates carries
 * impermanent-loss exposure, read the same way `useExitTerms` reads the
 * lockup: re-fetched from the resolved pool row, not from the tool call.
 *
 * `ilExposure` is scored server-side straight from DeFiLlama's own per-pool
 * `ilRisk` field (`api`'s `score-opportunities.processor.ts`) — accurate
 * pool-by-pool (a correlated-asset LP reads `false`; a volatile pair or a
 * concentrated-liquidity zap reads `true`), so this hook is a plain re-fetch,
 * never a client-side guess keyed off `DepositTarget.kind`.
 *
 * Returns `undefined` while loading/unresolvable — the card treats that as
 * "nothing to say," never as a false "no risk."
 */

import { useQuery } from "@tanstack/react-query";
import { strategiesApi } from "@/api/endpoints/strategies";

export { depositRiskNotice } from "./depositRiskCopy";

async function fetchIlExposure(poolId: string): Promise<boolean | undefined> {
  const opportunity = await strategiesApi.getPool(poolId).catch(() => null);
  return opportunity?.ilExposure;
}

/**
 * Card-side hook. Disabled without a `poolId` — same rule as `useExitTerms`.
 */
export function useDepositRisk(poolId: string | undefined) {
  return useQuery({
    queryKey: ["defi", "deposit-risk", poolId],
    queryFn: () => fetchIlExposure(poolId as string),
    enabled: !!poolId,
    staleTime: 30_000,
    retry: 1,
  });
}
