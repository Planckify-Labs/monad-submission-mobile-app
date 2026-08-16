/**
 * LstStakeAdapter — one adapter for every liquid-staking / restaking venue
 * (docs/defi-evm-protocol-expansion-spec.md §6.4, §12 Q2).
 *
 * A stake sends the chain's native coin to the venue's entry contract and
 * receives a rate-appreciating token. The venue's entry address and call shape
 * come from `lst.config.ts`, keyed by `DepositTarget.venue`, so adding a venue
 * is a config row on each side and never a branch here.
 *
 * **Native deposits carry `value`, not an approval** (§12 Q5). There is no
 * ERC-20 `approve` for ETH; emitting one would be a no-op that hides a
 * mis-build, so the Layer-4 decode assertion checks `value == amount` instead.
 *
 * **The exit is where this family is honest or it is nothing** (§12 Q2, §8.3).
 * Most LSTs redeem through a withdrawal queue that takes days, or only through
 * a DEX. So:
 *   - `exit: "instant"` → a real on-chain redeem (none of the pinned venues).
 *   - `exit: "queue"`   → withdraw is DISABLED with a typed reason until the
 *     Tier-4 request/claim machinery lands. It then upgrades with no resolver
 *     or adapter change — only the exit branch gains a case.
 *   - `exit: "dex"`     → the exit is a swap, which belongs to the swap layer
 *     with its own slippage bounds, not to this adapter.
 * Deposit ships regardless; we never promise an instant exit we cannot honour.
 */

import { type Address, encodeFunctionData, erc20Abi } from "viem";
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
import { NATIVE_ASSET_SENTINEL } from "../types";
import { type LstVenueConfig, lstVenueConfig } from "./lst.config";

