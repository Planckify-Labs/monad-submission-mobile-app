/**
 * SolidlyLpAdapter — Aerodrome (Base) / Velodrome (Optimism) and the rest of
 * the Solidly fork family (docs/defi-evm-protocol-expansion-spec.md §6.1).
 *
 * Liquidity goes in through the **Router**, not the pool:
 * `addLiquidity(tokenA, tokenB, stable, amountADesired, amountBDesired,
 * amountAMin, amountBMin, to, deadline)`. `stable` picks the invariant, and it
 * is proven on-chain by the backend resolver rather than inferred from a name —
 * passing the wrong one addresses a different pool entirely.
 *
 * **Both legs are required.** A Solidly router has no single-sided add, so the
 * user must hold both tokens; the build emits an approval for each (hence the
 * multi-approval `UnsignedCall` shape). Turning one token into a balanced pair
 * is a swap, which belongs to the zap track (§1 non-goals) — approximating it
 * here would quietly sell half the user's position at whatever price the
 * moment offered.
 *
 * `minA`/`minB` and `deadline` are mandatory (§6.1) and come from the router's
 * own `quoteAddLiquidity`; there is no path here that emits a zero minimum.
 */

import { type Address, encodeFunctionData, erc20Abi } from "viem";
import { assertEvmChain } from "@/constants/configs/chainConfig";
import { getPublicClient } from "@/utils/clients";
import { DefiError } from "../errors/defiErrors";
import { minOutFor, slippageBpsFor } from "../slippage";
import type {
  ApprovalRequirement,
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  DepositTarget,
  PositionReadContext,
  UnsignedCall,
} from "../types";

/** How long a built add/remove stays valid on-chain (§11 Layer-4 deadline). */
const DEADLINE_SECONDS = 20 * 60;

const ROUTER_ABI = [
  {
    name: "addLiquidity",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "stable", type: "bool" },
      { name: "amountADesired", type: "uint256" },
      { name: "amountBDesired", type: "uint256" },
      { name: "amountAMin", type: "uint256" },
      { name: "amountBMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [
      { name: "amountA", type: "uint256" },
      { name: "amountB", type: "uint256" },
      { name: "liquidity", type: "uint256" },
    ],
  },
  {
    name: "removeLiquidity",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "stable", type: "bool" },
      { name: "liquidity", type: "uint256" },
      { name: "amountAMin", type: "uint256" },
      { name: "amountBMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [
      { name: "amountA", type: "uint256" },
      { name: "amountB", type: "uint256" },
    ],
  },
  {
    name: "quoteAddLiquidity",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "stable", type: "bool" },
      { name: "_factory", type: "address" },
      { name: "amountADesired", type: "uint256" },
      { name: "amountBDesired", type: "uint256" },
    ],
    outputs: [
      { name: "amountA", type: "uint256" },
      { name: "amountB", type: "uint256" },
      { name: "liquidity", type: "uint256" },
    ],
  },
  {
    name: "defaultFactory",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "getReserves",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "stable", type: "bool" },
      { name: "_factory", type: "address" },
    ],
    outputs: [
      { name: "reserveA", type: "uint256" },
      { name: "reserveB", type: "uint256" },
    ],
  },
] as const;

type SolidlyTarget = Extract<DepositTarget, { kind: "solidly-lp" }>;

function requireSolidlyTarget(
  target: DepositTarget | undefined,
): SolidlyTarget {
  if (!target || target.kind !== "solidly-lp") {
    throw new DefiError(
      "protocol_not_found",
      "solidly-lp adapter requires a resolved { kind: 'solidly-lp' } depositTarget",
    );
  }
  return target;
}

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
}

