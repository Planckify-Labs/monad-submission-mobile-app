/**
 * Recently / frequently used phone numbers for the Pulsa & Data screen,
 * persisted in MMKV (`storage`, id "takumipay-app"). Powers the
 * "Frequently used" chips under the phone input.
 *
 * Records are keyed by the normalized number (digits only, `62` -> `0`)
 * so the same line typed or picked from contacts dedupes. Each record
 * caches the operator name + logo URL so the chip renders offline without
 * re-detecting or re-fetching the provider logo.
 */

import { storage } from "@/lib/storage/mmkv";

const STORAGE_KEY = "pulsa_recent_numbers_v1";
const MAX_RECORDS = 12;

export interface RecentNumber {
  /** Normalized digits (dedupe key), e.g. "085930970697". */
  key: string;
  /** Number as entered, for display / prefill. */
  number: string;
  /** Optional contact name shown before the number (e.g. "Satria"). */
  label?: string;
  /** Detected provider key (from constants/ISP-list), for the logo fallback. */
  providerKey?: string;
  /** Operator display name, e.g. "Telkomsel". */
  providerName?: string;
  /** Cached operator logo URL (the product imageUrl). */
  logoUrl?: string;
  /** Times this number was used to start a purchase. */
  useCount: number;
  /** Epoch ms of the last use. */
  lastUsedAt: number;
}

/** `62xxxx`/`+62xxxx` -> `0xxxx`; strips non-digits. */
export function normalizeNumberKey(raw: string): string {
  let digits = (raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("62")) digits = `0${digits.slice(2)}`;
  return digits;
}

function readAll(): RecentNumber[] {
  const raw = storage.getString(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentNumber[]) : [];
  } catch {
    return [];
  }
}

function writeAll(records: RecentNumber[]): void {
  storage.set(STORAGE_KEY, JSON.stringify(records.slice(0, MAX_RECORDS)));
}

/** Most-used first, then most-recent. */
function sortRecords(records: RecentNumber[]): RecentNumber[] {
  return [...records].sort(
    (a, b) => b.useCount - a.useCount || b.lastUsedAt - a.lastUsedAt,
  );
}

export function getRecentNumbers(): RecentNumber[] {
  return sortRecords(readAll());
}

export interface RecordUsageInput {
  number: string;
  label?: string;
  providerKey?: string;
  providerName?: string;
  logoUrl?: string;
}

/**
 * Upsert a number on use: increments `useCount`, refreshes `lastUsedAt`,
 * and fills provider metadata (never blanks an existing field with an
 * empty one). Returns the new sorted list.
 */
export function recordNumberUsage(input: RecordUsageInput): RecentNumber[] {
  const key = normalizeNumberKey(input.number);
  if (!key) return getRecentNumbers();

  const records = readAll();
  const existing = records.find((r) => r.key === key);
  const now = Date.now();

  if (existing) {
    existing.useCount += 1;
    existing.lastUsedAt = now;
    existing.number = input.number || existing.number;
    if (input.label) existing.label = input.label;
    if (input.providerKey) existing.providerKey = input.providerKey;
    if (input.providerName) existing.providerName = input.providerName;
    if (input.logoUrl) existing.logoUrl = input.logoUrl;
  } else {
    records.push({
      key,
      number: input.number,
      label: input.label,
      providerKey: input.providerKey,
      providerName: input.providerName,
      logoUrl: input.logoUrl,
      useCount: 1,
      lastUsedAt: now,
    });
  }

  const sorted = sortRecords(records);
  writeAll(sorted);
  return sorted;
}

/** Remove one number (long-press / clear). */
export function removeRecentNumber(numberOrKey: string): RecentNumber[] {
  const key = normalizeNumberKey(numberOrKey);
  const next = readAll().filter((r) => r.key !== key);
  writeAll(next);
  return sortRecords(next);
}

export function clearRecentNumbers(): void {
  storage.remove(STORAGE_KEY);
}
