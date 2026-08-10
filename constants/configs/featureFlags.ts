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
