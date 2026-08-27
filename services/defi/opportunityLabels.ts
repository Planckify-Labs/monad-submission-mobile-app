/**
 * Display labels shared by the two DeFi opportunity surfaces — the browse
 * list and the Quick Invest card (docs/defi-quick-invest-spec.md §4).
 *
 * Kept out of `opportunityDisplay.ts` deliberately: that module is pure and
 * framework-free so its unit test stays cheap, while `chainLabel` reaches
 * the walletKit registry for the chain-family fallback.
 *
 * Both cards must name the same venue and the same chain the same way — the
 * approval sheet quotes back whatever the user was shown when they picked.
 */

import { getChainFamilyLabel } from "@/services/walletKit/chainInfo";

export const TIER_LABEL: Record<string, string> = {
  conservative: "Low risk",
  balanced: "Moderate risk",
  aggressive: "High risk",
};

/**
 * Prefer the backend's DeFiLlama-provided label (covers testnets like
 * "Ethereum Sepolia" and any chain we haven't hardcoded). Fall back to a
 * best-effort lookup by chainId for legacy payloads that omit the name.
 */
export function chainLabel(
  chainName?: string,
  chainId?: number,
  namespace?: string,
): string | null {
  if (chainName && chainName.trim()) return chainName;
  // Non-EVM payloads (Solana / Sui) carry a namespace but no numeric
  // chainId — ask the registry for the chain-family label instead of
  // branching on the namespace string here.
  if (chainId === undefined && namespace) {
    const label = getChainFamilyLabel(namespace);
    if (label !== "Wallet") return label;
  }
  switch (chainId) {
    case 1:
      return "Ethereum";
    case 8453:
      return "Base";
    case 42161:
      return "Arbitrum";
    case 10:
      return "Optimism";
    case 137:
      return "Polygon";
    case 56:
      return "BNB Chain";
    default:
      return chainId ? `Chain ${chainId}` : null;
  }
}