const STAKE_ABIS = {
  "payable-deposit": [
    {
      name: "deposit",
      type: "function",
      stateMutability: "payable",
      inputs: [],
      outputs: [],
    },
  ],
  "payable-deposit-receiver": [
    {
      name: "deposit",
      type: "function",
      stateMutability: "payable",
      inputs: [{ name: "receiver", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
  ],
  "payable-deposit-referral": [
    {
      name: "deposit",
      type: "function",
      stateMutability: "payable",
      inputs: [{ name: "referral", type: "address" }],
      outputs: [],
    },
  ],
  "payable-submit": [
    {
      name: "submit",
      type: "function",
      stateMutability: "payable",
      inputs: [],
      outputs: [{ name: "", type: "uint256" }],
    },
  ],
} as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

function requireLstTarget(
  target: DepositTarget | undefined,
): Extract<DepositTarget, { kind: "lst-stake" }> {
  if (!target || target.kind !== "lst-stake") {
    throw new DefiError(
      "protocol_not_found",
      "lst-stake adapter requires a resolved { kind: 'lst-stake' } depositTarget",
    );
  }
  return target;
}

function requireVenue(key: string, chainId: number): LstVenueConfig {
  const venue = lstVenueConfig(key);
  if (!venue) {
    throw new DefiError(
      "protocol_not_found",
      `lst-stake: no config for venue "${key}"`,
    );
  }
  if (venue.chainId !== chainId) {
    throw new DefiError(
      "unsupported_chain",
      `lst-stake: venue "${key}" is not deployed on chainId=${chainId}`,
    );
  }
  return venue;
}

/** Encode the venue's stake call. `wallet` fills receiver/referral slots. */
function encodeStake(venue: LstVenueConfig, wallet: Address): `0x${string}` {
  switch (venue.shape) {
    case "payable-deposit":
      return encodeFunctionData({
        abi: STAKE_ABIS["payable-deposit"],
        functionName: "deposit",
      });
    case "payable-deposit-receiver":
      return encodeFunctionData({
        abi: STAKE_ABIS["payable-deposit-receiver"],
        functionName: "deposit",
        args: [wallet],
      });
    case "payable-deposit-referral":
      return encodeFunctionData({
        abi: STAKE_ABIS["payable-deposit-referral"],
        functionName: "deposit",
        // No referral programme — the zero address is the documented "none".
        args: [ZERO_ADDRESS],
      });
    case "payable-submit":
      return encodeFunctionData({
        abi: STAKE_ABIS["payable-submit"],
        functionName: "submit",
      });
  }
}

export const LstStakeAdapter: DefiProtocolAdapter = {
  slug: "lst-stake",
  namespace: "eip155",
  kind: "liquid_staking",
  chainId: 0, // nominal — routed by DepositTarget.kind
  displayName: "Liquid Staking",
  targetKinds: ["lst-stake"],
  externalSlugs: [
    "rocket-pool",
    "ether.fi-stake",
    "stader",
    "binance-staked-eth",
    "benqi-staked-avax",
  ],
  staticSafetyScore: 78,

  async buildDeposit({
    wallet,
    chain,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    const t = requireLstTarget(target);
    const evm = assertEvmChain(chain);
    const venue = requireVenue(t.venue, evm.chain.id);

    if (t.asset.toLowerCase() !== NATIVE_ASSET_SENTINEL.toLowerCase()) {
      // Every pinned venue stakes the native coin. An ERC-20 stake would need
      // an approval preamble and a different shape, so refuse rather than
      // build a payable call for a token.
      throw new DefiError(
        "unsupported_asset",
        "lst-stake: only native-coin stakes are supported by the pinned venues",
      );
    }

    return {
      kind: "evm-call",
      to: venue.entry,
      data: encodeStake(venue, wallet.address as Address),
      // Native deposit: the amount rides as `value`, and there is deliberately
      // NO `needsApproval` (§12 Q5).
      value: amount,
    } satisfies UnsignedCall;
  },

  async buildWithdraw({ target }: BuildWithdrawArgs): Promise<UnsignedCall> {
    const t = requireLstTarget(target);
    if (t.exit === "queue") {
      throw new DefiError(
        "cooldown_in_progress",
        `lst-stake: ${t.venue} exits through a withdrawal queue; in-app exit lands with the ERC-7540 two-phase flow`,
      );
    }
    if (t.exit === "dex") {
      throw new DefiError(
        "withdraw_failed",
        `lst-stake: ${t.venue} exits by swapping the receipt token; route through the swap layer, not this adapter`,
      );
    }
    // No pinned venue reports "instant" today. Reaching here means a venue was
    // added claiming an instant redeem without an encoder for it, which is a
    // wiring error — fail loudly rather than build nothing.
    throw new DefiError(
      "withdraw_failed",
      `lst-stake: no redeem encoder for venue "${t.venue}"`,
    );
  },

  /**
   * Receipt balance, converted to the staked asset for rate tokens. A rebasing
   * receipt (eETH) already reads in asset terms, so its balance is the position.
   */
  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    const target = ctx?.target;
    if (!target || target.kind !== "lst-stake") return null;
    if (!ctx?.chain) return null;
    try {
      const evm = assertEvmChain(ctx.chain);
      const venue = lstVenueConfig(target.venue);
      if (!venue || venue.chainId !== evm.chain.id) return null;
      const client = getPublicClient(evm.chain);
      const balance = await client.readContract({
        address: venue.receipt,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress as Address],
      });
      if (balance === 0n) return null;

      let currentAmount = balance;
      if (venue.valuation === "share" && venue.rateView) {
        // The rate view is per-venue config, so this stays one code path.
        const rateAbi = [
          {
            name: venue.rateView,
            type: "function",
            stateMutability: "view",
            inputs:
              venue.rateView === "getPooledAvaxByShares"
                ? [{ name: "shareAmount", type: "uint256" }]
                : [],
            outputs: [{ name: "", type: "uint256" }],
          },
        ] as const;
        const raw = (await client
          .readContract({
            address: venue.receipt,
            abi: rateAbi,
            functionName: venue.rateView,
            args:
              venue.rateView === "getPooledAvaxByShares"
                ? [balance]
                : ([] as const),
          })
          .catch(() => null)) as bigint | null;
        if (raw !== null) {
          currentAmount =
            venue.rateView === "getPooledAvaxByShares"
              ? raw // already the asset amount for `balance` shares
              : (balance * raw) / 10n ** 18n;
        }
      }

      return {
        protocolSlug: "lst-stake",
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
