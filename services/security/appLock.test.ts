/**
 * TWV-2026-061 — recovery PIN (app password) invariants, appLock side.
 *
 * We can't boot the full appLock module under node:test because it
 * imports `expo-sqlite` + `expo-local-authentication`. Instead we assert
 * via source-level checks that:
 *   - The PIN surface is the single `pinStore` module (no second KDF or
 *     store reappears here), so `hooks/usePin.ts` and lock-state callers
 *     verify against the same record.
 *   - A biometric-invalidation handler path exists and can fire.
 *
 * The store's own behaviour (Argon2id at rest, legacy plaintext migrated
 * once, timing-safe compare) is covered by `pinStore.test.ts` under
 * vitest, where the KDF primitive has a Node twin.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *     services/security/appLock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const src = readFileSync(new URL("./appLock.ts", import.meta.url), "utf-8");
const storeSrc = readFileSync(
  new URL("./pinStore.ts", import.meta.url),
  "utf-8",
);

describe("appLock — single PIN store (TWV-2026-061)", () => {
  it("re-exports the PIN API from pinStore rather than owning one", () => {
    assert.match(
      src,
      /export \{ clearPin, isPinSet, setPin, verifyPin \} from "\.\/pinStore"/,
    );
  });

  it("carries no PIN hashing or PIN storage of its own", () => {
    assert.doesNotMatch(
      src,
      /hashPin|pin_hash|walletSecureGet|walletSecureSet/,
    );
    assert.doesNotMatch(src, /crypto\.subtle|PBKDF2/);
  });
});

describe("pinStore — KDF and storage shape", () => {
  it("derives with Argon2id through the shared native primitive", () => {
    assert.match(
      storeSrc,
      /from "@\/services\/backup\/primitives"/,
      "must import the primitive via the @/ alias so vitest swaps in the Node twin",
    );
    assert.match(storeSrc, /alg: "argon2id"/);
  });

  it("compares hashes with the timing-safe helper, not ===", () => {
    assert.match(storeSrc, /bytesEqual\(hash,\s*hexToBytes\(record\.hash\)\)/);
  });

  it("migrates the legacy plaintext key instead of reading it forever", () => {
    assert.match(storeSrc, /LEGACY_PLAINTEXT_KEY = "takumipay_user_pin"/);
    assert.match(storeSrc, /walletSecureDelete\(LEGACY_PLAINTEXT_KEY\)/);
  });
});

describe("appLock — biometric invalidation hook", () => {
  it("exports onBiometricInvalidated + fireBiometricInvalidated", () => {
    assert.match(src, /export function onBiometricInvalidated/);
    assert.match(src, /export async function fireBiometricInvalidated/);
  });

  it("clears to `locked` state on invalidation", () => {
    assert.match(
      src,
      /fireBiometricInvalidated[\s\S]*?currentState\s*=\s*"locked"/,
    );
  });
});
