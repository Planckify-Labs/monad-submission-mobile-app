/**
 * DeFi adapter bootstrap — phased registration.
 *
 * Spec: docs/defi-strategies-spec.md §5.3 / §17 / §24.5#3.
 *
 * Phase 1 (always-on): Aave v3 (Eth/Base/Arb), Lido (Mainnet), Curve
 * 3pool, Morpho Steakhouse USDC (Ethereum).
 *
 * Phase 2 (FEATURE_DEFI_PHASE_2 — default ON): Morpho Flagship USDC
 * Base, Jito SOL, Maple syrupUSDC (EVM mainnet + Base).
 *
 * Phase 3 (FEATURE_DEFI_PHASE_3 — default ON): Yearn v3 USDC,
 * EigenLayer (Eth/Holesky), Ethena sUSDe, GMX v2 Arbitrum.
 *
 * Testnet adapters register when `FEATURE_DEFI_TESTNET_ADAPTERS` is
 * on — used by QA so production user lists stay clean.
 */

import {
  defiEvmFamilyEnabled,
  FEATURE_DEFI_EVM_TIER2,
  FEATURE_DEFI_EVM_TIER3,
  FEATURE_DEFI_EVM_TIER4,
  FEATURE_DEFI_PHASE_2,
  FEATURE_DEFI_PHASE_3,
  FEATURE_DEFI_SUI_ADAPTERS,
  FEATURE_DEFI_TESTNET_ADAPTERS,
} from "@/constants/configs/featureFlags";
import { walletKitRegistry } from "@/services/walletKit/registry";
import {
  AaveV3ArbitrumAdapter,
  AaveV3ArbitrumSepoliaAdapter,
  AaveV3BaseAdapter,
  AaveV3BaseSepoliaAdapter,
  AaveV3EthereumAdapter,
  AaveV3EthereumSepoliaAdapter,
} from "./adapters/aaveV3";
import { AsyncVaultAdapter } from "./adapters/asyncVault";
import { BalancerLpAdapter } from "./adapters/balancerLp";
import { BluefinSpotSuiAdapter } from "./adapters/bluefinSpotSui";
import { CetusSuiAdapter } from "./adapters/cetusSui";
import { CometV3Adapter } from "./adapters/cometV3";
import { CompoundV2Adapter } from "./adapters/compoundV2";
import { CurrentSuiAdapter } from "./adapters/currentSui";
import { Curve3poolAdapter } from "./adapters/curve3pool";
import { CurveLpAdapter } from "./adapters/curveLp";
import {
  EigenLayerEthereumAdapter,
  EigenLayerHoleskyAdapter,
} from "./adapters/eigenlayer";
import { EmberSuiAdapter } from "./adapters/emberSui";
import { Erc4626Adapter } from "./adapters/erc4626";
import { EthenaEthereumAdapter } from "./adapters/ethena";
import { GmxV2ArbitrumAdapter } from "./adapters/gmxV2";
import { KaiSuiAdapter } from "./adapters/kaiSui";
import { LidoHoleskyAdapter, LidoMainnetAdapter } from "./adapters/lido";
import { LstStakeAdapter } from "./adapters/lstStake";
import {
  MapleSyrupUsdcBaseAdapter,
  MapleSyrupUsdcEthereumAdapter,
} from "./adapters/maple";
import {
  MorphoFlagshipUsdcBaseAdapter,
  MorphoSteakhouseUsdcEthAdapter,
  MorphoVaultAdapter,
} from "./adapters/morpho";
import { MorphoBlueAdapter } from "./adapters/morphoBlue";
import { NaviSuiAdapter } from "./adapters/naviSui";
import { RouterCallAdapter } from "./adapters/routerCall";
import { ScallopSuiAdapter } from "./adapters/scallopSui";
import { SolanaJitoAdapter } from "./adapters/solanaJito";
import { SolidlyLpAdapter } from "./adapters/solidlyLp";
import { SuiLstAdapter } from "./adapters/suiLst";
import { SuilendSuiAdapter } from "./adapters/suilendSui";
import { TurbosSuiAdapter } from "./adapters/turbosSui";
import { UniswapV2LpAdapter } from "./adapters/uniswapV2Lp";
import {
  YearnV3EthereumAdapter,
  YearnV3UsdcEthereumAdapter,
} from "./adapters/yearnV3";
import { registerDefiAdapter } from "./registry";
import { bootDefiSafety } from "./safety/bootstrap";

