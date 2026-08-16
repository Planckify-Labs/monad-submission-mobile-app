/**
 * MorphoBlueAdapter — direct (isolated) markets on the Morpho singleton
 * (docs/defi-evm-protocol-expansion-spec.md §5.2, §3.1).
 *
 * `supply`/`withdraw` take the full `MarketParams` struct, not the market id —
 * the id is `keccak256(abi.encode(params))`, which cannot be inverted on-chain.
 * That is why the target carries `params` and why the backend re-derives the
 * hash before the target is ever trusted (§3.1). This adapter simply passes the
 * struct through; it never reconstructs or guesses any field.
 *
 * **Lender-side only.** We supply as `onBehalf = the user's own wallet` and
 * receive back to the same wallet. `onBehalf` is never a third party — that is
 * also asserted by the Layer-4 decoded-intent check before signing.
 *
 * Morpho's rule: exactly ONE of `assets`/`shares` must be zero.
 *   - deposit and partial withdraw  → by `assets`
 *   - full withdraw ("MAX")         → by `shares`, read from the position
 * Withdrawing a full balance by assets would race interest accrual and revert
 * on a wei of rounding; withdrawing by shares is exact.
 */

import { type Address, encodeFunctionData } from "viem";
import { assertEvmChain } from "@/constants/configs/chainConfig";
import { getPublicClient } from "@/utils/clients";
import { morphoSingleton } from "../constants/evmAddressBook";
import { DefiError } from "../errors/defiErrors";
import type {
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  DepositTarget,
  MorphoMarketParams,
  PositionReadContext,
  UnsignedCall,
} from "../types";

const MARKET_PARAMS_COMPONENTS = [
  { name: "loanToken", type: "address" },
  { name: "collateralToken", type: "address" },
  { name: "oracle", type: "address" },
  { name: "irm", type: "address" },
  { name: "lltv", type: "uint256" },
] as const;

const MORPHO_ABI = [
  {
    name: "supply",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "marketParams",
        type: "tuple",
        components: MARKET_PARAMS_COMPONENTS,
      },
      { name: "assets", type: "uint256" },
      { name: "shares", type: "uint256" },
      { name: "onBehalf", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [
      { name: "assetsSupplied", type: "uint256" },
      { name: "sharesSupplied", type: "uint256" },
    ],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "marketParams",
        type: "tuple",
        components: MARKET_PARAMS_COMPONENTS,
      },
      { name: "assets", type: "uint256" },
      { name: "shares", type: "uint256" },
      { name: "onBehalf", type: "address" },
      { name: "receiver", type: "address" },
    ],
    outputs: [
      { name: "assetsWithdrawn", type: "uint256" },
      { name: "sharesWithdrawn", type: "uint256" },
    ],
  },
  {
    name: "position",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "supplyShares", type: "uint256" },
      { name: "borrowShares", type: "uint128" },
      { name: "collateral", type: "uint128" },
    ],
  },
  {
    name: "market",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "totalSupplyAssets", type: "uint128" },
      { name: "totalSupplyShares", type: "uint128" },
      { name: "totalBorrowAssets", type: "uint128" },
      { name: "totalBorrowShares", type: "uint128" },
      { name: "lastUpdate", type: "uint128" },
      { name: "fee", type: "uint128" },
    ],
  },
] as const;

/** The struct viem encodes, with `lltv` parsed back from its wire string. */
function toStruct(params: MorphoMarketParams) {
  return {
    loanToken: params.loanToken,
    collateralToken: params.collateralToken,
    oracle: params.oracle,
    irm: params.irm,
    lltv: BigInt(params.lltv),
  };
}

function requireMorphoTarget(
  target: DepositTarget | undefined,
): Extract<DepositTarget, { kind: "morpho-blue" }> {
  if (!target || target.kind !== "morpho-blue") {
    throw new DefiError(
      "protocol_not_found",
      "morpho-blue adapter requires a resolved { kind: 'morpho-blue' } depositTarget",
    );
  }
  if (!target.params?.loanToken) {
    // A target carrying only `marketId` is the pre-fix shape and cannot build a
    // transaction at all (§3.1). Fail loudly rather than encoding a zero struct.
    throw new DefiError(
      "market_id_mismatch",
      "morpho-blue target is missing MarketParams",
    );
  }
  return target;
}

