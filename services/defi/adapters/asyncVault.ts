/**
 * AsyncVaultAdapter — ERC-7540 request/claim vaults
 * (docs/defi-evm-protocol-expansion-spec.md §7).
 *
 * ERC-7540 extends 4626 for assets that **cannot settle in one transaction** —
 * tokenised treasuries, private credit, anything with T+1/T+2 or a withdrawal
 * queue. Deposit and redeem become a state machine:
 *
 *     requestDeposit(assets) → (off-chain fulfilment) → deposit()  to claim
 *     requestRedeem(shares)  → (off-chain fulfilment) → redeem()   to claim
 *
 * ── NOT REGISTERED ─────────────────────────────────────────────────────────
 * §7 is explicit: no `async-vault` resolver may register until the two-phase
 * flow works end to end — the pending-claims tracker (the `asyncPhase` columns
 * on `StrategyPosition` and the claim-watcher worker), the "pending settlement"
 * position state, and the agent copy that says "requested, we'll notify you
 * when it's claimable" instead of "done". Badging an async pool "Deposit
 * in-app" before that exists produces a deposit that requests and then appears
 * stuck, which is worse than the honest Manual badge these pools carry today.
 *
 * This file is the interface half of that work: the encoders and the readiness
 * read, fork-testable, waiting on the UX half.
 */

import { type Address, encodeFunctionData } from "viem";
import { assertEvmChain } from "@/constants/configs/chainConfig";
import { getPublicClient } from "@/utils/clients";
import { DefiError } from "../errors/defiErrors";
import type {
  AsyncRequestState,
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  DepositTarget,
  PositionReadContext,
  UnsignedCall,
} from "../types";

