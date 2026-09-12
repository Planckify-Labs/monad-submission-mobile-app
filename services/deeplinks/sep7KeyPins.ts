/**
 * Per-domain `URI_REQUEST_SIGNING_KEY` pins — SEP-0007 rule 5 (spec §6.4).
 *
 * "Wallets should cache the last used `URI_REQUEST_SIGNING_KEY` for a
 * given domain and only use the cached value to compare it to the latest
 * signing key retrieved; if the latest signing key differs … the wallet
 * must alert the user." The toml itself is never cached (rule 4).
 *
 * Pins never expire (D-16); a changed key blocks until the user
 * explicitly trusts the new one behind biometrics.
 */

import { storage } from "@/lib/storage/mmkv";

const KEY = "deeplinks.sep7.keypins.v1";

type Pins = Record<string, { key: string; pinnedAt: number }>;

function read(): Pins {
  try {
    const raw = storage.getString(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Pins) : {};
  } catch {
    return {};
  }
}

function write(pins: Pins): void {
  try {
    storage.set(KEY, JSON.stringify(pins));
  } catch {
    // best effort
  }
}

export const sep7KeyPins = {
  get(domain: string): string | null {
    return read()[domain.toLowerCase()]?.key ?? null;
  },
  /** `true` when the domain had no pin before (first contact). */
  pin(domain: string, key: string): boolean {
    const pins = read();
    const d = domain.toLowerCase();
    const first = !pins[d];
    pins[d] = { key, pinnedAt: Date.now() };
    write(pins);
    return first;
  },
  /** Compare the fetched key with the pin. */
  check(domain: string, key: string): "unpinned" | "match" | "changed" {
    const pinned = this.get(domain);
    if (pinned === null) return "unpinned";
    return pinned === key ? "match" : "changed";
  },
  __resetForTest(): void {
    try {
      storage.remove(KEY);
    } catch {
      // ignore
    }
  },
};
