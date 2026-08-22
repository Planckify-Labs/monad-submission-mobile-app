/**
 * CurveLpAdapter — every Curve pool in one adapter
 * (docs/defi-evm-protocol-expansion-spec.md §5.3), generalising the shipped
 * single-market `curve3pool` adapter.
 *
 * Two things vary across Curve's generations, and both arrive on the target so
 * this adapter never probes the chain to decide how to encode (§3.3):
 *   - `nCoins` — `add_liquidity` takes a fixed-size `uint256[N]`, so N is part
 *     of the function signature, not an argument.
 *   - `isNg` — new-generation pools index coins with `uint256`; legacy pools
 *     use `int128`.
 *
 * **Slippage is mandatory, not optional.** `min_mint_amount: 0` is an open
 * invitation to sandwich the deposit, so the minimum is always computed from
 * the pool's own `calc_token_amount` / `calc_withdraw_one_coin` at build time
 * and the build is BLOCKED if that view cannot price it (§5.3, §12 Q4). There
 * is no code path here that emits a zero minimum.
 *
 * Curve LP carries impermanent-loss and de-peg risk that single-asset vaults do
 * not — the opportunity's `lp_stable`/`lp_volatile` kind is what lets the card
 * warn about it, and `staticSafetyScore` stays deliberately conservative.
 */

import { type Abi, type Address, encodeFunctionData, erc20Abi } from "viem";
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

type CurveTarget = Extract<DepositTarget, { kind: "curve-lp" }>;

/**
 * `add_liquidity(uint256[N], uint256)` — N is baked into the signature, so we
 * build the ABI per arity instead of pretending one shape fits all.
 */
function addLiquidityAbi(nCoins: 2 | 3 | 4): Abi {
  return [
    {
      name: "add_liquidity",
      type: "function",
      stateMutability: "nonpayable",
      inputs: [
        { name: "amounts", type: `uint256[${nCoins}]` },
        { name: "min_mint_amount", type: "uint256" },
      ],
      outputs: [],
    },
    {
      name: "calc_token_amount",
      type: "function",
      stateMutability: "view",
      inputs: [
        { name: "amounts", type: `uint256[${nCoins}]` },
        { name: "is_deposit", type: "bool" },
      ],
      outputs: [{ name: "", type: "uint256" }],
    },
  ];
}

/** `remove_liquidity_one_coin` — the index type is the generation difference. */
function removeLiquidityAbi(isNg: boolean): Abi {
  const indexType = isNg ? "uint256" : "int128";
  return [
    {
      name: "remove_liquidity_one_coin",
      type: "function",
      stateMutability: "nonpayable",
      inputs: [
        { name: "_burn_amount", type: "uint256" },
        { name: "i", type: indexType },
        { name: "_min_received", type: "uint256" },
      ],
      outputs: [],
    },
    {
      name: "calc_withdraw_one_coin",
      type: "function",
      stateMutability: "view",
      inputs: [
        { name: "_burn_amount", type: "uint256" },
        { name: "i", type: indexType },
      ],
      outputs: [{ name: "", type: "uint256" }],
    },
  ];
}

function requireCurveTarget(target: DepositTarget | undefined): CurveTarget {
  if (!target || target.kind !== "curve-lp") {
    throw new DefiError(
      "protocol_not_found",
      "curve-lp adapter requires a resolved { kind: 'curve-lp' } depositTarget",
    );
  }
  if (target.index < 0 || target.index >= target.nCoins) {
    throw new DefiError(
      "unsupported_asset",
      "curve-lp: coin index is outside the pool's arity",
    );
  }
  return target;
}

/** Single-sided amounts array: everything zero except our coin. */
function singleSidedAmounts(target: CurveTarget, amount: bigint): bigint[] {
  const amounts = new Array<bigint>(target.nCoins).fill(0n);
  amounts[target.index] = amount;
  return amounts;
}

/**
 * The pool's LP token. NG-generation pools ARE their own LP token; classic
 * pools (3pool and its lineage) mint a separate ERC-20 that the resolver
 * fetched from Curve's own MetaRegistry and carries as `lpToken` — added
 * 2026-08-21, see the field's doc comment in `types.ts`.
 */
function lpTokenOf(target: CurveTarget): Address {
  return target.lpToken ?? target.pool;
}

