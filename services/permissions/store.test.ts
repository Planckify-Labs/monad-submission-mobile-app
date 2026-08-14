/**
 * Behavioural test for `namespaceForChainKey` — the helper that lets the
 * dApp-bridge disconnect path and the connection-manager UI recover a
 * grant's chain namespace from its stored `chainId`, without persisting a
 * separate namespace field.
 *
 * Contract mirrors what each adapter writes at grant time:
 *   - EVM   → numeric chainId            (EvmAdapter)
 *   - Solana → "solana:<cluster>"        (clusterToChain)
 *   - Sui   → "sui:<network>"            (networkToChain)
 *
 * Runs under the node:test harness (scripts/run-node-tests.sh); the
 * resolver stubs expo-secure-store + AsyncStorage so store.ts loads.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { namespaceForChainKey, PermissionStore } from "./store.ts";

describe("namespaceForChainKey", () => {
  it("maps numeric chainIds to eip155", () => {
    assert.equal(namespaceForChainKey(1), "eip155");
    assert.equal(namespaceForChainKey(137), "eip155");
    assert.equal(namespaceForChainKey(8453), "eip155");
  });

  it("maps CAIP-2 solana clusters to solana", () => {
    assert.equal(namespaceForChainKey("solana:mainnet"), "solana");
    assert.equal(namespaceForChainKey("solana:devnet"), "solana");
    assert.equal(namespaceForChainKey("solana:testnet"), "solana");
  });

  it("maps CAIP-2 sui networks to sui", () => {
    assert.equal(namespaceForChainKey("sui:mainnet"), "sui");
    assert.equal(namespaceForChainKey("sui:testnet"), "sui");
    assert.equal(namespaceForChainKey("sui:devnet"), "sui");
  });

  it("maps stellar chain keys to stellar (docs/stellar-dapp-bridge-spec.md §9)", () => {
    assert.equal(namespaceForChainKey("stellar:mainnet"), "stellar");
    assert.equal(namespaceForChainKey("stellar:testnet"), "stellar");
  });

  it("falls back to eip155 for unrecognised string keys", () => {
    assert.equal(namespaceForChainKey("0x1"), "eip155");
    assert.equal(namespaceForChainKey(""), "eip155");
  });
});

/**
 * Regression for the multi-namespace connect bug: a dApp like Uniswap can
 * fire simultaneous EVM + Solana connect requests. When the Solana leg is
 * rejected (or the dApp resets it via `standard:disconnect` after a
 * failure), the Solana adapter's `handleDisconnect` used to call
 * `PermissionStore.revoke({ origin })` with no namespace filter — which
 * silently wiped the already-approved EVM grant for the same origin too,
 * so the connection manager showed "not connected" despite a live EVM
 * session. `revoke` must scope to `namespace` when the caller passes one.
 */
describe("PermissionStore.revoke namespace scoping", () => {
  const ORIGIN = "https://app.uniswap.org";

  it("a namespace-scoped revoke leaves other namespaces' grants intact", async () => {
    await PermissionStore.grant({
      origin: ORIGIN,
      walletAddress: "0x000000000000000000000000000000000000aa",
      chainId: 1,
    });
    await PermissionStore.grant({
      origin: ORIGIN,
      walletAddress: "SoLwAt1111111111111111111111111111111111",
      chainId: "solana:mainnet",
    });

    // Solana disconnects/resets; EVM must survive.
    await PermissionStore.revoke({ origin: ORIGIN, namespace: "solana" });

    const remaining = PermissionStore.listByOrigin(ORIGIN);
    assert.equal(remaining.length, 1);
    assert.equal(namespaceForChainKey(remaining[0].chainId), "eip155");

    // Cleanup so this test doesn't leak state into others in the process.
    await PermissionStore.revoke({ origin: ORIGIN });
  });

  it("an unscoped revoke (no namespace) still wipes every namespace (site-wide disconnect)", async () => {
    await PermissionStore.grant({
      origin: ORIGIN,
      walletAddress: "0x000000000000000000000000000000000000bb",
      chainId: 1,
    });
    await PermissionStore.grant({
      origin: ORIGIN,
      walletAddress: "SoLwAt2222222222222222222222222222222222",
      chainId: "solana:mainnet",
    });

    await PermissionStore.revoke({ origin: ORIGIN });

    assert.equal(PermissionStore.listByOrigin(ORIGIN).length, 0);
  });
});
