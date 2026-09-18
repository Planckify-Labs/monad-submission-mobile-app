/**
 * Which TakumiPay passkey this device used last.
 *
 * Mera's recipe (`recipes/create-passkey-accounts.mdx`, "Remember the
 * credential"): store the credential metadata and pass it back on the next
 * sign-in, so the OS reuses that passkey instead of offering a picker. On a
 * phone with several Google accounts that each hold a TakumiPay passkey,
 * this is what keeps "Continue with fingerprint" landing on the same wallet
 * every time instead of asking the user to choose.
 *
 * Only the credential id and transports are stored; both are public
 * metadata (the OS shows the id to any relying party that asks) and reveal
 * nothing about the key. Kept in plain MMKV rather than SecureStore on
 * purpose so it survives a wallet wipe: the login screen only appears when
 * the device holds zero wallets, which is exactly when the hint is needed.
 */

import type { TPasskeyFields } from "@/constants/types/walletTypes";
import { storage } from "@/lib/storage/mmkv";
import { PASSKEY_RP_ID } from "./derive";

const KEY = "passkey.last_credential.v1";

export type KnownPasskeyCredential = Pick<
  TPasskeyFields,
  "credentialId" | "transports"
>;

export function readLastPasskeyCredential(): KnownPasskeyCredential | null {
  try {
    const raw = storage.getString(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TPasskeyFields>;
    if (
      typeof parsed.credentialId !== "string" ||
      parsed.credentialId.length === 0 ||
      parsed.rpId !== PASSKEY_RP_ID
    ) {
      return null;
    }
    return {
      credentialId: parsed.credentialId,
      ...(Array.isArray(parsed.transports)
        ? { transports: parsed.transports.filter((t) => typeof t === "string") }
        : {}),
    };
  } catch {
    return null;
  }
}

export function writeLastPasskeyCredential(passkey: TPasskeyFields): void {
  try {
    storage.set(
      KEY,
      JSON.stringify({
        credentialId: passkey.credentialId,
        rpId: passkey.rpId,
        ...(passkey.transports ? { transports: passkey.transports } : {}),
      }),
    );
  } catch {
    // Hint only; the discoverable-credential path still works without it.
  }
}

export function clearLastPasskeyCredential(): void {
  try {
    storage.remove(KEY);
  } catch {
    // ignore
  }
}
