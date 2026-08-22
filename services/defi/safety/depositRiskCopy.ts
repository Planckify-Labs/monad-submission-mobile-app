/**
 * User-facing copy for deposit risk (impermanent-loss exposure).
 *
 * Pure and dependency-free on purpose, same reasoning as `exitCopy.ts`.
 *
 * House rule: no em-dashes in anything a user reads.
 */

/**
 * The line the user has to read before funding a position whose value can
 * diverge from simply holding the underlying assets. Returns `null` when
 * there is nothing to disclose (no exposure, or exposure not yet known).
 */
export function depositRiskNotice(
  ilExposure: boolean | undefined,
): string | null {
  if (!ilExposure) return null;
  return "This pool's value can move differently than just holding the underlying assets, especially if their prices drift apart. This is sometimes called impermanent loss.";
}
