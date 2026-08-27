/**
 * Address equality for the safety checks (§11.5 "normalize what's common,
 * delegate what's native").
 *
 * The Layer-4 assertions compare addresses the pipeline holds against
 * addresses decoded out of a built call: is the recipient the user's own
 * wallet, is the asset the pool's underlying, is the approval's spender the
 * call's destination. Those comparisons were written with `.toLowerCase()` on
 * both sides, which is correct for `0x` hex and WRONG for every other
 * encoding — Solana base58 and Stellar base32 are case-SIGNIFICANT, and
 * folding them does not reject anything, it makes distinct addresses compare
 * EQUAL. On the one check whose entire job is catching a substituted
 * recipient, a fold that only ever creates false matches is the wrong
 * direction to be lossy in: a 44-character base58 pubkey has ~30 letters, so
 * case-insensitivity is worth roughly 2^30 of grinding to anyone trying to
 * pass off a lookalike.
 *
 * The rule lives per namespace, in the wallet kit, which is the seam shared
 * code is supposed to dispatch through (`chainInfo#addressesEqual`). The
 * shape-based fallback is for the one case that seam cannot serve: a check
 * running before/without a registered kit (unit tests, a namespace whose kit
 * has not booted). It reads the case rule off the address's own encoding
 * rather than off a namespace branch — same helper shared code already uses
 * for storage keys.
 */

import { foldAddressForKey } from "@/services/chains/addressCompare";
import type { Namespace } from "@/services/chains/types";
import { addressesEqual } from "@/services/walletKit/chainInfo";
import { walletKitRegistry } from "@/services/walletKit/registry";

/**
 * True when `a` and `b` are the same address under `namespace`'s own case
 * rule. Nullish is never equal — an absent value is not a match, and a check
 * that wants "absent means skip" must say so itself.
 */
export function sameAddress(
  namespace: Namespace,
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (walletKitRegistry.has(namespace)) return addressesEqual(namespace, a, b);
  return foldAddressForKey(a) === foldAddressForKey(b);
}
