/**
 * `services/push/pushRegistrationState.ts` — persists push-token
 * registration health across process restarts.
 *
 * `registerForPushNotifications` already retries a failed POST three
 * times in-process (immediate, +1s, +3s — see `index.ts`), and
 * `usePushRegistrationRetry` re-asserts on foreground, token rotation,
 * and auth-state change. Both only work while the JS process stays
 * alive: if the cold-start attempt exhausted its retries before the
 * network was ready and the app got killed before ever reaching the
 * foreground again in that process, the old in-memory-only failure flag
 * was lost — the next launch had no way to tell "we tried and failed"
 * from "never tried," so a device stuck in that loop just silently got
 * no pushes until something else (a foreground event, up to a day
 * later) happened to fire.
 *
 * This persists the same state to MMKV so a fresh launch sees it
 * immediately — `usePushRegistrationRetry` retries right away on mount
 * instead of waiting on `useWallet` to rehydrate and the boot effect in
 * `app/_layout.tsx` to fire — and so a run of failures is visible
 * (`consecutiveFailures`) instead of silent. Mirrors the shape of
 * `services/transfers/transferRecordOutbox.ts`.
 */

import { storage } from "@/lib/storage/mmkv";

export interface PushRegistrationState {
  failed: boolean;
  wallets: string[];
  lastSuccessAt: number;
  lastAttemptAt: number;
  consecutiveFailures: number;
  lastError?: string;
  /**
   * The Expo push token last successfully POSTed to the backend. Lets a
   * fresh call skip the network entirely when the token and wallet list
   * are both unchanged and the registration isn't stale — most calls
   * (every cold start, every foreground) have nothing new to say.
   */
  lastRegisteredToken?: string;
}

const STATE_KEY = "takumipay_push_registration_state";

function defaultState(): PushRegistrationState {
  return {
    failed: false,
    wallets: [],
    lastSuccessAt: 0,
    lastAttemptAt: 0,
    consecutiveFailures: 0,
  };
}

function isState(v: unknown): v is PushRegistrationState {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.failed === "boolean" &&
    Array.isArray(s.wallets) &&
    s.wallets.every((w) => typeof w === "string") &&
    typeof s.lastSuccessAt === "number" &&
    typeof s.lastAttemptAt === "number" &&
    typeof s.consecutiveFailures === "number"
  );
}

export function readPushRegistrationState(): PushRegistrationState {
  try {
    const raw = storage.getString(STATE_KEY);
    if (!raw) return defaultState();
    const parsed: unknown = JSON.parse(raw);
    return isState(parsed) ? parsed : defaultState();
  } catch {
    return defaultState();
  }
}

export function writePushRegistrationState(state: PushRegistrationState): void {
  try {
    storage.set(STATE_KEY, JSON.stringify(state));
  } catch (err) {
    if (__DEV__) console.warn("[push] failed to persist retry state:", err);
  }
}
