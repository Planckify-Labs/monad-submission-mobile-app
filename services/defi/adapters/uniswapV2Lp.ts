/**
 * UniswapV2LpAdapter — the family Solidly forked from, and the simplest shape
 * in the LP family: no invariant choice (every v2 pool is constant-product),
 * and the pair contract IS its own LP token.
 *
 * Liquidity goes in through the Router:
 * `addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin,
 * amountBMin, to, deadline)`. Unlike Solidly's router, Uniswap v2's Router02
 * has no `getReserves`/`quoteAddLiquidity` convenience — reserves come from
 * the PAIR contract directly (`getReserves()`), and the pairing math uses the
 * router's `quote(amountA, reserveA, reserveB)` pure helper. Verified on chain
 * 2026-08-22 against the canonical Ethereum deployment.
 *
 * **Both legs are required.** A v2 router has no single-sided add, so the user
 * must hold both tokens; the build emits an approval for each. Turning one
 * token into a balanced pair is a swap, which belongs to the zap track (§1
 * non-goals) — approximating it here would quietly sell half the user's
 * position at whatever price the moment offered.
 *
 * There is no router-level minimum quote to lean on (unlike Solidly), so the
 * minimums are derived from the SAME reserves used to size the pair, via the
 * shared slippage policy. There is no code path here that emits a zero
 * minimum.
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
    name: "quote",
    type: "function",
    stateMutability: "pure",
    inputs: [
      { name: "amountA", type: "uint256" },
      { name: "reserveA", type: "uint256" },
      { name: "reserveB", type: "uint256" },
    ],
    outputs: [{ name: "amountB", type: "uint256" }],
  },
] as const;

const PAIR_ABI = [
  {
    name: "getReserves",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" },
    ],
  },
] as const;

type UniswapV2Target = Extract<DepositTarget, { kind: "uniswap-v2" }>;

function requireUniswapV2Target(
  target: DepositTarget | undefined,
): UniswapV2Target {
  if (!target || target.kind !== "uniswap-v2") {
    throw new DefiError(
      "protocol_not_found",
      "uniswap-v2 adapter requires a resolved { kind: 'uniswap-v2' } depositTarget",
    );
  }
  return target;
}

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
}

/** `(reserve0, reserve1)` ordered to match `(tokenA, tokenB)`. */
async function orderedReserves(
  client: ReturnType<typeof getPublicClient>,
  target: UniswapV2Target,
  tokenA: Address,
): Promise<readonly [bigint, bigint]> {
  const [reserve0, reserve1] = (await client.readContract({
    address: target.pool,
    abi: PAIR_ABI,
    functionName: "getReserves",
  })) as readonly [bigint, bigint, number];
  const aIsToken0 = tokenA.toLowerCase() === target.token0.toLowerCase();
  return aIsToken0 ? [reserve0, reserve1] : [reserve1, reserve0];
}

export const UniswapV2LpAdapter: DefiProtocolAdapter = {
  slug: "uniswap-v2",
  namespace: "eip155",
  kind: "lp_volatile",
  chainId: 0, // nominal — routed by DepositTarget.kind
  displayName: "Uniswap v2 Pool",
  targetKinds: ["uniswap-v2"],
  // Throws without a resolved target — see `requiresTarget` in types.ts.
  requiresTarget: true,
  externalSlugs: ["uniswap-v2"],
  // Same conservative floor as Solidly: an LP position carries impermanent
  // loss a single-asset lending position does not, and unlike Solidly's
  // "stable" pools every v2 pool is the volatile invariant.
  staticSafetyScore: 55,

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
    const t = requireUniswapV2Target(target);
    const evm = assertEvmChain(chain);
    const client = getPublicClient(evm.chain);

    const supplied = (asset.contract ?? t.token0).toLowerCase();
    const isToken0 = supplied === t.token0.toLowerCase();
    const isToken1 = supplied === t.token1.toLowerCase();
    if (!isToken0 && !isToken1) {
      throw new DefiError(
        "unsupported_asset",
        "uniswap-v2: asset is not one of the pool's tokens",
      );
    }
    const tokenA = (isToken0 ? t.token0 : t.token1) as Address;
    const tokenB = (isToken0 ? t.token1 : t.token0) as Address;

    const [reserveA, reserveB] = await orderedReserves(client, t, tokenA);
    if (reserveA <= 0n || reserveB <= 0n) {
      throw new DefiError(
        "protocol_not_found",
        "uniswap-v2: pool has no reserves to price the pair against",
      );
    }

    const amountBDesired = (await client
      .readContract({
        address: t.router,
        abi: ROUTER_ABI,
        functionName: "quote",
        args: [amount, reserveA, reserveB],
      })
      .catch(() => null)) as bigint | null;
    if (!amountBDesired || amountBDesired <= 0n) {
      throw new DefiError(
        "below_min_deposit",
        "uniswap-v2: amount is too small to pair",
      );
    }

    // The same reserves that sized the pair also floor the minimums — no
    // separate quote call exists on this router, unlike Solidly's.
    const bps = slippageBpsFor({ stable: false });
    const amountAMin = minOutFor(amount, { stable: false, overrideBps: bps });
    const amountBMin = minOutFor(amountBDesired, {
      stable: false,
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
    const t = requireUniswapV2Target(target);
    if (amount !== "MAX") {
      // Same reasoning as Curve/Solidly: `amount` is in underlying units but
      // the router burns LP, and a guessed LP figure removes the wrong value.
      throw new DefiError(
        "withdraw_failed",
        "uniswap-v2: partial withdraw needs an LP amount; use MAX for a full exit",
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
      throw new DefiError("position_not_found", "uniswap-v2: no LP balance");
    }

    const totalSupply = await client.readContract({
      address: t.pool,
      abi: erc20Abi,
      functionName: "totalSupply",
    });
    if (totalSupply === 0n) {
      throw new DefiError("withdraw_failed", "uniswap-v2: pool has no supply");
    }
    const [reserve0, reserve1] = (await client.readContract({
      address: t.pool,
      abi: PAIR_ABI,
      functionName: "getReserves",
    })) as readonly [bigint, bigint, number];

    const bps = slippageBpsFor({ stable: false });
    const amountAMin = minOutFor((liquidity * reserve0) / totalSupply, {
      stable: false,
      overrideBps: bps,
    });
    const amountBMin = minOutFor((liquidity * reserve1) / totalSupply, {
      stable: false,
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
    if (!target || target.kind !== "uniswap-v2") return null;
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
        protocolSlug: "uniswap-v2",
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
