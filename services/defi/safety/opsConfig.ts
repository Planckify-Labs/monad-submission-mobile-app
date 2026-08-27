/**
 * Ops configuration for the safety layer (§11 Layer 3, §11.6 #2 and #7).
 *
 * The three hard gates in Layer 3 and the audit sink in `registry.ts` were all
 * built with a setter and no caller. That is a specific, silent failure mode
 * rather than an unfinished feature: `isFamilyKilled` answered `false` for
 * every family, the sanctions deny list was empty so `SanctionsScreenCheck`
 * returned `ok` on its first line, `chain-enabled-for-defi` short-circuited on
 * a `null` set, and every audit entry — pass and fail — went to a `__DEV__`
 * console that production never runs. Each check was present, registered, and
 * incapable of ever firing. This module is the missing half.
 *
 * **Sourcing.** Env-backed today, remote-config-shaped by construction:
 * `applyDefiOpsConfig` is a pure "here is the current config" entry point, so
 * a future hot-config fetch is a caller, not a rewrite. That ordering is
 * deliberate — a kill switch that can only be changed by shipping a build is
 * worth much less during the incident it exists for, but one that can ONLY be
 * changed remotely is worth nothing when the remote is what broke.
 *
 * **What is NOT here.** No secrets, no allowlist of addresses to trust. Every
 * value is a REFUSAL: families to stop, counterparties to block, chains to
 * withhold. A corrupted or empty config therefore costs availability, never
 * safety, which is the only direction a config fetch is allowed to fail in.
 */

import { track } from "@/services/analytics/posthog";
import {
  setCounterpartyDenyList,
  setDefiEnabledChains,
  setKilledFamilies,
} from "./checks/layer3-policy";
import { type SafetyAuditEntry, setSafetyAuditSink } from "./registry";

export interface DefiOpsConfig {
  /** Family/kind keys to refuse outright, e.g. `["curve-lp"]`. */
  readonly killedFamilies?: readonly string[];
  /** Addresses to refuse as a counterparty (sanctions / incident). */
  readonly counterpartyDenyList?: readonly string[];
  /**
   * Chain ids DeFi routing is allowed on. `null`/absent means "no per-chain
   * restriction" — the §11.3 read-only posture for a chain whose provider is
   * partial is expressed by LISTING the chains that are ready, so forgetting
   * to list one costs availability rather than safety.
   */
  readonly enabledChains?: readonly (number | string)[] | null;
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Env-sourced config. `EXPO_PUBLIC_DEFI_FAMILY_KILL_SWITCH` already existed
 * (read directly by `isFamilyKilled`'s own fallback); the other two are its
 * twins, named the same way.
 */
export function opsConfigFromEnv(): DefiOpsConfig {
  const chains = parseList(process.env.EXPO_PUBLIC_DEFI_ENABLED_CHAINS);
  return {
    killedFamilies: parseList(process.env.EXPO_PUBLIC_DEFI_FAMILY_KILL_SWITCH),
    counterpartyDenyList: parseList(
      process.env.EXPO_PUBLIC_DEFI_COUNTERPARTY_DENYLIST,
    ),
    // Absent env ⇒ `null` ⇒ no per-chain gate, NOT "zero chains enabled".
    // The opposite default would dark every chain the moment this shipped.
    enabledChains: chains.length > 0 ? chains : null,
  };
}

/**
 * Apply a config snapshot. Idempotent and total: every field is replaced, so
 * a family removed from the kill list is genuinely un-killed rather than
 * accumulating forever.
 */
export function applyDefiOpsConfig(config: DefiOpsConfig): void {
  setKilledFamilies(config.killedFamilies ?? []);
  setCounterpartyDenyList(config.counterpartyDenyList ?? []);
  setDefiEnabledChains(
    config.enabledChains === undefined ? null : config.enabledChains,
  );
}

/**
 * The audit trail (§11.6 #7: "which check let this through / blocked this"
 * must be answerable after the fact).
 *
 * Two stores, because the requirement has two halves and one mechanism serves
 * each badly:
 *
 *  - **A refusal becomes an analytics event.** Refusals are rare and are the
 *    record an incident review actually starts from.
 *  - **Every verdict, pass included, lands in a bounded in-memory ring.** A
 *    single deposit clears ~19 checks; nineteen "nothing happened" events per
 *    deposit would drown the signal and spend the user's bandwidth. But
 *    "which check let this through" is a question about the PASSES, so they
 *    have to be kept somewhere — here, cheaply, and read back with the
 *    refusal that followed them.
 *
 * The wallet address is deliberately NOT sent to analytics. Analytics
 * identifies by a stable device id, and a DeFi audit trail is not a reason to
 * start attaching on-chain identities to it. It IS kept in the local ring,
 * which never leaves the device. `detail` is our own curated string (never a
 * server body or an SDK error), consistent with the user-facing-error rule.
 */
const AUDIT_RING_SIZE = 100;
const auditRing: SafetyAuditEntry[] = [];

/**
 * The checks that PASSED immediately before this refusal, in the same run.
 * `runSafetyPipeline` is strictly sequential and stops at the first failure,
 * so walking the ring backwards while the target and wallet match reconstructs
 * the run without the sink having to know about run boundaries.
 */
function passedBefore(entry: SafetyAuditEntry): string[] {
  const ids: string[] = [];
  for (let i = auditRing.length - 1; i >= 0; i--) {
    const prev = auditRing[i];
    if (prev === entry) continue;
    if (prev.verdict !== "pass") break;
    if (prev.target !== entry.target || prev.wallet !== entry.wallet) break;
    ids.unshift(prev.checkId);
  }
  return ids;
}

/** Recent safety verdicts, oldest first. Device-local; for diagnostics. */
export function dumpSafetyAudit(): readonly SafetyAuditEntry[] {
  return [...auditRing];
}

function auditSink(entry: SafetyAuditEntry): void {
  auditRing.push(entry);
  if (auditRing.length > AUDIT_RING_SIZE) auditRing.shift();
  if (entry.verdict === "pass") return;

  track("defi_safety_check_failed", {
    check_id: entry.checkId,
    layer: entry.layer,
    verdict: entry.verdict,
    fail_code: entry.fail,
    detail: entry.detail,
    target_kind: entry.target,
    chain_id: entry.chainId,
    passed_before: passedBefore(entry).join(","),
  });
  if (__DEV__) console.warn("[defi/safety] refused", entry);
}

let booted = false;

/**
 * Called once from `bootDefiSafety`. Separate from the check registrations so
 * a test can register checks without also installing an analytics sink.
 */
export function bootDefiOpsConfig(): void {
  if (booted) return;
  applyDefiOpsConfig(opsConfigFromEnv());
  setSafetyAuditSink(auditSink);
  booted = true;
}

/** Test seam. */
export function resetDefiOpsConfig(): void {
  booted = false;
}
