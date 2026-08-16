/**
 * CompoundV2Adapter — the whole cToken fork lineage in one adapter
 * (docs/defi-evm-protocol-expansion-spec.md §5.4).
 *
 * Venus (`vToken`), Benqi (`qiToken`), Sonne and the rest of the Compound-v2
 * descendants share one supply ABI: `mint(assets)` to enter,
 * `redeemUnderlying(assets)` for a partial exit, `redeem(shares)` for a full
 * one, with the position tracked as exchange-rate shares. One instance covers
 * all of them, routed by `DepositTarget.kind`.
 *
 * **MAX exits by shares, not by amount.** `redeemUnderlying(balance)` races the
 * exchange rate: the rate accrues between the read and the tx, so the request
 * can exceed the position by a wei and revert, or leave dust behind. Redeeming
 * the exact share balance is exact by construction — the same reasoning the
 * 4626 adapter uses to prefer `redeem` over `withdraw` for a full exit.
 *
 * §12 Q3: where a fork ships an ERC-4626 wrapper for a market, the backend
 * resolves that instead and it routes to `Erc4626Adapter`. This adapter is the
 * general fallback for markets without one.
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

const CTOKEN_ABI = [
  {
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "mintAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "redeem",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "redeemTokens", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "redeemUnderlying",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "redeemAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "exchangeRateStored",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Compound-v2 scales `exchangeRateStored` by 1e18. */
const EXCHANGE_RATE_SCALE = 10n ** 18n;

function requireCTokenTarget(
  target: DepositTarget | undefined,
): Extract<DepositTarget, { kind: "compound-v2" }> {
  if (!target || target.kind !== "compound-v2") {
    throw new DefiError(
      "protocol_not_found",
      "compound-v2 adapter requires a resolved { kind: 'compound-v2' } depositTarget",
    );
  }
  return target;
}

export const CompoundV2Adapter: DefiProtocolAdapter = {
  slug: "compound-v2",
  namespace: "eip155",
  kind: "stablecoin_lending",
  chainId: 0, // nominal — routed by DepositTarget.kind
  displayName: "Compound V2 Market",
  targetKinds: ["compound-v2"],
  externalSlugs: ["venus", "venus-core-pool", "benqi-lending", "sonne-finance"],
  staticSafetyScore: 80,

  async buildDeposit({
    asset,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    const t = requireCTokenTarget(target);
    if (
      asset.contract &&
      asset.contract.toLowerCase() !== t.asset.toLowerCase()
    ) {
      throw new DefiError(
        "unsupported_asset",
        "compound-v2: asset does not match the market's underlying",
      );
    }
    return {
      kind: "evm-call",
      to: t.cToken,
      data: encodeFunctionData({
        abi: CTOKEN_ABI,
        functionName: "mint",
        args: [amount],
      }),
      // `mint` pulls the underlying, so the cToken itself is the spender.
      needsApproval: { token: t.asset, spender: t.cToken, amount },
    } satisfies UnsignedCall;
  },

  async buildWithdraw({
    wallet,
    chain,
    amount,
    target,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    const t = requireCTokenTarget(target);
    if (amount === "MAX") {
      const evm = assertEvmChain(chain);
      const client = getPublicClient(evm.chain);
      const shares = await client.readContract({
        address: t.cToken,
        abi: CTOKEN_ABI,
        functionName: "balanceOf",
        args: [wallet.address as Address],
      });
      if (shares === 0n) {
        throw new DefiError("position_not_found", "compound-v2: no cTokens");
      }
      return {
        kind: "evm-call",
        to: t.cToken,
        data: encodeFunctionData({
          abi: CTOKEN_ABI,
          functionName: "redeem",
          args: [shares],
        }),
      } satisfies UnsignedCall;
    }
    return {
      kind: "evm-call",
      to: t.cToken,
      data: encodeFunctionData({
        abi: CTOKEN_ABI,
        functionName: "redeemUnderlying",
        args: [amount],
      }),
    } satisfies UnsignedCall;
  },

  /** Position in underlying units = `balanceOf × exchangeRateStored / 1e18`. */
  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    const target = ctx?.target;
    if (!target || target.kind !== "compound-v2") return null;
    if (!ctx?.chain) return null;
    try {
      const evm = assertEvmChain(ctx.chain);
      const client = getPublicClient(evm.chain);
      const [shares, rate] = await Promise.all([
        client.readContract({
          address: target.cToken,
          abi: CTOKEN_ABI,
          functionName: "balanceOf",
          args: [walletAddress as Address],
        }),
        client.readContract({
          address: target.cToken,
          abi: CTOKEN_ABI,
          functionName: "exchangeRateStored",
        }),
      ]);
      return {
        protocolSlug: "compound-v2",
        namespace: "eip155",
        chainId: evm.chain.id,
        assetSymbol: ctx.assetSymbol ?? "",
        amountAtDeposit: 0n,
        amountAtDepositUsd: 0,
        currentAmount: (shares * rate) / EXCHANGE_RATE_SCALE,
        currentAmountUsd: 0, // priced upstream by positions/pnl.ts
        pnlUsd: 0,
      };
    } catch {
      return null;
    }
  },
};
