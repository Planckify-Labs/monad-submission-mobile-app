/**
 * Aave V3 adapter — supply / withdraw / readPosition.
 *
 * Spec: docs/defi-strategies-spec.md §7.7, Appendix B.1.
 *
 * Coordinates resolve in this order:
 *   1. Hardcoded `AAVE_V3.<deployment>.pool` constant (doc-sourced,
 *      compile-time safe — same posture as `@bgd-labs/aave-address-book`).
 *   2. `chain.smartContracts` registry entry named `aave_v3_pool`
 *      (lets ops swap addresses on staging without a code change).
 *
 * `readPosition` uses the Pool Data Provider to find the aToken for the
 * asset, then calls `balanceOf(wallet)` on the aToken (rebasing 1:1
 * with the underlying — `balanceOf` IS the position in underlying units).
 */

import { type Address, encodeFunctionData, erc20Abi, type Hex } from "viem";
import { getPublicClient } from "@/utils/clients";
import { AAVE_V3 } from "../constants/addresses";
import { DefiError } from "../errors/defiErrors";
import type {
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  UnsignedCall,
} from "../types";

const AAVE_V3_POOL_IDENTIFIER = "aave_v3_pool";
const AAVE_V3_DATA_PROVIDER_IDENTIFIER = "aave_v3_data_provider";

const POOL_ABI = [
  {
    name: "supply",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const DATA_PROVIDER_ABI = [
  {
    name: "getReserveTokensAddresses",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "aTokenAddress", type: "address" },
      { name: "stableDebtTokenAddress", type: "address" },
      { name: "variableDebtTokenAddress", type: "address" },
    ],
  },
] as const;

// Withdraw sentinel — Aave treats `type(uint256).max` as "withdraw the
// entire aToken balance" (Pool.sol). Safer than calling aToken.balanceOf
// from mobile and racing the rebase.
const MAX_UINT256 = (1n << 256n) - 1n;

interface AaveDeployment {
  chainId: number;
  pool: Hex;
  poolDataProvider: Hex;
  underlyings?: Partial<Record<string, Hex>>;
}

function resolveUnderlying(
  deployment: AaveDeployment,
  asset: { symbol: string; contract?: string },
): Address {
  if (asset.contract) return asset.contract as Address;
  const fallback = deployment.underlyings?.[asset.symbol];
  if (!fallback) {
    throw new DefiError(
      "unsupported_asset",
      `aave-v3 requires ERC-20 asset (symbol=${asset.symbol}, chainId=${deployment.chainId})`,
    );
  }
  return fallback as Address;
}

