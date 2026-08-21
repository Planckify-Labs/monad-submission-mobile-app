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
import { BalancerLpAdapter } from "./adapters/balancerLp";
import { CometV3Adapter } from "./adapters/cometV3";
import { CompoundV2Adapter } from "./adapters/compoundV2";
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
// SuilendSuiAdapter is implemented but NOT registered — Suilend's deposit AND
// withdraw both assert a fresh reserve price (abort code 1), needing a Pyth
// pull-oracle push in-tx (deferred). Registering it would badge Suilend
// "in-app" then intermittently fail. Wire the Pyth push, then register it.
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
    // Suilend NOT registered — deposit + withdraw are Pyth-gated (see import
    // note). Adapter is ready; wire the Pyth push then register here.
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
