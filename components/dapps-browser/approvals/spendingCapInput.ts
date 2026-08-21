import { parseUnits } from "viem";

/**
 * Parsing for the hand-typed spending cap.
 *
 * Pure, and deliberately in its own file rather than inside the editor
 * component: this turns what somebody types into the integer that goes into
 * signed calldata, so it is the kind of logic that deserves tests of its own.
 *
 * Two real failures drove this apart from a bare `parseUnits` call:
 *
 *  1. **Decimal commas.** Android's `decimal-pad` emits the locale's own
 *     separator, so a phone set to Indonesian (or German, or French, or most
 *     of Europe and Latin America) types `10,6`. viem throws
 *     `InvalidDecimalNumberError` on that, which surfaced as "Enter a valid
 *     amount" and made the field look broken for anyone not on an en-US
 *     keyboard. The separator is a keyboard-layout detail, never the user's
 *     mistake.
 *
 *  2. **Silent rounding.** `parseUnits("1.1234567", 6)` returns `1123457`,
 *     rounding the eighth digit away without a word. Rounding somebody's
 *     approval amount for them is exactly the sort of quiet edit this screen
 *     exists to prevent, so excess precision is refused and named instead.
 */

export type SpendingCapParse =
  | { ok: true; value: bigint }
  | { ok: false; reason: "empty" | "invalid" | "ambiguous" | "tooPrecise" };

/** Digits with at most one separator, e.g. "10", "10.", "10.6", ".5". */
const SHAPE = /^\d*\.?\d*$/;

/**
 * `decimals` is required. There is no base-units mode: asking someone to type
 * `6000000` to approve six tokens is a wallet handing its own unfinished work
 * to the user. When the scale cannot be resolved the editor is not offered at
 * all, which is the caller's job to enforce.
 */
export function parseSpendingCapInput(
  text: string,
  decimals: number,
): SpendingCapParse {
  // Spaces cover both the stray typo and the thin-space grouping some
  // keyboards insert.
  const raw = text.trim().replace(/\s/g, "");
  if (!raw) return { ok: false, reason: "empty" };

  const commas = (raw.match(/,/g) ?? []).length;
  const dots = (raw.match(/\./g) ?? []).length;

  // "1,234.5" or "1.234,5" is someone's thousands grouping, and which mark
  // means what depends on a locale this function cannot see. Guessing wrong
  // moves the value by a factor of a thousand, so ask rather than assume.
  if (commas > 0 && dots > 0) return { ok: false, reason: "ambiguous" };
  if (commas > 1 || dots > 1) return { ok: false, reason: "ambiguous" };

  const normalized = commas === 1 ? raw.replace(",", ".") : raw;
  if (!SHAPE.test(normalized)) return { ok: false, reason: "invalid" };
  if (!/\d/.test(normalized)) return { ok: false, reason: "invalid" };

  const [, fraction = ""] = normalized.split(".");

  // Refuse rather than round. See the note above.
  if (fraction.length > decimals) return { ok: false, reason: "tooPrecise" };

  try {
    const value = parseUnits(normalized, decimals);
    return value < 0n ? { ok: false, reason: "invalid" } : { ok: true, value };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/** User-facing copy for a rejected cap. Hand-written, never a thrown message. */
export function spendingCapError(
  reason: Exclude<SpendingCapParse & { ok: false }, { ok: true }>["reason"],
  decimals: number,
): string | null {
  switch (reason) {
    case "empty":
      return null; // nothing typed yet is not an error
    case "ambiguous":
      return "Use just one decimal separator, like 10.6";
    case "tooPrecise":
      return `This token supports up to ${decimals} decimal places.`;
    default:
      return "Enter a valid amount.";
  }
}

/** Thousands separators, so a raw-unit preview can be checked at a glance. */
export function groupDigits(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
