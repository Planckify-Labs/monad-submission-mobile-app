/**
 * `pinStore` behaviour against the in-memory SecureStore mock and real
 * Argon2id (the Node twin of `services/backup/primitives`). Pins the two
 * things a PIN store must never get wrong: the PIN is not on disk in
 * the clear, and a legacy plaintext entry keeps working exactly once
 * before it is replaced.
 */

import {
  __dumpSecureStore,
  __resetSecureStore,
  getItemAsync,
  setItemAsync,
} from "expo-secure-store";
import { beforeEach, describe, expect, it } from "vitest";
import type { Argon2Params } from "@/services/backup/types";
import { clearPin, isPinSet, setPin, verifyPin } from "./pinStore";

// Cheap KDF so the suite runs in milliseconds; the record shape, compare
// and migration under test do not depend on cost.
const FAST: Argon2Params = { m: 256, t: 1, p: 1, dkLen: 32 };

const RECORD_KEY = "app_pin";
const LEGACY_KEY = "takumipay_user_pin";

describe("pinStore", () => {
  beforeEach(() => __resetSecureStore());

  it("starts unset", async () => {
    expect(await isPinSet()).toBe(false);
    expect(await verifyPin("1234")).toBe(false);
  });

  it("set then verify: right PIN passes, wrong PIN fails", async () => {
    await setPin("4821", FAST);
    expect(await isPinSet()).toBe(true);
    expect(await verifyPin("4821")).toBe(true);
    expect(await verifyPin("4822")).toBe(false);
    expect(await verifyPin("")).toBe(false);
  });

  it("never writes the PIN itself to any key", async () => {
    await setPin("7391", FAST);
    expect(__dumpSecureStore()).not.toContain("7391");
  });

  it("stores an argon2id record whose params the verifier honours", async () => {
    await setPin("1111", FAST);
    const record = JSON.parse((await getItemAsync(RECORD_KEY)) as string);
    expect(record).toMatchObject({
      v: 1,
      kdf: { alg: "argon2id", m: FAST.m, t: FAST.t, p: FAST.p },
    });
    expect(record.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    // Same PIN, fresh salt: a second setPin must not reproduce the hash.
    await setPin("1111", FAST);
    const again = JSON.parse((await getItemAsync(RECORD_KEY)) as string);
    expect(again.hash).not.toBe(record.hash);
    expect(await verifyPin("1111")).toBe(true);
  });

  it("replacing the PIN invalidates the old one", async () => {
    await setPin("1234", FAST);
    await setPin("9876", FAST);
    expect(await verifyPin("1234")).toBe(false);
    expect(await verifyPin("9876")).toBe(true);
  });

  it("clearPin removes it", async () => {
    await setPin("1234", FAST);
    await clearPin();
    expect(await isPinSet()).toBe(false);
    expect(await verifyPin("1234")).toBe(false);
  });

  describe("legacy plaintext entry", () => {
    it("counts as set", async () => {
      await setItemAsync(LEGACY_KEY, "2468");
      expect(await isPinSet()).toBe(true);
    });

    it("verifies once, then is replaced by a hashed record", async () => {
      await setItemAsync(LEGACY_KEY, "2468");
      expect(await verifyPin("2468")).toBe(true);
      // Migrated: plaintext gone, hashed record present, still verifies.
      expect(await getItemAsync(LEGACY_KEY)).toBeNull();
      expect(await getItemAsync(RECORD_KEY)).not.toBeNull();
      expect(__dumpSecureStore()).not.toContain("2468");
      expect(await verifyPin("2468")).toBe(true);
      expect(await verifyPin("2469")).toBe(false);
    });

    it("a wrong guess leaves the plaintext in place for the next attempt", async () => {
      await setItemAsync(LEGACY_KEY, "2468");
      expect(await verifyPin("0000")).toBe(false);
      expect(await getItemAsync(LEGACY_KEY)).toBe("2468");
      expect(await getItemAsync(RECORD_KEY)).toBeNull();
    });

    it("setPin drops the plaintext without needing a verify first", async () => {
      await setItemAsync(LEGACY_KEY, "2468");
      await setPin("1357", FAST);
      expect(await getItemAsync(LEGACY_KEY)).toBeNull();
      expect(await verifyPin("2468")).toBe(false);
      expect(await verifyPin("1357")).toBe(true);
    });

    it("a hashed record wins over a stray plaintext entry", async () => {
      await setPin("1357", FAST);
      await setItemAsync(LEGACY_KEY, "2468");
      expect(await verifyPin("2468")).toBe(false);
      expect(await verifyPin("1357")).toBe(true);
    });
  });

  describe("unreadable record", () => {
    it.each([
      ["not JSON", "{oops"],
      ["wrong version", JSON.stringify({ v: 2 })],
      [
        "missing hash",
        JSON.stringify({
          v: 1,
          kdf: { alg: "argon2id", m: 1, t: 1, p: 1 },
          salt: "00",
        }),
      ],
      [
        "non-hex salt",
        JSON.stringify({
          v: 1,
          kdf: { alg: "argon2id", m: 1, t: 1, p: 1 },
          salt: "zz",
          hash: "00",
        }),
      ],
    ])("%s reads as unset so setup can run again", async (_label, raw) => {
      await setItemAsync(RECORD_KEY, raw);
      expect(await isPinSet()).toBe(false);
      expect(await verifyPin("1234")).toBe(false);
      await setPin("1234", FAST);
      expect(await verifyPin("1234")).toBe(true);
    });
  });
});
