/**
 * Synchronous access to the last-known `/blockchains` catalogue.
 *
 * `hooks/useBlockchainsWithStorage.ts` and `hooks/queries/useBlockchains.ts`
 * persist the full feed to MMKV under these keys so React screens can
 * seed `initialData` on frame 0. Non-React callers (the deep-link kernel,
 * the root bridge boot, transports) need the same rows without a hook;
 * this module is that reader. Read-only: the hooks own the writes.
 */

import type { TBlockchain } from "@/api/types/blockchain";
import { storage } from "@/lib/storage/mmkv";

export const BLOCKCHAIN_STORAGE_KEY = "cached_blockchains";
export const BLOCKCHAIN_TIMESTAMP_KEY = "cached_blockchains_timestamp";

/** `null` when nothing has been cached yet (first launch, offline). */
export function readCachedBlockchainRows(): TBlockchain[] | null {
  try {
    const raw = storage.getString(BLOCKCHAIN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as TBlockchain[]) : null;
  } catch {
    return null;
  }
}

/** Active rows only — the same filter every screen applies. */
export function readActiveBlockchainRows(): TBlockchain[] | null {
  const rows = readCachedBlockchainRows();
  return rows ? rows.filter((r) => r.isActive !== false) : null;
}
