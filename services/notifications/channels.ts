/**
 * Notification channel definitions and preferences.
 */

import * as SQLite from "expo-sqlite";

export type NotificationChannel =
  | "tx-confirmed"
  | "tx-failed"
  | "approval-detected"
  | "token-received"
  | "nft-received"
  | "security-alert"
  | "price-alert"
  | "dapp-request";

export interface ChannelConfig {
  id: NotificationChannel;
  label: string;
  description: string;
  category: "transactions" | "security" | "transfers" | "market";
  defaultEnabled: boolean;
  alwaysOn: boolean;
}

export const CHANNELS: ChannelConfig[] = [
  {
    id: "tx-confirmed",
    label: "Transaction Confirmed",
    description: "When your transaction is confirmed",
    category: "transactions",
    defaultEnabled: true,
    alwaysOn: false,
  },
  {
    id: "tx-failed",
    label: "Transaction Failed",
    description: "When your transaction fails or is dropped",
    category: "transactions",
    defaultEnabled: true,
    alwaysOn: false,
  },
  {
    id: "approval-detected",
    label: "New Approval Detected",
    description: "When a new unlimited approval is detected",
    category: "security",
    defaultEnabled: true,
    alwaysOn: false,
  },
  {
    id: "security-alert",
    label: "Security Alert",
    description: "Critical security notifications",
    category: "security",
    defaultEnabled: true,
    alwaysOn: true,
  },
  {
    id: "dapp-request",
    label: "Connected App Requests",
    description:
      "When a connected app sends a request while TakumiPay is in the background",
    category: "security",
    defaultEnabled: true,
    alwaysOn: true,
  },
  {
    id: "token-received",
    label: "Token Received",
    description: "When you receive tokens",
    category: "transfers",
    defaultEnabled: true,
    alwaysOn: false,
  },
  {
    id: "nft-received",
    label: "NFT Received",
    description: "When you receive an NFT",
    category: "transfers",
    defaultEnabled: true,
    alwaysOn: false,
  },
  {
    id: "price-alert",
    label: "Price Alert",
    description: "Token price movement alerts",
    category: "market",
    defaultEnabled: false,
    alwaysOn: false,
  },
];

let db: SQLite.SQLiteDatabase | null = null;

function getDb(): SQLite.SQLiteDatabase {
  if (!db) {
    db = SQLite.openDatabaseSync("notifications.db");
    db.execSync(
      "CREATE TABLE IF NOT EXISTS channel_prefs (channel_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);",
    );
    db.execSync(
      "CREATE TABLE IF NOT EXISTS notification_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );
  }
  return db;
}

export function isChannelEnabled(channelId: NotificationChannel): boolean {
  const channel = CHANNELS.find((c) => c.id === channelId);
  if (!channel) return false;
  if (channel.alwaysOn) return true;
  if (isPaused()) return false;

  const database = getDb();
  const row = database.getFirstSync<{ enabled: number }>(
    "SELECT enabled FROM channel_prefs WHERE channel_id = ?",
    [channelId],
  );
  return row ? row.enabled === 1 : channel.defaultEnabled;
}

export function setChannelEnabled(
  channelId: NotificationChannel,
  enabled: boolean,
): void {
  const channel = CHANNELS.find((c) => c.id === channelId);
  if (channel?.alwaysOn) return;
  const database = getDb();
  database.runSync(
    "INSERT OR REPLACE INTO channel_prefs (channel_id, enabled) VALUES (?, ?)",
    [channelId, enabled ? 1 : 0],
  );
}

export function getAllChannelPrefs(): Record<NotificationChannel, boolean> {
  const result = {} as Record<NotificationChannel, boolean>;
  for (const channel of CHANNELS)
    result[channel.id] = isChannelEnabled(channel.id);
  return result;
}

export function isPaused(): boolean {
  const database = getDb();
  const row = database.getFirstSync<{ value: string }>(
    "SELECT value FROM notification_settings WHERE key = ?",
    ["paused"],
  );
  return row?.value === "true";
}

export function setPaused(paused: boolean): void {
  const database = getDb();
  database.runSync(
    "INSERT OR REPLACE INTO notification_settings (key, value) VALUES (?, ?)",
    ["paused", paused ? "true" : "false"],
  );
}
