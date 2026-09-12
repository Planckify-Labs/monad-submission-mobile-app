/**
 * Process-wide app-lock flag, readable outside React.
 *
 * `AppLockedContext` in `app/_layout.tsx` is the React-side truth; this
 * module mirrors it for non-React consumers that must not present
 * anything above the lock screen: `ApprovalHost` (renders `null` while
 * locked), `pendingIntentsStore` (paused while locked) and the deep-link
 * inbox drain (spec §4.8, invariant S-9). `AppShell` writes it whenever
 * the lock state changes; nothing else may.
 */

type Listener = (locked: boolean) => void;

let locked = false;
const listeners = new Set<Listener>();

export function isAppLocked(): boolean {
  return locked;
}

export function setAppLocked(next: boolean): void {
  if (locked === next) return;
  locked = next;
  for (const l of listeners) {
    try {
      l(next);
    } catch (e) {
      if (typeof __DEV__ !== "undefined" && __DEV__)
        console.warn("[appLockState] listener threw", e);
    }
  }
}

export function subscribeAppLocked(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam. */
export function __resetAppLockStateForTest(): void {
  locked = false;
  listeners.clear();
}
