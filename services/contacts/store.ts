/**
 * Address book CRUD with expo-sqlite persistence.
 */

import * as SQLite from "expo-sqlite";
import { foldAddressForKey } from "@/services/chains/addressCompare";
import type { Contact, ContactAddress } from "./types";

let db: SQLite.SQLiteDatabase | null = null;

function getDb(): SQLite.SQLiteDatabase {
  if (!db) {
    db = SQLite.openDatabaseSync("contacts.db");
    db.execSync(
      "CREATE TABLE IF NOT EXISTS contacts (" +
        "id TEXT PRIMARY KEY, " +
        "label TEXT NOT NULL, " +
        "addresses TEXT NOT NULL, " +
        "notes TEXT, " +
        "created_at INTEGER NOT NULL, " +
        "last_used_at INTEGER NOT NULL" +
        ");",
    );
    db.execSync(
      "CREATE TABLE IF NOT EXISTS send_counts (" +
        "address TEXT PRIMARY KEY, " +
        "count INTEGER NOT NULL DEFAULT 0" +
        ");",
    );
  }
  return db;
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function addContact(
  contact: Omit<Contact, "id" | "createdAt" | "lastUsedAt">,
): Contact {
  const database = getDb();
  const id = genId();
  const now = Date.now();
  const entry: Contact = { ...contact, id, createdAt: now, lastUsedAt: now };

  database.runSync(
    "INSERT INTO contacts (id, label, addresses, notes, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      id,
      entry.label,
      JSON.stringify(entry.addresses),
      entry.notes ?? null,
      now,
      now,
    ],
  );
  return entry;
}

export function updateContact(
  id: string,
  patch: Partial<Pick<Contact, "label" | "addresses" | "notes">>,
): void {
  const database = getDb();
  const existing = getContactById(id);
  if (!existing) return;
  const updated = { ...existing, ...patch };
  database.runSync(
    "UPDATE contacts SET label = ?, addresses = ?, notes = ? WHERE id = ?",
    [
      updated.label,
      JSON.stringify(updated.addresses),
      updated.notes ?? null,
      id,
    ],
  );
}

export function deleteContact(id: string): void {
  const database = getDb();
  database.runSync("DELETE FROM contacts WHERE id = ?", [id]);
}

export function getContactById(id: string): Contact | null {
  const database = getDb();
  const row = database.getFirstSync<{
    id: string;
    label: string;
    addresses: string;
    notes: string | null;
    created_at: number;
    last_used_at: number;
  }>("SELECT * FROM contacts WHERE id = ?", [id]);
  if (!row) return null;
  return rowToContact(row);
}

export function getContacts(opts?: {
  search?: string;
  namespace?: string;
}): Contact[] {
  const database = getDb();
  let query = "SELECT * FROM contacts";
  const params: unknown[] = [];

  if (opts?.search) {
    query += " WHERE label LIKE ? OR addresses LIKE ?";
    const term = `%${opts.search}%`;
    params.push(term, term);
  }
  query += " ORDER BY last_used_at DESC";

  const rows = database.getAllSync<{
    id: string;
    label: string;
    addresses: string;
    notes: string | null;
    created_at: number;
    last_used_at: number;
  }>(query, params as (string | number | null)[]);

  let contacts = rows.map(rowToContact);
  if (opts?.namespace) {
    contacts = contacts.filter((c) =>
      c.addresses.some((a) => a.namespace === opts.namespace),
    );
  }
  return contacts;
}

export function touchContact(id: string): void {
  const database = getDb();
  database.runSync("UPDATE contacts SET last_used_at = ? WHERE id = ?", [
    Date.now(),
    id,
  ]);
}

export function incrementSendCount(address: string): void {
  const database = getDb();
  database.runSync(
    "INSERT INTO send_counts (address, count) VALUES (?, 1) ON CONFLICT(address) DO UPDATE SET count = count + 1",
    // Fold EVM/Sui for dedup, but keep Solana/Stellar verbatim — a lowercased
    // base58/base32 address is a different (invalid) address, and this value
    // is returned as a send target by getFrequentRecipients().
    [foldAddressForKey(address)],
  );
}

export function getFrequentRecipients(minCount: number = 3): string[] {
  const database = getDb();
  const rows = database.getAllSync<{ address: string }>(
    "SELECT address FROM send_counts WHERE count >= ? ORDER BY count DESC",
    [minCount],
  );
  const contacts = getContacts();
  const savedAddresses = new Set(
    contacts.flatMap((c) => c.addresses.map((a) => foldAddressForKey(a.address))),
  );
  return rows.map((r) => r.address).filter((addr) => !savedAddresses.has(addr));
}

function rowToContact(row: {
  id: string;
  label: string;
  addresses: string;
  notes: string | null;
  created_at: number;
  last_used_at: number;
}): Contact {
  return {
    id: row.id,
    label: row.label,
    addresses: JSON.parse(row.addresses) as ContactAddress[],
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}
