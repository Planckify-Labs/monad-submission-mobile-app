/**
 * Unit tests for the `chainInfo.ts` helpers that dispatch through the
 * walletKit registry — the chain-agnostic seam that replaced the
 * `namespace === "…"` branches in auth / payment / balance screens.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *        --import ./services/walletKit/evm/_test-resolver.mjs \
 *        services/walletKit/chainInfo.test.ts
 *
 * Node runs each test file in its own process, so booting the singleton
 * registry here doesn't leak into the other walletKit suites.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { mainnet } from "viem/chains";

import type { TBlockchain } from "../../api/types/blockchain.ts";
import type { ChainConfig } from "../../constants/configs/chainConfig.ts";
import {
  addressesEqual,
  canonicalizeAddress,
  getAuthChainSlug,
  getNonceParams,
  matchesBlockchainRow,
  preferredChainRail,
} from "./chainInfo.ts";
import { createEvmWalletKit } from "./evm/EvmWalletKit.ts";
import { walletKitRegistry } from "./registry.ts";
import { createSolanaWalletKit } from "./solana/SolanaWalletKit.ts";
import { createSuiWalletKit } from "./sui/SuiWalletKit.ts";

const ethereumChain: ChainConfig = { namespace: "eip155", chain: mainnet };
const solanaDevnet: ChainConfig = {
  namespace: "solana",
  cluster: "devnet",
  rpcUrl: "https://api.devnet.solana.com",
};
const solanaMainnet: ChainConfig = {
  namespace: "solana",
  cluster: "mainnet-beta",
  rpcUrl: "https://api.mainnet-beta.solana.com",
};
const suiTestnet: ChainConfig = {
  namespace: "sui",
  network: "testnet",
  rpcUrl: "https://fullnode.testnet.sui.io",
};

function row(partial: Partial<TBlockchain>): TBlockchain {
  return {
    id: "row",
    name: "Row",
    chainId: null,
    chainSlug: null,
    rpcUrl: "",
    blockExplorer: "",
    isEVM: false,
    isActive: true,
    isTestnet: false,
    updatedAt: "",
    ...partial,
  } as TBlockchain;
}

before(() => {
  walletKitRegistry.clear();
  walletKitRegistry.register(createEvmWalletKit());
  walletKitRegistry.register(createSolanaWalletKit());
  walletKitRegistry.register(createSuiWalletKit());
});

describe("chainInfo.canonicalizeAddress / addressesEqual", () => {
  const EVM_CHECKSUM = "0x877862C2B7DEfD1beeD83f4654b040f70809c9Dc";
  const EVM_LOWER = EVM_CHECKSUM.toLowerCase();
  const SOLANA = "7EqQdEULxWcraVx3mXKFjc84LhCkMGZCkRuDpvcMwJeK";

  it("EVM: collapses case to the checksum and compares case-insensitively", () => {
    assert.equal(canonicalizeAddress("eip155", EVM_LOWER), EVM_CHECKSUM);
    assert.equal(
      canonicalizeAddress("eip155", EVM_LOWER),
      canonicalizeAddress("eip155", EVM_CHECKSUM),
    );
    assert.equal(addressesEqual("eip155", EVM_CHECKSUM, EVM_LOWER), true);
  });

  it("Solana: keeps base58 verbatim and compares case-sensitively", () => {
    assert.equal(canonicalizeAddress("solana", SOLANA), SOLANA);
    assert.equal(addressesEqual("solana", SOLANA, SOLANA), true);
    assert.equal(addressesEqual("solana", SOLANA, SOLANA.toLowerCase()), false);
  });

  it("falls back to identity for a namespace with no registered kit", () => {
    // Stellar is not registered in this suite — dispatch returns the address
    // unchanged rather than throwing.
    assert.equal(canonicalizeAddress("stellar", "GABC"), "GABC");
    assert.equal(addressesEqual("stellar", "GABC", "GABC"), true);
  });

  it("never matches nullish inputs", () => {
    assert.equal(addressesEqual("eip155", null, EVM_LOWER), false);
    assert.equal(addressesEqual("eip155", EVM_LOWER, undefined), false);
  });
});

describe("chainInfo.getNonceParams", () => {
  it("EVM source -> { chainId }", () => {
    assert.deepEqual(getNonceParams(ethereumChain, ethereumChain), {
      chainId: 1,
    });
  });

  it("Solana source -> { chainSlug } from the chain's cluster", () => {
    assert.deepEqual(getNonceParams(solanaDevnet, solanaDevnet), {
      chainSlug: "solana-devnet",
    });
    assert.deepEqual(getNonceParams(solanaMainnet, solanaMainnet), {
      chainSlug: "solana-mainnet",
    });
  });

  it("Sui source -> { chainSlug } from the chain's network", () => {
    assert.deepEqual(getNonceParams(suiTestnet, suiTestnet), {
      chainSlug: "sui-testnet",
    });
  });

  it("race window: non-EVM wallet + lagging EVM chain falls back to the family mainnet slug", () => {
    // Right after switching to a Solana/Sui wallet, `activeChain` can still
    // be the previous EVM chain. The fallback must keep a chainSlug (not
    // drop to chainId), or the server 400s on the SIWE path.
    assert.deepEqual(
      getNonceParams({ namespace: "solana" } as const, ethereumChain),
      {
        chainSlug: "solana-mainnet",
      },
    );
    assert.deepEqual(
      getNonceParams({ namespace: "sui" } as const, ethereumChain),
      {
        chainSlug: "sui-mainnet",
      },
    );
  });

  it("returns {} when there is no source", () => {
    assert.deepEqual(getNonceParams(undefined, ethereumChain), {});
    assert.deepEqual(getNonceParams(null, null), {});
  });
});

describe("chainInfo.getAuthChainSlug", () => {
  it("delegates to the kit; null for EVM", () => {
    assert.equal(getAuthChainSlug(solanaDevnet), "solana-devnet");
    assert.equal(getAuthChainSlug(suiTestnet), "sui-testnet");
    assert.equal(getAuthChainSlug(ethereumChain), null);
  });
});

describe("chainInfo.preferredChainRail", () => {
  it("solana -> solana; evm -> evm; sui -> evm (no dedicated rail)", () => {
    assert.equal(preferredChainRail(solanaMainnet), "solana");
    assert.equal(preferredChainRail(ethereumChain), "evm");
    assert.equal(preferredChainRail(suiTestnet), "evm");
  });
});

describe("chainInfo.matchesBlockchainRow", () => {
  it("delegates to the kit's matcher", () => {
    assert.equal(
      matchesBlockchainRow(ethereumChain, row({ isEVM: true, chainId: 1 })),
      true,
    );
    assert.equal(
      matchesBlockchainRow(
        solanaDevnet,
        row({ chainSlug: "solana-devnet", isTestnet: true }),
      ),
      true,
    );
    assert.equal(
      matchesBlockchainRow(ethereumChain, row({ isEVM: true, chainId: 8453 })),
      false,
    );
  });
});