const ERC7540_ABI = [
  {
    name: "requestDeposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "controller", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "requestId", type: "uint256" }],
  },
  {
    name: "requestRedeem",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "controller", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "requestId", type: "uint256" }],
  },
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    name: "redeem",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "assets", type: "uint256" }],
  },
  {
    name: "pendingDepositRequest",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "requestId", type: "uint256" },
      { name: "controller", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "claimableDepositRequest",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "requestId", type: "uint256" },
      { name: "controller", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "pendingRedeemRequest",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "requestId", type: "uint256" },
      { name: "controller", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "claimableRedeemRequest",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "requestId", type: "uint256" },
      { name: "controller", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function requireAsyncTarget(
  target: DepositTarget | undefined,
): Extract<DepositTarget, { kind: "async-vault" }> {
  if (!target || target.kind !== "async-vault") {
    throw new DefiError(
      "protocol_not_found",
      "async-vault adapter requires a resolved { kind: 'async-vault' } depositTarget",
    );
  }
  return target;
}

/** ERC-7540 request ids are 0 for vaults that don't partition requests. */
const DEFAULT_REQUEST_ID = 0n;

export const AsyncVaultAdapter: DefiProtocolAdapter = {
  slug: "async-vault",
  namespace: "eip155",
  kind: "rwa_yield",
  chainId: 0, // nominal — routed by DepositTarget.kind
  displayName: "Async Vault",
  targetKinds: ["async-vault"],
  staticSafetyScore: 70,

  /**
   * The synchronous entry points are deliberately unavailable. A caller that
   * reaches one has routed an async vault through the sync path, and answering
   * it would take the user's funds into a request nothing tracks.
   */
  buildDeposit(): Promise<UnsignedCall> {
    throw new DefiError(
      "protocol_not_found",
      "async-vault: use buildRequestDeposit / buildClaimDeposit (two-phase, §7)",
    );
  },

  buildWithdraw(): Promise<UnsignedCall> {
    throw new DefiError(
      "protocol_not_found",
      "async-vault: use buildRequestRedeem / buildClaimRedeem (two-phase, §7)",
    );
  },

  async buildRequestDeposit({
    wallet,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    const t = requireAsyncTarget(target);
    if (t.flavor === "7540-redeem") {
      throw new DefiError(
        "protocol_not_found",
        "async-vault: this vault's deposits are synchronous",
      );
    }
    const owner = wallet.address as Address;
    return {
      kind: "evm-call",
      to: t.vault,
      data: encodeFunctionData({
        abi: ERC7540_ABI,
        functionName: "requestDeposit",
        // controller and owner are both the user: the claim must return to the
        // same wallet that made the request, never a third party.
        args: [amount, owner, owner],
      }),
      needsApproval: { token: t.asset, spender: t.vault, amount },
    } satisfies UnsignedCall;
  },

  async buildClaimDeposit({
    wallet,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    const t = requireAsyncTarget(target);
    const owner = wallet.address as Address;
    return {
      kind: "evm-call",
      to: t.vault,
      data: encodeFunctionData({
        abi: ERC7540_ABI,
        functionName: "deposit",
        args: [amount, owner],
      }),
    } satisfies UnsignedCall;
  },

  async buildRequestRedeem({
    wallet,
    chain,
    amount,
    target,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    const t = requireAsyncTarget(target);
    if (t.flavor === "7540-deposit") {
      throw new DefiError(
        "protocol_not_found",
        "async-vault: this vault's redemptions are synchronous",
      );
    }
    const owner = wallet.address as Address;
    let shares = amount === "MAX" ? 0n : amount;
    if (amount === "MAX") {
      const evm = assertEvmChain(chain);
      const client = getPublicClient(evm.chain);
      shares = await client.readContract({
        address: t.vault,
        abi: ERC7540_ABI,
        functionName: "balanceOf",
        args: [owner],
      });
      if (shares === 0n) {
        throw new DefiError("position_not_found", "async-vault: no shares");
      }
    }
    return {
      kind: "evm-call",
      to: t.vault,
      data: encodeFunctionData({
        abi: ERC7540_ABI,
        functionName: "requestRedeem",
        args: [shares, owner, owner],
      }),
    } satisfies UnsignedCall;
  },

  async buildClaimRedeem({
    wallet,
    amount,
    target,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    const t = requireAsyncTarget(target);
    if (amount === "MAX") {
      throw new DefiError(
        "withdraw_failed",
        "async-vault: claim the exact claimable amount, not MAX",
      );
    }
    const owner = wallet.address as Address;
    return {
      kind: "evm-call",
      to: t.vault,
      data: encodeFunctionData({
        abi: ERC7540_ABI,
        functionName: "redeem",
        args: [amount, owner, owner],
      }),
    } satisfies UnsignedCall;
  },

  /**
   * How far along an outstanding request is. `null` means "we could not read
   * it", which the tracker treats as still pending — never as ready, because a
   * false "ready" would show a claim button that reverts.
   */
  async readAsyncRequest(
    walletAddress: string,
    ctx: PositionReadContext,
  ): Promise<AsyncRequestState | null> {
    const target = ctx.target;
    if (!target || target.kind !== "async-vault") return null;
    if (!ctx.chain) return null;
    try {
      const evm = assertEvmChain(ctx.chain);
      const client = getPublicClient(evm.chain);
      const owner = walletAddress as Address;
      const phase = target.flavor === "7540-redeem" ? "redeem" : "deposit";
      const [pending, claimable] = await Promise.all([
        client.readContract({
          address: target.vault,
          abi: ERC7540_ABI,
          functionName:
            phase === "redeem"
              ? "pendingRedeemRequest"
              : "pendingDepositRequest",
          args: [DEFAULT_REQUEST_ID, owner],
        }),
        client.readContract({
          address: target.vault,
          abi: ERC7540_ABI,
          functionName:
            phase === "redeem"
              ? "claimableRedeemRequest"
              : "claimableDepositRequest",
          args: [DEFAULT_REQUEST_ID, owner],
        }),
      ]);
      return {
        phase,
        requestId: DEFAULT_REQUEST_ID.toString(),
        pending,
        claimable,
      };
    } catch {
      return null;
    }
  },

  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    const target = ctx?.target;
    if (!target || target.kind !== "async-vault") return null;
    if (!ctx?.chain) return null;
    try {
      const evm = assertEvmChain(ctx.chain);
      const client = getPublicClient(evm.chain);
      const shares = await client.readContract({
        address: target.vault,
        abi: ERC7540_ABI,
        functionName: "balanceOf",
        args: [walletAddress as Address],
      });
      if (shares === 0n) return null;
      return {
        protocolSlug: "async-vault",
        namespace: "eip155",
        chainId: evm.chain.id,
        assetSymbol: ctx.assetSymbol ?? "",
        amountAtDeposit: 0n,
        amountAtDepositUsd: 0,
        // Shares, not assets: a pending request is not yet a share balance, so
        // the position display must show "pending settlement" alongside this
        // rather than implying the whole deposit has landed.
        currentAmount: shares,
        currentAmountUsd: 0,
        pnlUsd: 0,
      };
    } catch {
      return null;
    }
  },
};
