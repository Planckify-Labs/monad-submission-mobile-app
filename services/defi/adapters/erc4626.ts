/**
 * Erc4626Adapter — ONE generic adapter for the entire ERC-4626 vault family
 * (Morpho MetaMorpho, Yearn v3, Euler v2, Gearbox…), the biggest coverage
 * unlock in the pool-level deposits spec (§7, §7.1).
 *
 * Unlike the per-deployment adapters (aaveV3/morpho/yearnV3 with a hardcoded
 * market), this one is parametrised entirely by the resolved
 * `DepositTarget` — `{ kind: "erc4626", vault, asset }` — that the backend
 * resolver produced and the executor re-fetched by `pool_id`. It is routed by
 * `DepositTarget.kind` (`targetKinds: ["erc4626"]`), NOT by slug/chainId, so a
 * single instance serves every sibling vault on every EVM chain. The LLM never
 * supplies the vault address; it arrives on `args.target` from the trusted
 * server round-trip (§6, §8).
 *
 * Deposit uses the canonical `deposit(assets, receiver)`. Withdraw uses
 * `redeem(shares,…)` for a full exit (avoids dust) and `withdraw(assets,…)`
 * for a partial. `readPosition(walletAddress)` returns null — the vault can't
 * be derived from an address alone, so 4626 positions fall back to the DB
 * snapshot (best-effort, spec §14.5); the withdraw path threads the target
 * from the position's pinned `poolId`.
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

const ERC4626_ABI = [
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
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
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
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // Share balance → underlying, so a position reads in the same units the
    // deposit was recorded in. EIP-4626 requires it on every vault.
    name: "convertToAssets",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "assets", type: "uint256" }],
  },
] as const;

function requireErc4626Target(
  target: DepositTarget | undefined,
): Extract<DepositTarget, { kind: "erc4626" }> {
  if (!target || target.kind !== "erc4626") {
    // The executor must re-fetch + pass the server-resolved target; a missing
    // one is a wiring error, never LLM-supplied.
    throw new DefiError(
      "protocol_not_found",
      "erc4626 adapter requires a resolved { kind: 'erc4626' } depositTarget",
    );
  }
  return target;
}

export const Erc4626Adapter: DefiProtocolAdapter = {
  slug: "erc4626",
  namespace: "eip155",
  kind: "yield_vault",
  // Nominal — this adapter is routed by `DepositTarget.kind`, not chainId. 0
  // keeps it out of per-chain venue listings (`listDefiAdaptersForChain`).
  chainId: 0,
  displayName: "ERC-4626 Vault",
  targetKinds: ["erc4626"],

  async buildDeposit({
    wallet,
    asset,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    const t = requireErc4626Target(target);
    // Defence-in-depth: if the caller passed an explicit asset contract it
    // must match the target's underlying (the target is the trusted source).
    if (
      asset.contract &&
      asset.contract.toLowerCase() !== t.asset.toLowerCase()
    ) {
      throw new DefiError(
        "unsupported_asset",
        "erc4626: asset does not match resolved vault underlying",
      );
    }
    return {
      kind: "evm-call",
      to: t.vault,
      data: encodeFunctionData({
        abi: ERC4626_ABI,
        functionName: "deposit",
        args: [amount, wallet.address as Address],
      }),
      needsApproval: {
        token: t.asset,
        spender: t.vault,
        amount,
      },
    } as UnsignedCall;
  },

  async buildWithdraw({
    wallet,
    chain,
    amount,
    target,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    const t = requireErc4626Target(target);
    const owner = wallet.address as Address;
    if (amount === "MAX") {
      const evm = assertEvmChain(chain);
      const client = getPublicClient(evm.chain);
      const shares = await client.readContract({
        address: t.vault,
        abi: ERC4626_ABI,
        functionName: "balanceOf",
        args: [owner],
      });
      if (shares === 0n) {
        throw new DefiError("position_not_found", "erc4626: no shares");
      }
      return {
        kind: "evm-call",
        to: t.vault,
        data: encodeFunctionData({
          abi: ERC4626_ABI,
          functionName: "redeem",
          args: [shares, owner, owner],
        }),
      } as UnsignedCall;
    }
    return {
      kind: "evm-call",
      to: t.vault,
      data: encodeFunctionData({
        abi: ERC4626_ABI,
        functionName: "withdraw",
        args: [amount, owner, owner],
      }),
    } as UnsignedCall;
  },

  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    // This used to `return null` unconditionally, on the reasoning that "the
    // vault address is not derivable from the wallet address". That was true
    // when it was written and stopped being true once `PositionReadContext`
    // gained `target` — the withdraw path threads the vault in from the
    // position's pinned `poolId`, exactly as `cometV3` receives its Comet.
    //
    // The stub was not merely incomplete, it silently disabled a guard.
    // `withdraw` refuses an empty position via `live.currentAmount <= 0n`,
    // which a null can never satisfy, so a MAX withdraw against a drained
    // 4626 vault skipped the preflight and surfaced as the adapter's own
    // `position_not_found` ("erc4626: no shares") — a different recovery class
    // from `no_onchain_balance`, and not even accurate, since the position row
    // exists and is simply empty. It also left `liveBalance` undefined, so
    // `WithdrawBalanceCheck` had nothing to validate an over-request against.
    // Found by the Gate-4 fork case, 2026-08-22.
    const target = ctx?.target;
    if (!target || target.kind !== "erc4626") return null;
    const chain = ctx?.chain;
    if (!chain) return null;
    try {
      const evm = assertEvmChain(chain);
      const client = getPublicClient(evm.chain);
      const shares = await client.readContract({
        address: target.vault as Address,
        abi: ERC4626_ABI,
        functionName: "balanceOf",
        args: [walletAddress as Address],
      });
      // Report in UNDERLYING units. Shares are not the position's value — an
      // accruing vault's share price drifts from 1:1, and `amountAtDeposit`
      // was recorded in underlying, so returning shares here would make every
      // downstream PnL comparison wrong in a way that looks like yield.
      const currentAmount =
        shares === 0n
          ? 0n
          : await client.readContract({
              address: target.vault as Address,
              abi: ERC4626_ABI,
              functionName: "convertToAssets",
              args: [shares],
            });
      return {
        protocolSlug: "erc4626",
        namespace: "eip155",
        chainId: evm.chain.id,
        assetSymbol: ctx?.assetSymbol ?? "",
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
