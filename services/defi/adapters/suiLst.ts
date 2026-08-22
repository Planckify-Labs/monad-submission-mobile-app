/**
 * Sui liquid-staking adapter — a `DefiProtocolAdapter` for pool-level Sui LST
 * deposits (docs/defi-pool-level-deposits-spec.md §7, Phase 3). ONE adapter
 * covers Haedal / Volo / SpringSui / Aftermath, dispatched by
 * `DepositTarget.kind === "sui-lst"` and routed to the right venue by
 * `target.venue` (never a namespace branch — space-docking §7).
 *
 * NO SDK. PTBs are built directly with `@mysten/sui`, calling each venue's
 * public stake entry point (all verified on-chain 2026-07-04; see
 * `adapters/sui/lst.config.ts` for the exact ids + move-call shapes):
 *
 *   Haedal    → staking::request_stake_coin(SuiSystemState, Staking, Coin<SUI>,
 *                 validator) -> Coin<HASUI>
 *   Volo      → native_pool::stake(NativePool, Metadata, SuiSystemState,
 *                 Coin<SUI>)                         [entry; mints vSUI to sender]
 *   SpringSui → liquid_staking::mint<sSUI>(LiquidStakingInfo, SuiSystemState,
 *                 Coin<SUI>) -> Coin<sSUI>
 *   Aftermath → staked_sui_vault::request_stake(Vault, Safe, SuiSystemState,
 *                 ReferralVault, Coin<SUI>, validator) -> Coin<afSUI>
 *
 * The input asset is always native SUI; the receipt is the venue's LST coin,
 * which appreciates against SUI via staking rewards. Every deposit leg is
 * ORACLE-FREE (no Pyth `PriceInfoObject`) — that is what lets these badge
 * "Deposit in-app". All four are in-app. (Suilend's own deposit is oracle-free
 * too as of 2026-08-22 — its earlier "Pyth-gated" status was a stale-package
 * false alarm, see `suilendSui.ts` — so it's no longer the contrast case
 * here; Current Finance's withdraw is the current real example of a
 * genuine Pyth dependency in this codebase, see `currentSui.ts`.)
 * Haedal + Volo additionally hard version-gate their shared objects, so their
 * preview dry-run aborts `assert_version` even though real execution succeeds
 * (verified); the adapter forces an explicit gas budget (so `tx.build` doesn't
 * throw) and exposes `isDryRunUnreliable`, which VERIFIES the on-chain version
 * precondition (the exact thing `assert_version` checks) before the executor
 * exempts that specific abort from its dry-run block — a reliable on-chain check,
 * not an "ignore the revert".
 *
 * WITHDRAW is in-app (FULL EXIT — redeems the whole LST balance), also oracle-
 * free, dispatched by `cfg.withdrawShape`:
 *   SpringSui → liquid_staking::redeem<P>(LSI, Coin<sSUI>, SuiSystemState)
 *                 -> Coin<SUI>                              [instant; SUI transferred to sender]
 *   Volo      → native_pool::unstake(Pool, Metadata, SuiSystemState, Coin<vSUI>)
 *                                                            [instant; SUI to sender]
 *   Haedal    → staking::request_unstake_instant(Staking, Coin<haSUI>)
 *                                                            [instant; SUI to sender]
 *   Aftermath → staked_sui_vault::request_unstake(Vault, Safe, Coin<afSUI>)
 *                                                            [DELAYED; SUI arrives after the epoch]
 * The intent preview dry-runs the exit, so an instant-buffer shortfall surfaces
 * in the preview instead of failing silently. MAINNET-ONLY (`chainId:"mainnet"`).
 */