function createAaveV3Adapter(
  slug: string,
  deployment: AaveDeployment,
  displayName: string,
): DefiProtocolAdapter {
  return {
    slug,
    namespace: "eip155",
    kind: "stablecoin_lending",
    chainId: deployment.chainId,
    displayName,
    staticSafetyScore: 90,
    // Pool-level deposits (§7): when a resolved `{ kind: "aave-v3" }` target is
    // present, the executor routes here by kind and we read the concrete
    // { pool, asset } from it instead of the per-deployment constant.
    targetKinds: ["aave-v3"],

    async buildDeposit({ wallet, chain, asset, amount, target }) {
      const pool =
        target?.kind === "aave-v3"
          ? target.pool
          : resolvePoolAddress(chain, deployment);
      const underlying =
        target?.kind === "aave-v3"
          ? target.asset
          : resolveUnderlying(deployment, asset);
      // Defence in depth, as in the Comet/4626 adapters: the resolved target is
      // the trusted source, so an explicit asset that disagrees with it means
      // the caller and the server disagree about what is being deposited.
      if (
        asset.contract &&
        asset.contract.toLowerCase() !== underlying.toLowerCase()
      ) {
        throw new DefiError(
          "unsupported_asset",
          "aave-v3: asset does not match the reserve's underlying",
        );
      }
      return {
        kind: "evm-call",
        to: pool,
        data: encodeFunctionData({
          abi: POOL_ABI,
          functionName: "supply",
          args: [
            underlying,
            amount,
            wallet.address as Address,
            0, // referralCode — inactive on v3
          ],
        }),
        needsApproval: {
          token: underlying,
          spender: pool,
          amount,
        },
      } satisfies UnsignedCall;
    },

    async buildWithdraw({ wallet, chain, asset, amount, target }) {
      const pool =
        target?.kind === "aave-v3"
          ? target.pool
          : resolvePoolAddress(chain, deployment);
      const underlying =
        target?.kind === "aave-v3"
          ? target.asset
          : resolveUnderlying(deployment, asset);
      const rawAmount = amount === "MAX" ? MAX_UINT256 : amount;
      return {
        kind: "evm-call",
        to: pool,
        data: encodeFunctionData({
          abi: POOL_ABI,
          functionName: "withdraw",
          args: [underlying, rawAmount, wallet.address as Address],
        }),
      } satisfies UnsignedCall;
    },

    async readPosition(walletAddress: string): Promise<DefiPosition | null> {
      // We can't resolve a chain.smartContracts override here because
      // readPosition runs without a `chain` argument. Use the hardcoded
      // constants directly — this is the "address-book" posture.
      try {
        // We don't know the asset symbol from the slug alone. Position
        // reads for Aave are best driven by the position record (the
        // executor invokes `positions/reader.ts` which passes the
        // asset). For the standalone path, return null and let the
        // backend's StrategyPosition table be the source of truth.
        return null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Resolve the Pool address for an Aave deployment. Prefers
 * `chain.smartContracts` (lets ops swap addresses on staging) and
 * falls back to the hardcoded `AAVE_V3.*` constant. Throws a typed
 * DefiError if neither yields a non-empty address.
 */
function resolvePoolAddress(
  chain: { smartContracts?: { name: string; address: string }[] } | undefined,
  deployment: AaveDeployment,
): Address {
  const override = chain?.smartContracts?.find(
    (s) => s.name === AAVE_V3_POOL_IDENTIFIER,
  )?.address;
  if (override && /^0x[0-9a-fA-F]{40}$/.test(override))
    return override as Address;
  return deployment.pool;
}

function resolveDataProviderAddress(
  chain: { smartContracts?: { name: string; address: string }[] } | undefined,
  deployment: AaveDeployment,
): Address {
  const override = chain?.smartContracts?.find(
    (s) => s.name === AAVE_V3_DATA_PROVIDER_IDENTIFIER,
  )?.address;
  if (override && /^0x[0-9a-fA-F]{40}$/.test(override))
    return override as Address;
  return deployment.poolDataProvider;
}

/**
 * Standalone position reader used by `positions/reader.ts`. Hits the
 * Pool Data Provider to find the aToken for `assetContract`, then reads
 * `aToken.balanceOf(walletAddress)` which IS the position in underlying
 * units (aTokens rebase 1:1).
 */
export async function readAaveV3Position(args: {
  deployment: AaveDeployment;
  viemChain: import("viem").Chain;
  walletAddress: Address;
  assetSymbol: string;
  assetContract: Address;
  assetDecimals: number;
}): Promise<DefiPosition | null> {
  try {
    const client = getPublicClient(args.viemChain);
    const [aTokenAddress] = await client.readContract({
      address: args.deployment.poolDataProvider,
      abi: DATA_PROVIDER_ABI,
      functionName: "getReserveTokensAddresses",
      args: [args.assetContract],
    });
    if (
      !aTokenAddress ||
      aTokenAddress === "0x0000000000000000000000000000000000000000"
    ) {
      return null;
    }
    const balance = await client.readContract({
      address: aTokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [args.walletAddress],
    });
    return {
      protocolSlug: `aave-v3-${chainIdToSlug(args.deployment.chainId)}`,
      namespace: "eip155",
      chainId: args.deployment.chainId,
      assetSymbol: args.assetSymbol,
      amountAtDeposit: 0n,
      amountAtDepositUsd: 0,
      currentAmount: balance,
      currentAmountUsd: 0, // priced upstream by positions/pnl.ts
      pnlUsd: 0,
    };
  } catch {
    return null;
  }
}

function chainIdToSlug(chainId: number): string {
  switch (chainId) {
    case 1:
      return "ethereum";
    case 8453:
      return "base";
    case 42161:
      return "arbitrum";
    case 11155111:
      return "sepolia";
    case 84532:
      return "base-sepolia";
    case 421614:
      return "arbitrum-sepolia";
    default:
      return String(chainId);
  }
}

// Mainnet adapters
export const AaveV3EthereumAdapter = createAaveV3Adapter(
  "aave-v3-ethereum",
  AAVE_V3.ethereum,
  "Aave V3 (Ethereum)",
);
export const AaveV3BaseAdapter = createAaveV3Adapter(
  "aave-v3-base",
  AAVE_V3.base,
  "Aave V3 (Base)",
);
export const AaveV3ArbitrumAdapter = createAaveV3Adapter(
  "aave-v3-arbitrum",
  AAVE_V3.arbitrum,
  "Aave V3 (Arbitrum)",
);

// Testnet adapters — feature-flagged at boot.
export const AaveV3EthereumSepoliaAdapter = createAaveV3Adapter(
  "aave-v3-sepolia",
  AAVE_V3.ethereumSepolia,
  "Aave V3 (Sepolia)",
);
export const AaveV3BaseSepoliaAdapter = createAaveV3Adapter(
  "aave-v3-base-sepolia",
  AAVE_V3.baseSepolia,
  "Aave V3 (Base Sepolia)",
);
export const AaveV3ArbitrumSepoliaAdapter = createAaveV3Adapter(
  "aave-v3-arbitrum-sepolia",
  AAVE_V3.arbitrumSepolia,
  "Aave V3 (Arbitrum Sepolia)",
);

export const AaveV3Deployments = {
  ethereum: AAVE_V3.ethereum,
  base: AAVE_V3.base,
  arbitrum: AAVE_V3.arbitrum,
  ethereumSepolia: AAVE_V3.ethereumSepolia,
  baseSepolia: AAVE_V3.baseSepolia,
  arbitrumSepolia: AAVE_V3.arbitrumSepolia,
} as const;
