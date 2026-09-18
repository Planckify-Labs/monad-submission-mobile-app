/**
 * Unit tests for `bootstrapFirstLoginWallets` + `defaultWalletNameFor`.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *        --import ./services/walletKit/evm/_test-resolver.mjs \
 *        services/walletKit/bootstrap.test.ts
 *
 * Style matches `services/walletKit/boot.test.ts`. The EVM resolver
 * hook is reused because `bootstrap.ts` transitively imports
 * `services/walletService.ts` (`generateWalletMnemonic` dwell site),
 * which pulls `expo-secure-store` + `@/lib/storage/mmkv`. The
 * resolver stubs both so the tests run under plain Node.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { __resetWalletKitBootForTests, bootWalletKits } from "./boot.ts";
import {
  bootstrapFirstLoginWallets,
  defaultWalletNameFor,
  walletNameFor,
} from "./bootstrap.ts";
import {
  CHAIN_LOCKDOWN_ACTIVE,
  getSupportedWalletKits,
} from "./chainSupport.ts";
import { walletKitRegistry } from "./registry.ts";

describe("defaultWalletNameFor", () => {
  it("returns `Main Wallet · ETH` for eip155", () => {
    assert.equal(defaultWalletNameFor("eip155"), "Main Wallet · ETH");
  });

  it("returns `Main Wallet · SOL` for solana", () => {
    assert.equal(defaultWalletNameFor("solana"), "Main Wallet · SOL");
  });

  it("falls back to an uppercase namespace tag for unknown namespaces", () => {
    assert.equal(defaultWalletNameFor("sui"), "Main Wallet · SUI");
  });
});

describe("walletNameFor", () => {
  it("applies a custom prefix (Google sign-in names by account)", () => {
    assert.equal(walletNameFor("Arinda", "eip155"), "Arinda · ETH");
    assert.equal(walletNameFor("Arinda", "solana"), "Arinda · SOL");
    assert.equal(walletNameFor("Arinda", "sui"), "Arinda · SUI");
  });
});

describe("bootstrapFirstLoginWallets (zero-wallet first login)", () => {
  before(() => {
    walletKitRegistry.clear();
    __resetWalletKitBootForTests();
    bootWalletKits();
  });

  it("returns exactly one wallet per kit the app surfaces", async () => {
    const wallets = await bootstrapFirstLoginWallets();
    // Every kit is registered regardless of build (that invariant is
    // boot.test.ts's job); how many get a wallet is the chain lockdown's
    // call: all four in the multi-chain build, EVM only when locked to
    // Monad. Assert against the same source of truth the code uses.
    assert.equal(wallets.length, getSupportedWalletKits().length);
    assert.equal(walletKitRegistry.getAll().length, 4);
    assert.equal(wallets.length, CHAIN_LOCKDOWN_ACTIVE ? 1 : 4);
  });

  it("each wallet has a non-empty address, a non-empty seedPhrase, and a registered namespace", async () => {
    const wallets = await bootstrapFirstLoginWallets();
    const registeredNamespaces = new Set(
      walletKitRegistry.getAll().map((k) => k.namespace),
    );
    for (const w of wallets) {
      assert.ok(
        typeof w.address === "string" && w.address.length > 0,
        `expected non-empty address for namespace ${w.namespace}`,
      );
      assert.ok(
        typeof w.seedPhrase === "string" && w.seedPhrase.length > 0,
        `expected non-empty seedPhrase for namespace ${w.namespace}`,
      );
      assert.ok(
        registeredNamespaces.has(w.namespace),
        `namespace ${w.namespace} is not in the registry`,
      );
    }
  });

  it("names each wallet via defaultWalletNameFor", async () => {
    const wallets = await bootstrapFirstLoginWallets();
    for (const w of wallets) {
      assert.equal(w.name, defaultWalletNameFor(w.namespace));
    }
  });

  it("all wallets share the same seedPhrase (one mnemonic → N wallets)", async () => {
    const wallets = await bootstrapFirstLoginWallets();
    assert.ok(wallets.length >= 1, "expected at least one wallet");
    const [first, ...rest] = wallets;
    for (const w of rest) {
      assert.equal(
        w.seedPhrase,
        first.seedPhrase,
        `namespace ${w.namespace} seedPhrase diverged from ${first.namespace}`,
      );
    }
  });

  it("produces a fresh mnemonic on each invocation (CSPRNG)", async () => {
    const [a] = await bootstrapFirstLoginWallets();
    const [b] = await bootstrapFirstLoginWallets();
    assert.notEqual(
      a.seedPhrase,
      b.seedPhrase,
      "bootstrap should mint a fresh mnemonic each call",
    );
  });

  it("preserves registry insertion order (EVM first, Solana second)", async () => {
    const wallets = await bootstrapFirstLoginWallets();
    const expected = getSupportedWalletKits().map((k) => k.namespace);
    assert.deepEqual(
      wallets.map((w) => w.namespace),
      expected,
    );
  });
});
