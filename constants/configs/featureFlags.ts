/**
 * Feature flags consumed by the DeFi Strategies feature.
 *
 * Spec: docs/defi-strategies-spec.md §22.2 / §17 phasing.
 *
 * Defaults are conservative:
 *   - DEFI_STRATEGIES: gates the entire `/strategies` surface + agent
 *     tool registrations.
 *   - DEFI_PHASE_2: gates the Phase 2 adapter set (Morpho-Base, Jito,
 *     Maple syrupUSDC EVM, LI.FI-driven cross-chain).
 *   - DEFI_PHASE_3: gates the Phase 3 adapter set (Yearn, EigenLayer,
 *     Ethena, GMX). Tier-cap and cooldown UI ride alongside.
 *   - DEFI_TESTNET_ADAPTERS: registers Aave Sepolia / Lido Holesky /
 *     EigenLayer Holesky adapters so QA flows can run against
 *     testnet without polluting production user lists.
 *   - DEFI_CROSS_CHAIN_REBALANCE: Phase-2 cross-chain rebalance UI
 *     (LI.FI-powered). Spec §22.2.
 */

function flag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === "true") return true;
  if (raw === "false") return false;
  return defaultValue;
}

export const FEATURE_DEFI_STRATEGIES = flag(
  "EXPO_PUBLIC_DEFI_STRATEGIES",
  true,
);
export const FEATURE_DEFI_PHASE_2 = flag("EXPO_PUBLIC_FF_DEFI_PHASE_2", true);
export const FEATURE_DEFI_PHASE_3 = flag("EXPO_PUBLIC_FF_DEFI_PHASE_3", true);
export const FEATURE_DEFI_TESTNET_ADAPTERS = flag(
  "EXPO_PUBLIC_FF_DEFI_TESTNET_ADAPTERS",
  false,
);
export const FEATURE_DEFI_CROSS_CHAIN_REBALANCE = flag(
  "EXPO_PUBLIC_FF_CROSS_CHAIN_REBALANCE",
  false,
);

/**
 * Sui DeFi adapters (Scallop) for the Intent Engine (Sui Overflow 2026
 * Phase 1). Default ON: the adapter is `chainId:"mainnet"`, so on testnet
 * `listDefiAdaptersForChain("sui","testnet")` resolves it nowhere and it
 * is inert until the user is on Sui mainnet (spec §4.6). Flag exists so ops
 * can disable the mainnet supply/withdraw surface without a code change.
 */
export const FEATURE_DEFI_SUI_ADAPTERS = flag(
  "EXPO_PUBLIC_FF_DEFI_SUI_ADAPTERS",
  true,
);

/**
 * EVM protocol expansion (docs/defi-evm-protocol-expansion-spec.md §8.6).
 *
 * Each tier gates the mobile `registerDefiAdapter` calls for its families; the
 * backend gates the twin `registerResolver` calls behind the same-named env
 * vars. Both sides must be on, or a half-wired family would badge "Deposit
 * in-app" for a target nothing can execute.
 *
 * **Default OFF, and that is a review gate rather than unfinished work.**
 * Nothing is stubbed out: every resolver, adapter and safety check is present
 * and testable, so turning a tier on for a test build is purely a config
 * change. Tiers 1-3 are fork-tested; what is still missing is security sign-off
 * on the pinned address book (§12 Q7), which no test can substitute for.
 *
 * ⚠️ **Read `docs/runbooks/add-defi-pool-resolver.md` §12 before flipping one.**
 * Two things bite people here:
 *   - the BACKEND flag of the same name must be on too, or the app badges
 *     "Deposit in-app" for a target it cannot build (§8.6),
 *   - `EXPO_PUBLIC_*` is inlined at bundle time and read here at module scope,
 *     so a new value needs a FULL RELOAD (shake → Reload). Fast Refresh re-runs
 *     neither this module nor `bootDefi()`, and will happily keep testing the
 *     old flags. No dev-server restart, no cache clear, no native rebuild —
 *     this is a JavaScript-only change.
 *
 * Tier 1 registers NO adapter — its families reuse the shipped `Erc4626Adapter`
 * and `AaveV3` adapters, so it is backend-resolver-only by construction. The
 * flag exists here so the two sides read symmetrically.
 */
export const FEATURE_DEFI_EVM_TIER1 = flag(
  "EXPO_PUBLIC_FF_DEFI_EVM_TIER1",
  false,
);
export const FEATURE_DEFI_EVM_TIER2 = flag(
  "EXPO_PUBLIC_FF_DEFI_EVM_TIER2",
  false,
);
export const FEATURE_DEFI_EVM_TIER3 = flag(
  "EXPO_PUBLIC_FF_DEFI_EVM_TIER3",
  false,
);
/**
 * Tier 4 — ERC-7540 async vaults. Stays off until the two-phase request/claim
 * interface ships end to end (§7): an async pool badged "in-app" before then
 * takes a deposit that requests and then appears stuck.
 */
export const FEATURE_DEFI_EVM_TIER4 = flag(
  "EXPO_PUBLIC_FF_DEFI_EVM_TIER4",
  false,
);

/**
 * Per-family sub-flag under a tier, so one risky family can be dark-launched or
 * killed without taking the tier down (§8.6, and the hook the §11 Layer-3
 * kill-switch reads). Default ON within an enabled tier.
 */
export function defiEvmFamilyEnabled(
  tierEnabled: boolean,
  family: string,
): boolean {
  if (!tierEnabled) return false;
  const envName = `EXPO_PUBLIC_FF_DEFI_EVM_FAMILY_${family
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")}`;
  return flag(envName, true);
}

/**
 * Allows the EVM onchain-settlement rail (`processMerchantPayment` on the
 * TakumiPay contract) to run on NON-testnet chains.
 *
 * Default OFF, so the rail is testnet-only. The first deployment it targets
 * is Arc Testnet, where two things are still true — both release blockers
 * rather than code problems:
 *   - `backendSigner` derives from a private key committed in the API's
 *     `.env.example`, so anyone can forge a quote the contract accepts.
 *   - the contract owner is still the deploying EOA, not the intended owner.
 *
 * Flip this only once the signer key has been rotated via
 * `rotateBackendSigner()` and ownership has been transferred and accepted.
 */
export const FEATURE_EVM_ONCHAIN_SETTLEMENT_MAINNET = flag(
  "EXPO_PUBLIC_FF_EVM_ONCHAIN_SETTLEMENT_MAINNET",
  false,
);
