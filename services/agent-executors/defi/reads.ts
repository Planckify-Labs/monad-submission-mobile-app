/**
 * DeFi read executors — wire `defi_list_opportunities` and
 * `defi_list_positions` to the backend `/strategies/*` endpoints.
 *
 * Spec: docs/defi-strategies-spec.md §11.
 *
 * `defi_list_opportunities` and `defi_get_config` are pure backend
 * calls. `defi_list_positions` is hybrid: the backend owns position
 * metadata (slug, asset, opened_at, goal, target_date, amount_at_deposit),
 * and we enrich each row with the live on-chain balance via the
 * protocol adapter so the user sees the current position value (with
 * accrued interest) instead of a stale DB snapshot.
 */

import { strategiesApi } from "@/api/endpoints/strategies";
import type { TOpportunity, TStrategyPosition } from "@/api/types/strategy";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import { enrichPositionLive } from "@/services/defi/positions/enrich";
import { getDefiAdapter } from "@/services/defi/registry";
import {
  type MobileToolExecutor,
  optionalString,
  safeExecute,
  type ToolInput,
} from "../types";
import { classifyPointsError, sanitizeApiResponse } from "../utils";

/**
 * The chain config for a position row, built from the API's blockchain list.
 *
 * Chain support is data-driven: a chain the backend has not published simply
 * yields `undefined`, and the adapter falls back to the DB snapshot instead of
 * reading against a chain we cannot reach.
 */
function chainConfigForRow(
  context: { blockchains: { chainId?: number | null }[] },
  chainId: number | string | undefined,
): ChainConfig | undefined {
  if (typeof chainId !== "number") return undefined;
  const blockchain = context.blockchains.find((b) => b.chainId === chainId);
  return blockchain
    ? buildChainConfigFromBlockchain(
        blockchain as Parameters<typeof buildChainConfigFromBlockchain>[0],
      )
    : undefined;
}

function optionalInt(input: ToolInput, key: string): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function optionalNumber(input: ToolInput, key: string): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function shapeOpportunity(o: TOpportunity) {
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
    //   2. the mobile app has a registered adapter for this protocol slug
    //      (bespoke/single-market path, §7 "bespoke adapters stay valid" —
    //      e.g. Scallop via the Sui Intent Engine, Aave, Lido).
    // The mobile registry is the authority on what we can actually sign, so we
    // OR the two. We still expose only the boolean, never an address — the card
    // badges/gates off it and the LLM passes `pool_id`/venue, not a target.
    in_app: o.depositTarget != null || getDefiAdapter(o.protocolSlug) != null,
    apy: o.apy,
    apy_7d_avg: o.apy7dAvg,
    tvl_usd: o.tvlUsd,
    score: o.score,
    tier: o.tier,
    il_exposure: o.ilExposure,
    scored_at: o.scoredAt,
  };
}

function shapePosition(p: TStrategyPosition) {
  return {
    id: p.id,
    protocol_slug: p.protocolSlug,
    chain_id: p.chainId,
    chain_name: p.chainName,
    namespace: p.namespace,
    asset_symbol: p.assetSymbol,
    asset_contract: p.assetContract,
    pool_id: p.poolId,
    amount_at_deposit: p.amountAtDeposit,
    amount_at_deposit_usd: p.amountAtDepositUsd,
    current_amount_raw: p.currentAmountRaw,
    current_amount_usd: p.currentAmountUsd,
    /** Live APY off the position's opportunity row, joined server-side at
     *  read time (never persisted — APY drifts). Null when the pool has
     *  aged out of the cache. */
    current_apy: p.currentApy,
    pnl_usd: null as number | null,
    pnl_pct: null as number | null,
    status: p.status,
    open_tx_hash: p.openTxHash,
    close_tx_hash: p.closeTxHash,
    opened_at: p.openedAt,
    closed_at: p.closedAt,
    goal: p.goal,
    target_date: p.targetDate,
  };
}

/**
 * Explicit "every chain" escape hatch on the `namespace` filter. Without
 * it the model has no way to ask for the cross-chain catalog once the
 * default below narrows to the active chain.
 */
const ALL_CHAINS = "all";

