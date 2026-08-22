/**
 * Kai Finance adapter — a `DefiProtocolAdapter` for pool-level Sui deposits
 * (docs/defi-pool-level-deposits-spec.md §7, Phase 3). Built 2026-08-22.
 *
 * Kai's Single Asset Vaults are a generic tokenized vault (structurally close
 * to Ember's `Vault<T,R>`, but a separate package — see `kai.resolver.ts`),
 * dispatched by `DepositTarget.kind === "kai-vault"`.
 *
 * NO SDK. PTBs are built directly with `@mysten/sui`, calling Kai's public
 * `vault` module — everything moves through `Balance<T>`, not `Coin<T>`:
 *
 *   deposit  → coin::into_balance(coin) then
 *              vault::deposit<T,Y>(vault, balance, clock) -> Balance<Y>
 *   withdraw → coin::into_balance(shareCoin) then
 *              vault::withdraw<T,Y>(vault, shareBalance, clock)
 *                -> WithdrawTicket<T,Y>, then
 *              vault::redeem_withdraw_ticket<T,Y>(vault, ticket) -> Balance<T>
 *
 * Both directions chain atomically in ONE PTB — device-verified 2026-08-22 via
 * `sui_devInspectTransactionBlock` against live mainnet (deposit 1 SUI,
 * immediately withdraw+redeem it back, in a single transaction), even against
 * a vault with zero idle `free_balance` at the time. No oracle either
 * direction. The `WithdrawTicket` return type looked like it might be a
 * genuine async/queued redemption (`redeem_withdraw_ticket` is a SEPARATE
 * call, and every vault checked had `free_balance: 0`, meaning 100% of funds
 * were deployed into strategies) — it isn't; the round-trip succeeding proves
 * the vault settles it instantly regardless.
 *
 * The vault object id + coinType (T) + shareType (Y) are the immutable
 * per-vault identity carried on the resolved `target`; the mutable moveCall
 * package comes from `kai.config.ts` (MVR-fetched, cached, pinned fallback —
 * "config not constants" — calling through the vault object's own on-chain
 * type-package instead aborts `assert_version`, the same bug class Suilend
 * had).
 *
 * SCOPE: deposit + full-exit withdraw only, like every other Sui venue here
 * (Ember/Scallop/Suilend) — v1 doesn't split an exact underlying amount out of
 * the share balance. Kai's own `vault::withdraw_t_amt` primitive could support
 * a real partial withdraw later (it takes a target u64 amount and a `&mut
 * Balance<Y>`, leaving the remainder in place), but that needs its own
 * verification pass and isn't exercised here. No zap-supply (`buildZapSupply`)
 * yet either — optional capability, not required for pool-card deposits.
 * `readPosition` returns null: Kai's `vault` module has no
 * `calculate_amount_from_shares`-equivalent view function (unlike Ember), and
 * computing the share→underlying rate by hand from raw vault fields (fees,
 * `time_locked_profit`'s unlock schedule, multi-strategy `borrowed` sums)
 * risks getting the math wrong — the position still shows its recorded
 * deposit amount via the generic fallback.
 *
 * MAINNET-ONLY (`chainId:"mainnet"`). Every failure maps to a curated
 * `DefiError`, never a raw RPC string (CLAUDE.md).
 */

import { toBase64 } from "@mysten/bcs";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import type { SuiChainConfig } from "@/constants/configs/chainConfig";
import { classifySuiMoveError, DefiError } from "../errors/defiErrors";
import type {
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  DepositTarget,
  UnsignedCall,
} from "../types";
import { getKaiPackage } from "./kai.config";
import { gatherAllCoins, prepareInputCoin } from "./sui/coins";

