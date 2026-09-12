/**
 * Phantom-compatible session tokens and key storage — deep-link spec §9.
 *
 *   - per-install x25519 keypair (`encryptedLink.x25519.v1`, SecureStore)
 *   - per-install Ed25519 session-signing keypair (`encryptedLink.sessionSign.v1`)
 *   - shared secrets + session records in encrypted MMKV `ul.v1` (D-17)
 *
 * Neither keypair is a chain key. Session JSON follows Phantom's shape
 * (`app_url`, `timestamp`, `chain`, `cluster`, `public_key`) and is
 * signed with `nacl.sign` semantics, base58-encoded. Ours additionally
 * expire after 30 days (D-16) even though Phantom's "do not expire".
 */

import { ed25519, x25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import bs58 from "bs58";
import type { MMKV } from "react-native-mmkv";
import { openEncryptedMmkv } from "@/services/security/encryptedMmkv";
import {
  walletSecureGet,
  walletSecureSet,
} from "@/services/security/walletSecureStore";
import {
  boxSharedSecret,
  type Ed25519Keypair,
  generateEd25519Keypair,
  generateX25519Keypair,
  signAttached,
  signOpen,
  type X25519Keypair,
} from "./crypto";

export const UL_MMKV_ID = "ul.v1";
export const UL_MMKV_SECURE_KEY = "ul.mmkv.key.v1";
const X25519_KEY = "encryptedLink.x25519.v1";
const SIGN_KEY = "encryptedLink.sessionSign.v1";
const SECRET_PREFIX = "secret:";
const SESSION_PREFIX = "session:";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionJson {
  app_url: string;
  timestamp: number;
  chain: string;
  cluster: string;
  public_key: string;
}

export interface SessionRecord extends SessionJson {
  dappPublicKey: string;
  redirectOrigin: string;
  name?: string;
}

async function loadOrCreate(
  key: string,
  gen: () => { publicKey: Uint8Array; secretKey: Uint8Array },
  derivePub: (sk: Uint8Array) => Uint8Array,
): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
  const stored = await walletSecureGet(key);
  if (stored && /^[0-9a-f]{64}$/i.test(stored)) {
    const secretKey = hexToBytes(stored);
    return { secretKey, publicKey: derivePub(secretKey) };
  }
  const pair = gen();
  await walletSecureSet(key, bytesToHex(pair.secretKey));
  return pair;
}

export class EncryptedLinkKeys {
  private x25519: Promise<X25519Keypair> | null = null;
  private sign: Promise<Ed25519Keypair> | null = null;
  private mmkv: Promise<MMKV> | null = null;

  async walletKeypair(): Promise<X25519Keypair> {
    if (!this.x25519) {
      this.x25519 = loadOrCreate(X25519_KEY, generateX25519Keypair, (sk) =>
        x25519.getPublicKey(sk),
      );
    }
    return this.x25519;
  }

  async signingKeypair(): Promise<Ed25519Keypair> {
    if (!this.sign) {
      this.sign = loadOrCreate(SIGN_KEY, generateEd25519Keypair, (sk) =>
        ed25519.getPublicKey(sk),
      );
    }
    return this.sign;
  }

  private store(): Promise<MMKV> {
    if (!this.mmkv)
      this.mmkv = openEncryptedMmkv(UL_MMKV_ID, UL_MMKV_SECURE_KEY);
    return this.mmkv;
  }

  /** Shared secret for a dApp public key (base58), derived once and cached. */
  async sharedSecret(dappPublicKeyB58: string): Promise<Uint8Array> {
    const mmkv = await this.store();
    const cached = mmkv.getString(SECRET_PREFIX + dappPublicKeyB58);
    if (cached) return hexToBytes(cached);
    const theirPub = bs58.decode(dappPublicKeyB58);
    const { secretKey } = await this.walletKeypair();
    const secret = boxSharedSecret(theirPub, secretKey);
    mmkv.set(SECRET_PREFIX + dappPublicKeyB58, bytesToHex(secret));
    return secret;
  }

  async forgetSecret(dappPublicKeyB58: string): Promise<void> {
    const mmkv = await this.store();
    mmkv.remove(SECRET_PREFIX + dappPublicKeyB58);
  }

  // ── Session tokens ─────────────────────────────────────────────────

  async issueSession(json: SessionJson): Promise<string> {
    const { secretKey } = await this.signingKeypair();
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    return bs58.encode(signAttached(bytes, secretKey));
  }

  /** Verify + parse a session token. `null` when forged, malformed or expired. */
  async openSession(
    token: string,
    now: number = Date.now(),
  ): Promise<SessionJson | null> {
    let signed: Uint8Array;
    try {
      signed = bs58.decode(token);
    } catch {
      return null;
    }
    const { publicKey } = await this.signingKeypair();
    const message = signOpen(signed, publicKey);
    if (!message) return null;
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(message));
    } catch {
      return null;
    }
    if (!json || typeof json !== "object") return null;
    const s = json as Partial<SessionJson>;
    if (
      typeof s.app_url !== "string" ||
      typeof s.timestamp !== "number" ||
      typeof s.chain !== "string" ||
      typeof s.cluster !== "string" ||
      typeof s.public_key !== "string"
    ) {
      return null;
    }
    if (now - s.timestamp > SESSION_TTL_MS) return null;
    return s as SessionJson;
  }

  // ── Session records (for the permissions screen) ───────────────────

  async saveSession(record: SessionRecord): Promise<void> {
    const mmkv = await this.store();
    mmkv.set(SESSION_PREFIX + record.dappPublicKey, JSON.stringify(record));
  }

  async getSession(dappPublicKey: string): Promise<SessionRecord | null> {
    const mmkv = await this.store();
    const raw = mmkv.getString(SESSION_PREFIX + dappPublicKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionRecord;
    } catch {
      return null;
    }
  }

  async deleteSession(dappPublicKey: string): Promise<void> {
    const mmkv = await this.store();
    mmkv.remove(SESSION_PREFIX + dappPublicKey);
  }

  async listSessions(): Promise<SessionRecord[]> {
    const mmkv = await this.store();
    const out: SessionRecord[] = [];
    for (const k of mmkv.getAllKeys()) {
      if (!k.startsWith(SESSION_PREFIX)) continue;
      const raw = mmkv.getString(k);
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw) as SessionRecord);
      } catch {
        // skip
      }
    }
    return out;
  }
}

export const encryptedLinkKeys = new EncryptedLinkKeys();
