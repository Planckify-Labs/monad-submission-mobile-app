/**
 * Unit tests for the deposit support verdict.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *        --import ./services/walletKit/evm/_test-resolver.mjs \
 *        hooks/deposit/depositSupport.test.ts
 *
 * The regression these lock down: "Network Not Supported" used to be
 * inferred from `!hasContract && !isContractFetching`, so every transition
 * window (chain switch, disabled query, failed request) briefly looked
 * identical to a genuinely unsupported chain and fired the sheet.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type DepositSupportInput,
  resolveDepositSupport,
} from "./depositSupport.ts";

/** A settled, fully supported chain — each test perturbs one field. */
function input(overrides: Partial<DepositSupportInput> = {}) {
  const base: DepositSupportInput = {
    chainSupportsDeposit: true,
    isChainListUnresolved: false,
    hasBackendChain: true,
    isContractUnresolved: false,
    hasContract: true,
    isTokenListUnresolved: false,
    hasEligibleToken: true,
    isSignedIn: true,
  };
  return { ...base, ...overrides };
}

describe("resolveDepositSupport", () => {
  it("supported: family has a path, backend knows the chain, contract resolved", () => {
    assert.equal(resolveDepositSupport(input()), "supported");
  });

  it("unsupported: chain family has no deposit path at all", () => {
    // Solana / Sui — structural, so it doesn't wait on any lookup.
    assert.equal(
      resolveDepositSupport(
        input({
          chainSupportsDeposit: false,
          isChainListUnresolved: true,
          hasBackendChain: false,
          isContractUnresolved: true,
          hasContract: false,
          isTokenListUnresolved: true,
          hasEligibleToken: false,
          isSignedIn: false,
        }),
      ),
      "unsupported",
    );
  });

  it("unsupported: contract deployed but the chain has no depositable token", () => {
    // Arbitrum Sepolia / Polygon today: an active `takumi_pay` row but no
    // eligible stablecoin, which used to render an empty token picker and
    // no warning at all.
    assert.equal(
      resolveDepositSupport(input({ hasEligibleToken: false })),
      "unsupported",
    );
  });

  it("unknown while the token catalogue is still loading", () => {
    assert.equal(
      resolveDepositSupport(
        input({ hasEligibleToken: false, isTokenListUnresolved: true }),
      ),
      "unknown",
    );
  });

  it("supported needs BOTH a contract and a token, in either order of arrival", () => {
    assert.equal(
      resolveDepositSupport(input({ hasContract: false })),
      "unsupported",
    );
    assert.equal(
      resolveDepositSupport(input({ hasEligibleToken: false })),
      "unsupported",
    );
    assert.equal(resolveDepositSupport(input()), "supported");
  });

  it("unsupported: supported family, but no contract deployed on this network", () => {
    assert.equal(
      resolveDepositSupport(input({ hasContract: false })),
      "unsupported",
    );
  });

  it("unsupported: backend has no /blockchains row for this network", () => {
    assert.equal(
      resolveDepositSupport(
        input({ hasBackendChain: false, hasContract: false }),
      ),
      "unsupported",
    );
  });

  it("unknown while the contract lookup is still in flight", () => {
    // The chain-switch window: query key just changed, no answer yet.
    assert.equal(
      resolveDepositSupport(
        input({ hasContract: false, isContractUnresolved: true }),
      ),
      "unknown",
    );
  });

  it("unknown when the contract lookup failed — a network error is not a verdict", () => {
    // `isContractUnresolved` folds in `isError`; offline must not read as
    // "this chain doesn't support deposits".
    assert.equal(
      resolveDepositSupport(
        input({ hasContract: false, isContractUnresolved: true }),
      ),
      "unknown",
    );
  });

  it("unknown while the /blockchains list is still loading", () => {
    // Stellar's contract query is keyed on the backend row, so it sits
    // disabled (and looks 'settled with no contract') until the list lands.
    assert.equal(
      resolveDepositSupport(
        input({
          isChainListUnresolved: true,
          hasBackendChain: false,
          hasContract: false,
        }),
      ),
      "unknown",
    );
  });

  it("unknown when a stale chain list is refetching and has no row yet", () => {
    // The MMKV-cached list can predate a newly added chain; don't sentence
    // that chain before the refresh lands.
    assert.equal(
      resolveDepositSupport(
        input({
          isChainListUnresolved: true,
          hasBackendChain: false,
          isContractUnresolved: true,
          hasContract: false,
        }),
      ),
      "unknown",
    );
  });

  it("unknown when signed out — the inline sign-in CTA leads instead", () => {
    assert.equal(
      resolveDepositSupport(input({ hasContract: false, isSignedIn: false })),
      "unknown",
    );
  });

  it("stays supported while resolved lookups are being revalidated", () => {
    // Background refetch of a stale cache must not blank a known-good chain.
    assert.equal(
      resolveDepositSupport(
        input({ isContractUnresolved: true, isTokenListUnresolved: true }),
      ),
      "supported",
    );
  });

  it("structural unsupported outranks a stale contract hit", () => {
    assert.equal(
      resolveDepositSupport(
        input({ chainSupportsDeposit: false, hasContract: true }),
      ),
      "unsupported",
    );
  });
});
