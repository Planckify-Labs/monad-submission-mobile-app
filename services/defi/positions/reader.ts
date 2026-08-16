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
import { getDefiAdapter } from "../registry";
import type { DefiPosition, PositionReadContext } from "../types";

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

/**
 * Read the current on-chain state of a position. Returns `null` when
 * the adapter can't resolve (e.g. Aave without an asset hint, or the
 * position is empty).
 */
export async function readPosition(
  input: PositionReadInput,
): Promise<DefiPosition | null> {
  const adapter = getDefiAdapter(input.protocolSlug);
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
    try {
      const { strategiesApi } = await import("@/api/endpoints/strategies");
      const opp = await strategiesApi.getPool(input.poolId).catch(() => null);
      if (opp?.depositTarget) ctx.target = opp.depositTarget;
    } catch {
      // best-effort — adapter falls back to null / DB snapshot
    }
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
