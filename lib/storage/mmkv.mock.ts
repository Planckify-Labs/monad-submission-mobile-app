/**
 * In-memory twin of `lib/storage/mmkv.ts` for vitest.
 *
 * `react-native-mmkv` is a Nitro native module and cannot load outside the
 * app runtime, so any pure-logic test that transitively reaches the
 * storage helper needs this at the module boundary. Mirrors the node-side
 * stub in `services/walletKit/evm/_test-resolver-hook.mjs`
 * (`feedback_rn_native_module_stubbing`: stub in BOTH harnesses or a test
 * passes under one runner and fails under the other).
 *
 * Deliberately a REAL map rather than a no-op: modules that persist
 * through it are only meaningfully testable if a write can be read back.
 */

function createMemoryStore() {
  const mem = new Map<string, string>();
  return {
    getString: (key: string): string | undefined => mem.get(key),
    getBoolean: (key: string): boolean | undefined => {
      const v = mem.get(key);
      return v === undefined ? undefined : v === "true";
    },
    getNumber: (key: string): number | undefined => {
      const v = mem.get(key);
      return v === undefined ? undefined : Number(v);
    },
    set: (key: string, value: string | number | boolean): void => {
      mem.set(key, String(value));
    },
    remove: (key: string): void => {
      mem.delete(key);
    },
    delete: (key: string): void => {
      mem.delete(key);
    },
    clearAll: (): void => {
      mem.clear();
    },
  };
}

export const storage = createMemoryStore();
export const queryCache = createMemoryStore();
