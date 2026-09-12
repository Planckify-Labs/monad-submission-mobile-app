/**
 * Wallet binding — spec §4.7: namespace presence, protocol-pinned
 * account, user pick with a most-recently-used default; never the
 * home-screen active wallet.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TWallet } from "@/constants/types/walletTypes";
import { bindWallet } from "./binding.ts";

const w = (
  address: string,
  namespace: TWallet["namespace"],
  accountId?: string,
): TWallet =>
  ({
    name: address,
    address,
    balance: "0",
    source: "seed",
    type: "x",
    namespace,
    account: null,
    accountId,
  }) as unknown as TWallet;

const wallets = [
  w("0xA", "eip155", "acc1"),
  w("SolA", "solana", "acc1"),
  w("SolB", "solana", "acc2"),
  w("GXLM", "stellar"),
];

describe("bindWallet", () => {
  it("no wallet on the namespace → no_wallet_for_namespace", () => {
    assert.deepEqual(bindWallet({ namespace: "sui", wallets }), {
      kind: "reject",
      code: "no_wallet_for_namespace",
    });
  });
  it("single wallet → bound", () => {
    const b = bindWallet({ namespace: "stellar", wallets });
    assert.equal(b.kind, "bound");
    if (b.kind === "bound") assert.equal(b.wallet.address, "GXLM");
  });
  it("pinned account we hold → bound; one we do not → wrong_account", () => {
    const b = bindWallet({
      namespace: "solana",
      wallets,
      pinnedAccount: "SolB",
    });
    assert.ok(b.kind === "bound" && b.wallet.address === "SolB");
    assert.deepEqual(
      bindWallet({ namespace: "solana", wallets, pinnedAccount: "SolZ" }),
      { kind: "reject", code: "wrong_account" },
    );
  });
  it("several wallets → user picks, defaulting to the same-account wallet", () => {
    const b = bindWallet({
      namespace: "solana",
      wallets,
      preferredAccountId: "0xA",
    });
    assert.equal(b.kind, "pick");
    if (b.kind === "pick") {
      assert.equal(b.candidates.length, 2);
      assert.equal(b.defaultWallet.address, "SolA");
    }
  });
});
