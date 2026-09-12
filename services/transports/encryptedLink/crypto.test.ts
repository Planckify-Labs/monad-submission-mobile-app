/**
 * Phantom-compatible crypto — box/open round-trip, wrong key / wrong
 * nonce refusal, session sign/open, nonce-reuse ring. Spec §14.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  boxOpen,
  boxSeal,
  boxSharedSecret,
  generateEd25519Keypair,
  generateX25519Keypair,
  NonceRing,
  randomNonce,
  signAttached,
  signOpen,
} from "./crypto.ts";

describe("nacl.box compatibility", () => {
  it("both sides derive the same shared secret and a box round-trips", () => {
    const wallet = generateX25519Keypair();
    const dapp = generateX25519Keypair();
    const a = boxSharedSecret(dapp.publicKey, wallet.secretKey);
    const b = boxSharedSecret(wallet.publicKey, dapp.secretKey);
    assert.deepEqual(a, b);
    assert.equal(a.length, 32);
    const nonce = randomNonce();
    const msg = new TextEncoder().encode(
      JSON.stringify({ public_key: "abc", session: "tok" }),
    );
    const box = boxSeal(msg, nonce, a);
    assert.equal(box.length, msg.length + 16);
    assert.deepEqual(boxOpen(box, nonce, b), msg);
  });
  it("refuses a wrong key, wrong nonce or tampered box", () => {
    const wallet = generateX25519Keypair();
    const dapp = generateX25519Keypair();
    const other = generateX25519Keypair();
    const secret = boxSharedSecret(dapp.publicKey, wallet.secretKey);
    const nonce = randomNonce();
    const box = boxSeal(new Uint8Array([1, 2, 3]), nonce, secret);
    assert.equal(
      boxOpen(box, nonce, boxSharedSecret(other.publicKey, wallet.secretKey)),
      null,
    );
    assert.equal(boxOpen(box, randomNonce(), secret), null);
    const tampered = new Uint8Array(box);
    tampered[tampered.length - 1] ^= 1;
    assert.equal(boxOpen(tampered, nonce, secret), null);
    assert.equal(boxOpen(box, new Uint8Array(23), secret), null);
  });
});

describe("nacl.sign compatibility (session tokens)", () => {
  it("signs and opens; a forged token fails", () => {
    const kp = generateEd25519Keypair();
    const json = new TextEncoder().encode(
      JSON.stringify({
        app_url: "https://d.app",
        timestamp: 1,
        chain: "solana",
        cluster: "mainnet-beta",
        public_key: "P",
      }),
    );
    const signed = signAttached(json, kp.secretKey);
    assert.equal(signed.length, 64 + json.length);
    assert.deepEqual(signOpen(signed, kp.publicKey), json);
    const forged = new Uint8Array(signed);
    forged[70] ^= 1;
    assert.equal(signOpen(forged, kp.publicKey), null);
    assert.equal(signOpen(signed, generateEd25519Keypair().publicKey), null);
    assert.equal(signOpen(new Uint8Array(10), kp.publicKey), null);
  });
});

describe("NonceRing", () => {
  it("refuses a reused nonce per secret and stays bounded", () => {
    const ring = new NonceRing(3);
    const n1 = randomNonce();
    assert.equal(ring.accept("k", n1), true);
    assert.equal(ring.accept("k", n1), false);
    assert.equal(ring.accept("other", n1), true);
    ring.accept("k", randomNonce());
    ring.accept("k", randomNonce());
    ring.accept("k", randomNonce());
    // n1 has been evicted (ring of 3), so it is accepted again — the
    // bound is the documented trade-off; the sheet + session checks
    // remain behind it.
    assert.equal(ring.accept("k", n1), true);
  });
});
