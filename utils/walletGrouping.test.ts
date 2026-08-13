/**
 * Node-only tests for the wallet-picker grouping helpers. No react /
 * react-native imports — runs under `scripts/run-node-tests.sh`.
 */

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { describe, it } from "node:test";

// `@solana/kit` (pulled in transitively via walletUtils) reaches for
// `globalThis.crypto` at import time — mirror walletUtils.test.ts.
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

import type { TWallet } from "@/constants/types/walletTypes";
import {
  buildWalletAccountGroups,
  flattenWalletGroups,
  groupWalletSections,
} from "@/utils/walletGrouping";

// Minimal wallet-row factory. Rows sharing a `seedGroupId` collapse
// into one account (see `groupWalletsIntoAccounts`).
//
// TWV-2026-057 Tier 1 — grouping keys on the non-secret `seedGroupId`
// assigned by the wallet service, never on the mnemonic. Wallets that
// reach this code come from app state and carry no key material.
function row(
  overrides: Partial<TWallet> & Pick<TWallet, "address" | "namespace">,
): TWallet {
  return {
    name: "Wallet",
    balance: "0",
    source: "Social",
    type: "SeedPhrase",
    account: { address: overrides.address },
    ...overrides,
  } as TWallet;
}

// Two Google accounts, each with EVM + Solana + Sui rows, both named
// "Satria" — the exact ambiguous case the email header disambiguates.
function twoGoogleAccounts(): TWallet[] {
  const mk = (
    seed: string,
    email: string,
    addrs: [string, string, string],
  ): TWallet[] => [
    row({
      address: addrs[0],
      namespace: "eip155",
      name: "Satria · ETH",
      seedGroupId: seed,
      socialAccount: { provider: "google", email, name: "Satria Ali" },
    }),
    row({
      address: addrs[1],
      namespace: "solana",
      name: "Satria · SOL",
      seedGroupId: seed,
      socialAccount: { provider: "google", email, name: "Satria Ali" },
    }),
    row({
      address: addrs[2],
      namespace: "sui",
      name: "Satria · SUI",
      seedGroupId: seed,
      socialAccount: { provider: "google", email, name: "Satria Ali" },
    }),
  ];
  return [
    ...mk("seed-one words here", "satria.one@gmail.com", [
      "0xaaa1",
      "solAAA1",
      "0xsuiAAA1",
    ]),
    ...mk("seed-two words here", "satria.two@gmail.com", [
      "0xbbb2",
      "solBBB2",
      "0xsuiBBB2",
    ]),
  ];
}

const showAll = () => true;
const noneExpanded = () => false;

describe("buildWalletAccountGroups", () => {
  it("labels a Google account by its email and derives initials from the name", () => {
    const groups = buildWalletAccountGroups(twoGoogleAccounts());
    assert.equal(groups.length, 2);
    assert.equal(groups[0].label, "satria.one@gmail.com");
    assert.equal(groups[0].provider, "Google");
    assert.equal(groups[0].initials, "SA");
    assert.equal(groups[0].wallets.length, 3);
  });

  it("falls back to the canonical name for a non-social account", () => {
    const groups = buildWalletAccountGroups([
      row({
        address: "0xseed1",
        namespace: "eip155",
        name: "Trading · ETH",
        type: "SeedPhrase",
        source: "Created",
        seedGroupId: "solo seed phrase",
      }),
      row({
        address: "0xseed2",
        namespace: "solana",
        name: "Trading · SOL",
        type: "SeedPhrase",
        source: "Created",
        seedGroupId: "solo seed phrase",
      }),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].label, "Trading");
    assert.equal(groups[0].provider, undefined);
    assert.equal(groups[0].initials, "TR");
  });
});

