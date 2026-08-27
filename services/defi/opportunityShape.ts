/**
 * `TOpportunity` (backend, camelCase) → the snake_case row shape the agent
 * tool payload and the DeFi cards read.
 *
 * Extracted out of `services/agent-executors/defi/reads.ts` because the
 * Quick Invest card re-fetches opportunities *directly* when the user
 * changes the risk dial (defi-quick-invest-spec §3.1 — `tier` is a hard
 * Prisma filter, so a dial change cannot be a client-side recompute).
 * Both callers must produce identical rows, so the mapping lives in one
 * place instead of being mirrored by hand.
 *
 * Pure apart from the adapter-registry lookup behind `in_app`.
 */

import type { TOpportunity } from "@/api/types/strategy";
import { getDefiAdapter } from "@/services/defi/registry";

/**
 * A registered mobile adapter that does NOT require a server-resolved
 * `depositTarget` can execute from the slug alone (bespoke/single-market
 * adapters — Scallop, NAVI, Ember). Adapters that DO require a target
 * open with `if (!target) throw`, so only a `requiresTarget !== true`
 * adapter can honour a slug-only deposit.
 */
function canBuildWithoutTarget(slug: string): boolean {
  const adapter = getDefiAdapter(slug);
  return adapter != null && adapter.requiresTarget !== true;
}

export function shapeOpportunity(o: TOpportunity) {
  return {
    id: o.id,
    protocol_slug: o.protocolSlug,
    chain_id: o.chainId,
    chain_name: o.chainName,
    namespace: o.namespace,
    asset_symbol: o.assetSymbol,
    asset_contract: o.assetContract,
    pool_id: o.poolId,
    pool_meta: o.poolMeta ?? null,
    // Protocol's own site (DeFiLlama `/protocol/{slug}.url`) — the "Manual"
    // badge opens this instead of the DeFiLlama page (spec §9.1 layer 2).
    app_url: o.appUrl ?? null,
    // Executability signal (spec §2.1). A pool is AI-agent-executable in-app
    // via EITHER path:
    //   1. the backend resolved a `depositTarget` (generic kind-routed adapter,
    //      §7 — e.g. any Morpho/Yearn vault), OR
    //   2. the mobile app has a registered adapter for this protocol slug that
    //      can build WITHOUT one (bespoke/single-market path, §7 "bespoke
    //      adapters stay valid" — Scallop, NAVI and Ember keep their canonical
    //      market when no target is present).
    //
    // The `requiresTarget` half of (2) is load-bearing and was missing. A
    // kind-routed family adapter also carries `externalSlugs`, so the slug
    // fallback matched it and the pool reported executable — but those
    // adapters open with `if (!target) throw`, so the deposit could only fail
    // at build time. Measured on device 2026-08-21: 5 Aerodrome, 2 Curve, 2
    // Benqi and 1 ether.fi pool badged "Deposit in-app" with nothing able to
    // execute them. Benqi is the clearest case — its chain is not even in the
    // directory, so no target can exist for it at all.
    //
    // We still expose only the boolean, never an address — the card
    // badges/gates off it and the LLM passes `pool_id`/venue, not a target.
    in_app: o.depositTarget != null || canBuildWithoutTarget(o.protocolSlug),
    // Outside the user's saved risk tier — returned so the card can tell
    // the truth about availability, never so it can deposit into them.
    outside_tier: o.outsideTier === true,
    apy: o.apy,
    apy_7d_avg: o.apy7dAvg,
    tvl_usd: o.tvlUsd,
    score: o.score,
    tier: o.tier,
    il_exposure: o.ilExposure,
    scored_at: o.scoredAt,
  };
}

export type ShapedOpportunity = ReturnType<typeof shapeOpportunity>;
