/**
 * MWA authorization scopes — deep-link spec §8.2 / D-16.
 *
 * `authorizationScope` is 32 random bytes the wallet hands the dApp at
 * `authorize`; every privileged request presents it back. We keep
 * `scope → { originKey, walletAddress, cluster, issuedAt }` in encrypted
 * MMKV (`mwa.v1`, D-17) with a 30-day expiry; `reauthorize` rotates it.
 */

import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import type { MMKV } from "react-native-mmkv";
import { openEncryptedMmkv } from "@/services/security/encryptedMmkv";

export const MWA_MMKV_ID = "mwa.v1";
export const MWA_MMKV_SECURE_KEY = "mwa.mmkv.key.v1";
export const MWA_SCOPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PREFIX = "scope:";

export interface MwaScopeRecord {
  originKey: string;
  /** Human identity for the permissions screen. */
  identityUri?: string;
  identityName?: string;
  walletAddress: string;
  cluster: string;
  issuedAt: number;
  verifiedPackage?: string;
  /** Web origin proven by the Phase 3b attestation flow (browser launches). */
  attestedOrigin?: string;
}

function scopeKey(scope: Uint8Array): string {
  return bytesToHex(scope);
}

export class MwaScopeStore {
  private mmkv: Promise<MMKV> | null = null;

  private store(): Promise<MMKV> {
    if (!this.mmkv)
      this.mmkv = openEncryptedMmkv(MWA_MMKV_ID, MWA_MMKV_SECURE_KEY);
    return this.mmkv;
  }

  async issue(record: Omit<MwaScopeRecord, "issuedAt">): Promise<Uint8Array> {
    const scope = randomBytes(32);
    const mmkv = await this.store();
    mmkv.set(
      PREFIX + scopeKey(scope),
      JSON.stringify({ ...record, issuedAt: Date.now() }),
    );
    return scope;
  }

  async lookup(
    scope: Uint8Array,
    now: number = Date.now(),
  ): Promise<MwaScopeRecord | null> {
    const mmkv = await this.store();
    const raw = mmkv.getString(PREFIX + scopeKey(scope));
    if (!raw) return null;
    try {
      const rec = JSON.parse(raw) as MwaScopeRecord;
      if (now - rec.issuedAt > MWA_SCOPE_TTL_MS) {
        mmkv.remove(PREFIX + scopeKey(scope));
        return null;
      }
      return rec;
    } catch {
      return null;
    }
  }

  /** `reauthorize`: replace the scope, keep the binding. */
  async rotate(scope: Uint8Array): Promise<Uint8Array | null> {
    const rec = await this.lookup(scope);
    if (!rec) return null;
    await this.revoke(scope);
    return this.issue(rec);
  }

  async revoke(scope: Uint8Array): Promise<void> {
    const mmkv = await this.store();
    mmkv.remove(PREFIX + scopeKey(scope));
  }

  async revokeByOrigin(originKey: string): Promise<void> {
    const mmkv = await this.store();
    for (const k of mmkv.getAllKeys()) {
      if (!k.startsWith(PREFIX)) continue;
      const raw = mmkv.getString(k);
      if (!raw) continue;
      try {
        if ((JSON.parse(raw) as MwaScopeRecord).originKey === originKey)
          mmkv.remove(k);
      } catch {
        mmkv.remove(k);
      }
    }
  }

  async list(
    now: number = Date.now(),
  ): Promise<Array<MwaScopeRecord & { scopeHex: string }>> {
    const mmkv = await this.store();
    const out: Array<MwaScopeRecord & { scopeHex: string }> = [];
    for (const k of mmkv.getAllKeys()) {
      if (!k.startsWith(PREFIX)) continue;
      const raw = mmkv.getString(k);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw) as MwaScopeRecord;
        if (now - rec.issuedAt > MWA_SCOPE_TTL_MS) continue;
        out.push({ ...rec, scopeHex: k.slice(PREFIX.length) });
      } catch {
        // skip
      }
    }
    return out;
  }
}

export const mwaScopeStore = new MwaScopeStore();
