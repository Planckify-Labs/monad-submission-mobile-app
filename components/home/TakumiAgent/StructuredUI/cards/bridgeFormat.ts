/**
 * Bridge card formatting — pure, testable, no React.
 *
 * Spec: docs/bridge-capability-spec.md §6, §7.2, §7.7.1.
 *
 * Every amount is formatted from the token's OWN `decimals`. That is the
 * whole point of the §6 widening: we used to return `toAmount` without
 * decimals so every call site formatted by guesswork, and Stellar USDC is
 * 7 decimals while USDC everywhere else is 6. A shared constant would
 * misprice every Stellar amount by 10x.
 *
 * Copy rules: no em-dashes in anything user-facing
 * (`feedback_no_emdash_in_ui_copy`), and no raw provider text ever
 * (CLAUDE.md user-facing errors).
 */

import type {
  TBridgeFee,
  TBridgeOutcome,
  TBridgePhase,
  TBridgeToken,
} from "@/api/types/bridge";
import { CHAIN_NAMES } from "../approvalSummary";

/**
 * Format a smallest-unit amount using the token's own decimals.
 *
 * Uses bigint arithmetic rather than `Number`, because a 78-digit raw
 * amount silently loses precision through a float and would display a
 * wrong number on a confirmation screen.
 */
export function formatTokenAmount(
  amountRaw: string | undefined,
  decimals: number | undefined,
  maxFractionDigits = 6,
): string {
  if (!amountRaw) return "0";
  const dp = typeof decimals === "number" && decimals >= 0 ? decimals : 0;

  let value: bigint;
  try {
    value = BigInt(amountRaw);
  } catch {
    return "0";
  }

  const negative = value < 0n;
  if (negative) value = -value;

  const base = 10n ** BigInt(dp);
  const whole = value / base;
  const fraction = value % base;

  let out = whole.toLocaleString("en-US");
  if (dp > 0 && fraction > 0n) {
    const padded = fraction.toString().padStart(dp, "0");
    const trimmed = padded.slice(0, maxFractionDigits).replace(/0+$/, "");
    if (trimmed) out += `.${trimmed}`;
  }
  return negative ? `-${out}` : out;
}

/** `"12.5 USDC"`, with decimals taken from the token itself. */
export function formatTokenValue(
  amountRaw: string | undefined,
  token: TBridgeToken | undefined,
): string {
  if (!token) return formatTokenAmount(amountRaw, undefined);
  return `${formatTokenAmount(amountRaw, token.decimals)} ${token.symbol}`;
}