let booted = false;

export function bootDefi(): void {
  if (booted) return;
  // Safety first, literally: the pipeline must be able to answer before any
  // adapter can build a call, or a deposit could run with zero checks
  // registered and look exactly like one that passed them all.
  bootDefiSafety();
  if (walletKitRegistry.getAll().length === 0) {
    // The DeFi registry has no signing capability of its own — every
    // adapter dispatches submission through `WalletKitAdapter`. Boot
    // order matters; fail loud per spec §24.5#3.
    throw new Error(
      "[bootDefi] walletKitRegistry is empty. Must boot wallets first.",
    );
  }

  // ── Phase 1 (always on) ──────────────────────────────────────────
  // Generic ERC-4626 family adapter (pool-level deposits §7) — routed by
  // `DepositTarget.kind`, so ONE registration covers every Morpho/Yearn/
  // Euler vault the backend resolver returns. Bespoke per-deployment adapters
  // below still resolve by slug for the legacy/canonical path.
  registerDefiAdapter(Erc4626Adapter);
  registerDefiAdapter(AaveV3EthereumAdapter);
  registerDefiAdapter(AaveV3BaseAdapter);
  registerDefiAdapter(AaveV3ArbitrumAdapter);
  registerDefiAdapter(LidoMainnetAdapter);
  registerDefiAdapter(Curve3poolAdapter);
  registerDefiAdapter(MorphoSteakhouseUsdcEthAdapter);
  registerDefiAdapter(MorphoVaultAdapter); // legacy slug alias

  // ── Phase 2 ──────────────────────────────────────────────────────
  if (FEATURE_DEFI_PHASE_2) {
    registerDefiAdapter(MorphoFlagshipUsdcBaseAdapter);
    registerDefiAdapter(SolanaJitoAdapter);
    registerDefiAdapter(MapleSyrupUsdcEthereumAdapter);
    registerDefiAdapter(MapleSyrupUsdcBaseAdapter);
  }

  // ── Phase 3 ──────────────────────────────────────────────────────
  if (FEATURE_DEFI_PHASE_3) {
    registerDefiAdapter(YearnV3UsdcEthereumAdapter);
    registerDefiAdapter(YearnV3EthereumAdapter); // legacy slug alias
    registerDefiAdapter(EigenLayerEthereumAdapter);
    registerDefiAdapter(EthenaEthereumAdapter);
    registerDefiAdapter(GmxV2ArbitrumAdapter);
  }

  // ── EVM protocol expansion (docs/defi-evm-protocol-expansion-spec.md) ──
  // Tier 1 registers NOTHING here on purpose: Family A routes to the
  // `Erc4626Adapter` already registered above and Family B to the Aave
  // adapters, so widening those funnels is backend-resolver-only.
  //
  // Every registration below is gated by the SAME flag name the backend uses
  // for its resolver, so a family can never be live on one side only — that
  // would badge "Deposit in-app" for a target nothing can build (§8.6).
  if (FEATURE_DEFI_EVM_TIER2) {
    // Compound III — one adapter, every Comet market on every chain.
    if (defiEvmFamilyEnabled(FEATURE_DEFI_EVM_TIER2, "compound-v3")) {
      registerDefiAdapter(CometV3Adapter);
    }
    // Compound-v2 cToken forks — Venus, Benqi, Sonne and the rest of the
    // lineage behind one `mint`/`redeem` shape.
    if (defiEvmFamilyEnabled(FEATURE_DEFI_EVM_TIER2, "compound-v2")) {
      registerDefiAdapter(CompoundV2Adapter);
    }
    if (defiEvmFamilyEnabled(FEATURE_DEFI_EVM_TIER2, "morpho-blue")) {
      registerDefiAdapter(MorphoBlueAdapter);
    }
    // Generalises the single-market Curve3pool adapter to any Curve pool.
    if (defiEvmFamilyEnabled(FEATURE_DEFI_EVM_TIER2, "curve-lp")) {
      registerDefiAdapter(CurveLpAdapter);
    }
  }

  if (FEATURE_DEFI_EVM_TIER3) {
    // Router-calldata (Pendle). Every quote round-trips through the backend
    // proxy and is re-checked here against the device's pinned allowlist.
    if (defiEvmFamilyEnabled(FEATURE_DEFI_EVM_TIER3, "router-call")) {
      registerDefiAdapter(RouterCallAdapter);
    }
    // Solidly forks (Aerodrome / Velodrome).
    if (defiEvmFamilyEnabled(FEATURE_DEFI_EVM_TIER3, "solidly-lp")) {
      registerDefiAdapter(SolidlyLpAdapter);
    }
    // Uniswap v2 — the family Solidly forked from.
    if (defiEvmFamilyEnabled(FEATURE_DEFI_EVM_TIER3, "uniswap-v2")) {
      registerDefiAdapter(UniswapV2LpAdapter);
    }
    // Liquid staking / restaking. Queue-exit venues ship deposit-only until
    // the Tier-4 request/claim machinery lands (§12 Q2).
    if (defiEvmFamilyEnabled(FEATURE_DEFI_EVM_TIER3, "lst-stake")) {
      registerDefiAdapter(LstStakeAdapter);
    }
    // Balancer v2 / Beets — single-asset joins/exits, priced by the pinned
    // `BalancerQueries` singleton (services/defi/constants/evmAddressBook.ts).
    // v2 ONLY: the adapter refuses to build against a v3 Vault (no
    // `joinPool`/`exitPool`/`BalancerQueries` there at all — see the file
    // header on `adapters/balancerLp.ts`); v3 pools stay Manual until a
    // Router-based join/exit ships as separate work.
    if (defiEvmFamilyEnabled(FEATURE_DEFI_EVM_TIER3, "balancer-lp")) {
      registerDefiAdapter(BalancerLpAdapter);
    }
  }

  // ERC-7540 async vaults (docs/defi-evm-protocol-expansion-spec.md §7). The
  // adapter has carried the two-phase request/claim methods since it was
  // written; what was missing was the durable request tracker
  // (`StrategyPosition.asyncPhase` + `async-claim-watcher.processor.ts`,
  // landed on the backend) and the claim wiring on this side — both now in
  // place. Registering the adapter does not by itself register a resolver:
  // no `async-vault` target exists yet for any protocol, so this flag alone
  // changes nothing until a resolver ships (§7, "no resolver until the
  // two-phase flow is proven end to end").
  if (FEATURE_DEFI_EVM_TIER4) {
    if (defiEvmFamilyEnabled(FEATURE_DEFI_EVM_TIER4, "async-vault")) {
      registerDefiAdapter(AsyncVaultAdapter);
    }
  }

  // ── Sui adapters (Intent Engine) ────────────────────────────────
  // Scallop is mainnet-only; `chainId:"mainnet"` makes it inert on
  // testnet via the registry's network gate (spec §4.6).
  if (FEATURE_DEFI_SUI_ADAPTERS) {
    registerDefiAdapter(ScallopSuiAdapter);
    // Ember (Bluefin) — generic Sui vault family, routed by
    // `DepositTarget.kind === "ember-vault"` (pool-level deposits §7). One
    // adapter covers every Ember vault the backend resolver returns.
    registerDefiAdapter(EmberSuiAdapter);
    // NAVI — Sui money market, routed by `DepositTarget.kind === "navi-pool"`.
    registerDefiAdapter(NaviSuiAdapter);
    // Liquid staking (Haedal / Volo / SpringSui / Aftermath) — ONE adapter for
    // every LST venue, routed by `DepositTarget.kind === "sui-lst"`. Deposits are
    // oracle-free (no Pyth), so they badge "Deposit in-app". The LST opportunity
    // rows are synthesized server-side (they are not in DeFiLlama's Sui pools).
    registerDefiAdapter(SuiLstAdapter);
    // Suilend — money market, routed by `DepositTarget.kind === "suilend-market"`.
    // Deposit-only (see suilendSui.ts header, corrected 2026-08-22): the prior
    // "Pyth-gated" reasoning was wrong — deposit is device-verifiable and its
    // real blocker (a stale moveCall package) is fixed; withdraw stays deferred
    // pending its own verification, not an oracle push.
    registerDefiAdapter(SuilendSuiAdapter);
    // Kai Finance Single Asset Vaults — generic tokenized vault, routed by
    // `DepositTarget.kind === "kai-vault"`. Deposit AND full-exit withdraw
    // both device-verified via sui_devInspectTransactionBlock chained
    // atomically in one PTB against live mainnet 2026-08-22, no oracle either
    // direction (see kaiSui.ts header).
    registerDefiAdapter(KaiSuiAdapter);
    // Current Finance — isolated-market money market, routed by
    // `DepositTarget.kind === "current-market"`. DEPOSIT-ONLY: creating the
    // obligation + depositing chain atomically in one PTB, device-verified
    // via sui_devInspectTransactionBlock against live mainnet 2026-08-22, no
    // oracle. Withdraw needs a genuine live Pyth push this codebase hasn't
    // built for any protocol yet — see currentSui.ts header.
    registerDefiAdapter(CurrentSuiAdapter);
    // Cetus CLMM — concentrated liquidity, full-range only, routed by
    // `DepositTarget.kind === "cetus-clmm-pool"`. DEPOSIT-ONLY: an internal
    // swap-split zap (own-pool swap, never external) + open_position +
    // add_liquidity_fix_coin, device-verified via
    // sui_devInspectTransactionBlock against live mainnet 2026-08-22. No
    // oracle. Withdraw not wired (see cetusSui.ts header).
    registerDefiAdapter(CetusSuiAdapter);
    // Turbos Finance CLMM — concentrated liquidity, full-range only, routed
    // by `DepositTarget.kind === "turbos-clmm-pool"`. DEPOSIT-ONLY: an
    // internal swap-split zap + `position_manager::mint` (explicit
    // amountA/amountB read back in-PTB, no hot-potato receipt like Cetus),
    // device-verified via sui_devInspectTransactionBlock against live
    // mainnet 2026-08-22, both input directions. No oracle. Withdraw not
    // wired (see turbosSui.ts header).
    registerDefiAdapter(TurbosSuiAdapter);
    // Bluefin Spot CLMM — concentrated liquidity, full-range only, routed
    // by `DepositTarget.kind === "bluefin-spot-pool"`. DEPOSIT-ONLY: an
    // internal swap-split zap + `gateway::provide_liquidity_with_fixed_
    // amount` (explicit amount/amountAMax/amountBMax read back in-PTB, no
    // hot-potato receipt), device-verified via
    // sui_devInspectTransactionBlock against live mainnet 2026-08-22. No
    // oracle. Withdraw not wired (see bluefinSpotSui.ts header).
    registerDefiAdapter(BluefinSpotSuiAdapter);
  }

  // ── Testnet adapters (QA-only) ──────────────────────────────────
  if (FEATURE_DEFI_TESTNET_ADAPTERS) {
    registerDefiAdapter(AaveV3EthereumSepoliaAdapter);
    registerDefiAdapter(AaveV3BaseSepoliaAdapter);
    registerDefiAdapter(AaveV3ArbitrumSepoliaAdapter);
    registerDefiAdapter(LidoHoleskyAdapter);
    if (FEATURE_DEFI_PHASE_3) {
      registerDefiAdapter(EigenLayerHoleskyAdapter);
    }
  }

  booted = true;
}
