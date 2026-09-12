/**
 * Consumed-link ledger — spec §4.8 (F7, invariant S-10).
 *
 * `Linking.getInitialURL()` on Android returns the launch intent's data
 * every time the task is resumed from recents until a new intent
 * replaces it, so a payment link opened once would re-present after the
 * user backs out and re-enters. We remember `sha256(raw)` for 24 h and
 * drop a **cold-start** URL whose hash is present. Warm `url` events are
 * exempt: a user can legitimately tap the same QR twice, and the
 * on-chain nonce / blockhash / sequence number is the real replay guard
 * for those.
 *
 * Only the hash is stored, never the URL (S-15: raw URIs stay out of
 * persistent storage and logs).
 */

import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { storage } from "@/lib/storage/mmkv";

const KEY = "deeplinks.ledger.v1";
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 64;

type Ledger = Record<string, number>;

export function hashLink(raw: string): string {
  return bytesToHex(sha256(utf8ToBytes(raw)));
}

function read(): Ledger {
  try {
    const rawJson = storage.getString(KEY);
    if (!rawJson) return {};
    const parsed = JSON.parse(rawJson) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Ledger;
  } catch {
    return {};
  }
}

function write(ledger: Ledger): void {
  try {
    storage.set(KEY, JSON.stringify(ledger));
  } catch {
    // Best effort: a failed write means a possible re-present, never a crash.
  }
}

function prune(ledger: Ledger, now: number): Ledger {
  const entries = Object.entries(ledger)
    .filter(([, at]) => typeof at === "number" && now - at < TTL_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ENTRIES);
  return Object.fromEntries(entries);
}

/** `true` when this exact link was consumed within the TTL. */
export function wasConsumed(raw: string, now: number = Date.now()): boolean {
  const ledger = prune(read(), now);
  return hashLink(raw) in ledger;
}

/** Record a link as consumed. Idempotent. */
export function markConsumed(raw: string, now: number = Date.now()): void {
  const ledger = prune(read(), now);
  ledger[hashLink(raw)] = now;
  write(ledger);
}

/** Test seam. */
export function __resetLedgerForTest(): void {
  try {
    storage.remove(KEY);
  } catch {
    // ignore
  }
}