const SLUG = "kai-sui";
const NETWORK = "mainnet" as const;

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[kaiSui] ${scope}:`, err);
  }
}

function suiClientFor(chain: SuiChainConfig): SuiJsonRpcClient {
  return new SuiJsonRpcClient({ url: chain.rpcUrl, network: chain.network });
}

/**
 * The `kai-vault` target is mandatory: Kai is multi-vault (one per asset) with
 * no canonical market, so without the resolved vault there's nothing to
 * deposit into.
 */
function requireKaiTarget(
  target: DepositTarget | undefined,
): Extract<DepositTarget, { kind: "kai-vault" }> {
  if (target?.kind !== "kai-vault") {
    throw new DefiError(
      "deposit_failed",
      "kai: a resolved pool target is required (vault + coin/share type)",
    );
  }
  return target;
}

export const KaiSuiAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "sui",
  kind: "yield_vault",
  chainId: NETWORK, // string id → free network gate via listDefiAdaptersForChain
  displayName: "Kai Finance",
  staticSafetyScore: 60,
  externalSlugs: ["kai-finance", "kai"],
  targetKinds: ["kai-vault"],

  async buildDeposit({
    wallet,
    chain,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "sui") {
      throw new DefiError("unsupported_chain", "kai: requires sui namespace");
    }
    const { vault, coinType, shareType } = requireKaiTarget(target);
    try {
      const pkg = await getKaiPackage();
      const client = suiClientFor(chain);
      const tx = new Transaction();
      tx.setSender(wallet.address);

      const depositCoin = await prepareInputCoin(
        tx,
        client,
        wallet.address,
        coinType,
        amount,
      );
      const depositBalance = tx.moveCall({
        target: "0x2::coin::into_balance",
        typeArguments: [coinType],
        arguments: [depositCoin],
      });
      const [shareBalance] = tx.moveCall({
        target: `${pkg}::vault::deposit`,
        typeArguments: [coinType, shareType],
        arguments: [
          tx.object(vault),
          depositBalance,
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      });
      const [shareCoin] = tx.moveCall({
        target: "0x2::coin::from_balance",
        typeArguments: [shareType],
        arguments: [shareBalance],
      });
      tx.transferObjects([shareCoin], tx.pure.address(wallet.address));

      const bytes = await tx.build({ client });
      return { kind: "sui-ptb", transactionBlockBase64: toBase64(bytes) };
    } catch (err) {
      if (err instanceof DefiError) throw err;
      devWarn("buildDeposit", err);
      throw classifySuiMoveError(err, "deposit_failed");
    }
  },

  async buildWithdraw({
    wallet,
    chain,
    amount,
    target,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "sui") {
      throw new DefiError("unsupported_chain", "kai: requires sui namespace");
    }
    const { vault, coinType, shareType } = requireKaiTarget(target);
    // First cut: full exit only (see file header — Kai's own `withdraw_t_amt`
    // could support a real partial withdraw, unexercised here).
    if (amount !== "MAX") {
      throw new DefiError(
        "withdraw_failed",
        "kai: partial withdraw not supported yet",
      );
    }
    try {
      const pkg = await getKaiPackage();
      const client = suiClientFor(chain);
      const tx = new Transaction();
      tx.setSender(wallet.address);

      const shareCoin = await gatherAllCoins(
        tx,
        client,
        wallet.address,
        shareType,
      );
      if (!shareCoin) {
        throw new DefiError("no_onchain_balance", "kai: nothing to withdraw");
      }
      const shareBalance = tx.moveCall({
        target: "0x2::coin::into_balance",
        typeArguments: [shareType],
        arguments: [shareCoin],
      });
      const [ticket] = tx.moveCall({
        target: `${pkg}::vault::withdraw`,
        typeArguments: [coinType, shareType],
        arguments: [
          tx.object(vault),
          shareBalance,
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      });
      const [outBalance] = tx.moveCall({
        target: `${pkg}::vault::redeem_withdraw_ticket`,
        typeArguments: [coinType, shareType],
        arguments: [tx.object(vault), ticket],
      });
      const [outCoin] = tx.moveCall({
        target: "0x2::coin::from_balance",
        typeArguments: [coinType],
        arguments: [outBalance],
      });
      tx.transferObjects([outCoin], tx.pure.address(wallet.address));

      const bytes = await tx.build({ client });
      return { kind: "sui-ptb", transactionBlockBase64: toBase64(bytes) };
    } catch (err) {
      if (err instanceof DefiError) throw err;
      devWarn("buildWithdraw", err);
      throw classifySuiMoveError(err, "withdraw_failed");
    }
  },

  async readPosition(): Promise<DefiPosition | null> {
    // See file header: no live share→underlying read implemented yet. The
    // position still shows its recorded deposit amount via the generic
    // fallback (this adapter just doesn't supply a live update).
    return null;
  },
};