/**
 * `defi_list_opportunities` — scored, tier-filtered yield catalog.
 *
 * Backend returns the curated list filtered by tier when the user has a
 * `UserStrategy` row, or unfiltered when they don't. Transient params
 * (tier/asset_symbol/chain_id/liquidity_profile/amount_usd) let
 * first-touch users browse without onboarding (§14.6).
 *
 * Chain scope belongs to the DEVICE, not the model. Every other wallet
 * surface (balances, send, token list) shows the active chain only, and
 * this list follows the same rule: a wallet on Stellar must not be handed
 * Sui and Solana pools it cannot deposit into.
 *
 * "Active chain" means the exact chain, not its family. On Base that is
 * Base, NOT every EVM chain — a wallet on Base holds Base funds, and an
 * Ethereum or Arbitrum pool needs a bridge just like a Sui one does. So
 * the scope is `namespace` PLUS `chain_id` whenever the active chain has
 * a numeric id (`context.activeChainId`, EVM-only by construction, which
 * keeps this free of namespace branching). Non-EVM chains have no numeric
 * id and their rows are `chain_id` 0, so namespace alone pins them.
 *
 * Two deliberate exits exist, and nothing else:
 *   - `namespace: "all"` — the user explicitly asked to see every chain.
 *   - an explicit `chain_id` — a specific chain the user named.
 * Anything else, INCLUDING a bare `namespace` the model chose on its own,
 * resolves to the active namespace. That last part is the load-bearing
 * bit: the model reliably probes other chains ("let me check Sui too"),
 * and honoring those probes is exactly what produced a Sui-only list on a
 * Stellar wallet. Same posture as `walletKit`'s `namespaceScope.ts` —
 * device-side determinism, prompt wording as belt-and-suspenders.
 *
 * There is deliberately NO auto-widening when the active chain has no
 * venues. Silently swapping in other chains' rows is what made the list
 * look like it ignored the wallet. An empty result stays empty and the
 * card offers a one-tap "see every chain" instead, so widening is always
 * the user's choice.
 */
