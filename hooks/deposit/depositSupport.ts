/**
 * "Can the user add points on the active network?" — resolved as a
 * three-value verdict instead of a boolean.
 *
 * Why three values: the old deposit screen inferred "unsupported" from
 * `!hasContract && !isContractFetching`, which is ALSO the state during
 * every transition window — the moment a chain switch swaps the query key,
 * the frame before a disabled query is enabled, and after a failed request.
 * So the "Network Not Supported" sheet fired on chains that were merely
 * still resolving, and did so inconsistently (whichever of those windows the
 * render happened to land in). `unknown` gives those windows a name so the
 * UI can wait them out instead of accusing the chain.
 *
 * Pure by design so the precedence rules are unit-testable without a React
 * tree — see `depositSupport.test.ts`.
 */

export type DepositSupport = "supported" | "unsupported" | "unknown";

export interface DepositSupportInput {
  /**
   * The chain family has a point-deposit execution path at all
   * (`chainInfo#supportsPointDeposit`). `false` for Solana / Sui.
   */
  chainSupportsDeposit: boolean;
  /**
   * The `/blockchains` list has NOT settled: loading, refetching a stale
   * MMKV cache, or failed. A list that predates a newly added chain must
   * not sentence that chain before the refresh lands.
   */
  isChainListUnresolved: boolean;
  /** The `/blockchains` row for the active chain was found in that list. */
  hasBackendChain: boolean;
  /**
   * The deposit-contract lookup has NOT settled: pending, disabled-and-
   * waiting on an input, refetching a stale cache, or errored.
   */
  isContractUnresolved: boolean;
  /** A deposit contract address resolved for the active chain. */
  hasContract: boolean;
  /** The token catalogue lookup has NOT settled (same three windows). */
  isTokenListUnresolved: boolean;
  /**
   * At least one token on this chain is actually depositable. Availability
   * is data-driven per chain, so a deployed contract alone doesn't mean the
   * user can add points — a chain whose catalogue has no eligible stablecoin
   * dead-ends at an empty token picker, which is what this catches.
   */
  hasEligibleToken: boolean;
  /**
   * Auth state has settled to signed-in. A signed-out user is shown the
   * inline "Sign In to Add Points" CTA first, so we don't also interrupt
   * them with a network sheet for a verdict they can't act on yet.
   */
  isSignedIn: boolean;
}

export function resolveDepositSupport(
  input: DepositSupportInput,
): DepositSupport {
  // Structural: no execution path for this family, nothing to wait for.
  if (!input.chainSupportsDeposit) return "unsupported";

  if (!input.hasBackendChain) {
    return input.isChainListUnresolved ? "unknown" : "unsupported";
  }

  // Both halves are required: a deployed deposit contract AND a token the
  // deposit can actually be denominated in. Answering yes wins over any
  // in-flight refetch, so background revalidation of a known-good chain
  // never blanks the verdict.
  if (input.hasContract && input.hasEligibleToken) return "supported";

  // One half is missing — but only call it missing once its lookup settled.
  if (!input.hasContract && input.isContractUnresolved) return "unknown";
  if (!input.hasEligibleToken && input.isTokenListUnresolved) return "unknown";

  // Settled and genuinely unavailable on this chain. Signed-out users get
  // the inline sign-in CTA first rather than a sheet they can't act on.
  return input.isSignedIn ? "unsupported" : "unknown";
}
