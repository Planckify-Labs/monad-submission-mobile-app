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
import { minOutFor } from "../slippage";
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
import {
  type LstVenueConfig,
  lstVenueConfig,
  MIN_OUT_STAKE_SHAPES,
} from "./lst.config";

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
  "payable-stake-minout": [
    {
      name: "stake",
      type: "function",
      stateMutability: "payable",
      inputs: [{ name: "minMETHAmount", type: "uint256" }],
      outputs: [],
    },
  ],
  "payable-deposit-eth-minout-referral": [
    {
      name: "depositETH",
      type: "function",
      stateMutability: "payable",
      inputs: [
        { name: "minRSETHAmountExpected", type: "uint256" },
        { name: "referralId", type: "string" },
      ],
      outputs: [],
    },
  ],
  "payable-submit-referral": [
    {
      name: "submit",
      type: "function",
      stateMutability: "payable",
      inputs: [{ name: "_referral", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
  ],
} as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
/**
 * The `0xEeee…` native-asset sentinel, as used by protocols that take an asset
 * argument for a native-coin deposit. Distinct from the zero address, which
 * some of the same contracts reject outright.
 */
const NATIVE_ETH_SENTINEL =
  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

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
function encodeStake(
  venue: LstVenueConfig,
  wallet: Address,
  minOut?: bigint,
): `0x${string}` {
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
    case "payable-submit-referral":
      return encodeFunctionData({
        abi: STAKE_ABIS["payable-submit-referral"],
        functionName: "submit",
        // Same convention as `payable-deposit-referral`: no referral
        // programme, and the zero address is the documented "none".
        args: [ZERO_ADDRESS],
      });
    case "payable-stake-minout":
      if (minOut === undefined || minOut <= 0n) {
        // Unreachable via buildDeposit, which computes and checks it — but a
        // zero minimum is the single thing §12 Q4 forbids outright, so it
        // fails loudly here rather than encoding a sandwichable call.
        throw new DefiError(
          "slippage_too_high",
          `lst-stake: ${venue.key} needs a positive minimum-out and none was computed`,
        );
      }
      return encodeFunctionData({
        abi: STAKE_ABIS["payable-stake-minout"],
        functionName: "stake",
        args: [minOut],
      });
    case "payable-deposit-eth-minout-referral":
      if (minOut === undefined || minOut <= 0n) {
        // Same rule as `payable-stake-minout`: §12 Q4 forbids a zero minimum
        // outright, so this refuses rather than encoding a sandwichable call.
        throw new DefiError(
          "slippage_too_high",
          `lst-stake: ${venue.key} needs a positive minimum-out and none was computed`,
        );
      }
      return encodeFunctionData({
        abi: STAKE_ABIS["payable-deposit-eth-minout-referral"],
        functionName: "depositETH",
        // Empty referral id — no referral programme, and the protocol treats
        // "" as none. The referral here is a STRING, unlike
        // `payable-deposit-referral`'s address; that difference is the whole
        // reason this is a separate shape rather than a reused one.
        args: [minOut, ""],
      });
  }
}

/**
 * The minimum receipt this stake must return, from the protocol's own quote.
 *
 * Read at build time, never cached and never model-supplied (§12 Q4). The pair
 * is an LST against its own native asset, i.e. CORRELATED, so it draws the
 * `stable` slippage budget rather than the volatile one.
 */
async function minReceiptFor(
  venue: LstVenueConfig,
  chain: BuildDepositArgs["chain"],
  amount: bigint,
  tier: BuildDepositArgs["tier"],
): Promise<bigint> {
  if (!venue.previewView) {
    throw new DefiError(
      "protocol_not_found",
      `lst-stake: venue "${venue.key}" needs a preview view to price its minimum`,
    );
  }
  const evm = assertEvmChain(chain);
  const client = getPublicClient(evm.chain);
  // Two preview conventions so far: `(uint256)` (Mantle `ethToMETH`) and
  // `(address asset, uint256 amount)` (Kelp `getRsETHAmountToMint`). Which one
  // a venue uses is DECLARED, never inferred from the view's name — the
  // `getPooledAvaxByShares` string comparison this file used to carry is
  // exactly how the second venue on a shared convention gets mis-read.
  const previewAbi = [
    {
      name: venue.previewView,
      type: "function",
      stateMutability: "view",
      inputs: venue.previewTakesAsset
        ? [
            { name: "asset", type: "address" },
            { name: "amount", type: "uint256" },
          ]
        : [{ name: "amount", type: "uint256" }],
      outputs: [{ name: "", type: "uint256" }],
    },
  ] as const;

  const expected = (await client.readContract({
    address: venue.entry,
    abi: previewAbi,
    functionName: venue.previewView,
    // The asset argument is the venue's own NATIVE SENTINEL, not the zero
    // address: Kelp's pool reverts (0x762798e1) on the zero address and
    // answers on 0xEeee…, and they are not interchangeable.
    args: venue.previewTakesAsset
      ? [NATIVE_ETH_SENTINEL, amount]
      : ([amount] as const),
  })) as bigint;

  if (!expected || expected <= 0n) {
    // A quote of zero means the venue would mint nothing. Refusing is the only
    // honest answer: the alternative is a stake with a zero floor.
    throw new DefiError(
      "withdraw_failed",
      `lst-stake: ${venue.key} quoted zero receipt for the stake amount`,
    );
  }
  return minOutFor(expected, { tier, stable: true });
}

export const LstStakeAdapter: DefiProtocolAdapter = {
  slug: "lst-stake",
  namespace: "eip155",
  kind: "liquid_staking",
  chainId: 0, // nominal — routed by DepositTarget.kind
  displayName: "Liquid Staking",
  targetKinds: ["lst-stake"],
  // Throws without a resolved target — see `requiresTarget` in types.ts.
  requiresTarget: true,
  externalSlugs: [
    "lido",
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
    tier,
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

    // A venue with an on-chain floor refuses below it. Checking here turns a
    // paid-for revert into a message the user can act on.
    if (venue.minStakeWei !== undefined && amount < venue.minStakeWei) {
      throw new DefiError(
        "below_min_deposit",
        `lst-stake: ${venue.key} requires at least ${venue.minStakeWei} wei`,
      );
    }

    const minOut = MIN_OUT_STAKE_SHAPES.has(venue.shape)
      ? await minReceiptFor(venue, chain, amount, tier)
      : undefined;

    return {
      kind: "evm-call",
      to: venue.entry,
      data: encodeStake(venue, wallet.address as Address, minOut),
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
            inputs: venue.rateTakesAmount
              ? [{ name: "shareAmount", type: "uint256" }]
              : [],
            outputs: [{ name: "", type: "uint256" }],
          },
        ] as const;
        const raw = (await client
          .readContract({
            address:
              venue.rateViewAt ??
              (venue.rateViewOn === "entry" ? venue.entry : venue.receipt),
            abi: rateAbi,
            functionName: venue.rateView,
            args: venue.rateTakesAmount ? [balance] : ([] as const),
          })
          .catch(() => null)) as bigint | null;
        if (raw !== null) {
          currentAmount = venue.rateTakesAmount
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
