/**
 * Phantom-compatible deep-link crypto — deep-link spec §9.
 *
 * Wire-compatible with `tweetnacl`'s `box` / `box.open` / `sign` /
 * `sign.open` (what Phantom's clients use), implemented on `@noble/*`
 * so no new native or nacl dependency is added:
 *
 *   shared secret = hsalsa20("expand 32-byte k", x25519(sk, pk), 0¹⁶)   (nacl.box.before)
 *   box           = xsalsa20-poly1305(shared, nonce₂₄)                    (nacl.secretbox)
 *   session token = ed25519.sign(JSON bytes) ‖ JSON bytes                 (nacl.sign)
 *
 * Nonce reuse under one shared secret is refused through a bounded ring
 * (S-10). Pure module: node-testable.
 */

import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa";
import { u32, utf8ToBytes } from "@noble/ciphers/utils";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { randomBytes } from "@noble/hashes/utils";

export const NONCE_BYTES = 24;
export const NONCE_RING_MAX = 1000;

const SIGMA32 = u32(utf8ToBytes("expand 32-byte k"));
const ZERO16 = u32(new Uint8Array(16));

export interface X25519Keypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface Ed25519Keypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generateX25519Keypair(): X25519Keypair {
  const secretKey = x25519.utils.randomPrivateKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function generateEd25519Keypair(): Ed25519Keypair {
  const secretKey = ed25519.utils.randomPrivateKey();
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

/** `nacl.box.before(theirPublicKey, mySecretKey)`. */
export function boxSharedSecret(
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array,
): Uint8Array {
  const point = x25519.getSharedSecret(mySecretKey, theirPublicKey);
  const out = new Uint32Array(8);
  hsalsa(SIGMA32, u32(point), ZERO16, out);
  return new Uint8Array(out.buffer, out.byteOffset, 32).slice();
}

export function randomNonce(): Uint8Array {
  return randomBytes(NONCE_BYTES);
}

/** `nacl.box.after(message, nonce, sharedKey)`. */
export function boxSeal(
  message: Uint8Array,
  nonce: Uint8Array,
  sharedKey: Uint8Array,
): Uint8Array {
  if (nonce.length !== NONCE_BYTES) throw new Error("bad nonce length");
  return xsalsa20poly1305(sharedKey, nonce).encrypt(message);
}

/** `nacl.box.open.after(box, nonce, sharedKey)`; `null` on failure. */
export function boxOpen(
  box: Uint8Array,
  nonce: Uint8Array,
  sharedKey: Uint8Array,
): Uint8Array | null {
  if (nonce.length !== NONCE_BYTES) return null;
  try {
    return xsalsa20poly1305(sharedKey, nonce).decrypt(box);
  } catch {
    return null;
  }
}

/** `nacl.sign(message, secretKey)` — signature ‖ message. */
export function signAttached(
  message: Uint8Array,
  secretKey: Uint8Array,
): Uint8Array {
  const sig = ed25519.sign(message, secretKey);
  const out = new Uint8Array(sig.length + message.length);
  out.set(sig, 0);
  out.set(message, sig.length);
  return out;
}

/** `nacl.sign.open(signed, publicKey)`; `null` on failure. */
export function signOpen(
  signed: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array | null {
  if (signed.length < 64) return null;
  const sig = signed.slice(0, 64);
  const message = signed.slice(64);
  try {
    return ed25519.verify(sig, message, publicKey) ? message : null;
  } catch {
    return null;
  }
}

/**
 * Bounded nonce ring per shared secret. `nacl.box` with a repeated nonce
 * under the same key leaks the keystream; a client replaying a request
 * would also re-trigger a sheet. Both are refused.
 */
export class NonceRing {
  private seen = new Map<string, string[]>();
  private readonly max: number;
  constructor(max: number = NONCE_RING_MAX) {
    this.max = max;
  }

  /** `true` when fresh (and now recorded); `false` on reuse. */
  accept(secretId: string, nonce: Uint8Array): boolean {
    const key = Array.from(nonce, (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    const ring = this.seen.get(secretId) ?? [];
    if (ring.includes(key)) return false;
    ring.push(key);
    while (ring.length > this.max) ring.shift();
    this.seen.set(secretId, ring);
    return true;
  }

  __resetForTest(): void {
    this.seen.clear();
  }
}
