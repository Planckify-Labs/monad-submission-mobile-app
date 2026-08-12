import * as SecureStore from "expo-secure-store";
import { originKey } from "@/services/permissions/caip";
import type { ApprovalDecision, ApprovalIntent } from "./approval";

const STORAGE_KEY = "dapp_bridge.pending_intents";
const STALE_MS = 5 * 60 * 1000;

/**
 * Queue caps — spec phase Q.
 *
 * `ppom/batching.js` fires ten un-awaited `eth_sendTransaction` calls in
 * a loop. `DappBridge.enqueue` already refuses the second and later
 * request *from the same origin* with -32002, so that specific loop does
 * not reach this store ten deep. These caps exist for the paths that
 * guard does not cover: several origins, the re-push in
 * `runOnDemandInspector`, and a persisted queue restored from storage.
 *
 * A dApp with a legitimate need for a dozen simultaneous approvals does
 * not exist. `wallet_sendCalls` is the supported way to ask for many
 * actions at once, and it is the one that gets a single reviewable sheet.
 */
const MAX_PENDING_TOTAL = 8;
const MAX_PENDING_PER_ORIGIN = 2;

/**
 * How long after one sheet resolves a newly-presented one keeps its
 * approve button inert.
 *
 * This is the phase-Q finding that is not about counting. Rejecting a
 * request paints the next one **instantly, in the same place**, so the
 * reject button of sheet *n* sits under the finger that is about to
 * approve sheet *n+1*. Nine rejections train the muscle and the tenth is
 * a drain. The attack is a mis-tap, not a crash, and no cap prevents it.
 */
export const QUEUE_INPUT_LOCK_MS = 700;
/** A sheet counts as "presented during a drain" within this window. */
export const QUEUE_DRAIN_WINDOW_MS = 1500;

type Listener = (intents: ApprovalIntent[]) => void;
type ResolveListener = (id: string, decision: ApprovalDecision) => void;

class PendingIntentsStore {
  private intents: ApprovalIntent[] = [];
  private listeners = new Set<Listener>();
  private resolveListeners = new Set<ResolveListener>();
  private hydrated = false;
  private hydratePromise: Promise<void> | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener([...this.intents]);
    return () => this.listeners.delete(listener);
  }

  onResolve(listener: ResolveListener): () => void {
    this.resolveListeners.add(listener);
    return () => this.resolveListeners.delete(listener);
  }

  get snapshot(): ApprovalIntent[] {
    return [...this.intents];
  }

  /**
   * Returns `false` when a cap refused the intent, so the caller can
   * answer the dApp with `resourceUnavailable` rather than growing the
   * queue without bound.
   */
  push(intent: ApprovalIntent): boolean {
    if (this.intents.length >= MAX_PENDING_TOTAL) return false;
    const host = originKey(intent.origin.url);
    const fromOrigin = this.intents.filter(
      (i) => originKey(i.origin.url) === host,
    ).length;
    if (fromOrigin >= MAX_PENDING_PER_ORIGIN) return false;
    this.intents = [...this.intents, intent];
    this.notify();
    void this.persist();
    return true;
  }

  /** When the last decision was delivered, for the input-lock window. */
  private lastResolveAt = 0;

  /**
   * True when a sheet appearing right now is appearing *because* another
   * one just went away, which is when a queued approve tap is most
   * likely to land on something the user has not read.
   */
  isDraining(): boolean {
    return Date.now() - this.lastResolveAt < QUEUE_DRAIN_WINDOW_MS;
  }

  /**
   * Emits a decision to listeners but does not remove — caller removes after
   * execution completes so UI can show a transient "executing" state.
   */
  resolve(id: string, decision: ApprovalDecision): void {
    this.lastResolveAt = Date.now();
    for (const l of this.resolveListeners) {
      try {
        l(id, decision);
      } catch (e) {
        if (__DEV__) console.warn("[pendingIntents] resolve listener threw", e);
      }
    }
  }

  remove(id: string): void {
    const before = this.intents.length;
    this.intents = this.intents.filter((i) => i.id !== id);
    if (this.intents.length !== before) {
      this.notify();
      void this.persist();
    }
  }

  private notify(): void {
    const snap = [...this.intents];
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch (e) {
        if (__DEV__) console.warn("[pendingIntents] listener threw", e);
      }
    }
  }

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    if (this.hydratePromise) return this.hydratePromise;
    this.hydratePromise = (async () => {
      try {
        const raw = await SecureStore.getItemAsync(STORAGE_KEY);
        if (!raw) {
          this.hydrated = true;
          return;
        }
        const parsed = JSON.parse(raw, reviver) as ApprovalIntent[];
        if (Array.isArray(parsed)) {
          const now = Date.now();
          const { stale, fresh } = parsed.reduce<{
            stale: ApprovalIntent[];
            fresh: ApprovalIntent[];
          }>(
            (acc, intent) => {
              if (now - intent.createdAt > STALE_MS) acc.stale.push(intent);
              else acc.fresh.push(intent);
              return acc;
            },
            { stale: [], fresh: [] },
          );
          // Phase Q — the cap applies to a restored queue too. A
          // persisted list is one of the few ways to arrive here already
          // deeper than any live path allows.
          this.intents = fresh.slice(0, MAX_PENDING_TOTAL);
          for (const dropped of fresh.slice(MAX_PENDING_TOTAL)) {
            this.resolve(dropped.id, { id: dropped.id, outcome: "reject" });
          }
          this.notify();
          // Synthesize reject decisions for stale intents so the dApp
          // observer (DappBridge) can post -32002 back to the WebView.
          for (const s of stale) {
            this.resolve(s.id, { id: s.id, outcome: "reject" });
          }
        }
      } catch (e) {
        if (__DEV__) console.warn("[pendingIntents] hydrate failed", e);
      } finally {
        this.hydrated = true;
      }
    })();
    return this.hydratePromise;
  }

  private async persist(): Promise<void> {
    try {
      await SecureStore.setItemAsync(
        STORAGE_KEY,
        JSON.stringify(this.intents, replacer),
      );
    } catch (e) {
      if (__DEV__) console.warn("[pendingIntents] persist failed", e);
    }
  }

  clearAll(): void {
    this.intents = [];
    this.notify();
    void this.persist();
  }

  /** Test seam — the caps and the drain window are time- and count-based. */
  __resetForTest(): void {
    this.intents = [];
    this.lastResolveAt = 0;
  }
}

// bigint is not JSON-serializable — encode as {__b:"0x…"} on the way out and
// decode on the way in. Intents in flight carry viem bigints in fee fields.
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return { __b: `0x${value.toString(16)}` };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "__b" in value &&
    typeof (value as { __b: unknown }).__b === "string"
  ) {
    return BigInt((value as { __b: string }).__b);
  }
  return value;
}

export const pendingIntentsStore = new PendingIntentsStore();
