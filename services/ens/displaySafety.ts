/**
 * Whether an ENS name is safe to *show* — spec phase R.
 *
 * Resolution safety and display safety are different problems, and we
 * already have the first one. `services/ens/resolver.ts` is sound in the
 * two ways that are easy to get wrong: forward resolution normalises
 * through ENSIP-15, and reverse resolution goes through viem's
 * `getEnsName`, which calls the UniversalResolver's
 * `reverseWithGateways`. Per ENS's own documentation that function
 * "internally checks that the name forward resolves to the address
 * you're looking up, so your implementation doesn't need to do any
 * additional checks" — an attacker cannot point a reverse record at a
 * name they do not control.
 *
 * None of that says a resolved name is safe to put beside an address on
 * a consent screen, because normalization decides **validity, not
 * similarity**. Two classes survive it:
 *
 *   - **Whole-script confusables.** ENSIP-15 forbids mixing scripts
 *     inside a label, but a label that is *entirely* Cyrillic is valid
 *     and normalizes cleanly. `виталик.eth` is a real, registrable name.
 *   - **Same-script confusables.** `rn` against `m`, `l` against `I`.
 *     Note `vitaIik.eth` normalizes to `vitaiik.eth` (capital I maps to
 *     lowercase i), a distinct and perfectly valid name that reads as
 *     `vitalik.eth` in most sans-serif faces at sheet size.
 *
 * This module closes the first class and deliberately does not attempt
 * the second. `ens_split` gives each label's script offline and for
 * free, so the whole-script class is a cheap, complete win. Telling `rn`
 * from `m` needs a visual-similarity model whose false positives land on
 * legitimate names, and the mitigation for it is structural instead: the
 * label is never a replacement for the address (see `CounterpartyLabel`),
 * so there is always something exact on screen to check against.
 *
 * A useful thing ENSIP-15 already does for us: `ǀ` (U+01C0, the Latin
 * dental click, a near-perfect `l`) and `ı` (U+0131, dotless i) are both
 * *disallowed characters*, so the worst Latin-block homoglyphs never get
 * as far as this gate. That is why the Latin script group is accepted
 * alongside ASCII rather than being cut for safety: it costs users with
 * accented names their labels and buys very little.
 */

import { ens_beautify, ens_split } from "@adraffy/ens-normalize";

export type EnsDisplayDecision =
  | { render: true; display: string }
  | {
      render: false;
      /** For dev logs only. Never shown to a user. */
      reason: "empty" | "unnormalizable" | "non-latin-script";
    };

/** Script groups whose glyphs a Latin-reading user can actually check. */
const ALLOWED_SCRIPTS = new Set(["ASCII", "Latin"]);

/**
 * Decide whether `name` may be rendered next to an address, and in what
 * form. Never throws.
 */
export function ensDisplaySafety(
  name: string | null | undefined,
): EnsDisplayDecision {
  if (!name || name.trim() === "") return { render: false, reason: "empty" };
  let labels: ReturnType<typeof ens_split>;
  try {
    // `ens_split` normalizes as it goes and reports per-label script.
    labels = ens_split(name);
  } catch {
    return { render: false, reason: "unnormalizable" };
  }
  if (labels.length === 0) return { render: false, reason: "empty" };
  for (const label of labels) {
    // A label that failed to normalize carries an `error`; treat that
    // as unrenderable rather than reading around it.
    if ("error" in label && label.error) {
      return { render: false, reason: "unnormalizable" };
    }
    const type = (label as { type?: string }).type;
    if (!type || !ALLOWED_SCRIPTS.has(type)) {
      // Emoji labels land here too. They are not confusable with ASCII,
      // but they are also not checkable against an address by eye, and
      // the address alone is the honest fallback.
      return { render: false, reason: "non-latin-script" };
    }
  }
  try {
    return { render: true, display: ens_beautify(name) };
  } catch {
    return { render: false, reason: "unnormalizable" };
  }
}
