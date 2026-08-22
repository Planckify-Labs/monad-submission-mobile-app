/**
 * Position reader dispatcher.
 *
 * Spec: docs/defi-strategies-spec.md §9.2 + §6 (services/defi/positions).
 *
 * Each adapter's `readPosition(walletAddress)` is authoritative for the
 * raw on-chain numbers. This module dispatches to the right adapter by
 * slug and (for adapters that need asset metadata) supplements the call
 * with extra args.
 *
 * The Aave adapter is the only one whose standalone `readPosition` is
 * insufficient — it needs `assetContract` to resolve the aToken via
 * the Pool Data Provider. We carry the asset hint through this module
 * so the executor pipeline doesn't have to know about that quirk.
 */

import type { Address } from "viem";
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  mainnet,
  sepolia,
} from "viem/chains";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { AaveV3Deployments, readAaveV3Position } from "../adapters/aaveV3";
import { getDefiAdapter, getDefiAdapterForTarget } from "../registry";
import type {
  DefiPosition,
  DepositTarget,
  PositionReadContext,
} from "../types";

export interface PositionReadInput {
  protocolSlug: string;
  walletAddress: string;
  /** EVM token contract for the position's underlying asset (e.g. USDC). */
  assetContract?: string;
  assetSymbol?: string;
  assetDecimals?: number;
  chainId?: number | string;
  /**
   * DeFiLlama pool id from the position row. For pool-level adapters (Sui) it's
   * re-resolved to the on-chain `depositTarget` so the adapter knows which
   * reserve/vault to read — the LLM/UI still only ever sees the opaque id (§8).
   */
  poolId?: string;
  /**
   * Chain config for the position's chain, built from the backend blockchain
   * row. Required by the kind-routed EVM family adapters, which have no fixed
   * deployment to derive an RPC client from. Optional so existing callers are
   * unaffected — an adapter that needs it and doesn't get it returns null and
   * the position falls back to the DB snapshot.
   */
  chain?: ChainConfig;
}

/** Best-effort fetch of the authoritative on-chain target for a pool row. */
async function fetchPoolTarget(poolId: string): Promise<DepositTarget | null> {
  try {
    const { strategiesApi } = await import("@/api/endpoints/strategies");
    const opp = await strategiesApi.getPool(poolId).catch(() => null);
    return opp?.depositTarget ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the current on-chain state of a position.
 *
 * `null` means "could not read" — no adapter claims this position, or the read
 * failed. It does NOT mean "empty": an adapter that resolves reports a real
 * zero, and callers depend on that distinction. `withdraw`'s
 * `no_onchain_balance` guard fires on `currentAmount <= 0n`, which a `null` can
 * never satisfy, so an adapter returning `null` for a drained position silently
 * disables the guard rather than tripping it.
 */
export async function readPosition(
  input: PositionReadInput,
): Promise<DefiPosition | null> {
  let adapter = getDefiAdapter(input.protocolSlug);
  let prefetchedTarget: DepositTarget | null = null;

  // Kind-routed families carry the DEFILLAMA PROJECT slug, which no adapter
  // claims — `Erc4626Adapter` declares no `externalSlugs` and serves Sky,
  // Morpho, Yearn and Euler alike. A slug-only lookup therefore missed every
  // one of them and returned null here, which silently disabled the caller's
  // guard rather than failing: `withdraw`'s `no_onchain_balance` preflight
  // exists to stop a doomed MAX withdraw, and for these families it never ran.
  //
  // The user-visible symptom was two different codes for one situation —
  // `compound-v3` (slug claimed) refused an emptied position with
  // `no_onchain_balance`, while an ERC-4626 vault fell through to the
  // adapter's own `position_not_found` ("erc4626: no shares"), which is a
  // different recovery class and is not even true: the row exists, it is
  // drained. Found by the Gate-4 fork case, 2026-08-22.
  //
  // Routing by the target's `kind` is exactly what the DEPOSIT path already
  // does (`getDefiAdapterForTarget` in `agent-executors/defi/writes.ts`), so
  // this makes the read agree with the write. Additive on purpose: a slug that
  // already resolved keeps its adapter and its behaviour unchanged.
  if (!adapter && input.poolId) {
    prefetchedTarget = await fetchPoolTarget(input.poolId);
    adapter = getDefiAdapterForTarget(input.protocolSlug, prefetchedTarget);
  }
  if (!adapter) return null;

  // Aave needs the asset contract + chain to derive the aToken via
  // the Pool Data Provider. Use the specialized reader.
  if (input.protocolSlug.startsWith("aave-v3-")) {
    const deploymentKey = aaveDeploymentKeyForSlug(input.protocolSlug);
    if (!deploymentKey) return null;
    const deployment = AaveV3Deployments[deploymentKey];
    const viemChain = aaveViemChainFor(deployment.chainId);
    if (!viemChain) return null;
    // The backend position row frequently omits `asset_contract`. The
    // underlying is deterministic per (deployment, symbol), so fall
    // back to the adapter's address-book — otherwise the live read
    // silently returns null and the position reports a null
    // `current_amount_raw`, masking the real on-chain balance (and
    // letting a doomed MAX withdraw get submitted downstream).
    const assetSymbol = input.assetSymbol ?? "USDC";
    const underlyings = (
      deployment as { underlyings?: Partial<Record<string, string>> }
    ).underlyings;
    const assetContract = input.assetContract ?? underlyings?.[assetSymbol];
    if (!assetContract) return null;
    return readAaveV3Position({
      deployment,
      viemChain,
      walletAddress: input.walletAddress as Address,
      assetSymbol,
      assetContract: assetContract as Address,
      assetDecimals: input.assetDecimals ?? 6,
    });
  }

  // Build the optional read context. For pool-level adapters (those declaring
  // `targetKinds` — Sui reserves/vaults with no fixed per-asset deployment),
  // re-resolve the authoritative on-chain target from the row's `pool_id` so the
  // adapter knows exactly which reserve/vault to read. Presence-checked on the
  // adapter (never a namespace branch); best-effort so a target-fetch failure
  // degrades to the DB snapshot instead of dropping the position.
  const ctx: PositionReadContext = {
    assetContract: input.assetContract,
    assetSymbol: input.assetSymbol,
    assetDecimals: input.assetDecimals,
    chain: input.chain,
  };
  if (input.poolId && adapter.targetKinds?.length) {
    // Reuse the target the adapter lookup above already fetched rather than
    // asking the backend for the same row twice.
    const target = prefetchedTarget ?? (await fetchPoolTarget(input.poolId));
    if (target) ctx.target = target;
  }

  // Default — let the adapter handle it.
  return adapter.readPosition(input.walletAddress, ctx);
}

function aaveDeploymentKeyForSlug(
  slug: string,
): keyof typeof AaveV3Deployments | null {
  switch (slug) {
    case "aave-v3-ethereum":
      return "ethereum";
    case "aave-v3-base":
      return "base";
    case "aave-v3-arbitrum":
      return "arbitrum";
    case "aave-v3-sepolia":
      return "ethereumSepolia";
    case "aave-v3-base-sepolia":
      return "baseSepolia";
    case "aave-v3-arbitrum-sepolia":
      return "arbitrumSepolia";
    default:
      return null;
  }
}

function aaveViemChainFor(chainId: number): import("viem").Chain | null {
  switch (chainId) {
    case 1:
      return mainnet;
    case 8453:
      return base;
    case 42161:
      return arbitrum;
    case 11155111:
      return sepolia;
    case 84532:
      return baseSepolia;
    case 421614:
      return arbitrumSepolia;
    default:
      return null;
  }
}
