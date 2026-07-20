/**
 * Unit tests for the chain-agnostic clear-signing orchestrator —
 * task 65 (TWV-2026-066) Phase B. Verifies the adapter-first /
 * bespoke-second / null-last fallback chain, and that a broken
 * adapter can never block resolution.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types --import ./services/walletKit/evm/_test-resolver.mjs services/decoders/clearSigning.test.ts
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { walletKitRegistry } from "../walletKit/registry.ts";
import type {
  ClearSigningDescriptor,
  WalletKitAdapter,
} from "../walletKit/types.ts";
import { resolveClearSigningSummary } from "./clearSigning.ts";

const STUB_DESCRIPTOR: ClearSigningDescriptor = {
  intent: "Transfer",
  source: "erc7730",
  fields: [{ label: "To", value: "0xabc" }],
};

function registerStubKit(
  resolver: WalletKitAdapter["resolveClearSigningDescriptor"] | undefined,
): void {
  walletKitRegistry.register({
    namespace: "eip155",
    resolveClearSigningDescriptor: resolver,
  } as unknown as WalletKitAdapter);
}

const PERMIT_TYPED_DATA = {
  domain: {
    name: "USD Coin",
    verifyingContract: "0x00000000000000000000000000000000000000AA",
  },
  types: {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Permit",
  message: {
    owner: "0x00000000000000000000000000000000000000BB",
    spender: "0x00000000000000000000000000000000000000CC",
    value: "1000",
    nonce: "1",
    deadline: "9999999999",
  },
};

describe("resolveClearSigningSummary", () => {
  afterEach(() => {
    walletKitRegistry.clear();
  });

  it("uses the adapter capability when it resolves", async () => {
    registerStubKit(async () => STUB_DESCRIPTOR);
    const d = await resolveClearSigningSummary("eip155", { call: {} });
    assert.deepEqual(d, STUB_DESCRIPTOR);
  });

  it("falls back to the bespoke decoders when the adapter returns null", async () => {
    registerStubKit(async () => null);
    const d = await resolveClearSigningSummary("eip155", {
      call: { typedData: PERMIT_TYPED_DATA },
    });
    assert.ok(d);
    assert.equal(d.source, "bespoke");
    assert.equal(d.intent, "Permit token spending");
  });

  it("falls back when the kit leaves the capability undefined", async () => {
    registerStubKit(undefined);
    const d = await resolveClearSigningSummary("eip155", {
      call: { typedData: PERMIT_TYPED_DATA },
    });
    assert.equal(d?.source, "bespoke");
  });

  it("a throwing adapter degrades to fallback, never an error", async () => {
    registerStubKit(async () => {
      throw new Error("rpc exploded");
    });
    const d = await resolveClearSigningSummary("eip155", {
      call: { typedData: PERMIT_TYPED_DATA },
    });
    assert.equal(d?.source, "bespoke");
  });

  it("no adapter + no bespoke match → null (explicit unrecognized state)", async () => {
    registerStubKit(async () => null);
    const d = await resolveClearSigningSummary("eip155", {
      call: { data: "0xdeadbeef" },
    });
    assert.equal(d, null);
  });

  it("unregistered namespace → bespoke probe only, no throw", async () => {
    const d = await resolveClearSigningSummary("sui", { call: {} });
    assert.equal(d, null);
  });
});
