/**
 * BalancerLpAdapter — Balancer v2 / Beets single-asset joins
 * (docs/defi-evm-protocol-expansion-spec.md §6.2).
 *
 * A Balancer pool is joined through the **Vault** by its registration `poolId`,
 * never by calling the pool contract. A single-asset join is
 * `EXACT_TOKENS_IN_FOR_BPT_OUT` with one non-zero entry in `maxAmountsIn` and a
 * `minimumBPT` floor.
 *
 * ── NOT REGISTERED YET, on purpose ──────────────────────────────────────────
 * `minimumBPT` cannot be derived from reserves the way a constant-product
 * minimum can — for weighted and composable-stable pools it needs
 * `BalancerQueries.queryJoin`, and we have no reviewed deployment for that
 * contract in the address-book. §12 Q4 forbids a zero minimum outright, and a
 * zero-minimum join is not a revert — it is a silent sandwich, which is exactly
 * the failure mode the slippage policy exists to prevent. So this adapter
 * throws rather than guessing, and `bootstrap.ts` does not register the family.
 *
 * Turning it on is a reviewed two-line change: pin `BalancerQueries` per chain
 * in `BALANCER_QUERIES` below, then register the adapter and its resolver.
 * Everything else — the join encoding, the composable-stable BPT handling, the
 * validator — is already here and fork-testable.
 */

import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
} from "viem";
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

/**
 * `BalancerQueries` per chain — the off-chain simulation contract whose
 * `queryJoin` gives the BPT a join would mint. **Deliberately empty**: an
 * unreviewed address here would be trusted to price a user's deposit. See the
 * file header.
 */
const BALANCER_QUERIES: Readonly<Record<number, Address>> = {};

/** JoinKind for weighted/stable pools: give exact tokens, receive BPT. */
const EXACT_TOKENS_IN_FOR_BPT_OUT = 1n;
/** ExitKind: burn exact BPT, receive one token. */
const EXACT_BPT_IN_FOR_ONE_TOKEN_OUT = 0n;

const VAULT_ABI = [
  {
    name: "getPoolTokens",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "tokens", type: "address[]" },
      { name: "balances", type: "uint256[]" },
      { name: "lastChangeBlock", type: "uint256" },
    ],
  },
  {
    name: "getPool",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "", type: "address" },
      { name: "", type: "uint8" },
    ],
  },
  {
    name: "joinPool",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "sender", type: "address" },
      { name: "recipient", type: "address" },
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "assets", type: "address[]" },
          { name: "maxAmountsIn", type: "uint256[]" },
          { name: "userData", type: "bytes" },
          { name: "fromInternalBalance", type: "bool" },
        ],
      },
    ],
    outputs: [],
  },
  {
    name: "exitPool",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "sender", type: "address" },
      { name: "recipient", type: "address" },
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "assets", type: "address[]" },
          { name: "minAmountsOut", type: "uint256[]" },
          { name: "userData", type: "bytes" },
          { name: "toInternalBalance", type: "bool" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const QUERIES_ABI = [
  {
    name: "queryJoin",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "sender", type: "address" },
      { name: "recipient", type: "address" },
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "assets", type: "address[]" },
          { name: "maxAmountsIn", type: "uint256[]" },
          { name: "userData", type: "bytes" },
          { name: "fromInternalBalance", type: "bool" },
        ],
      },
    ],
    outputs: [
      { name: "bptOut", type: "uint256" },
      { name: "amountsIn", type: "uint256[]" },
    ],
  },
] as const;

type BalancerTarget = Extract<DepositTarget, { kind: "balancer-lp" }>;

function requireBalancerTarget(
  target: DepositTarget | undefined,
): BalancerTarget {
  if (!target || target.kind !== "balancer-lp") {
    throw new DefiError(
      "protocol_not_found",
      "balancer-lp adapter requires a resolved { kind: 'balancer-lp' } depositTarget",
    );
  }
  return target;
}

/** The pool contract address is the first 20 bytes of its `poolId`. */
function poolAddressFromId(poolId: string): Address {
  return `0x${poolId.slice(2, 42)}`.toLowerCase() as Address;
}

/**
 * `userData` amounts EXCLUDE the pool's own BPT when it is registered as one of
 * its tokens (composable-stable pools). Getting this wrong is the classic
 * Balancer integration bug: the join reverts, or worse, prices against the
 * wrong array.
 */
function userDataAmounts(
  tokens: readonly Address[],
  amounts: readonly bigint[],
  bpt: Address,
): bigint[] {
  const out: bigint[] = [];
  tokens.forEach((token, i) => {
    if (token.toLowerCase() === bpt.toLowerCase()) return;
    out.push(amounts[i]);
  });
  return out;
}

