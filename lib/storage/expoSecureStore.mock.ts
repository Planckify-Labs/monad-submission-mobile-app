/**
 * `expo-secure-store` stub for vitest.
 *
 * The real module is a native module and cannot load outside the app
 * runtime, so anything that persists through it — the dApp bridge's
 * pending-approval queue, wallet storage — is untestable without this.
 *
 * In-memory rather than a no-op: a store that silently forgets makes
 * round-trip behaviour pass by accident. Twin of the `expo-secure-store`
 * stub in `services/walletKit/evm/_test-resolver-hook.mjs`; keep the two
 * in step, per the RN-native-module stubbing rule.
 */

export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = "whenUnlockedThisDeviceOnly";
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY =
  "afterFirstUnlockThisDeviceOnly";

const store = new Map<string, string>();

export async function getItemAsync(key: string): Promise<string | null> {
  return store.get(key) ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  store.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  store.delete(key);
}

export function __resetSecureStore(): void {
  store.clear();
}

/**
 * Every value currently held, concatenated. Lets a test assert that a
 * secret did not reach *any* key, not just the one it expected — the
 * pending-approval queue leaked `privateKey` through a key nobody was
 * checking (TWV-2026-004).
 */
export function __dumpSecureStore(): string {
  return [...store.entries()].map(([k, v]) => `${k}=${v}`).join("\n");
}

export default {
  getItemAsync,
  setItemAsync,
  deleteItemAsync,
};
