/**
 * App PIN verifier. The ONE store behind every in-app PIN gate: send,
 * redeem, Add Points, sign-in, spending approvals, and the OS-auth
 * fallback on a device with no screen lock (`utils/authUtils.ts`).
 *
 * Storage: `Argon2id(pin, salt)` through the same native primitive the
 * encrypted seed backup uses (`@/services/backup/primitives`, so vitest
 * swaps in the Node twin), kept as a single JSON record in SecureStore
 * under the wallet-credential accessibility flag. The PIN itself is
 * never written. Cost is far below the backup's 64 MiB / 3 passes: this
 * runs on every confirm, and the record already sits behind the OS
 * keystore, so the KDF only has to make an offline guess at a 4-digit
 * PIN cost more than reading the seed would.
 *
 * History (TWV-2026-061): `hooks/usePin.ts` used to keep the PIN in
 * plaintext under `takumipay_user_pin`, while `appLock.ts` carried an
 * iterated-SHA-256 store that no screen ever called. This module
 * replaces both. A legacy plaintext entry is honoured once: the first
 * successful verify re-stores it as a hash and deletes the plaintext.
 *
 * Not here: attempt throttling. Callers that want lockout after N wrong
 * PINs layer it on top.
 */

import { bytesEqual, utf8ToBytes } from "@/services/backup/bytes";
import { deriveKey, getRandomBytes } from "@/services/backup/primitives";
import type { Argon2Params } from "@/services/backup/types";
import {
  walletSecureDelete,
  walletSecureGet,
  walletSecureSet,
} from "@/services/security/walletSecureStore";

const RECORD_KEY = "app_pin";
/** Plaintext key written by the pre-consolidation `usePin` hook. */
const LEGACY_PLAINTEXT_KEY = "takumipay_user_pin";

export const PIN_ARGON2_PARAMS: Argon2Params = {
  m: 16384, // 16 MiB
  t: 2,
  p: 1,
  dkLen: 32,
};

const SALT_BYTES = 16;

interface PinRecordV1 {
  v: 1;
  kdf: { alg: "argon2id"; m: number; t: number; p: number };
  /** Hex. */
  salt: string;
  /** Hex, `kdf.dkLen` bytes. */
  hash: string;
}

export async function isPinSet(): Promise<boolean> {
  if ((await readRecord()) !== null) return true;
  return (await walletSecureGet(LEGACY_PLAINTEXT_KEY)) !== null;
}

/** Replaces any existing PIN (hashed or legacy plaintext). */
export async function setPin(
  pin: string,
  params: Argon2Params = PIN_ARGON2_PARAMS,
): Promise<void> {
  const salt = getRandomBytes(SALT_BYTES);
  const hash = await deriveKey(utf8ToBytes(pin), salt, params);
  const record: PinRecordV1 = {
    v: 1,
    kdf: { alg: "argon2id", m: params.m, t: params.t, p: params.p },
    salt: bytesToHex(salt),
    hash: bytesToHex(hash),
  };
  await walletSecureSet(RECORD_KEY, JSON.stringify(record));
  await walletSecureDelete(LEGACY_PLAINTEXT_KEY);
}

export async function verifyPin(pin: string): Promise<boolean> {
  const record = await readRecord();
  if (record) {
    const hash = await deriveKey(utf8ToBytes(pin), hexToBytes(record.salt), {
      ...record.kdf,
      dkLen: record.hash.length / 2,
    });
    return bytesEqual(hash, hexToBytes(record.hash));
  }

  // Legacy plaintext entry: verify against it once, then re-store the
  // PIN hashed and drop the plaintext. A failed guess leaves it in place
  // so the next correct entry still migrates.
  const legacy = await walletSecureGet(LEGACY_PLAINTEXT_KEY);
  if (legacy === null) return false;
  if (!bytesEqual(utf8ToBytes(pin), utf8ToBytes(legacy))) return false;
  try {
    await setPin(pin);
  } catch (e) {
    // The PIN was right; a migration hiccup must not read as "wrong PIN".
    if (__DEV__) console.warn("[pinStore] legacy PIN migration failed", e);
  }
  return true;
}

export async function clearPin(): Promise<void> {
  await walletSecureDelete(RECORD_KEY);
  await walletSecureDelete(LEGACY_PLAINTEXT_KEY);
}

/**
 * `null` when there is no record OR the record is unreadable. An
 * unreadable record can only come from our own write bug; surfacing it
 * as "no PIN yet" re-runs setup, whereas "PIN set but never verifies"
 * would wall the user off from every gated action.
 */
async function readRecord(): Promise<PinRecordV1 | null> {
  const raw = await walletSecureGet(RECORD_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isPinRecordV1(parsed)) return parsed;
  } catch {
    // fall through
  }
  if (__DEV__)
    console.warn("[pinStore] unreadable PIN record, treating as unset");
  return null;
}

function isPinRecordV1(x: unknown): x is PinRecordV1 {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  const kdf = r.kdf as Record<string, unknown> | undefined;
  return (
    r.v === 1 &&
    typeof kdf === "object" &&
    kdf !== null &&
    kdf.alg === "argon2id" &&
    typeof kdf.m === "number" &&
    typeof kdf.t === "number" &&
    typeof kdf.p === "number" &&
    typeof r.salt === "string" &&
    isHex(r.salt) &&
    typeof r.hash === "string" &&
    isHex(r.hash) &&
    r.hash.length > 0
  );
}

function isHex(s: string): boolean {
  return s.length % 2 === 0 && /^[0-9a-f]*$/.test(s);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
