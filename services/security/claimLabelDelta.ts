// TWV-2026-038 — Claim-label vs simulated-delta mismatch detector.
//
// Penpie ($27M, Sep 2024) and several drainer waves abuse the user's
// reflex of treating "claim rewards" as a one-tap, low-risk action.
// The defence: when the dApp / decoded calldata claims this is a
// `claim` / `harvest` / `collect` / `redeem`, but the simulated net
// asset delta is non-positive, raise a red banner and require a
// secondary tap.
//
// Pure logic — wired into the signer UI on top of `txSimulator.ts`'s
// asset-delta output.

import type { AssetDelta } from "./txSimulator.ts";

// Matches the verb at a word boundary on the left and either a word
// boundary or a camelCase capital letter on the right — so `claim`,
// `claim rewards`, and `claimRewards` all hit, while `proclaim` does not.
export const CLAIM_LABEL_RE = /\b(claim|harvest|collect|redeem)(\b|[A-Z])/i;

// Task 65 (TWV-2026-066) Phase F — the claim-shaped intent class with a
// well-defined delta invariant ("should be net-positive inflow").
// Matched against the LEADING VERB of a resolved Stage-2
// `ClearSigningDescriptor.intent` — structured, not regexed off free
// text, so it's harder to evade than string matching. Deliberately not
// extended to intent classes whose "correct" delta shape isn't obvious
// (arbitrary multicalls): a wrong invariant produces false-positive
// fatigue, which is worse than the narrower heuristic.
const CLAIM_INTENT_VERBS: ReadonlySet<string> = new Set([
  "claim",
  "harvest",
  "collect",
  "redeem",
]);

/** True iff a resolved Stage-2 intent's leading verb is claim-shaped. */
export function intentLooksLikeClaim(
  resolvedIntent: string | undefined,
): boolean {
  if (!resolvedIntent) return false;
  const leading = resolvedIntent.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return CLAIM_INTENT_VERBS.has(leading);
}

export interface ClaimMismatchInput {
  /** dApp-supplied tx title / description, if present. */
  dappLabel?: string;
  /** Top-level decoded function name, if available. */
  functionName?: string;
  /**
   * Resolved Stage-2 `ClearSigningDescriptor.intent` (task 65 Phase B),
   * when descriptor resolution succeeded. The most reliable label
   * source: it comes from a pinned registry / on-chain spec, not from
   * dApp-supplied free text. The regex paths below stay as fallback
   * for calls Phase B doesn't resolve.
   */
  resolvedIntent?: string;
  /** Output of `predictAssetDeltasFromCalldata` / full simulator. */
  deltas: AssetDelta[];
}

export interface ClaimMismatchVerdict {
  triggered: boolean;
  /** Why — for the UI banner copy. */
  reason?: string;
}

/**
 * True iff label set looks like a claim flow. The resolved Stage-2
 * intent (structured, registry/on-chain-sourced) is checked first,
 * then the decoded function name, then dApp-supplied text — most
 * trustworthy source first per the spec ("never trust dApp text
 * alone").
 */
export function looksLikeClaim(input: {
  dappLabel?: string;
  functionName?: string;
  resolvedIntent?: string;
}): boolean {
  if (intentLooksLikeClaim(input.resolvedIntent)) return true;
  if (input.functionName && CLAIM_LABEL_RE.test(input.functionName))
    return true;
  if (input.dappLabel && CLAIM_LABEL_RE.test(input.dappLabel)) return true;
  return false;
}

/**
 * The user's net inflow per the predicted deltas. `in` adds, `out`
 * subtracts. "unlimited" out-flows are treated as "definitely not a
 * positive claim" — return -1 sentinel-shaped result.
 */
function netInflow(deltas: AssetDelta[]): bigint | "negative_infinity" {
  let net = 0n;
  for (const d of deltas) {
    if (d.amount === "unlimited") {
      if (d.direction === "out") return "negative_infinity";
      // "unlimited in" never happens in practice; treat as zero.
      continue;
    }
    if (d.direction === "in") net += d.amount;
    else net -= d.amount;
  }
  return net;
}

export function detectClaimMismatch(
  input: ClaimMismatchInput,
): ClaimMismatchVerdict {
  if (!looksLikeClaim(input)) return { triggered: false };

  const net = netInflow(input.deltas);
  if (net === "negative_infinity") {
    return {
      triggered: true,
      reason:
        "This claim grants the contract unlimited outbound permission, a pattern drainers exploit. Proceed only if you are sure.",
    };
  }
  if (net <= 0n) {
    return {
      triggered: true,
      reason:
        "This claim has no net inflow: the simulator predicts you receive nothing. Proceed only if you are sure.",
    };
  }
  return { triggered: false };
}
