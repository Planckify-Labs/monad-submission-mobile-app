/**
 * Exit-lockup consent ledger (§11 Layer 0 + Layer 3, §12 Q2a).
 *
 * `ExitTermsConsentCheck` refuses a deposit into a newly discovered lockup
 * unless the user was shown the delay and accepted it. That acceptance has to
 * reach the executor somehow, and there is exactly one route it must NOT take:
 * the model. A consent value the LLM can emit is not consent — it is the agent
 * approving its own write, which is the whole thing §11 Layer 0 exists to stop.
 *
 * So the approval CARD records it here after the user taps Approve, and the
 * executor reads it back. The ledger is deliberately tiny and hostile to reuse:
 *
 *  - **in memory only** — a lockup accepted last week is not consent today, and
 *    persisting it would quietly turn one tap into a standing permission.
 *  - **short TTL** — an approval left on screen goes stale like a quote does.
 *  - **keyed by poolId** — consent is to a specific pool's terms, never to a
 *    protocol or to "lockups in general".
 *  - **single use** — read clears it, so one approval funds one deposit.
 */

/** How long an acknowledgement stays usable. Matches the approval sheet's own life. */
const CONSENT_TTL_MS = 10 * 60 * 1000;

interface ConsentEntry {
  /** The delay, in seconds, the user actually saw. */
  readonly seconds: number;
  readonly at: number;
}

const ledger = new Map<string, ConsentEntry>();

function fresh(entry: ConsentEntry | undefined, now: number): boolean {
  return !!entry && now - entry.at < CONSENT_TTL_MS;
}

/**
 * Record that the user was shown `seconds` of lockup for this pool and accepted
 * it. Called from the approval surface, never from a tool argument.
 */
export function recordExitConsent(poolId: string, seconds: number): void {
  if (!poolId) return;
  ledger.set(poolId, {
    seconds: Math.max(0, Math.floor(seconds)),
    at: Date.now(),
  });
}

/**
 * Consume the acknowledgement for a pool, or `undefined` when the user was
 * never asked (or the answer went stale). Undefined must read as "not
 * acknowledged" at the call site — never as zero, which would look like a
 * user who accepted an instant exit.
 */
export function takeExitConsent(
  poolId: string | undefined,
): number | undefined {
  if (!poolId) return undefined;
  const entry = ledger.get(poolId);
  ledger.delete(poolId);
  return fresh(entry, Date.now()) ? entry?.seconds : undefined;
}

/** Non-consuming read, for rendering the card's own state. */
export function peekExitConsent(
  poolId: string | undefined,
): number | undefined {
  if (!poolId) return undefined;
  const entry = ledger.get(poolId);
  return fresh(entry, Date.now()) ? entry?.seconds : undefined;
}

/** Test seam. */
export function resetExitConsent(): void {
  ledger.clear();
}
