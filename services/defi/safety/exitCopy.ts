/**
 * User-facing copy for exit terms (§12 Q2a).
 *
 * Pure and dependency-free on purpose: the approval card needs these, and so do
 * the tests, but importing the React Query hook next door drags React Native's
 * Flow-syntax entry point into the vitest transform and the suite will not
 * parse. Keeping the strings here is also the right seam regardless — copy is
 * the thing most likely to be reviewed by someone who does not want to read a
 * data-fetching hook.
 *
 * House rule: no em-dashes in anything a user reads.
 */

import type { ExitTerms } from "./types";

/** Friendly duration for the card. Hand-written copy, never a raw number dump. */
export function formatExitDelay(seconds: number): string {
  if (seconds <= 0) return "";
  const days = Math.round(seconds / 86_400);
  if (days >= 1) return days === 1 ? "about 1 day" : `about ${days} days`;
  const hours = Math.round(seconds / 3_600);
  if (hours >= 1) return hours === 1 ? "about 1 hour" : `about ${hours} hours`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "about 1 minute" : `about ${minutes} minutes`;
}

/**
 * The line the user has to read before funding a lockup. Returns `null` when
 * the exit is proven instant, which is the only case that needs no warning.
 */
export function exitTermsNotice(terms: ExitTerms | undefined): string | null {
  if (!terms) return null;
  switch (terms.kind) {
    case "instant":
      return null;
    case "delayed":
      return `Withdrawals from this pool aren't instant. After you request one, your money is locked for ${formatExitDelay(terms.seconds)}.`;
    case "queued":
      return "Withdrawals from this pool aren't instant. They go through a queue, and the wait isn't fixed.";
    case "unknown":
      return "We couldn't confirm how long your money would be locked here.";
  }
}
