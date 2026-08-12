/**
 * Shared helpers for marketplace-order decoders — spec phase P.
 *
 * Seaport, 0x and Blur describe the same act (someone signs away an NFT
 * off-chain) in three different structs, but the questions a user needs
 * answered are identical: what leaves my wallet, what comes back, when
 * does this expire, and is this order even mine. Keeping the primitives
 * here means those answers are phrased the same way on every venue, and
 * a fix to one is a fix to all three.
 */

/** Parse anything number-ish without throwing. `null` means unreadable. */
export function big(v: unknown): bigint | null {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(v);
    if (typeof v === "string" && v.trim() !== "") return BigInt(v.trim());
  } catch {
    // fall through
  }
  return null;
}

/** Unix seconds to a readable UTC instant. Never throws on junk input. */
export function describeTime(v: unknown): string {
  const n = big(v);
  if (n === null) return "Not set";
  // Marketplaces use `type(uint256).max` for "no expiry"; anything
  // beyond a sane date range is the same intent expressed sloppily.
  if (n > 100_000_000_000n) return "Never expires";
  try {
    return new Date(Number(n) * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 16);
  } catch {
    return "Not set";
  }
}

/** Case-insensitive address comparison that tolerates absent values. */
export function sameAddress(a: unknown, b: unknown): boolean {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.toLowerCase() === b.toLowerCase()
  );
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function isZeroAddress(v: unknown): boolean {
  return typeof v === "string" && v.toLowerCase() === ZERO;
}

/**
 * The one warning every order decoder owes the user, and the reason
 * `signer` is threaded down from `intent.wallet`.
 *
 * An order's own maker field (`offerer`, `maker`, `trader`) is supplied
 * by the dApp and proves nothing about who is signing. A self-consistency
 * check that compares consideration recipients against *that* field is
 * satisfied by an attacker who sets both to an address they control,
 * while the person holding the phone still receives nothing.
 *
 * Returns `null` when there is nothing to say, either because the two
 * agree or because we were not told who is signing.
 */
export function makerMismatchWarning(
  signer: string | undefined,
  maker: unknown,
  makerLabel: string,
): { title: string; detail: string } | null {
  if (!signer || typeof maker !== "string") return null;
  if (sameAddress(signer, maker)) return null;
  return {
    title: "This order is not in your name",
    detail: `The ${makerLabel} on this order is a different address from the one signing. A valid sale is signed by the person who owns the items, so this is either a mistake or an attempt to have you authorise someone else's order.`,
  };
}