export const listOpportunities: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const tier = optionalString(input, "tier");
    const assetSymbol = optionalString(input, "asset_symbol");
    const chainId = optionalInt(input, "chain_id");
    const requestedNamespace = optionalString(input, "namespace");
    const liquidityProfile = optionalString(input, "liquidity_profile");
    const amountUsd = optionalNumber(input, "amount_usd");

    const activeNamespace = context.wallet.namespace;
    const wantsEveryChain = requestedNamespace === ALL_CHAINS;
    // An explicit chain_id IS the chain scope; don't stack a namespace on it.
    const wantsOneChainId = chainId !== undefined;
    const scopedToActive = !wantsEveryChain && !wantsOneChainId;
    const namespace = scopedToActive ? activeNamespace : undefined;
    // Present only for chains with a numeric id (EVM). Pins Base to Base
    // instead of showing every EVM chain's pools.
    const activeChainId =
      scopedToActive && context.activeChainId && context.activeChainId > 0
        ? context.activeChainId
        : undefined;
    const effectiveChainId = chainId ?? activeChainId;
    // Name the exact chain for the card's empty state ("No yield options on
    // Base"). The namespace family label ("EVM") would be wrong now that the
    // scope is per chain, so prefer the blockchains row and fall back to the
    // family only when the active chain has no numeric id (non-EVM).
    const activeChainName =
      activeChainId !== undefined
        ? (context.blockchains.find((b) => b.chainId === activeChainId)?.name ??
          null)
        : null;
    const chainScope = wantsEveryChain
      ? "all_chains"
      : wantsOneChainId
        ? "requested_chain"
        : "active_chain";

    if (__DEV__) {
      console.warn("[defi/listOpportunities] ENTER", {
        tier,
        assetSymbol,
        chainId,
        requestedNamespace,
        activeNamespace,
        namespace,
        activeChainId,
        effectiveChainId,
        chainScope,
        // Loud on purpose: a namespace the model picked itself is ignored
        // in favour of the active chain, and that should be visible when
        // debugging "why am I not seeing chain X".
        ignoredModelNamespace:
          requestedNamespace !== undefined &&
          !wantsEveryChain &&
          requestedNamespace !== activeNamespace
            ? requestedNamespace
            : undefined,
        liquidityProfile,
        amountUsd,
      });
    }

    try {
      const raw = await strategiesApi.getOpportunities({
        ...(tier ? { tier } : {}),
        ...(assetSymbol ? { asset_symbol: assetSymbol } : {}),
        ...(effectiveChainId !== undefined
          ? { chain_id: effectiveChainId }
          : {}),
        ...(namespace ? { namespace } : {}),
        ...(liquidityProfile ? { liquidity_profile: liquidityProfile } : {}),
        ...(amountUsd !== undefined ? { amount_usd: amountUsd } : {}),
      });
      const opportunities = (raw ?? []).map(shapeOpportunity);

      if (__DEV__) {
        console.warn("[defi/listOpportunities] OK", {
          count: opportunities.length,
          chainScope,
          slugs: opportunities.map((o) => o.protocol_slug),
        });
        // ⚠️ TEMPORARY DIAGNOSTIC — delete with __debugEvmCoverage.ts.
        //
        // `in_app` ORs two independent signals, so a Manual badge does not say
        // WHICH one was missing. The backend can have resolved a target that
        // never reaches here (wrong field name, stripped in transit, stale
        // response) and the symptom is identical to "the resolver refused".
        // Print the raw shape so the two can be told apart.
        const rows = raw ?? [];
        const hasTarget = (o: TOpportunity) => o.depositTarget != null;
        console.warn(
          [
            "═══ DEPOSIT-TARGET WIRE CHECK (copy-paste this) ═══",
            `rows=${rows.length}`,
            `serverResolved=${rows.filter(hasTarget).length}`,
            `adapterOnly=${rows.filter((o) => !hasTarget(o) && getDefiAdapter(o.protocolSlug) != null).length}`,
            `manual=${rows.filter((o) => !hasTarget(o) && getDefiAdapter(o.protocolSlug) == null).length}`,
            // If `depositTarget` is absent from this list, the field is being
            // dropped between Prisma and the device and nothing downstream can
            // recover it. That is the first thing to check.
            `keysOnFirstRow=${JSON.stringify(Object.keys(rows[0] ?? {}))}`,
            `sampleResolved=${JSON.stringify(
              rows
                .filter(hasTarget)
                .slice(0, 5)
                .map((o) => `${o.protocolSlug}:${o.poolId}`),
            )}`,
            "═══ END WIRE CHECK ═══",
          ].join("\n"),
        );
      }
      return {
        status: "success",
        data: sanitizeApiResponse({
          opportunities,
          count: opportunities.length,
          chain_scope: chainScope,
          active_namespace: activeNamespace,
          active_chain_id: activeChainId ?? null,
          active_chain_name: activeChainName,
        }),
      };
    } catch (err) {
      if (__DEV__) {
        console.error("[defi/listOpportunities] failed", {
          tier,
          assetSymbol,
          chainId,
          liquidityProfile,
          amountUsd,
          error: err,
        });
      }
      return { status: "failed", error: classifyPointsError(err) };
    }
  });

/**
 * `defi_get_config` — return the user's UserStrategy row (or null when
 * the wallet has none yet). The LLM uses this to ground tier /
 * whitelist reasoning before proposing a deposit.
 */
export const getConfig: MobileToolExecutor = (_input, _context) =>
  safeExecute(async () => {
    if (__DEV__) {
      console.warn("[defi/getConfig] ENTER");
    }
    try {
      const strategy = await strategiesApi.getStrategy().catch((err) => {
        if (__DEV__) {
          console.warn(
            "[defi/getConfig] getStrategy rejected (treating as no strategy)",
            { error: err },
          );
        }
        return null;
      });
      if (__DEV__) {
        console.warn("[defi/getConfig] OK", {
          hasStrategy: !!strategy,
          tier: strategy?.tier,
          paused: !!strategy?.pausedAt,
          whitelistLen: strategy?.protocolWhitelist?.length ?? 0,
        });
      }
      return {
        status: "success",
        data: sanitizeApiResponse({
          strategy: strategy
            ? {
                tier: strategy.tier,
                liquidity_pref: strategy.liquidityPref,
                allocation_pct: strategy.allocationPct,
                protocol_whitelist: strategy.protocolWhitelist ?? [],
                allow_all_in_tier: !!strategy.allowAllInTier,
                rebalance_trigger: strategy.rebalanceTrigger,
                notification_level: strategy.notificationLevel,
                activated_at: strategy.activatedAt,
                paused_at: strategy.pausedAt,
              }
            : null,
        }),
      };
    } catch (err) {
      if (__DEV__) {
        console.error("[defi/getConfig] failed", { error: err });
      }
      return { status: "failed", error: classifyPointsError(err) };
    }
  });

