/**
 * Imperative bridge to the in-app PIN sheet.
 *
 * `authenticateUser()` is a plain async function with no React context,
 * but on a device with no screen lock the only secret we can verify is
 * the app PIN, and that UI lives in `PinConfirmationModal`. A caller
 * parks a promise here via `requestPinConfirmation`; `PinGateHost`
 * (root-mounted in `app/_layout.tsx`) renders the sheet for the pending
 * request and settles the promise through `resolvePinGate`.
 *
 * One request at a time. A second caller while a sheet is already up
 * resolves `false` immediately rather than queueing a surprise second
 * sheet behind the first.
 */

export type PinGateRequest = {
  id: number;
  /** Sheet title. Callers pass the same reason they give the OS prompt. */
  title: string;
};

type Pending = PinGateRequest & { resolve: (ok: boolean) => void };

let pending: Pending | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      if (typeof __DEV__ !== "undefined" && __DEV__)
        console.warn("[pinGate] listener threw", e);
    }
  }
}

export function requestPinConfirmation(title: string): Promise<boolean> {
  if (pending) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending = { id: nextId++, title, resolve };
    emit();
  });
}

export function resolvePinGate(ok: boolean): void {
  const settled = pending;
  if (!settled) return;
  pending = null;
  emit();
  settled.resolve(ok);
}

/** Stable reference until the request changes (for `useSyncExternalStore`). */
export function getPinGateRequest(): PinGateRequest | null {
  return pending;
}

export function subscribePinGate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam. */
export function __resetPinGateForTest(): void {
  pending = null;
  nextId = 1;
  listeners.clear();
}
