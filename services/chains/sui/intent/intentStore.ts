/**
 * Intent store — opaque `intentId` → compiled-PTB hand-off (spec §8.1).
 *
 * Mirrors the `mintPaymentIntent` opaque-id hand-off and the dApp bridge's
 * `pendingIntents`: `defi_intent_preview` (read) compiles + guards a PTB
 * and stashes it; `defi_intent_execute` (write) loads it by id and signs.
 *
 * Storage is an in-memory, session-scoped Map with a short TTL. The spec
 * suggested MMKV, but the preview→execute hand-off happens within the same
 * app JS runtime within seconds, and a 5-minute TTL means stale entries are
 * worthless anyway — so an in-memory map is functionally equivalent while
 * staying free of native modules (keeps the module bundle-safe and
 * unit-testable under Vitest). `defi_intent_execute` re-runs the guardian
 * at sign time regardless (§5.3), so persistence buys nothing.
 */

import type { DepositTarget } from "@/services/defi/types";
import type { RiskFlag } from "./guardian/riskCheck";
import type { Intent } from "./intentSchema";

export interface IntentStoreEntry {
  ptbBase64: string;
  intent: Intent;
  /**
   * The server-resolved deposit target this PTB was compiled for, when the
   * intent named an exact pool. Carried through the store because the
   * pre-sign safety pipeline runs again at EXECUTE (§11.1's second anchor)
   * and every provider-backed check needs the target to have something to
   * verify. Absent for a plain venue-routed intent, exactly as
   * `services/agent-executors/defi/writes.ts` treats a slug-routed deposit.
   */
  depositTarget?: DepositTarget;
  flags: RiskFlag[];
  summary: string;
  /** Resolved input coinType — for activity-feed recording at execute. */
  inputCoinType?: string;
  /** Resolved raw input amount — for activity-feed recording at execute. */
  inputAmountRaw?: bigint;
  /** Carries the compiler's `simulationUnreliable` so the execute re-guard can
   *  apply the same scoped version-gate dry-run bypass the preview did. */
  simulationUnreliable?: boolean;
  /** Epoch ms when this entry is no longer valid. */
  expiresAt: number;
}

export interface PutIntentArgs {
  ptbBase64: string;
  intent: Intent;
  depositTarget?: DepositTarget;
  flags: RiskFlag[];
  summary: string;
  inputCoinType?: string;
  inputAmountRaw?: bigint;
  simulationUnreliable?: boolean;
}

/** 5 minutes — long enough to confirm, short enough that pool state can't drift far. */
export const INTENT_TTL_MS = 5 * 60 * 1000;

function randomId(): string {
  // Opaque local map key — not security-sensitive. Timestamp + two random
  // segments keeps collisions astronomically unlikely within a session.
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `intent_${Date.now().toString(36)}_${rand()}${rand()}`;
}

class IntentStoreImpl {
  private readonly entries = new Map<string, IntentStoreEntry>();

  /** Stash a compiled intent; returns the opaque id to hand to the LLM. */
  put(args: PutIntentArgs, now: number = Date.now()): string {
    this.sweep(now);
    const id = randomId();
    this.entries.set(id, {
      ptbBase64: args.ptbBase64,
      intent: args.intent,
      depositTarget: args.depositTarget,
      flags: args.flags,
      summary: args.summary,
      inputCoinType: args.inputCoinType,
      inputAmountRaw: args.inputAmountRaw,
      simulationUnreliable: args.simulationUnreliable,
      expiresAt: now + INTENT_TTL_MS,
    });
    return id;
  }

  /** Load by id; returns null when unknown or expired (TTL). */
  get(id: string, now: number = Date.now()): IntentStoreEntry | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.entries.delete(id);
      return null;
    }
    return entry;
  }

  /** Drop an entry once consumed (a previewed PTB signs at most once). */
  delete(id: string): void {
    this.entries.delete(id);
  }

  /** Evict expired entries — called opportunistically on `put`. */
  private sweep(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }

  /** Test-only: reset state between cases. */
  clear(): void {
    this.entries.clear();
  }
}

export { IntentStoreImpl };

export const intentStore = new IntentStoreImpl();
