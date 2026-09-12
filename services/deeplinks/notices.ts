/**
 * Transient user notices raised by transports outside any screen —
 * "This app is flagged as malicious", "Sent back to Uniswap.", a
 * callback delivery result. Rendered by `DeepLinkNoticeHost` at the
 * root. Copy is fixed and hand-written by the caller; nothing here is
 * ever a raw error.
 */

export interface DeepLinkNotice {
  id: string;
  title: string;
  body: string;
  /** Optional single action (e.g. "Return to {app}"). */
  action?: { label: string; onPress: () => void };
  /** Auto-dismiss after this many ms; omit for a modal the user closes. */
  autoDismissMs?: number;
}

type Listener = (notices: DeepLinkNotice[]) => void;

let notices: DeepLinkNotice[] = [];
const listeners = new Set<Listener>();
let counter = 0;

function notify(): void {
  const snap = [...notices];
  for (const l of listeners) {
    try {
      l(snap);
    } catch {
      // ignore
    }
  }
}

export const deepLinkNotices = {
  push(n: Omit<DeepLinkNotice, "id">): string {
    const id = `notice-${++counter}`;
    notices = [...notices, { ...n, id }].slice(-3);
    notify();
    return id;
  },
  dismiss(id: string): void {
    const before = notices.length;
    notices = notices.filter((n) => n.id !== id);
    if (notices.length !== before) notify();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    listener([...notices]);
    return () => {
      listeners.delete(listener);
    };
  },
  __resetForTest(): void {
    notices = [];
  },
};
