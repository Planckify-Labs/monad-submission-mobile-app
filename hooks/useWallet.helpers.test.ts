/**
 * Unit tests for `useWallet.helpers`.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *        --import ./services/walletKit/evm/_test-resolver.mjs \
 *        hooks/useWallet.helpers.test.ts
 *
 * Style mirrors `services/walletKit/evm/EvmWalletKit.test.ts` — we
 * reuse its `_test-resolver.mjs` so the `@/*` alias + `.ts` suffix
 * resolution + RN/Expo stubs are all in place.
 *
 * Scope: the pure `buildChainConfigFromBlockchain` helper (§7.5's
 * allowed namespace `if`). Kit accessors (`getActiveWalletKit`,
 * `getKitForWallet`) are covered via the registry round-trip test at
 * the bottom of this file — `useWallet` itself is a React hook and
 * not exercisable under node's test runner without a full react-dom
 * / react-native-test-renderer harness that the mobile-app does not
 * currently ship.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TBlockchain } from "../api/types/blockchain.ts";
import { walletKitRegistry } from "../services/walletKit/registry.ts";
import type { WalletKitAdapter } from "../services/walletKit/types.ts";
import { buildChainConfigFromBlockchain } from "./useWallet.helpers.ts";

function makeEvmBlockchain(overrides: Partial<TBlockchain> = {}): TBlockchain {
  return {
    id: "bc_evm_1",
    name: "Ethereum",
    chainId: 1,
    rpcUrl: "https://eth.llamarpc.com",
    blockExplorer: "https://etherscan.io",
    isEVM: true,
    isActive: true,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    tokens: [],
    ...overrides,
  };
}

function makeSolanaBlockchain(
  overrides: Partial<TBlockchain> = {},
): TBlockchain {
  return {
    id: "bc_sol_1",
    name: "Solana Mainnet",
    chainId: 101,
    rpcUrl: "https://api.mainnet-beta.solana.com",
    blockExplorer: "https://solscan.io",
    isEVM: false,
    isActive: true,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    tokens: [],
    ...overrides,
  };
}

function makeStellarBlockchain(
  overrides: Partial<TBlockchain> = {},
): TBlockchain {
  return {
    id: "bc_xlm_1",
    name: "Stellar Testnet",
    chainId: null,
    chainSlug: "stellar-testnet",
    // Post-refactor the backend serves the **Soroban RPC** endpoint here,
    // not Horizon — the whole reason this branch derives Horizon canonically.
    rpcUrl: "https://soroban-testnet.stellar.org",
    blockExplorer: "https://stellar.expert/explorer/testnet",
    isEVM: false,
    isActive: true,
    isTestnet: true,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    tokens: [],
    ...overrides,
  };
}

describe("buildChainConfigFromBlockchain — EVM branch", () => {
  it("produces an eip155 ChainConfig for an EVM row", () => {
    const b = makeEvmBlockchain({
      chainId: 137,
      name: "Polygon",
      rpcUrl: "https://polygon-rpc.com",
    });
    const cc = buildChainConfigFromBlockchain(b);
    assert.equal(cc.namespace, "eip155");
    if (cc.namespace !== "eip155") throw new Error("narrowing guard");
    assert.equal(cc.chain.id, 137);
    assert.equal(cc.chain.name, "Polygon");
    assert.deepEqual(cc.chain.rpcUrls.default.http, [
      "https://polygon-rpc.com",
    ]);
  });

  it("flags testnet when the name contains 'sepolia'", () => {
    const cc = buildChainConfigFromBlockchain(
      makeEvmBlockchain({ name: "Ethereum Sepolia", chainId: 11155111 }),
    );
    assert.equal(cc.isTestnet, true);
  });

  it("falls back to N/A symbol and the blockchain's own name when tokens is empty", () => {
    // A chain with no native token row is rare but valid (freshly-
    // added chain, indexer behind). We surface "N/A" for the symbol
    // (obvious "data missing") rather than lying with "ETH" on what
    // could be Polygon or BSC. Decimals default to the EVM standard.
    const row = makeEvmBlockchain({ name: "Linea" });
    const cc = buildChainConfigFromBlockchain(row);
    if (cc.namespace !== "eip155") throw new Error("narrowing guard");
    assert.equal(cc.chain.nativeCurrency.symbol, "N/A");
    assert.equal(cc.chain.nativeCurrency.name, row.name);
    assert.equal(cc.chain.nativeCurrency.decimals, 18);
  });

  // Native-alias chains (Arc). The gas coin IS USDC there, so ONE balance is
  // exposed at two precisions: 18-decimal wei via eth_getBalance, 6-decimal
  // micros via balanceOf. The feed models that as two rows — a native row
  // (no address) plus the ERC-20 row — and this helper must read the native
  // one. These pin the data contract that keeps the mapping a plain lookup
  // instead of needing an Arc special case.
  it("takes native precision from the native row, not the aliased ERC-20 row", () => {
    const cc = buildChainConfigFromBlockchain(
      makeEvmBlockchain({
        name: "Arc Testnet",
        chainId: 5042002,
        tokens: [
          {
            name: "USD Coin",
            symbol: "USDC",
            decimals: 18,
            contractAddress: null,
            isNativeCurrency: true,
          },
          {
            name: "USD Coin",
            symbol: "USDC",
            decimals: 6,
            contractAddress: "0x3600000000000000000000000000000000000000",
            isNativeCurrency: false,
          },
        ] as TBlockchain["tokens"],
      }),
    );
    if (cc.namespace !== "eip155") throw new Error("narrowing guard");
    // 6 here would format an 18-decimal eth_getBalance result at 6dp and
    // overstate the balance pill by 1e12.
    assert.equal(cc.chain.nativeCurrency.decimals, 18);
    // Gas on Arc really is USDC — the symbol is not a fallback.
    assert.equal(cc.chain.nativeCurrency.symbol, "USDC");
  });

  it("honors a native row whose precision is not 18", () => {
    // Native precision genuinely varies: of the chains viem ships, Tron uses
    // 6 and Nautilus 9. So this must come from the row, never a hardcoded 18.
    const cc = buildChainConfigFromBlockchain(
      makeEvmBlockchain({
        name: "Tron",
        chainId: 728126428,
        tokens: [
          {
            name: "Tronix",
            symbol: "TRX",
            decimals: 6,
            contractAddress: null,
            isNativeCurrency: true,
          },
        ] as TBlockchain["tokens"],
      }),
    );
    if (cc.namespace !== "eip155") throw new Error("narrowing guard");
    assert.equal(cc.chain.nativeCurrency.decimals, 6);
  });
});

describe("buildChainConfigFromBlockchain — Solana branch (§7.5)", () => {
  it("routes `isEVM: false` rows to the solana ChainConfig shape", () => {
    const cc = buildChainConfigFromBlockchain(makeSolanaBlockchain());
    assert.equal(cc.namespace, "solana");
    if (cc.namespace !== "solana") throw new Error("narrowing guard");
    assert.equal(cc.cluster, "mainnet-beta");
    assert.equal(cc.rpcUrl, "https://api.mainnet-beta.solana.com");
    assert.equal(cc.isTestnet, false);
  });

  it("infers `devnet` cluster when the name contains 'devnet'", () => {
    const cc = buildChainConfigFromBlockchain(
      makeSolanaBlockchain({
        name: "Solana Devnet",
        rpcUrl: "https://api.devnet.solana.com",
      }),
    );
    assert.equal(cc.namespace, "solana");
    if (cc.namespace !== "solana") throw new Error("narrowing guard");
    assert.equal(cc.cluster, "devnet");
    assert.equal(cc.isTestnet, true);
  });

  it("honors an explicit `namespace: 'solana'` field if the backend starts sending it", () => {
    const b = {
      ...makeEvmBlockchain({ isEVM: true as boolean }),
      namespace: "solana" as const,
      name: "Solana",
      rpcUrl: "https://rpc.solana",
    };
    const cc = buildChainConfigFromBlockchain(b as TBlockchain);
    assert.equal(cc.namespace, "solana");
  });

  it("defaults to eip155 when namespace is absent and isEVM is true", () => {
    const cc = buildChainConfigFromBlockchain(
      makeEvmBlockchain({ isEVM: true }),
    );
    assert.equal(cc.namespace, "eip155");
  });
});

describe("buildChainConfigFromBlockchain — Stellar branch", () => {
  // Regression guard for the API refactor that repurposed the Stellar
  // `rpcUrl` column from Horizon → Soroban RPC. The classic wallet kit
  // needs Horizon, so this branch must derive it canonically per-network
  // instead of echoing the feed's `rpcUrl`.
  it("derives the canonical testnet Horizon URL, not the feed's rpcUrl", () => {
    const cc = buildChainConfigFromBlockchain(makeStellarBlockchain());
    assert.equal(cc.namespace, "stellar");
    if (cc.namespace !== "stellar") throw new Error("narrowing guard");
    assert.equal(cc.network, "testnet");
    assert.equal(cc.horizonUrl, "https://horizon-testnet.stellar.org");
    // The Soroban endpoint the feed supplied lands in the reserved slot.
    assert.equal(cc.rpcUrl, "https://soroban-testnet.stellar.org");
    assert.equal(cc.isTestnet, true);
  });

  it("derives the canonical mainnet Horizon URL and leaves the Soroban slot empty", () => {
    // stellar-mainnet still serves a Horizon URL in `rpcUrl` (no Soroban
    // mainnet deployment yet) — it must NOT be mislabeled as Soroban.
    const cc = buildChainConfigFromBlockchain(
      makeStellarBlockchain({
        id: "bc_xlm_main",
        name: "Stellar",
        chainSlug: "stellar-mainnet",
        rpcUrl: "https://horizon.stellar.org",
        blockExplorer: "https://stellar.expert/explorer/public",
        isTestnet: false,
      }),
    );
    assert.equal(cc.namespace, "stellar");
    if (cc.namespace !== "stellar") throw new Error("narrowing guard");
    assert.equal(cc.network, "mainnet");
    assert.equal(cc.horizonUrl, "https://horizon.stellar.org");
    assert.equal(cc.rpcUrl, undefined);
    assert.equal(cc.isTestnet, false);
  });
});

describe("walletKitRegistry — kit accessor round-trip", () => {
  // `useWallet.getActiveWalletKit` / `getKitForWallet` are one-liners
  // over `walletKitRegistry.get(ns)`. We validate the registry
  // contract here so the hook-facing helpers stay covered without a
  // react-dom harness.
  const originalKits = walletKitRegistry.getAll();

  function installKit(
    adapter: Partial<WalletKitAdapter> & { namespace: "eip155" | "solana" },
  ): WalletKitAdapter {
    const kit: WalletKitAdapter = {
      namespace: adapter.namespace,
      validateAddress: () => true,
      validatePrivateKey: () => true,
      validateMnemonic: () => true,
      createWalletFromPrivateKey: async () => ({}) as never,
      createWalletFromMnemonic: async () => ({}) as never,
      generateMnemonic: () => "",
      getSignerForWallet: async () => null,
      getNativeBalance: async () => 0n,
      sendNativeTransfer: async () => "",
      estimateMaxTransferable: async () => 0n,
      formatNativeAmount: () => "",
      parseNativeAmount: () => 0n,
      truncateAddress: () => "",
      ...adapter,
    };
    walletKitRegistry.register(kit);
    return kit;
  }

  it("registry resolves a kit by namespace (the only thing getActiveWalletKit does)", () => {
    walletKitRegistry.clear();
    const evm = installKit({ namespace: "eip155" });
    const sol = installKit({ namespace: "solana" });

    assert.equal(walletKitRegistry.get("eip155"), evm);
    assert.equal(walletKitRegistry.get("solana"), sol);
    assert.equal(walletKitRegistry.get("eip155").namespace, "eip155");
    assert.equal(walletKitRegistry.get("solana").namespace, "solana");
  });

  it("a wallet with `namespace: 'solana'` resolves to the solana kit", () => {
    walletKitRegistry.clear();
    installKit({ namespace: "eip155" });
    const sol = installKit({ namespace: "solana" });
    const walletLike = { namespace: "solana" } as { namespace: "solana" };
    assert.equal(walletKitRegistry.get(walletLike.namespace), sol);
  });

  it("registry throws when the namespace is unknown (boot-order safety)", () => {
    walletKitRegistry.clear();
    assert.throws(
      () => walletKitRegistry.get("eip155"),
      /WalletKit not registered/,
    );
  });

  // Restore original boot state so other tests in the suite aren't
  // affected by ordering.
  it.after(() => {
    walletKitRegistry.clear();
    for (const k of originalKits) walletKitRegistry.register(k);
  });
});
