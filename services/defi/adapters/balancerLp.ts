/**
 * BalancerLpAdapter — Balancer v2 / Beets single-asset joins and exits
 * (docs/defi-evm-protocol-expansion-spec.md §6.2).
 *
 * A Balancer pool is joined/exited through the **Vault** by its registration
 * `poolId`, never by calling the pool contract. A single-asset join is
 * `EXACT_TOKENS_IN_FOR_BPT_OUT` with one non-zero entry in `maxAmountsIn` and a
 * `minimumBPT` floor; a single-asset exit is `EXACT_BPT_IN_FOR_ONE_TOKEN_OUT`
 * with a `minAmountsOut` floor. Both floors are priced off-chain via the
 * `BalancerQueries` singleton (`queryJoin`/`queryExit`) — §12 Q4 forbids ever
 * signing with a zero minimum, since that fails as a silent sandwich rather
 * than a loud revert.
 *
 * ── v2 ONLY ──────────────────────────────────────────────────────────────
 * `BALANCER_QUERIES` (services/defi/constants/evmAddressBook.ts) is pinned for
 * the chains where the v2 Vault + `BalancerQueries` are reviewed (verified
 * against `balancer/balancer-deployments`, 2026-08-19). Balancer **v3** is a
 * different contract shape entirely — no `joinPool`/`exitPool` on the Vault,
 * no `BalancerQueries` singleton; liquidity goes through a **Router**
 * (`addLiquidityUnbalanced`/`removeLiquiditySingleTokenExactIn` +
 * `queryAddLiquidityUnbalanced`/`queryRemoveLiquiditySingleTokenExactIn`), and
 * v3 pools don't even implement `getPoolId()` (`IBasePool` has no such
 * method), so `balancer.resolver.ts`'s `getPoolId()` probe already fails
 * closed on genuine v3-native pools before a target is ever emitted. This
 * adapter additionally refuses to build against anything but the pinned v2
 * Vault (`requireV2Vault` below) as a second, independent guard — the same
 * "two anchors must agree" posture as the rest of §11. Wiring v3 is separate,
 * larger work (a Router-based join/exit, a new resolver identity check) and is
 * intentionally not attempted here.
 */

import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
} from "viem";
import { assertEvmChain } from "@/constants/configs/chainConfig";
import { getPublicClient } from "@/utils/clients";
import {
  BALANCER_V2_VAULT,
  balancerQueries,
} from "../constants/evmAddressBook";
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
  {
    name: "queryExit",
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
    outputs: [
      { name: "bptIn", type: "uint256" },
      { name: "amountsOut", type: "uint256[]" },
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
 * Second, independent guard (on top of the resolver's identity check) that
 * this target is the v2 Vault this adapter actually knows how to call. A v3
 * Vault has no `joinPool`/`exitPool` at all, so calling through would revert —
 * safe, but this fails closed earlier with an honest reason instead of a bare
 * ABI-mismatch revert. See the file header.
 */
function requireV2Vault(vault: Address): void {
  if (vault.toLowerCase() !== BALANCER_V2_VAULT.toLowerCase()) {
    throw new DefiError(
      "protocol_not_found",
      "balancer-lp: target is not the pinned v2 Vault; v3 pools are not supported by this adapter yet",
    );
  }
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
  // Throws without a resolved target — see `requiresTarget` in types.ts.
  requiresTarget: true,
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
    requireV2Vault(t.vault);
    const queries = balancerQueries(evm.chain.id);
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
    requireV2Vault(t.vault);
    if (amount !== "MAX") {
      throw new DefiError(
        "withdraw_failed",
        "balancer-lp: partial withdraw needs a BPT amount; use MAX for a full exit",
      );
    }
    const evm = assertEvmChain(chain);
    const queries = balancerQueries(evm.chain.id);
    if (!queries) {
      throw new DefiError(
        "slippage_too_high",
        "balancer-lp: no pinned BalancerQueries deployment; cannot price the exit",
      );
    }
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
    // excludes the BPT — the same offset rule as the join (official docs:
    // "for pools that include their own BPT as part of the pool's tokens, the
    // BPT are not included in the userData").
    const userDataIndex = tokens
      .slice(0, index)
      .filter((token) => token.toLowerCase() !== bpt.toLowerCase()).length;

    // Ask the pool what this exit would return, then floor it by policy —
    // the same "quote, then floor" shape as the join. A zero minAmountsOut is
    // never signed (§12 Q4).
    const probeExitUserData = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [EXACT_BPT_IN_FOR_ONE_TOKEN_OUT, balance, BigInt(userDataIndex)],
    );
    const minAmountsOutProbe = tokens.map(() => 0n);
    const quoted = (await client
      .readContract({
        address: queries,
        abi: QUERIES_ABI,
        functionName: "queryExit",
        args: [
          t.poolId,
          wallet.address as Address,
          wallet.address as Address,
          {
            assets: tokens,
            minAmountsOut: minAmountsOutProbe,
            userData: probeExitUserData,
            toInternalBalance: false,
          },
        ],
      })
      .catch(() => null)) as readonly [bigint, readonly bigint[]] | null;
    if (!quoted) {
      throw new DefiError(
        "slippage_too_high",
        "balancer-lp: queryExit reverted; cannot set minAmountsOut",
      );
    }
    const quotedOut = quoted[1][index];
    const minOut = minOutFor(quotedOut, { stable: true });
    const minAmountsOut = tokens.map((_, i) => (i === index ? minOut : 0n));

    const userData = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [EXACT_BPT_IN_FOR_ONE_TOKEN_OUT, balance, BigInt(userDataIndex)],
    );

    return {
      kind: "evm-call",
      to: t.vault,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "exitPool",
        args: [
          t.poolId,
          wallet.address as Address,
          wallet.address as Address,
          {
            assets: tokens,
            minAmountsOut,
            userData,
            toInternalBalance: false,
          },
        ],
      }),
    } satisfies UnsignedCall;
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
