/**
 * Run:
 *   node --test --experimental-strip-types \
 *        --import ./services/walletKit/evm/_test-resolver.mjs \
 *        components/dapps-browser/connections/connectedApps.test.ts
 *
 * `sessionWallets` folds addresses through the registered kit's case rule,
 * so the EVM kit is booted for the checksum behaviour; Solana is booted to
 * prove base58 is left alone.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { DappConnectionSite } from "../../../hooks/useDappConnections.ts";
import type { TransportSession } from "../../../services/transports/types.ts";
import { createEvmWalletKit } from "../../../services/walletKit/evm/EvmWalletKit.ts";
import { walletKitRegistry } from "../../../services/walletKit/registry.ts";
import { createSolanaWalletKit } from "../../../services/walletKit/solana/SolanaWalletKit.ts";
import {
  buildConnectedApps,
  sessionExpiryLabel,
  sessionWallets,
} from "./connectedApps.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const EVM = "0x0141bE8b0dA6c1A7A7c8C4Bb5b4D4f4A5b6C4DB6";

function session(over: Partial<TransportSession>): TransportSession {
  return {
    id: "topic",
    transport: "walletconnect",
    peer: {
      name: "Exchange | PancakeSwap",
      url: "https://pancakeswap.finance",
    },
    chains: ["eip155:1", "eip155:56"],
    accounts: [`eip155:1:${EVM}`, `eip155:56:${EVM}`],
    originKey: "wc+https://pancakeswap.finance#topic",
    createdAt: 0,
    expiresAt: NOW + 6 * DAY,
    ...over,
  };
}

function site(origin: string): DappConnectionSite {
  return { origin, wallets: [], count: 0 };
}

before(() => {
  walletKitRegistry.register(createEvmWalletKit());
  walletKitRegistry.register(createSolanaWalletKit());
});

describe("buildConnectedApps", () => {
  it("folds a browser grant and a WalletConnect session for one host into one card", () => {
    const apps = buildConnectedApps(
      [site("https://pancakeswap.finance")],
      [session({ id: "a" })],
    );
    assert.equal(apps.length, 1);
    assert.equal(apps[0].key, "pancakeswap.finance");
    assert.ok(apps[0].site);
    assert.equal(apps[0].sessions.length, 1);
  });

  it("keeps several sessions of the same app on one card, most recent first", () => {
    const apps = buildConnectedApps(
      [],
      [
        session({ id: "old", expiresAt: NOW + 2 * DAY }),
        session({ id: "new", expiresAt: NOW + 6 * DAY }),
      ],
    );
    assert.equal(apps.length, 1);
    assert.deepEqual(
      apps[0].sessions.map((s) => s.id),
      ["new", "old"],
    );
  });

  it("keeps sites in their order and appends session-only hosts after", () => {
    const apps = buildConnectedApps(
      [site("https://app.1inch.io"), site("https://app.compound.finance")],
      [
        session({
          id: "t",
          peer: { name: "Tower", url: "https://tower.exchange" },
        }),
      ],
    );
    assert.deepEqual(
      apps.map((a) => a.key),
      ["app.1inch.io", "app.compound.finance", "tower.exchange"],
    );
    assert.equal(apps[2].site, undefined);
  });

  it("uses the first session icon for the card", () => {
    const apps = buildConnectedApps(
      [site("https://pancakeswap.finance")],
      [
        session({ id: "no-icon" }),
        session({
          id: "icon",
          expiresAt: NOW + DAY,
          peer: {
            name: "PancakeSwap",
            url: "https://pancakeswap.finance",
            icon: "https://pancakeswap.finance/logo.png",
          },
        }),
      ],
    );
    assert.equal(apps[0].icon, "https://pancakeswap.finance/logo.png");
  });

  it("falls back to the peer name, then the session id, when there is no URL", () => {
    const apps = buildConnectedApps(
      [],
      [
        session({ id: "x", peer: { name: "Native app", url: "" } }),
        session({ id: "y", transport: "mwa", peer: { name: "", url: "" } }),
      ],
    );
    assert.deepEqual(
      apps.map((a) => a.key),
      ["Native app", "mwa:y"],
    );
  });
});

describe("sessionWallets", () => {
  it("collapses one wallet on many EVM chains to a single entry", () => {
    const rows = sessionWallets(
      session({
        accounts: [
          `eip155:1:${EVM}`,
          `eip155:56:${EVM.toLowerCase()}`,
          `eip155:8453:${EVM}`,
        ],
      }),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].namespace, "eip155");
  });

  it("does not fold Solana addresses that differ only by case", () => {
    const rows = sessionWallets(
      session({
        accounts: [
          "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d:AbC",
          "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d:abc",
        ],
      }),
    );
    assert.equal(rows.length, 2);
  });

  it("keeps wallets of different namespaces apart", () => {
    const rows = sessionWallets(
      session({
        accounts: [`eip155:1:${EVM}`, "solana:mainnet:So1anaAddr"],
      }),
    );
    assert.deepEqual(
      rows.map((r) => r.namespace),
      ["eip155", "solana"],
    );
  });
});

describe("sessionExpiryLabel", () => {
  it("speaks in whole days", () => {
    assert.equal(sessionExpiryLabel(undefined, NOW), null);
    assert.equal(sessionExpiryLabel(NOW - 1, NOW), "Expired");
    assert.equal(sessionExpiryLabel(NOW + DAY / 2, NOW), "Expires today");
    assert.equal(sessionExpiryLabel(NOW + 1.5 * DAY, NOW), "Expires tomorrow");
    assert.equal(sessionExpiryLabel(NOW + 6.9 * DAY, NOW), "Expires in 6 days");
  });
});
