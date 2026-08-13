/**
 * Cached site icons for the dApps browser.
 *
 * The catalogue ships a curated `logoUrl` for every dApp it knows, but the
 * browser opens anything. A site the catalogue has never heard of used to
 * render as its first letter forever, so `tower.exchange` was a grey "T"
 * next to Uniswap's unicorn.
 *
 * The icon is read out of the page itself on every visit (see the
 * `takumi_favicon` message in `app/dapps-browser.tsx`), so a site that
 * rebrands is picked up the next time the user opens it. What is stored is
 * only a URL, never image bytes: `expo-image` already has a disk cache, and
 * MMKV is the wrong place for blobs.
 *
 * Two rules that matter more than they look:
 *
 *  - **A visit that finds no icon never erases one.** Pages report their
 *    icon after load, and a slow render, an offline hop or a page that
 *    only sets the tag late would otherwise blank an icon the user has
 *    been seeing for weeks. Absence is treated as "no news", not as "gone".
 *  - **This is browsing history by another name.** Knowing a device holds
 *    an icon for a host is knowing it visited that host, so the entries
 *    are cleared with the history, not separately (`historyStore`
 *    purges through to here).
 */

import { storage } from "@/lib/storage/mmkv";

const FAVICON_KEY = "takumipay_browser_favicons";

/** Host count, not bytes. Each entry is a URL and a timestamp. */
const MAX_ENTRIES = 300;

/**
 * Long enough for a CDN URL with a cache-busting hash, short enough that a
 * page cannot push a megabyte of `data:` into MMKV under the name of an
 * icon. Data URIs are rejected outright below.
 */
const MAX_URL_LENGTH = 512;

interface FaviconEntry {
  host: string;
  url: string;
  updatedAt: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Cached lookup handed to `useSyncExternalStore`. Identity has to survive
 * between mutations: building a fresh Map inside `getSnapshot` is an
 * infinite re-render.
 */
let snapshot: ReadonlyMap<string, string> | null = null;

function emit(): void {
  snapshot = null;
  for (const listener of listeners) listener();
}

function read(): FaviconEntry[] {
  const raw = storage.getString(FAVICON_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is FaviconEntry =>
        Boolean(entry) &&
        typeof entry.host === "string" &&
        typeof entry.url === "string" &&
        typeof entry.updatedAt === "number",
    );
  } catch {
    return [];
  }
}

function write(entries: FaviconEntry[]): void {
  storage.set(FAVICON_KEY, JSON.stringify(entries));
}

/**
 * What we are willing to render and keep. `https` only, because the
 * WebView refuses mixed content anyway and an icon is not worth an
 * exception; no `data:`, because those belong in the page, not on disk.
 */
export function isStorableIconUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return false;
  return /^https:\/\/[^\s]+$/i.test(trimmed);
}

export const FaviconStore = {
  /** host -> icon URL. Stable identity until the next write. */
  map(): ReadonlyMap<string, string> {
    if (snapshot === null) {
      const next = new Map<string, string>();
      for (const entry of read()) next.set(entry.host, entry.url);
      snapshot = next;
    }
    return snapshot;
  },

  get(host: string): string | undefined {
    return FaviconStore.map().get(host);
  },

  /**
   * Records the icon a page reported. Anything unusable is ignored rather
   * than stored as a blank, which is what keeps a known-good icon on
   * screen when a later visit reports nothing.
   */
  record({ host, url }: { host: string; url: unknown }): void {
    if (!host || !isStorableIconUrl(url)) return;

    const entries = read();
    const existing = entries.find((entry) => entry.host === host);
    const unchanged = existing?.url === url;

    // Most-recently-seen first, and eviction takes from the tail. Ordering
    // by `updatedAt` instead would be at the mercy of clock resolution:
    // entries written inside the same millisecond tie, a stable sort then
    // preserves insertion order, and the cap evicts the newest rather than
    // the oldest. Position is the ordering; `updatedAt` is only reporting.
    const next: FaviconEntry[] = [
      { host, url, updatedAt: unchanged ? existing.updatedAt : Date.now() },
      ...entries.filter((entry) => entry.host !== host),
    ];
    write(next.slice(0, MAX_ENTRIES));

    // A revisit that reports the icon we already hold still counts as a
    // visit for eviction, but nothing observable changed, so listeners are
    // left alone rather than re-rendering every list on each page load.
    if (!unchanged) emit();
  },

  remove(host: string): void {
    const entries = read();
    const next = entries.filter((entry) => entry.host !== host);
    if (next.length === entries.length) return;
    write(next);
    emit();
  },

  clear(): void {
    write([]);
    emit();
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
