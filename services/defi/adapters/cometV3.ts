/**
 * CometV3Adapter — Compound III, the whole family in one adapter
 * (docs/defi-evm-protocol-expansion-spec.md §5.1).
 *
 * Comet's supply-side ABI is the simplest in the expansion:
 * `supply(asset, amount)` / `withdraw(asset, amount)` on the market contract,
 * with `type(uint256).max` as the "withdraw everything" sentinel. One instance
 * therefore covers every Comet market on every EVM chain, routed by
 * `DepositTarget.kind` (`targetKinds: ["compound-v3"]`) — the `comet` address
 * arrives on the server-resolved target, never from the model.
 *
 * **Base asset only.** Comet distinguishes the base asset (which earns) from
 * collateral (which does not, and changes the account's borrow position). This
 * spec is supply-side only, so the backend validator proves
 * `comet.baseToken() == target.asset` before the target is trusted and this
 * adapter refuses anything else.
 */

import { type Address, encodeFunctionData } from "viem";
import { assertEvmChain } from "@/constants/configs/chainConfig";
import { getPublicClient } from "@/utils/clients";
import { DefiError } from "../errors/defiErrors";
import type {
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  DepositTarget,
  PositionReadContext,
  UnsignedCall,
} from "../types";

const COMET_ABI = [
  {
    name: "supply",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
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
    ],
    outputs: [],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "baseToken",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/**
 * Comet reads `type(uint256).max` as "withdraw the caller's entire base
 * balance" (Comet.sol), which is safer than reading `balanceOf` on device and
 * racing interest accrual between the read and the tx.
 */
const MAX_UINT256 = (1n << 256n) - 1n;

function requireCometTarget(
  target: DepositTarget | undefined,
): Extract<DepositTarget, { kind: "compound-v3" }> {
  if (!target || target.kind !== "compound-v3") {
    throw new DefiError(
      "protocol_not_found",
      "compound-v3 adapter requires a resolved { kind: 'compound-v3' } depositTarget",
    );
  }
  return target;
}

export const CometV3Adapter: DefiProtocolAdapter = {
  slug: "compound-v3",
  namespace: "eip155",
  kind: "stablecoin_lending",
  // Nominal — routed by `DepositTarget.kind`, not chainId. 0 keeps it out of
  // per-chain venue listings.
  chainId: 0,
  displayName: "Compound III",
  targetKinds: ["compound-v3"],
  // Throws without a resolved target — see `requiresTarget` in types.ts.
  requiresTarget: true,
  externalSlugs: ["compound-v3", "compound"],
  staticSafetyScore: 88,

  async buildDeposit({
    asset,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    const t = requireCometTarget(target);
    // Defence in depth: the target is the trusted source, so an explicit asset
    // that disagrees with it means the caller and the server disagree about
    // what is being deposited.
    if (
      asset.contract &&
      asset.contract.toLowerCase() !== t.asset.toLowerCase()
    ) {
      throw new DefiError(
        "unsupported_asset",
        "compound-v3: asset does not match the market's base token",
      );
    }
    return {
      kind: "evm-call",
      to: t.comet,
      data: encodeFunctionData({
        abi: COMET_ABI,
        functionName: "supply",
        args: [t.asset, amount],
      }),
      needsApproval: { token: t.asset, spender: t.comet, amount },
    } satisfies UnsignedCall;
  },

  async buildWithdraw({
    amount,
    target,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    const t = requireCometTarget(target);
    return {
      kind: "evm-call",
      to: t.comet,
      data: encodeFunctionData({
        abi: COMET_ABI,
        functionName: "withdraw",
        args: [t.asset, amount === "MAX" ? MAX_UINT256 : amount],
      }),
    } satisfies UnsignedCall;
  },

  /**
   * `comet.balanceOf(account)` is the account's BASE supply balance in base-token
   * units, already interest-accrued — the same shape as reading an aToken.
   * Needs the market from `ctx.target`, since it cannot be derived from the
   * wallet address alone.
   */
  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    const target = ctx?.target;
    if (!target || target.kind !== "compound-v3") return null;
    const chain = ctx?.chain;
    if (!chain) return null;
    try {
      const evm = assertEvmChain(chain);
      const client = getPublicClient(evm.chain);
      const balance = await client.readContract({
        address: target.comet,
        abi: COMET_ABI,
        functionName: "balanceOf",
        args: [walletAddress as Address],
      });
      return {
        protocolSlug: "compound-v3",
        namespace: "eip155",
        chainId: evm.chain.id,
        assetSymbol: ctx?.assetSymbol ?? "",
        amountAtDeposit: 0n,
        amountAtDepositUsd: 0,
        currentAmount: balance,
        currentAmountUsd: 0, // priced upstream by positions/pnl.ts
        pnlUsd: 0,
      };
    } catch {
      return null;
    }
  },
};
