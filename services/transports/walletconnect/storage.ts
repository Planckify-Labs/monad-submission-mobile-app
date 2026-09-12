/**
 * WalletConnect storage — `IKeyValueStorage` + `IKeyChain` over one
 * encrypted MMKV instance (`wc.v1`), spec §7.2 / TWV-2026-030.
 *
 * `Core({ storage, keychain })` accepts both (verified against
 * `@walletconnect/types` `core.ts`). The keychain (session symmetric
 * keys) uses the same instance under its own prefix so a device backup
 * or an `adb` pull never sees a plaintext relay key.
 */

import type { MMKV } from "react-native-mmkv";
import { openEncryptedMmkv } from "@/services/security/encryptedMmkv";

export const WC_MMKV_ID = "wc.v1";
export const WC_MMKV_SECURE_KEY = "wc.mmkv.key.v1";
const KV_PREFIX = "kv:";
const KEYCHAIN_PREFIX = "keychain:";

export interface WcKeyValueStorage {
  getKeys(): Promise<string[]>;
  getEntries<T = unknown>(): Promise<[string, T][]>;
  getItem<T = unknown>(key: string): Promise<T | undefined>;
  setItem<T = unknown>(key: string, value: T): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function createWcStorage(mmkv: MMKV): WcKeyValueStorage {
  const all = () => mmkv.getAllKeys().filter((k) => k.startsWith(KV_PREFIX));
  return {
    async getKeys() {
      return all().map((k) => k.slice(KV_PREFIX.length));
    },
    async getEntries<T>() {
      const out: [string, T][] = [];
      for (const k of all()) {
        const raw = mmkv.getString(k);
        if (raw === undefined) continue;
        try {
          out.push([k.slice(KV_PREFIX.length), JSON.parse(raw) as T]);
        } catch {
          // skip corrupt entry
        }
      }
      return out;
    },
    async getItem<T>(key: string) {
      const raw = mmkv.getString(KV_PREFIX + key);
      if (raw === undefined) return undefined;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    },
    async setItem<T>(key: string, value: T) {
      mmkv.set(KV_PREFIX + key, JSON.stringify(value));
    },
    async removeItem(key: string) {
      mmkv.remove(KV_PREFIX + key);
    },
  };
}

/**
 * Minimal `IKeyChain`. The core calls `init()` once, then `has/set/get/del`
 * by tag. Keys are relay symmetric keys (hex) — never logged.
 */
export function createWcKeychain(mmkv: MMKV) {
  const keychain = new Map<string, string>();
  const load = () => {
    keychain.clear();
    for (const k of mmkv.getAllKeys()) {
      if (!k.startsWith(KEYCHAIN_PREFIX)) continue;
      const v = mmkv.getString(k);
      if (v !== undefined) keychain.set(k.slice(KEYCHAIN_PREFIX.length), v);
    }
  };
  return {
    name: "keychain",
    context: "keychain",
    keychain,
    async init() {
      load();
    },
    has(tag: string) {
      return keychain.has(tag);
    },
    async set(tag: string, key: string) {
      keychain.set(tag, key);
      mmkv.set(KEYCHAIN_PREFIX + tag, key);
    },
    get(tag: string) {
      const v = keychain.get(tag);
      if (v === undefined) throw new Error(`No value for keychain tag`);
      return v;
    },
    async del(tag: string) {
      keychain.delete(tag);
      mmkv.remove(KEYCHAIN_PREFIX + tag);
    },
  };
}

export async function openWcMmkv(): Promise<MMKV> {
  return openEncryptedMmkv(WC_MMKV_ID, WC_MMKV_SECURE_KEY);
}