import { toBase64 } from "@mysten/bcs";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  Transaction,
  type TransactionObjectArgument,
} from "@mysten/sui/transactions";
import { SUI_SYSTEM_STATE_OBJECT_ID } from "@mysten/sui/utils";
import {
  getSuiMainnetChain,
  type SuiChainConfig,
} from "@/constants/configs/chainConfig";
import { SuiSwapError } from "@/services/swap/sui/types";
import { classifySuiMoveError, DefiError } from "../errors/defiErrors";
import type {
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  DepositTarget,
  PositionReadContext,
  UnsignedCall,
  ZapSupplyArgs,
  ZapSupplyResult,
} from "../types";
import { gatherAllCoins, prepareInputCoin } from "./sui/coins";
import {
  getLstConfig,
  isSuiLstVenue,
  SUI_LST_SLUGS,
  type SuiLstConfig,
} from "./sui/lst.config";
import { lstToSui, suiToLst } from "./sui/lstRate";

const SLUG = "sui-lst";
const NETWORK = "mainnet" as const;
const SUI_TYPE = "0x2::sui::SUI";

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[suiLst] ${scope}:`, err);
  }
}

function suiClientFor(chain: SuiChainConfig): SuiJsonRpcClient {
  return new SuiJsonRpcClient({ url: chain.rpcUrl, network: chain.network });
}

/**
 * 0.06 SUI — a generous explicit budget for the version-gated venues. Their
 * `assert_version` gate makes `tx.build`'s automatic gas-estimation dry-run ABORT
 * (throwing during build), so we set the budget ourselves to skip that estimation
 * (a stake/unstake costs well under this; the unused portion is refunded, and the
 * approval sheet shows the real gas).
 */
const SIM_UNRELIABLE_GAS_BUDGET = 60_000_000n;

/** Build the PTB → base64, setting an explicit gas budget for version-gated venues. */
async function buildLstPtb(
  tx: Transaction,
  client: SuiJsonRpcClient,
  cfg: SuiLstConfig,
): Promise<string> {
  if (cfg.simulationUnreliable) tx.setGasBudget(SIM_UNRELIABLE_GAS_BUDGET);
  const bytes = await tx.build({ client });
  return toBase64(bytes);
}

/**
 * The `sui-lst` target is mandatory: it names the venue whose pinned objects +
 * stake shape drive the PTB. Without it there is no venue to stake into. Fail
 * closed with a curated message.
 */
function requireLstConfig(target: DepositTarget | undefined): SuiLstConfig {
  if (target?.kind !== "sui-lst" || !isSuiLstVenue(target.venue)) {
    throw new DefiError(
      "deposit_failed",
      "liquid staking: a resolved venue target is required",
    );
  }
  return getLstConfig(target.venue);
}

/**
 * Append the venue's stake move-call, consuming `suiCoin` (a `Coin<SUI>`). For
 * shapes that RETURN the receipt coin, transfer it to the owner; Volo's entry
 * `stake` mints straight to the sender, so there is nothing to transfer.
 */
function appendStakeCall(
  tx: Transaction,
  cfg: SuiLstConfig,
  suiCoin: TransactionObjectArgument,
  owner: string,
): void {
  const target = `${cfg.packageId}::${cfg.stakeFn}`;
  const systemState = tx.object(SUI_SYSTEM_STATE_OBJECT_ID);

  switch (cfg.stakeShape) {
    case "returns-coin-validator": {
      // Haedal: request_stake_coin(SuiSystemState, Staking, Coin<SUI>, validator)
      const [lst] = tx.moveCall({
        target,
        arguments: [
          systemState,
          tx.object(cfg.poolObject),
          suiCoin,
          tx.pure.address(cfg.validator ?? owner),
        ],
      });
      tx.transferObjects([lst], tx.pure.address(owner));
      return;
    }
    case "entry-pool-metadata": {
      // Volo: native_pool::stake(NativePool, Metadata, SuiSystemState, Coin<SUI>)
      // — entry, mints vSUI to the sender; no return value to transfer.
      if (!cfg.metadataObject) {
        throw new DefiError("deposit_failed", `${cfg.displayName}: config`);
      }
      tx.moveCall({
        target,
        arguments: [
          tx.object(cfg.poolObject),
          tx.object(cfg.metadataObject),
          systemState,
          suiCoin,
        ],
      });
      return;
    }
    case "mint-generic": {
      // SpringSui: liquid_staking::mint<LST>(LiquidStakingInfo, SuiSystemState,
      // Coin<SUI>) -> Coin<LST>.
      const [lst] = tx.moveCall({
        target,
        typeArguments: [cfg.lstType],
        arguments: [tx.object(cfg.poolObject), systemState, suiCoin],
      });
      tx.transferObjects([lst], tx.pure.address(owner));
      return;
    }
    case "aftermath-vault": {
      // Aftermath: request_stake(Vault, Safe, SuiSystemState, ReferralVault,
      // Coin<SUI>, validator) -> Coin<afSUI>.
      if (!cfg.safeObject || !cfg.referralVault) {
        throw new DefiError("deposit_failed", `${cfg.displayName}: config`);
      }
      const [lst] = tx.moveCall({
        target,
        arguments: [
          tx.object(cfg.poolObject),
          tx.object(cfg.safeObject),
          systemState,
          tx.object(cfg.referralVault),
          suiCoin,
          tx.pure.address(cfg.validator ?? owner),
        ],
      });
      tx.transferObjects([lst], tx.pure.address(owner));
      return;
    }
    default: {
      const _exhaustive: never = cfg.stakeShape;
      throw new DefiError(
        "deposit_failed",
        `unknown stake shape ${_exhaustive}`,
      );
    }
  }
}

/**
 * Append the venue's unstake/redeem move-call, consuming `lstCoin` (the full
 * `Coin<LST>` balance). "redeem-generic" returns the `Coin<SUI>` (transfer it to
 * the owner); the others deliver SUI to the sender internally. `TxContext` is
 * implicit in PTB move-calls, so it is never in `arguments`.
 */
function appendUnstakeCall(
  tx: Transaction,
  cfg: SuiLstConfig,
  lstCoin: TransactionObjectArgument,
  owner: string,
): void {
  const target = `${cfg.packageId}::${cfg.unstakeFn}`;
  const systemState = tx.object(SUI_SYSTEM_STATE_OBJECT_ID);

  switch (cfg.withdrawShape) {
    case "redeem-generic": {
      // SpringSui: redeem<LST>(LiquidStakingInfo, Coin<LST>, SuiSystemState) -> Coin<SUI>.
      const [sui] = tx.moveCall({
        target,
        typeArguments: [cfg.lstType],
        arguments: [tx.object(cfg.poolObject), lstCoin, systemState],
      });
      tx.transferObjects([sui], tx.pure.address(owner));
      return;
    }
    case "volo-unstake": {
      // Volo: native_pool::unstake(NativePool, Metadata, SuiSystemState, Coin<CERT>)
      // — entry, SUI to sender.
      if (!cfg.metadataObject) {
        throw new DefiError("withdraw_failed", `${cfg.displayName}: config`);
      }
      tx.moveCall({
        target,
        arguments: [
          tx.object(cfg.poolObject),
          tx.object(cfg.metadataObject),
          systemState,
          lstCoin,
        ],
      });
      return;
    }
    case "haedal-instant": {
      // Haedal: staking::request_unstake_instant(Staking, Coin<HASUI>) — SUI to sender.
      tx.moveCall({
        target,
        arguments: [tx.object(cfg.poolObject), lstCoin],
      });
      return;
    }
    case "aftermath-unstake": {
      // Aftermath: staked_sui_vault::request_unstake(Vault, Safe, Coin<AFSUI>) —
      // delayed; SUI arrives after the epoch.
      if (!cfg.safeObject) {
        throw new DefiError("withdraw_failed", `${cfg.displayName}: config`);
      }
      tx.moveCall({
        target,
        arguments: [
          tx.object(cfg.poolObject),
          tx.object(cfg.safeObject),
          lstCoin,
        ],
      });
      return;
    }
    default: {
      const _exhaustive: never = cfg.withdrawShape;
      throw new DefiError(
        "withdraw_failed",
        `unknown withdraw shape ${_exhaustive}`,
      );
    }
  }
}

/**
 * Atomic swap→stake zap (Sui Intent Engine §4.7) — MAINNET-ONLY. ONE PTB: the
 * injected swap leg produces `Coin<SUI>`, which the venue's stake call consumes
 * whole (LST stakes take the coin by value — no `coin::value` read needed, unlike
 * NAVI); leftovers transfer back. The `sui-lst` target (venue) is REQUIRED.
 */
export async function buildLstZapSupply(
  args: ZapSupplyArgs,
): Promise<ZapSupplyResult> {
  if (args.chain.namespace !== "sui") {
    throw new DefiError(
      "unsupported_chain",
      "liquid staking: requires sui namespace",
    );
  }
  const cfg = requireLstConfig(args.target);
  try {
    const tx = new Transaction();
    tx.setSender(args.wallet.address);

    const swap = await args.appendSwap(tx);
    if (!swap) {
      throw new DefiError("deposit_failed", "zap: swap leg unavailable");
    }
    // The swap output is `Coin<SUI>`; stake it whole → LST receipt to the sender.
    appendStakeCall(tx, cfg, swap.outputCoin, args.wallet.address);
    if (swap.leftoverCoins.length > 0) {
      tx.transferObjects(
        swap.leftoverCoins,
        tx.pure.address(args.wallet.address),
      );
    }

    const ptbBase64 = await buildLstPtb(tx, suiClientFor(args.chain), cfg);
    return {
      ptbBase64,
      expectedOut: swap.expectedOut,
      priceImpact: swap.priceImpact,
      toCoinType: swap.toCoinType,
      poolObjectId: swap.poolObjectId,
    };
  } catch (err) {
    if (err instanceof DefiError) throw err;
    if (err instanceof SuiSwapError) throw err; // preserve actionable swap reason
    devWarn("buildLstZapSupply", err);
    throw classifySuiMoveError(err, "deposit_failed");
  }
}

export const SuiLstAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "sui",
  kind: "liquid_staking",
  chainId: NETWORK, // string id → free network gate via listDefiAdaptersForChain
  displayName: "Sui Liquid Staking",
  staticSafetyScore: 80,
  externalSlugs: SUI_LST_SLUGS,
  targetKinds: ["sui-lst"],
  // Atomic swap→stake zap (§4.7) — presence-checked by the compiler.
  buildZapSupply: buildLstZapSupply,
  // Haedal + Volo version-gate: their dry-run aborts `assert_version` though real
  // execution works. Rather than blindly trust the flag, VERIFY the exact
  // precondition the on-chain `assert_version` checks — read the pool's live
  // `version` field and confirm it matches the pinned `expectedPoolVersion`. That
  // holds iff real execution's gate would pass, so the executor's exemption rides
  // on a reliable on-chain read, not an "ignore the revert". Fail-safe: any doubt
  // (unknown venue, unread version, mismatch) → false → the dry-run block stands.
  async isDryRunUnreliable(target?: DepositTarget): Promise<boolean> {
    if (target?.kind !== "sui-lst" || !isSuiLstVenue(target.venue))
      return false;
    const cfg = getLstConfig(target.venue);
    if (!cfg.simulationUnreliable || cfg.expectedPoolVersion === undefined) {
      return false;
    }
    try {
      const client = suiClientFor(getSuiMainnetChain());
      const obj = await client.getObject({
        id: cfg.poolObject,
        options: { showContent: true },
      });
      const fields = (
        obj.data?.content as { fields?: Record<string, unknown> } | undefined
      )?.fields;
      const version = Number(fields?.version);
      return Number.isFinite(version) && version === cfg.expectedPoolVersion;
    } catch (err) {
      devWarn("isDryRunUnreliable", err);
      return false;
    }
  },

  async buildDeposit({
    wallet,
    chain,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "sui") {
      throw new DefiError(
        "unsupported_chain",
        "liquid staking: requires sui namespace",
      );
    }
    const cfg = requireLstConfig(target);
    try {
      const client = suiClientFor(chain);
      const tx = new Transaction();
      tx.setSender(wallet.address);

      // The staked asset is always native SUI; `amount` is raw SUI (9 dp).
      const suiCoin = await prepareInputCoin(
        tx,
        client,
        wallet.address,
        SUI_TYPE,
        amount,
      );
      appendStakeCall(tx, cfg, suiCoin, wallet.address);

      return {
        kind: "sui-ptb",
        transactionBlockBase64: await buildLstPtb(tx, client, cfg),
      };
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
      throw new DefiError(
        "unsupported_chain",
        "liquid staking: requires sui namespace",
      );
    }
    const cfg = requireLstConfig(target);
    try {
      const client = suiClientFor(chain);
      const owner = wallet.address;
      const bal = await client.getBalance({ owner, coinType: cfg.lstType });
      const totalLst = BigInt(bal.totalBalance);
      if (totalLst <= 0n) {
        throw new DefiError(
          "no_onchain_balance",
          `${cfg.displayName}: no ${cfg.lstSymbol} to withdraw`,
        );
      }

      const tx = new Transaction();
      tx.setSender(owner);

      // Gather the whole LST balance into one coin. "MAX" (or a requested amount
      // ≥ the position) redeems all of it; a smaller SUI amount is converted to
      // the LST to redeem (via the exchange rate) and split off — the remainder
      // stays in the wallet.
      const gathered = await gatherAllCoins(tx, client, owner, cfg.lstType);
      if (!gathered) {
        throw new DefiError(
          "no_onchain_balance",
          `${cfg.displayName}: no ${cfg.lstSymbol} to withdraw`,
        );
      }

      let lstCoin = gathered;
      if (amount !== "MAX") {
        const lstNeeded = await suiToLst(cfg, client, owner, amount);
        if (lstNeeded <= 0n) {
          throw new DefiError(
            "below_min_deposit",
            `${cfg.displayName}: withdrawal amount too small`,
          );
        }
        if (lstNeeded < totalLst) {
          const [part] = tx.splitCoins(gathered, [tx.pure.u64(lstNeeded)]);
          lstCoin = part;
        }
        // lstNeeded ≥ balance → full exit (redeem the whole gathered coin).
      }

      appendUnstakeCall(tx, cfg, lstCoin, owner);

      return {
        kind: "sui-ptb",
        transactionBlockBase64: await buildLstPtb(tx, client, cfg),
      };
    } catch (err) {
      if (err instanceof DefiError) throw err;
      devWarn("buildWithdraw", err);
      throw classifySuiMoveError(err, "withdraw_failed");
    }
  },

  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    // The position is the venue's receipt coin (haSUI/vSUI/sSUI/afSUI) the wallet
    // holds; report it in SUI-equivalent (what the user supplied) via the live
    // exchange rate. Needs the resolved `sui-lst` target (threaded from the row's
    // pool_id by services/defi/positions/reader.ts) to know which venue to read.
    // Any read failure → null → falls back to the DB snapshot (never drops the
    // row); a 0 receipt balance likewise falls back rather than showing 0.
    if (ctx?.target?.kind !== "sui-lst" || !isSuiLstVenue(ctx.target.venue)) {
      return null;
    }
    const cfg = getLstConfig(ctx.target.venue);
    try {
      const client = suiClientFor(getSuiMainnetChain());
      const bal = await client.getBalance({
        owner: walletAddress,
        coinType: cfg.lstType,
      });
      const lstRaw = BigInt(bal.totalBalance);
      if (lstRaw <= 0n) return null;

      // SUI-equivalent (incl. accrued staking rewards). Only `currentAmount` is
      // consumed downstream (the reader overrides current_amount_raw); USD/pnl
      // are the row's job, so left at 0. If the rate read hiccups, fall back to
      // the raw receipt count (≈1:1, conservative) rather than dropping the row.
      let currentAmount = lstRaw;
      try {
        currentAmount = await lstToSui(cfg, client, walletAddress, lstRaw);
      } catch (rateErr) {
        devWarn("readPosition:rate", rateErr);
      }

      return {
        protocolSlug: SLUG,
        namespace: "sui",
        chainId: NETWORK,
        assetSymbol: ctx.assetSymbol ?? "SUI",
        amountAtDeposit: 0n,
        amountAtDepositUsd: 0,
        currentAmount,
        currentAmountUsd: 0,
        pnlUsd: 0,
      };
    } catch (err) {
      devWarn("readPosition", err);
      return null;
    }
  },
};
