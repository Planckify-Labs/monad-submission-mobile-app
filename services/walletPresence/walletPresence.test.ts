import { describe, expect, it } from "vitest";
import type { TWallet } from "@/constants/types/walletTypes";
import {
  getWalletForNamespace,
  hasWalletForNamespace,
  ownedNamespaces,
  resolveNamespaceAccess,
} from "./index";

function wallet(
  partial: Partial<TWallet> & Pick<TWallet, "address" | "namespace">,
): TWallet {
  return {
    name: partial.address,
    balance: "0",
    source: "PrivateKey",
    type: "eoa",
    account: null,
    ...partial,
  } as TWallet;
}

// The bug's canonical shape: a private-key import covers exactly one
// namespace, so every other namespace is genuinely absent.
const evmOnly = [wallet({ address: "0xEVM", namespace: "eip155" })];

// A seed-phrase account: one row per namespace, all sharing a
// `seedGroupId`, so `groupWalletsIntoAccounts` collapses them into a
// single account.
//
// TWV-2026-057 Tier 1 — grouping keys on the non-secret `seedGroupId`
// assigned by the wallet service, NOT on the mnemonic. Wallets that
// reach this code come from app state and carry no key material, so a
// fixture built with `seedPhrase` would no longer group.
const SEED_GROUP = "seedgroup-test-0001";
const seedAccount = [
  wallet({ address: "0xSEED", namespace: "eip155", seedGroupId: SEED_GROUP }),
  wallet({ address: "SolSEED", namespace: "solana", seedGroupId: SEED_GROUP }),
  wallet({ address: "SuiSEED", namespace: "sui", seedGroupId: SEED_GROUP }),
];

describe("hasWalletForNamespace", () => {
  it("is true only for namespaces actually held", () => {
    expect(hasWalletForNamespace(evmOnly, "eip155")).toBe(true);
    expect(hasWalletForNamespace(evmOnly, "sui")).toBe(false);
    expect(hasWalletForNamespace([], "eip155")).toBe(false);
  });
});

describe("getWalletForNamespace", () => {
  it("prefers a wallet from the same account as the preferred address", () => {
    const unrelatedSui = wallet({ address: "SuiOTHER", namespace: "sui" });
    // Unrelated row FIRST, so a naive `find` would return the wrong one.
    const wallets = [unrelatedSui, ...seedAccount];

    expect(getWalletForNamespace(wallets, "sui", "0xSEED")?.address).toBe(
      "SuiSEED",
    );
  });

  it("falls back to any owned wallet when the account has none", () => {
    const wallets = [
      ...evmOnly,
      wallet({ address: "SuiOTHER", namespace: "sui" }),
    ];
    expect(getWalletForNamespace(wallets, "sui", "0xEVM")?.address).toBe(
      "SuiOTHER",
    );
  });

  it("never returns a wrong-namespace wallet", () => {
    // walletForNamespace's any-row fallback would return the EVM row here;
    // this helper must not.
    expect(getWalletForNamespace(evmOnly, "sui", "0xEVM")).toBeUndefined();
  });
});

describe("ownedNamespaces", () => {
  it("de-duplicates and reflects only held namespaces", () => {
    expect(ownedNamespaces(evmOnly)).toEqual(["eip155"]);
    expect(ownedNamespaces(seedAccount).sort()).toEqual([
      "eip155",
      "solana",
      "sui",
    ]);
  });
});

describe("resolveNamespaceAccess", () => {
  const active = evmOnly[0];

  describe("role: active", () => {
    it("resolves when the target namespace IS the active wallet", () => {
      const r = resolveNamespaceAccess({
        wallets: evmOnly,
        activeWallet: active,
        namespace: "eip155",
        role: "active",
      });
      expect(r).toEqual({ ok: true, wallet: active });
    });

    it("refuses with not_active when owned but not active", () => {
      // Signing must bind to what the user sees on screen — owning a Sui
      // wallet does not authorise signing with it while EVM is active.
      const r = resolveNamespaceAccess({
        wallets: seedAccount,
        activeWallet: seedAccount[0],
        namespace: "sui",
        role: "active",
      });
      expect(r).toEqual({
        ok: false,
        code: "not_active",
        owned: seedAccount[2],
      });
    });

    it("refuses with not_owned when nothing exists on the namespace", () => {
      const r = resolveNamespaceAccess({
        wallets: evmOnly,
        activeWallet: active,
        namespace: "sui",
        role: "active",
      });
      expect(r).toEqual({ ok: false, code: "not_owned" });
    });
  });

  describe("role: counterparty", () => {
    it("accepts an owned wallet that is NOT active", () => {
      // This is the case the old active-only guards wrongly rejected: a
      // destination never signs, so it need not be the active wallet.
      const r = resolveNamespaceAccess({
        wallets: seedAccount,
        activeWallet: seedAccount[0],
        namespace: "sui",
        role: "counterparty",
      });
      expect(r).toEqual({ ok: true, wallet: seedAccount[2] });
    });

    it("still refuses when the user owns nothing there", () => {
      const r = resolveNamespaceAccess({
        wallets: evmOnly,
        activeWallet: active,
        namespace: "solana",
        role: "counterparty",
      });
      expect(r).toEqual({ ok: false, code: "not_owned" });
    });

    it("honours the account preference", () => {
      const wallets = [
        wallet({ address: "SolOTHER", namespace: "solana" }),
        ...seedAccount,
      ];
      const r = resolveNamespaceAccess({
        wallets,
        activeWallet: seedAccount[0],
        namespace: "solana",
        role: "counterparty",
        preferredAccountId: "0xSEED",
      });
      expect(r).toEqual({ ok: true, wallet: seedAccount[1] });
    });
  });

  describe("role: discovery", () => {
    it("never fails, even with nothing owned", () => {
      const r = resolveNamespaceAccess({
        wallets: evmOnly,
        activeWallet: active,
        namespace: "sui",
        role: "discovery",
      });
      // Absence is information, not an error — a Sui-less user should
      // still be able to SEE Sui opportunities.
      expect(r).toEqual({ ok: true, wallet: null });
    });

    it("reports the wallet when one is owned", () => {
      const r = resolveNamespaceAccess({
        wallets: seedAccount,
        activeWallet: seedAccount[0],
        namespace: "sui",
        role: "discovery",
      });
      expect(r).toEqual({ ok: true, wallet: seedAccount[2] });
    });
  });

  describe("role: agnostic", () => {
    it("passes regardless of the namespace asked about", () => {
      const r = resolveNamespaceAccess({
        wallets: evmOnly,
        activeWallet: active,
        namespace: "stellar",
        role: "agnostic",
      });
      expect(r).toEqual({ ok: true, wallet: active });
    });

    it("tolerates no active wallet at all", () => {
      const r = resolveNamespaceAccess({
        wallets: [],
        activeWallet: null,
        namespace: "stellar",
        role: "agnostic",
      });
      expect(r).toEqual({ ok: true, wallet: null });
    });
  });
});