export const SolidlyLpAdapter: DefiProtocolAdapter = {
  slug: "solidly-lp",
  namespace: "eip155",
  kind: "lp_stable",
  chainId: 0, // nominal — routed by DepositTarget.kind
  displayName: "Solidly Pool",
  targetKinds: ["solidly-lp"],
  externalSlugs: ["aerodrome-v1", "velodrome-v2"],
  staticSafetyScore: 62,

  /**
   * `amount` is the amount of the pool's `token0` the user is supplying; the
   * matching `token1` amount comes from the pool's current reserve ratio, so
   * the add is balanced and the router does not refund a dust remainder.
   */
  async buildDeposit({
    wallet,
    chain,
    asset,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    const t = requireSolidlyTarget(target);
    const evm = assertEvmChain(chain);
    const client = getPublicClient(evm.chain);

    // Which leg is the user supplying? Everything downstream is expressed in
    // (tokenA = supplied, tokenB = counterpart) so the router argument order
    // matches what the user actually holds.
    const supplied = (asset.contract ?? t.token0).toLowerCase();
    const isToken0 = supplied === t.token0.toLowerCase();
    const isToken1 = supplied === t.token1.toLowerCase();
    if (!isToken0 && !isToken1) {
      throw new DefiError(
        "unsupported_asset",
        "solidly-lp: asset is not one of the pool's tokens",
      );
    }
    const tokenA = (isToken0 ? t.token0 : t.token1) as Address;
    const tokenB = (isToken0 ? t.token1 : t.token0) as Address;

    const factory = (await client
      .readContract({
        address: t.router,
        abi: ROUTER_ABI,
        functionName: "defaultFactory",
      })
      .catch(() => null)) as Address | null;
    if (!factory) {
      throw new DefiError(
        "protocol_not_found",
        "solidly-lp: router did not report a factory",
      );
    }

    // Pair the supplied amount against the pool's live reserves.
    const reserves = (await client
      .readContract({
        address: t.router,
        abi: ROUTER_ABI,
        functionName: "getReserves",
        args: [tokenA, tokenB, t.stable, factory],
      })
      .catch(() => null)) as readonly [bigint, bigint] | null;
    if (!reserves || reserves[0] <= 0n || reserves[1] <= 0n) {
      throw new DefiError(
        "protocol_not_found",
        "solidly-lp: pool has no reserves to price the pair against",
      );
    }
    const amountBDesired = (amount * reserves[1]) / reserves[0];
    if (amountBDesired <= 0n) {
      throw new DefiError(
        "below_min_deposit",
        "solidly-lp: amount is too small to pair",
      );
    }

    // The router's own quote decides what will actually be consumed; the
    // minimums are that quote minus the slippage budget.
    const quote = (await client
      .readContract({
        address: t.router,
        abi: ROUTER_ABI,
        functionName: "quoteAddLiquidity",
        args: [tokenA, tokenB, t.stable, factory, amount, amountBDesired],
      })
      .catch(() => null)) as readonly [bigint, bigint, bigint] | null;
    if (!quote) {
      throw new DefiError(
        "slippage_too_high",
        "solidly-lp: quoteAddLiquidity reverted; cannot set minimums",
      );
    }
    const bps = slippageBpsFor({ stable: t.stable });
    const amountAMin = minOutFor(quote[0], {
      stable: t.stable,
      overrideBps: bps,
    });
    const amountBMin = minOutFor(quote[1], {
      stable: t.stable,
      overrideBps: bps,
    });

    const approvals: ApprovalRequirement[] = [
      { token: tokenA, spender: t.router, amount },
      { token: tokenB, spender: t.router, amount: amountBDesired },
    ];

    return {
      kind: "evm-call",
      to: t.router,
      data: encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: "addLiquidity",
        args: [
          tokenA,
          tokenB,
          t.stable,
          amount,
          amountBDesired,
          amountAMin,
          amountBMin,
          wallet.address as Address,
          deadline(),
        ],
      }),
      needsApproval: approvals,
    } satisfies UnsignedCall;
  },

  async buildWithdraw({
    wallet,
    chain,
    amount,
    target,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    const t = requireSolidlyTarget(target);
    if (amount !== "MAX") {
      // Same reasoning as Curve: `amount` is in underlying units but the router
      // burns LP, and a guessed LP figure removes the wrong value.
      throw new DefiError(
        "withdraw_failed",
        "solidly-lp: partial withdraw needs an LP amount; use MAX for a full exit",
      );
    }
    const evm = assertEvmChain(chain);
    const client = getPublicClient(evm.chain);
    const liquidity = await client.readContract({
      address: t.pool,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet.address as Address],
    });
    if (liquidity === 0n) {
      throw new DefiError("position_not_found", "solidly-lp: no LP balance");
    }

    // Removing liquidity returns both legs; the minimums protect against the
    // reserves moving between build and mine.
    const totalSupply = await client.readContract({
      address: t.pool,
      abi: erc20Abi,
      functionName: "totalSupply",
    });
    if (totalSupply === 0n) {
      throw new DefiError("withdraw_failed", "solidly-lp: pool has no supply");
    }
    const [reserve0, reserve1] = (await client.readContract({
      address: t.router,
      abi: ROUTER_ABI,
      functionName: "getReserves",
      args: [
        t.token0 as Address,
        t.token1 as Address,
        t.stable,
        (await client.readContract({
          address: t.router,
          abi: ROUTER_ABI,
          functionName: "defaultFactory",
        })) as Address,
      ],
    })) as readonly [bigint, bigint];

    const bps = slippageBpsFor({ stable: t.stable });
    const amountAMin = minOutFor((liquidity * reserve0) / totalSupply, {
      stable: t.stable,
      overrideBps: bps,
    });
    const amountBMin = minOutFor((liquidity * reserve1) / totalSupply, {
      stable: t.stable,
      overrideBps: bps,
    });

    return {
      kind: "evm-call",
      to: t.router,
      data: encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: "removeLiquidity",
        args: [
          t.token0 as Address,
          t.token1 as Address,
          t.stable,
          liquidity,
          amountAMin,
          amountBMin,
          wallet.address as Address,
          deadline(),
        ],
      }),
      // The LP token itself must be approved to the router before it can burn.
      needsApproval: {
        token: t.pool as Address,
        spender: t.router,
        amount: liquidity,
      },
    } satisfies UnsignedCall;
  },

  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    const target = ctx?.target;
    if (!target || target.kind !== "solidly-lp") return null;
    if (!ctx?.chain) return null;
    try {
      const evm = assertEvmChain(ctx.chain);
      const client = getPublicClient(evm.chain);
      const liquidity = await client.readContract({
        address: target.pool as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress as Address],
      });
      if (liquidity === 0n) return null;
      return {
        protocolSlug: "solidly-lp",
        namespace: "eip155",
        chainId: evm.chain.id,
        assetSymbol: ctx.assetSymbol ?? "",
        amountAtDeposit: 0n,
        amountAtDepositUsd: 0,
        // LP units, not underlying: an LP position's value in one leg is
        // path-dependent, so pricing happens upstream where both reserves and
        // the USD rate are available.
        currentAmount: liquidity,
        currentAmountUsd: 0,
        pnlUsd: 0,
      };
    } catch {
      return null;
    }
  },
};