/** The singleton for this chain, or a typed failure. Never guessed. */
function requireSingleton(chainId: number): Address {
  const morpho = morphoSingleton(chainId);
  if (!morpho) {
    throw new DefiError(
      "unsupported_chain",
      `morpho-blue: no pinned singleton for chainId=${chainId}`,
    );
  }
  return morpho;
}

export const MorphoBlueAdapter: DefiProtocolAdapter = {
  slug: "morpho-blue-market",
  namespace: "eip155",
  kind: "stablecoin_lending",
  chainId: 0, // nominal — routed by DepositTarget.kind
  displayName: "Morpho Blue Market",
  targetKinds: ["morpho-blue"],
  staticSafetyScore: 82,

  async buildDeposit({
    wallet,
    chain,
    asset,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    const t = requireMorphoTarget(target);
    const evm = assertEvmChain(chain);
    const morpho = requireSingleton(evm.chain.id);
    if (
      asset.contract &&
      asset.contract.toLowerCase() !== t.params.loanToken.toLowerCase()
    ) {
      throw new DefiError(
        "unsupported_asset",
        "morpho-blue: asset does not match the market's loan token",
      );
    }
    return {
      kind: "evm-call",
      to: morpho,
      data: encodeFunctionData({
        abi: MORPHO_ABI,
        functionName: "supply",
        // assets = amount, shares = 0 (exactly one must be zero).
        args: [toStruct(t.params), amount, 0n, wallet.address as Address, "0x"],
      }),
      needsApproval: {
        token: t.params.loanToken,
        spender: morpho,
        amount,
      },
    } satisfies UnsignedCall;
  },

  async buildWithdraw({
    wallet,
    chain,
    amount,
    target,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    const t = requireMorphoTarget(target);
    const evm = assertEvmChain(chain);
    const morpho = requireSingleton(evm.chain.id);
    const owner = wallet.address as Address;

    let assets = amount === "MAX" ? 0n : amount;
    let shares = 0n;
    if (amount === "MAX") {
      const client = getPublicClient(evm.chain);
      const position = await client.readContract({
        address: morpho,
        abi: MORPHO_ABI,
        functionName: "position",
        args: [t.marketId, owner],
      });
      shares = position[0];
      if (shares === 0n) {
        throw new DefiError(
          "position_not_found",
          "morpho-blue: no supply shares",
        );
      }
      assets = 0n;
    }

    return {
      kind: "evm-call",
      to: morpho,
      data: encodeFunctionData({
        abi: MORPHO_ABI,
        functionName: "withdraw",
        // onBehalf and receiver are both the user's own wallet — a withdraw is
        // never routed to a third party.
        args: [toStruct(t.params), assets, shares, owner, owner],
      }),
    } satisfies UnsignedCall;
  },

  /**
   * Supply shares converted to assets with the market's own totals — the same
   * rounding Morpho applies, so the number matches what a withdraw would give.
   */
  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    const target = ctx?.target;
    if (!target || target.kind !== "morpho-blue") return null;
    if (!ctx?.chain) return null;
    try {
      const evm = assertEvmChain(ctx.chain);
      const morpho = morphoSingleton(evm.chain.id);
      if (!morpho) return null;
      const client = getPublicClient(evm.chain);
      const [position, market] = await Promise.all([
        client.readContract({
          address: morpho,
          abi: MORPHO_ABI,
          functionName: "position",
          args: [target.marketId, walletAddress as Address],
        }),
        client.readContract({
          address: morpho,
          abi: MORPHO_ABI,
          functionName: "market",
          args: [target.marketId],
        }),
      ]);
      const supplyShares = position[0];
      const totalSupplyAssets = market[0];
      const totalSupplyShares = market[1];
      const currentAmount =
        totalSupplyShares > 0n
          ? (supplyShares * totalSupplyAssets) / totalSupplyShares
          : 0n;
      return {
        protocolSlug: "morpho-blue-market",
        namespace: "eip155",
        chainId: evm.chain.id,
        assetSymbol: ctx.assetSymbol ?? "",
        amountAtDeposit: 0n,
        amountAtDepositUsd: 0,
        currentAmount,
        currentAmountUsd: 0, // priced upstream by positions/pnl.ts
        pnlUsd: 0,
      };
    } catch {
      return null;
    }
  },
};