export const BalancerLpAdapter: DefiProtocolAdapter = {
  slug: "balancer-lp",
  namespace: "eip155",
  kind: "lp_stable",
  chainId: 0, // nominal — routed by DepositTarget.kind
  displayName: "Balancer Pool",
  targetKinds: ["balancer-lp"],
  externalSlugs: ["balancer-v2", "beethoven-x"],
  staticSafetyScore: 62,

  async buildDeposit({
    wallet,
    chain,
    asset,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    const t = requireBalancerTarget(target);
    const evm = assertEvmChain(chain);
    const queries = BALANCER_QUERIES[evm.chain.id];
    if (!queries) {
      // See the file header: no reviewed queries deployment ⇒ no honest
      // minimumBPT ⇒ we do not build. Never a zero minimum.
      throw new DefiError(
        "slippage_too_high",
        "balancer-lp: no pinned BalancerQueries deployment; cannot price minimumBPT",
      );
    }
    const client = getPublicClient(evm.chain);
    const depositAsset = (asset.contract ?? t.asset).toLowerCase();
    if (depositAsset !== t.asset.toLowerCase()) {
      throw new DefiError(
        "unsupported_asset",
        "balancer-lp: asset does not match the resolved join token",
      );
    }

    const [tokens] = (await client.readContract({
      address: t.vault,
      abi: VAULT_ABI,
      functionName: "getPoolTokens",
      args: [t.poolId],
    })) as readonly [readonly Address[], readonly bigint[], bigint];

    const index = tokens.findIndex(
      (token) => token.toLowerCase() === depositAsset,
    );
    if (index < 0) {
      throw new DefiError(
        "unsupported_asset",
        "balancer-lp: asset is not one of the pool's registered tokens",
      );
    }

    const maxAmountsIn = tokens.map((_, i) => (i === index ? amount : 0n));
    const bpt = poolAddressFromId(t.poolId);
    const amountsForUserData = userDataAmounts(tokens, maxAmountsIn, bpt);

    // Ask the pool what this join would mint, then floor it by the policy.
    const probeUserData = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256[]" }, { type: "uint256" }],
      [EXACT_TOKENS_IN_FOR_BPT_OUT, amountsForUserData, 0n],
    );
    const quoted = (await client
      .readContract({
        address: queries,
        abi: QUERIES_ABI,
        functionName: "queryJoin",
        args: [
          t.poolId,
          wallet.address as Address,
          wallet.address as Address,
          {
            assets: tokens,
            maxAmountsIn,
            userData: probeUserData,
            fromInternalBalance: false,
          },
        ],
      })
      .catch(() => null)) as readonly [bigint, readonly bigint[]] | null;
    if (!quoted) {
      throw new DefiError(
        "slippage_too_high",
        "balancer-lp: queryJoin reverted; cannot set minimumBPT",
      );
    }
    const minimumBPT = minOutFor(quoted[0], { stable: true });

    const userData = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256[]" }, { type: "uint256" }],
      [EXACT_TOKENS_IN_FOR_BPT_OUT, amountsForUserData, minimumBPT],
    );

    return {
      kind: "evm-call",
      to: t.vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "joinPool",
        args: [
          t.poolId,
          wallet.address as Address,
          wallet.address as Address,
          {
            assets: tokens,
            maxAmountsIn,
            userData,
            fromInternalBalance: false,
          },
        ],
      }),
      needsApproval: { token: t.asset, spender: t.vault, amount },
    } satisfies UnsignedCall;
  },

  async buildWithdraw({
    wallet,
    chain,
    amount,
    target,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    const t = requireBalancerTarget(target);
    if (amount !== "MAX") {
      throw new DefiError(
        "withdraw_failed",
        "balancer-lp: partial withdraw needs a BPT amount; use MAX for a full exit",
      );
    }
    const evm = assertEvmChain(chain);
    const client = getPublicClient(evm.chain);
    const bpt = poolAddressFromId(t.poolId);
    const balance = await client.readContract({
      address: bpt,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet.address as Address],
    });
    if (balance === 0n) {
      throw new DefiError("position_not_found", "balancer-lp: no BPT balance");
    }

    const [tokens] = (await client.readContract({
      address: t.vault,
      abi: VAULT_ABI,
      functionName: "getPoolTokens",
      args: [t.poolId],
    })) as readonly [readonly Address[], readonly bigint[], bigint];
    const index = tokens.findIndex(
      (token) => token.toLowerCase() === t.asset.toLowerCase(),
    );
    if (index < 0) {
      throw new DefiError(
        "unsupported_asset",
        "balancer-lp: exit token is not registered on the pool",
      );
    }
    // The exit's `exitTokenIndex` is an index into the userData array, which
    // excludes the BPT — the same offset rule as the join.
    const userDataIndex = tokens
      .slice(0, index)
      .filter((token) => token.toLowerCase() !== bpt.toLowerCase()).length;

    // Without a reviewed queries deployment there is no honest floor for the
    // amount out either, so the exit is held to the same standard as the join.
    throw new DefiError(
      "slippage_too_high",
      `balancer-lp: no pinned BalancerQueries deployment; cannot floor the exit (bpt=${balance}, idx=${userDataIndex}, kind=${EXACT_BPT_IN_FOR_ONE_TOKEN_OUT})`,
    );
  },

  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    const target = ctx?.target;
    if (!target || target.kind !== "balancer-lp") return null;
    if (!ctx?.chain) return null;
    try {
      const evm = assertEvmChain(ctx.chain);
      const client = getPublicClient(evm.chain);
      const balance = await client.readContract({
        address: poolAddressFromId(target.poolId),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress as Address],
      });
      if (balance === 0n) return null;
      return {
        protocolSlug: "balancer-lp",
        namespace: "eip155",
        chainId: evm.chain.id,
        assetSymbol: ctx.assetSymbol ?? "",
        amountAtDeposit: 0n,
        amountAtDepositUsd: 0,
        currentAmount: balance, // BPT units; priced upstream
        currentAmountUsd: 0,
        pnlUsd: 0,
      };
    } catch {
      return null;
    }
  },
};