/**
 * `defi_list_positions` — open positions for the connected wallet.
 *
 * Returns `[]` when the wallet has no positions yet (the backend treats
 * "no UserStrategy row" as "no positions" — never a 404).
 *
 * The backend row is authoritative for *metadata* (slug, asset, opened_at,
 * goal, target_date, amount_at_deposit). For *live state* we read the
 * position on-chain via the protocol adapter (`services/defi/positions/reader.ts`)
 * — aTokens / vault shares / etc. are the source of truth for what the
 * position is worth right now, including accrued interest. The backend
 * `currentAmount*` fields are ignored when the on-chain read succeeds;
 * we fall back to the DB value (or `amountAtDeposit`) only when the
 * adapter can't resolve (unsupported chain, missing asset hint, RPC error).
 */
export const listPositions: MobileToolExecutor = (_input, context) =>
  safeExecute(async () => {
    if (__DEV__) {
      console.warn("[defi/listPositions] ENTER");
    }
    try {
      const raw = await strategiesApi.getPositions();
      const baseRows = (raw ?? []).map(shapePosition);

      const walletAddress = context.wallet.address;
      const enriched = await Promise.all(
        baseRows.map(async (row) => {
          // Lets pool-level (Sui) adapters re-resolve their on-chain target
          // and gives the kind-routed EVM family adapters (Comet, cToken,
          // Morpho Blue, Curve...) the chain config they need — sourced from
          // the API's blockchain rows, not a bundled per-chain constant.
          const live = await enrichPositionLive(
            {
              protocolSlug: row.protocol_slug ?? "",
              chainId: row.chain_id,
              poolId: row.pool_id,
              assetSymbol: row.asset_symbol ?? "",
              assetContract: row.asset_contract,
              amountAtDeposit: row.amount_at_deposit,
              amountAtDepositUsd: Number(row.amount_at_deposit_usd) || 0,
              status: row.status,
            },
            walletAddress,
            chainConfigForRow(context, row.chain_id),
          );
          if (live.currentAmountRaw === null) return row;
          // Best-effort, fire-and-forget: persist the freshly-observed value
          // so consumers that don't do a live read (auto-compound watcher,
          // push notifications) aren't stuck on the permanently-null
          // snapshot this endpoint used to leave behind. Never blocks or
          // fails the response the user is looking at.
          strategiesApi
            .refreshPosition(row.id, {
              currentAmountRaw: live.currentAmountRaw,
              currentAmountUsd: live.currentAmountUsd ?? undefined,
            })
            .catch(() => undefined);
          return {
            ...row,
            current_amount_raw: live.currentAmountRaw,
            current_amount_usd: live.currentAmountUsd ?? row.current_amount_usd,
            pnl_usd: live.pnlUsd,
            pnl_pct: live.pnlPct,
          };
        }),
      );

      if (__DEV__) {
        console.warn("[defi/listPositions] OK", {
          count: enriched.length,
          ids: enriched.map((p) => p.id),
          slugs: enriched.map((p) => p.protocol_slug),
          onchain_amounts: enriched.map((p) => p.current_amount_raw),
        });
      }
      return {
        status: "success",
        data: sanitizeApiResponse({
          positions: enriched,
          count: enriched.length,
        }),
      };
    } catch (err) {
      if (__DEV__) {
        console.error("[defi/listPositions] failed", { error: err });
      }
      return { status: "failed", error: classifyPointsError(err) };
    }
  });
