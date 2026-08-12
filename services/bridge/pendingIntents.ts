import * as SecureStore from "expo-secure-store";
import { originKey } from "@/services/permissions/caip";
import type { ApprovalDecision, ApprovalIntent } from "./approval";

const STORAGE_KEY = "dapp_bridge.pending_intents";

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

  /**
   * Cold-start recovery: **discard the persisted queue, never re-present
   * it.** `hydrated` is a per-process latch, so this runs exactly once,
   * at boot; a screen remount reuses the in-memory queue and never comes
   * back through here. That makes "restored from storage" and "the
   * process restarted" the same event.
   *
   * The "Persist pending intents" bullet in `docs/dapp-bridge-spec.md`
   * asks for "a recoverable state (or at
   * minimum, clean rejection on boot)". Clean rejection is the correct
   * reading of the two, for two independent reasons:
   *
   *   1. **The request is already gone.** `DappBridge.pending` and the
   *      WebView that issued the JSON-RPC call both died with the
   *      process. Approving a restored intent would sign and broadcast a
   *      transaction that no page is waiting for, on behalf of a session
   *      the user can no longer see.
   *   2. **Re-presenting makes one bad intent permanent.**
   *      `ApprovalHost` is mounted only by the dApps screen, so an
   *      intent whose sheet fails took that screen down on every visit,
   *      surviving app restarts, until it aged out of the old
   *      five-minute staleness window — which is exactly the reported
   *      "wait 5-8 minutes and it works again". A tower.exchange swap
   *      did this on device: the sheet's simulation effect hit
   *      `TypeError: Cannot assign to read-only property 'toString'`
   *      (`ox` vs. the `Object.freeze(Object.prototype)` hardening in
   *      pollyfills.ts, fixed there). That trigger is gone, but
   *      re-presentation is what escalated one crash into an unopenable
   *      screen, so the escalation path is closed too.
   *
   * No decisions are synthesized for the discarded entries. The previous
   * code resolved stale ones "so DappBridge can post -32002 back to the
   * WebView", but that never worked: `handleDecision` looks the id up in
   * this queue, which by then no longer holds it, and there is no live
   * WebView request to answer after a cold start anyway. Its only real
   * effect was to arm the phase-Q drain lock, which briefly disabled
   * approve on the first genuine sheet of the session.
   */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    if (this.hydratePromise) return this.hydratePromise;
    this.hydratePromise = (async () => {
      try {
        const raw = await SecureStore.getItemAsync(STORAGE_KEY);
        if (!raw) return;
        // Purge, unconditionally and before anything else looks at it.
        //
        // Nothing writes this key any more (see the note where `persist`
        // used to be), so anything found here was written by an older
        // build and contains `intent.wallet` — i.e. a copy of the
        // wallet's `privateKey` / `seedPhrase`, stored WITHOUT the
        // `WHEN_UNLOCKED_THIS_DEVICE_ONLY` flag. This delete is the
        // migration that gets that material off the device, so it must
        // stay even though the writer is gone.
        await SecureStore.deleteItemAsync(STORAGE_KEY);
        if (__DEV__) {
          console.warn(
            "[pendingIntents] purged a legacy persisted approval queue " +
              "(written by an older build; it embedded wallet key material)",
          );
        }
      } catch (e) {
        if (__DEV__) console.warn("[pendingIntents] hydrate failed", e);
      } finally {
        this.hydrated = true;
      }
    })();
    return this.hydratePromise;
  }

  /**
   * There is deliberately NO `persist()`. This queue is memory-only.
   *
   * It used to write `JSON.stringify(this.intents)` to SecureStore, and
   * an `ApprovalIntent` carries `intent.wallet` — a `TWallet`, which
   * holds `privateKey` and `seedPhrase`. So every dApp approval copied
   * the signing key of the paying wallet into a second storage key, via
   * a bare `SecureStore.setItemAsync(key, value)` with no options.
   *
   * That is the regression `services/security/walletSecureStore.ts`
   * (TWV-2026-004) exists to prevent, in its own words: every write of
   * wallet-credential material MUST go through that wrapper so
   * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` is never omitted. Without the flag
   * the item is eligible for iCloud-Keychain sync and Android backup —
   * the exact seed-exfiltration path (MetaMask 2022) the flag closes.
   * The canonical wallet copy had the flag; this shadow copy did not.
   *
   * It was also the source of the `Value being stored in SecureStore is
   * larger than 2048 bytes` warning: a swap intent carries ~1.2 KB of
   * calldata on top of the wallet object.
   *
   * Nothing is lost by dropping it. `hydrate()` discards a restored
   * queue by design (see its note), so persistence had no reader — it
   * only widened the exposure surface of the seed. Do not reintroduce
   * it: if a future feature needs approvals to survive a restart, it
   * must persist an intent *reference*, never `intent.wallet`.
   */

  clearAll(): void {
    this.intents = [];
    this.notify();
  }

  /** Test seam — the caps and the drain window are time- and count-based. */
  __resetForTest(): void {
    this.intents = [];
    this.lastResolveAt = 0;
  }
}

// The bigint `replacer` / `reviver` pair that used to live here went with
// `persist()`. They existed only to round-trip viem's bigint fee fields
// through JSON; with the queue memory-only there is nothing to serialise,
// and re-adding them would mean re-adding the write that leaked the seed.

export const pendingIntentsStore = new PendingIntentsStore();
