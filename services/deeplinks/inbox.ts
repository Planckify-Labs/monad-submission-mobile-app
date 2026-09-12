/**
 * In-memory hold for intents that need the user's consent before anything
 * happens — spec §4.2 / §4.8.
 *
 * `+native-intent` runs outside the app (no lock state, no React), so it
 * can never navigate straight into content. Anything that carries intent
 * is placed here and the router is pointed at `/link-inbox`, which
 * renders beneath the LockScreen and drains this queue one item at a
 * time after unlock.
 *
 * Bounded (max 3, FIFO) and short-lived (5 minutes) so a burst of links
 * cannot pile up sheets and a stale link cannot surprise the user an hour
 * later. Never persisted: a restart discards it (same posture as
 * `pendingIntentsStore`).
 */

import type { DeepLinkEnvelope, DeepLinkIntent } from "./types";

export const INBOX_MAX = 3;
export const INBOX_TTL_MS = 5 * 60 * 1000;

export interface InboxItem {
  id: string;
  envelope: DeepLinkEnvelope;
  intent: DeepLinkIntent;
  heldAt: number;
}

type Listener = (items: InboxItem[]) => void;

let items: InboxItem[] = [];
const listeners = new Set<Listener>();
let counter = 0;

function notify(): void {
  const snap = [...items];
  for (const l of listeners) {
    try {
      l(snap);
    } catch (e) {
      if (typeof __DEV__ !== "undefined" && __DEV__)
        console.warn("[deeplinks/inbox] listener threw", e);
    }
  }
}

function expire(now: number): void {
  const before = items.length;
  items = items.filter((i) => now - i.heldAt < INBOX_TTL_MS);
  if (items.length !== before) notify();
}

export const linkInbox = {
  /** Hold an intent. Oldest is dropped when the cap is hit (S-11). */
  hold(
    envelope: DeepLinkEnvelope,
    intent: DeepLinkIntent,
    now: number = Date.now(),
  ): InboxItem {
    expire(now);
    const item: InboxItem = {
      id: `link-${++counter}-${now.toString(36)}`,
      envelope,
      intent,
      heldAt: now,
    };
    items = [...items, item];
    while (items.length > INBOX_MAX) items.shift();
    notify();
    return item;
  },

  /** The oldest held item, or `null`. */
  peek(now: number = Date.now()): InboxItem | null {
    expire(now);
    return items[0] ?? null;
  },

  /** Remove one item (Continue / Dismiss / expiry). */
  consume(id: string): InboxItem | null {
    const found = items.find((i) => i.id === id) ?? null;
    if (found) {
      items = items.filter((i) => i.id !== id);
      notify();
    }
    return found;
  },

  snapshot(now: number = Date.now()): InboxItem[] {
    expire(now);
    return [...items];
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    listener([...items]);
    return () => {
      listeners.delete(listener);
    };
  },

  /** Test seam. */
  __resetForTest(): void {
    items = [];
    counter = 0;
  },
};