export function formatUsd(amountUsd: string | undefined): string | null {
  if (!amountUsd) return null;
  const n = Number.parseFloat(amountUsd);
  if (!Number.isFinite(n)) return null;
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Slippage as a visible percentage (§7.2), not a hidden bps integer. */
export function formatSlippage(bps: number | undefined): string {
  if (typeof bps !== "number" || !Number.isFinite(bps)) return "0%";
  const pct = bps / 100;
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2)}%`;
}

/**
 * Duration as a range when the provider gives one (§7.3).
 *
 * Standard CCTP transfers take 15 to 20 minutes. Saying so plainly beats
 * a bare spinner, which reads as "something is wrong".
 */
export function formatDuration(
  seconds: number | undefined,
  range?: [number, number],
): string {
  const toLabel = (s: number): string => {
    if (s < 60) return `${Math.max(1, Math.round(s))} sec`;
    const mins = Math.round(s / 60);
    if (mins < 60) return `${mins} min`;
    const hours = Math.round((mins / 60) * 10) / 10;
    return `${hours} hr`;
  };

  if (range && range.length === 2 && range[0] !== range[1]) {
    const lowMins = Math.round(range[0] / 60);
    const highMins = Math.round(range[1] / 60);
    if (lowMins >= 1 && highMins >= 1) return `${lowMins} to ${highMins} min`;
    return `${toLabel(range[0])} to ${toLabel(range[1])}`;
  }
  if (typeof seconds !== "number" || seconds <= 0) return "Unknown";
  return toLabel(seconds);
}

/**
 * Effective rate, so a 3 percent haircut is VISIBLE (§7.2).
 *
 * Returns `null` when either side has no USD price rather than inventing
 * a rate from amounts in different units.
 */
export function effectiveRatePercent(
  fromAmountUsd: string | undefined,
  toAmountUsd: string | undefined,
): number | null {
  const from = Number.parseFloat(fromAmountUsd ?? "");
  const to = Number.parseFloat(toAmountUsd ?? "");
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return null;
  return ((to - from) / from) * 100;
}

/**
 * Split fees into the two groups §7.2 requires be distinguishable:
 * already deducted from the output vs charged on top. Conflating them
 * means either double-counting or under-reporting.
 */
export function partitionFees(fees: TBridgeFee[] | undefined): {
  deducted: TBridgeFee[];
  onTop: TBridgeFee[];
} {
  const deducted: TBridgeFee[] = [];
  const onTop: TBridgeFee[] = [];
  for (const fee of fees ?? []) {
    (fee.included ? deducted : onTop).push(fee);
  }
  return { deducted, onTop };
}

/**
 * Plain-language description of the trust model actually moving the funds
 * (§7.3). Burn-and-mint, liquidity pool, and intent/filler are different
 * trust models and users are entitled to know which one they are in.
 */
export function mechanismLabel(mechanism: string | undefined): string | null {
  switch (mechanism) {
    case "burn_mint":
      return "Burned here, minted there";
    case "liquidity_pool":
      return "Paid from a liquidity pool";
    case "intent_filler":
      return "Fronted by a filler, settled after";
    default:
      return null;
  }
}

/**
 * Terminal-state copy. FOUR outcomes, never a boolean (§7.7.1).
 *
 * `partial` and `refunded` are OUTCOMES, not errors: they must NOT go
 * through `agentErrorCopy`. They get their own plain explanatory copy
 * naming the token actually received, or the chain the refund landed on.
 */
export function outcomeCopy(
  outcome: TBridgeOutcome | null | undefined,
  ctx: { receivedSymbol?: string; refundChainLabel?: string },
): {
  title: string;
  body: string | null;
  tone: "success" | "notice" | "error";
} {
  switch (outcome) {
    case "completed":
      return {
        title: "Transfer complete",
        body: null,
        tone: "success",
      };
    case "partial":
      return {
        title: "Arrived as a different token",
        body: ctx.receivedSymbol
          ? `The full value arrived, but as ${ctx.receivedSymbol} instead of the token you asked for.`
          : "The full value arrived, but as a different token than the one you asked for.",
        tone: "notice",
      };
    case "refunded":
      return {
        title: "Refunded to where it started",
        body: ctx.refundChainLabel
          ? `The transfer could not complete, so your funds were returned on ${ctx.refundChainLabel}.`
          : "The transfer could not complete, so your funds were returned on the chain they started from.",
        tone: "notice",
      };
    case "failed":
      return {
        title: "Transfer did not go through",
        body: "Your funds were not moved. You can try again in a moment.",
        tone: "error",
      };
    default:
      return { title: "In progress", body: null, tone: "notice" };
  }
}

/**
 * Honest per-phase copy (§7.7). Waiting for the attestation is where the
 * ~15 to 19 minutes of a standard transfer goes, and it is the step users
 * stare at, so it says what is actually happening.
 */
export function phaseCopy(phase: TBridgePhase | undefined): string {
  switch (phase) {
    case "pending_source":
      return "Confirming on the source chain";
    case "pending_attestation":
      return "Waiting for the transfer to be confirmed";
    case "pending_destination":
      return "Delivering on the destination chain";
    case "settled":
      return "Settled";
    default:
      return "In progress";
  }
}

/**
 * Human label for a CAIP-2 chain id.
 *
 * Takes the name from DATA, never from a namespace branch. The backend
 * resolves display names from each provider's own chain list and puts
 * them on the wire (`from.chainName` / `to.chainName`, and the support
 * matrix), so `known` is a lookup, not a derivation.
 *
 * That matters beyond tidiness: comparing the chain family inside a
 * component is exactly what `pnpm check:chains` forbids, because it is
 * the pattern that makes adding a chain an edit to shared UI instead of a
 * registration.
 *
 * Falls back to the shared `CHAIN_NAMES` table (same one
 * `approvalSummary.ts` uses) before giving up and showing the raw CAIP-2
 * id, because the backend's resolved name is NOT always present: LI.FI's
 * `chainNameFor` only reads a warm chains-list cache and returns
 * `undefined` on a cold one, which previously surfaced as "eip155:8453"
 * verbatim in the card on the first quote after a deploy.
 */
export function chainLabel(
  caip2: string | undefined,
  known: Array<{ chain: string; name: string }> = [],
): string {
  if (!caip2) return "Unknown chain";
  return (
    known.find((c) => c.chain === caip2)?.name ?? CHAIN_NAMES[caip2] ?? caip2
  );
}

/** Middle-truncate an address for display without hiding its ends. */
export function truncateAddress(address: string | undefined): string {
  if (!address) return "";
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

/**
 * Copy for a bridge card that has NO result yet.
 *
 * A card in this state has submitted NOTHING, and saying otherwise is the
 * worst lie this card can tell. `bridge_execute` reaches a result only by
 * running the executor, and the executor always posts one, so a call
 * sitting with no output has not run. "No output AND no live approval
 * surface" narrows it further: the approval prompt died with its turn
 * (the user walked away, the stream errored, or the conversation was
 * restored from history with the call orphaned) and the funds never
 * moved.
 *
 * This used to render "Submitting transfer" over "Sending from <chain>"
 * for every one of those states, which told a user whose turn had just
 * failed at the approval prompt that their money was already in flight.
 *
 * `bridge_status` is a READ. It polls a transfer that is already on its
 * way and submits nothing, so it never borrows submission language.
 */
export function pendingBridgeCopy(args: {
  /** True for the fund-moving calls (`amount_raw` is schema-required). */
  isExecute: boolean;
  /** True while a live approval surface is still attached to the call. */
  isLive: boolean;
}): { title: string; body: string; tone: "idle" | "interrupted" } {
  const { isExecute, isLive } = args;

  if (isExecute) {
    return isLive
      ? {
          // Defensive: the card renders the approval gate on this path, so
          // this is only reached if that gate is ever bypassed. Still says
          // the true thing.
          title: "Waiting for your approval",
          body: "Nothing has been sent yet.",
          tone: "idle",
        }
      : {
          title: "Not sent",
          body: "This transfer was interrupted before you approved it, so nothing was sent.",
          tone: "interrupted",
        };
  }

  return isLive
    ? {
        title: "Checking transfer status",
        body: "Looking up where your funds are.",
        tone: "idle",
      }
    : {
        title: "Status check interrupted",
        body: "We did not finish checking on this transfer.",
        tone: "interrupted",
      };
}

/**
 * A rejected or blocked call is an OUTCOME, not a failure. It is §7.7.1's
 * rule applied to the FRONT of the lifecycle: "the tool did not run" has
 * several meanings and only some of them are errors.
 *
 * These two codes need their own copy for a structural reason. The
 * dispatcher records a decline by upserting `state: "output-error"` with a
 * bare `error` code and NO output payload (`rejectDeclined`, and the deny
 * path's `permission_denied`), so:
 *
 *   - a card that gates its failure branch on `output` never sees them,
 *     and
 *   - `agentErrorCopy` has no entry for either, so they would render the
 *     generic "I couldn't complete that right now" and read as a system
 *     malfunction rather than as the user's own decision being honoured.
 *
 * Returns `null` for anything else, meaning "not a decline, take the
 * normal failure path".
 */
export function declinedBridgeCopy(
  error: string | undefined,
): { title: string; body: string } | null {
  switch (error) {
    case "user_declined":
      return {
        title: "Not sent",
        body: "You rejected this transfer, so nothing was sent.",
      };
    case "permission_denied":
      return {
        title: "Not sent",
        body: "This transfer was not allowed, so nothing was sent.",
      };
    default:
      return null;
  }
}

/**
 * Explanatory copy for a capability boundary (§7.6).
 *
 * This is NOT an error state, so it never routes through
 * `agentErrorCopy`, and it never echoes provider text.
 */
export function noRouteCopy(reason: string | undefined): string {
  switch (reason) {
    case "same_chain":
      return "Those are the same chain, so there is nothing to bridge.";
    case "chain_not_supported":
      return "We cannot move funds between those two chains yet.";
    case "asset_not_supported":
      return "That asset cannot be moved between those chains. Stablecoins usually have the widest coverage.";
    case "asset_chain_mismatch":
      return "That asset does not belong to the chain it was paired with.";
    case "check_unavailable":
      return "We could not check routes right now. Please try again in a moment.";
    default:
      return "We could not find a route for that transfer.";
  }
}