export const CurveLpAdapter: DefiProtocolAdapter = {
  slug: "curve-lp",
  namespace: "eip155",
  kind: "lp_stable",
  chainId: 0, // nominal — routed by DepositTarget.kind
  displayName: "Curve Pool",
  targetKinds: ["curve-lp"],
  // Throws without a resolved target — see `requiresTarget` in types.ts.
  requiresTarget: true,
  externalSlugs: ["curve-dex", "curve"],
  // Conservative on purpose: an LP position can lose value to de-peg or
  // impermanent loss in ways a single-asset lending position cannot.
  staticSafetyScore: 65,

  async buildDeposit({
    chain,
    asset,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    const t = requireCurveTarget(target);
    if (
      asset.contract &&
      asset.contract.toLowerCase() !== t.asset.toLowerCase()
    ) {
      throw new DefiError(
        "unsupported_asset",
        "curve-lp: asset does not match the resolved coin index",
      );
    }
    const evm = assertEvmChain(chain);
    const client = getPublicClient(evm.chain);
    const abi = addLiquidityAbi(t.nCoins);
    const amounts = singleSidedAmounts(t, amount);

    // The minimum comes from the pool's own view. If it reverts we have no
    // honest number to protect the user with, so we refuse to build rather
    // than fall back to zero.
    let expectedLp: bigint;
    try {
      expectedLp = (await client.readContract({
        address: t.pool,
        abi,
        functionName: "calc_token_amount",
        args: [amounts, true],
      })) as bigint;
    } catch {
      throw new DefiError(
        "slippage_too_high",
        "curve-lp: calc_token_amount reverted; cannot set a minimum",
      );
    }
    const minMint = minOutFor(expectedLp, { stable: true });

    return {
      kind: "evm-call",
      to: t.pool,
      data: encodeFunctionData({
        abi,
        functionName: "add_liquidity",
        args: [amounts, minMint],
      }),
      needsApproval: { token: t.asset, spender: t.pool, amount },
    } satisfies UnsignedCall;
  },

  async buildWithdraw({
    wallet,
    chain,
    amount,
    target,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    const t = requireCurveTarget(target);
    const evm = assertEvmChain(chain);
    const client = getPublicClient(evm.chain);
    const abi = removeLiquidityAbi(t.isNg);
    const index = BigInt(t.index);

    // `amount` is in UNDERLYING units, but remove_liquidity_one_coin burns LP.
    // MAX burns the whole LP balance; a partial withdraw is not expressible
    // without a reverse-quote, so it is rejected rather than approximated —
    // burning a guessed LP amount would withdraw the wrong value.
    let burnAmount: bigint;
    if (amount === "MAX") {
      burnAmount = await client.readContract({
        address: lpTokenOf(t),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet.address as Address],
      });
      if (burnAmount === 0n) {
        throw new DefiError("position_not_found", "curve-lp: no LP balance");
      }
    } else {
      throw new DefiError(
        "withdraw_failed",
        "curve-lp: partial withdraw needs an LP amount; use MAX for a full exit",
      );
    }

    let expectedOut: bigint;
    try {
      expectedOut = (await client.readContract({
        address: t.pool,
        abi,
        functionName: "calc_withdraw_one_coin",
        args: [burnAmount, index],
      })) as bigint;
    } catch {
      throw new DefiError(
        "slippage_too_high",
        "curve-lp: calc_withdraw_one_coin reverted; cannot set a minimum",
      );
    }
    const minReceived = minOutFor(expectedOut, { stable: true });

    return {
      kind: "evm-call",
      to: t.pool,
      data: encodeFunctionData({
        abi,
        functionName: "remove_liquidity_one_coin",
        args: [burnAmount, index, minReceived],
      }),
    } satisfies UnsignedCall;
  },

  /**
   * LP balance valued in the deposited coin via `calc_withdraw_one_coin` — the
   * amount the user would actually receive, not a virtual-price approximation.
   */
  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    const target = ctx?.target;
    if (!target || target.kind !== "curve-lp") return null;
    if (!ctx?.chain) return null;
    try {
      const evm = assertEvmChain(ctx.chain);
      const client = getPublicClient(evm.chain);
      const lp = await client.readContract({
        address: lpTokenOf(target),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress as Address],
      });
      if (lp === 0n) return null;
      const abi = removeLiquidityAbi(target.isNg);
      const index = BigInt(target.index);
      const value = (await client.readContract({
        address: target.pool,
        abi,
        functionName: "calc_withdraw_one_coin",
        args: [lp, index],
      })) as bigint;
      return {
        protocolSlug: "curve-lp",
        namespace: "eip155",
        chainId: evm.chain.id,
        assetSymbol: ctx.assetSymbol ?? "",
        amountAtDeposit: 0n,
        amountAtDepositUsd: 0,
        currentAmount: value,
        currentAmountUsd: 0, // priced upstream by positions/pnl.ts
        pnlUsd: 0,
      };
    } catch {
      return null;
    }
  },
};
