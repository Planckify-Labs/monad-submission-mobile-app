/**
 * Encrypted MMKV instances keyed from SecureStore — deep-link spec §7.2
 * (TWV-2026-030) and D-17.
 *
 * WalletConnect session state (symmetric keys, pairings, session
 * records), MWA authorization scopes and encrypted-link shared secrets
 * are secrets. They live in dedicated MMKV files encrypted with a
 * per-install 32-byte key (AES-256) that is generated once from the OS
 * CSPRNG and kept in `expo-secure-store` under the wallet's
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` options. Nothing transport-related
 * touches AsyncStorage.
 *
 * The key is a 32-character printable string (hex of 16 random bytes
 * would be 32 chars but only 128 bits of entropy; we use 32 random bytes
 * mapped to a base64url alphabet, i.e. 6 bits each, 192 bits, which MMKV
 * accepts as a 32-byte AES-256 key).
 */

import { createMMKV, type MMKV } from "react-native-mmkv";
import { walletSecureGet, walletSecureSet } from "./walletSecureStore";

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function randomKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += ALPHABET[bytes[i] & 0x3f];
  return out;
}

const instances = new Map<string, Promise<MMKV>>();

/**
 * Open (or create) the encrypted instance `id`. The encryption key is
 * looked up under `secureKeyName` and generated on first use. Idempotent
 * per process.
 */
export function openEncryptedMmkv(
  id: string,
  secureKeyName: string,
): Promise<MMKV> {
  const existing = instances.get(id);
  if (existing) return existing;
  const p = (async () => {
    let key = await walletSecureGet(secureKeyName);
    if (!key || key.length !== 32) {
      key = randomKey();
      await walletSecureSet(secureKeyName, key);
    }
    return createMMKV({ id, encryptionKey: key, encryptionType: "AES-256" });
  })();
  instances.set(id, p);
  return p;
}

/** Test seam. */
export function __resetEncryptedMmkvForTest(): void {
  instances.clear();
}