describe("flattenWalletGroups", () => {
  it("emits a header per account followed by its wallet rows when expanded", () => {
    const groups = buildWalletAccountGroups(twoGoogleAccounts());
    const items = flattenWalletGroups(groups, {
      isVisible: showAll,
      isExpanded: () => true,
      forceExpand: false,
    });
    const headers = items.filter((i) => i.type === "header");
    const rows = items.filter((i) => i.type === "wallet");
    assert.equal(headers.length, 2);
    assert.equal(rows.length, 6);
    // First item is a header, and wallet rows are flagged for indentation.
    assert.equal(items[0].type, "header");
    assert.ok(rows.every((r) => r.type === "wallet" && r.indented));
  });

  it("hides collapsed groups' rows but keeps their headers", () => {
    const groups = buildWalletAccountGroups(twoGoogleAccounts());
    const items = flattenWalletGroups(groups, {
      isVisible: showAll,
      isExpanded: noneExpanded,
      forceExpand: false,
    });
    assert.equal(items.filter((i) => i.type === "header").length, 2);
    assert.equal(items.filter((i) => i.type === "wallet").length, 0);
  });

  it("force-expands every group and marks headers non-collapsible", () => {
    const groups = buildWalletAccountGroups(twoGoogleAccounts());
    const items = flattenWalletGroups(groups, {
      isVisible: showAll,
      isExpanded: noneExpanded,
      forceExpand: true,
    });
    assert.equal(items.filter((i) => i.type === "wallet").length, 6);
    for (const item of items) {
      if (item.type === "header") assert.equal(item.collapsible, false);
    }
  });

  it("drops accounts with no wallet passing the filter", () => {
    const groups = buildWalletAccountGroups(twoGoogleAccounts());
    // Only show the first account's rows.
    const items = flattenWalletGroups(groups, {
      isVisible: (w) => w.address.includes("AAA") || w.address === "0xaaa1",
      isExpanded: () => true,
      forceExpand: false,
    });
    assert.equal(items.filter((i) => i.type === "header").length, 1);
    assert.equal(items.filter((i) => i.type === "wallet").length, 3);
  });

  it("marks the header that holds the active wallet", () => {
    const groups = buildWalletAccountGroups(twoGoogleAccounts());
    const items = flattenWalletGroups(groups, {
      isVisible: showAll,
      isExpanded: noneExpanded,
      forceExpand: false,
      activeAddress: "solBBB2",
    });
    const headers = items.filter(
      (i): i is Extract<typeof i, { type: "header" }> => i.type === "header",
    );
    assert.equal(headers[0].containsActive, false);
    assert.equal(headers[1].containsActive, true);
  });

  it("renders a lone single-wallet account flat with no header", () => {
    const groups = buildWalletAccountGroups([
      row({
        address: "0xonly",
        namespace: "eip155",
        name: "Imported",
        type: "PrivateKey",
        source: "Imported",
      }),
    ]);
    const items = flattenWalletGroups(groups, {
      isVisible: showAll,
      isExpanded: noneExpanded,
      forceExpand: false,
    });
    assert.equal(items.filter((i) => i.type === "header").length, 0);
    assert.equal(items.filter((i) => i.type === "wallet").length, 1);
    // Not indented — nothing to nest under.
    assert.ok(items[0].type === "wallet" && !items[0].indented);
  });

  it("keeps only wallets passing the filter per section (dApp 'Other' case)", () => {
    // Mirrors the dApp connection manager: some of an account's chains are
    // connected (hidden here) and only the rest show under "Other wallets".
    const groups = buildWalletAccountGroups(twoGoogleAccounts());
    const otherAddrs = new Set([
      "0xsuiaaa1", // account 1: only SUI is "other"
      "0xbbb2",
      "solbbb2",
      "0xsuibbb2", // account 2: all three
    ]);
    const sections = groupWalletSections(groups, {
      isVisible: (w) => otherAddrs.has(w.address.toLowerCase()),
      isExpanded: () => true,
      forceExpand: false,
    });
    assert.equal(sections.length, 2);
    assert.equal(sections[0].wallets.length, 1); // account 1 → just SUI
    assert.equal(sections[1].wallets.length, 3); // account 2 → all
    assert.ok(sections.every((s) => s.showHeader));
  });

  it("keeps the header for a single multi-wallet account (email context)", () => {
    const groups = buildWalletAccountGroups(
      twoGoogleAccounts().slice(0, 3), // just the first Google account
    );
    const items = flattenWalletGroups(groups, {
      isVisible: showAll,
      isExpanded: noneExpanded,
      forceExpand: false,
    });
    const headers = items.filter(
      (i): i is Extract<typeof i, { type: "header" }> => i.type === "header",
    );
    assert.equal(headers.length, 1);
    // Single account → shown, expanded, and not collapsible.
    assert.equal(headers[0].expanded, true);
    assert.equal(headers[0].collapsible, false);
    assert.equal(items.filter((i) => i.type === "wallet").length, 3);
  });
});
