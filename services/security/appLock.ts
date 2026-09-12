/**
 * App lock state machine: biometric + PIN authentication.
 */

import * as LocalAuthentication from "expo-local-authentication";
import * as SQLite from "expo-sqlite";

export type LockState = "unset" | "locked" | "unlocked";
export type LockMethod = "biometric" | "pin" | "biometric+pin";

interface AppLockConfig {
  lockMethod: LockMethod;
  timeoutSeconds: number;
  perActionAuthEnabled: boolean;
  smallAmountThreshold: number;
}

const DEFAULT_CONFIG: AppLockConfig = {
  lockMethod: "biometric",
  timeoutSeconds: 30,
  perActionAuthEnabled: true,
  smallAmountThreshold: 10,
};

let currentState: LockState = "unset";
let lastUnlockedAt = 0;
let db: SQLite.SQLiteDatabase | null = null;

function getDb(): SQLite.SQLiteDatabase {
  if (!db) {
    db = SQLite.openDatabaseSync("app_lock.db");
    db.execSync(
      "CREATE TABLE IF NOT EXISTS lock_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );
  }
  return db;
}

export function getConfig(): AppLockConfig {
  const database = getDb();
  const row = database.getFirstSync<{ value: string }>(
    "SELECT value FROM lock_config WHERE key = ?",
    ["config"],
  );
  if (!row) return DEFAULT_CONFIG;
  return { ...DEFAULT_CONFIG, ...JSON.parse(row.value) };
}

export function saveConfig(config: Partial<AppLockConfig>): void {
  const existing = getConfig();
  const merged = { ...existing, ...config };
  const database = getDb();
  database.runSync(
    "INSERT OR REPLACE INTO lock_config (key, value) VALUES (?, ?)",
    ["config", JSON.stringify(merged)],
  );
}

// TWV-2026-061 — the PIN here is the recovery "app password". It
// unlocks the wallet when the biometric set is invalidated (user
// enrolled a new Face ID / fingerprint) and gates every in-app action on
// a device with no screen lock. Storage and KDF (Argon2id via the
// native quick-crypto primitive) live in `pinStore.ts`, which is also
// what `hooks/usePin.ts` and the PIN modals use, so there is one PIN.
// Re-exported here so lock-state callers keep a single import.
export { clearPin, isPinSet, setPin, verifyPin } from "./pinStore";

// TWV-2026-061 — biometric-set change handler. Any caller that observes
// `LAError.BiometryLockout` / `BiometricPrompt.ERROR_LOCKOUT_PERMANENT`
// or equivalent should route here: wipe cached signing state and force
// the user back through the PIN recovery screen. The biometric binding
// on the signing key entry itself is invalidated at the OS level
// (iOS kSecAccessControlBiometryCurrentSet; Android Keystore
// setInvalidatedByBiometricEnrollment(true) — configured in the native
// module / expo-secure-store config; see the runbook).
export type BiometricInvalidationHandler = () => void | Promise<void>;

const invalidationHandlers: Set<BiometricInvalidationHandler> = new Set();

export function onBiometricInvalidated(
  handler: BiometricInvalidationHandler,
): () => void {
  invalidationHandlers.add(handler);
  return () => invalidationHandlers.delete(handler);
}

export async function fireBiometricInvalidated(): Promise<void> {
  currentState = "locked";
  for (const h of invalidationHandlers) {
    try {
      await h();
    } catch (e) {
      if (__DEV__) console.warn("[appLock] invalidation handler threw", e);
    }
  }
}

export function getLockState(): LockState {
  return currentState;
}

export function setLockState(state: LockState): void {
  currentState = state;
  if (state === "unlocked") lastUnlockedAt = Date.now();
}

export function isLockEnabled(): boolean {
  return currentState !== "unset";
}

export function shouldLockOnForeground(): boolean {
  if (currentState !== "unlocked") return false;
  const config = getConfig();
  return (Date.now() - lastUnlockedAt) / 1000 > config.timeoutSeconds;
}

export async function isBiometricAvailable(): Promise<boolean> {
  const result = await LocalAuthentication.hasHardwareAsync();
  if (!result) return false;
  return LocalAuthentication.isEnrolledAsync();
}

export async function authenticateBiometric(reason?: string): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: reason ?? "Authenticate to continue",
    fallbackLabel: "Use PIN",
    disableDeviceFallback: true,
  });
  return result.success;
}

export function requiresPerActionAuth(
  action: "sign" | "send" | "export" | "revoke" | "wipe",
  amountUsd?: number,
): boolean {
  if (action === "export" || action === "wipe") return true;
  const config = getConfig();
  if (!config.perActionAuthEnabled) return false;
  if (
    action === "send" &&
    amountUsd != null &&
    amountUsd < config.smallAmountThreshold
  )
    return false;
  return true;
}
