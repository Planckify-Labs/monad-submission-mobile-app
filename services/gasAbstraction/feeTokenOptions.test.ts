/**
 * Tests for the Gas Settings option grouping. Shapes mirror the live
 * 1Shot capabilities as of 2026-09: USDC on every served chain, USDT0
 * on Monad, mUSD on Ethereum + Linea, USDC only on the testnets, and
 * nothing at all for Monad Testnet (not served).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupFeeTokenOptions } from "./feeTokenOptions";
import type { FeeToken } from "./types";

const monad = { key: "eip155:143", name: "Monad", isTestnet: false };
const monadTestnet = {
  key: "eip155:10143",
  name: "Monad Testnet",
  isTestnet: true,
};
const ethereum = { key: "eip155:1", name: "Ethereum", isTestnet: false };
const baseSepolia = {
  key: "eip155:84532",
  name: "Base Sepolia",
  isTestnet: true,
};

const tok = (symbol: string, address: string, decimals = 6): FeeToken => ({
  symbol,
  address,
  decimals,
});

describe("groupFeeTokenOptions", () => {
  it("lists every accepted symbol with the chains it pays gas on, testnets included", () => {
    const tokens = new Map<string, FeeToken[]>([
      [monad.key, [tok("USDC", "0xa"), tok("USDT0", "0xb")]],
      [ethereum.key, [tok("USDC", "0xc"), tok("mUSD", "0xd")]],
      [baseSepolia.key, [tok("USDC", "0xe")]],
      // Monad Testnet: not served → no entry at all.
    ]);
    const options = groupFeeTokenOptions(
      [monad, monadTestnet, ethereum, baseSepolia],
      tokens,
    );
    assert.deepEqual(
      options.map((o) => [o.symbol, o.chains.map((c) => c.key)]),
      [
        ["USDC", [monad.key, ethereum.key, baseSepolia.key]],
        ["USDT0", [monad.key]],
        ["mUSD", [ethereum.key]],
      ],
    );
    // Per-chain token identity is preserved (address differs per chain).
    const usdc = options[0];
    assert.equal(usdc.chains[2].token.address, "0xe");
    assert.equal(usdc.chains[2].isTestnet, true);
  });

  it("sorts by breadth then first appearance and merges symbols case-insensitively", () => {
    const tokens = new Map<string, FeeToken[]>([
      [ethereum.key, [tok("mUSD", "0x1")]],
      [monad.key, [tok("MUSD", "0x2"), tok("USDC", "0x3")]],
      [baseSepolia.key, [tok("USDC", "0x4")]],
    ]);
    const options = groupFeeTokenOptions(
      [ethereum, monad, baseSepolia],
      tokens,
    );
    // mUSD (2 chains) and USDC (2 chains) tie on breadth; mUSD appeared first.
    assert.deepEqual(
      options.map((o) => o.symbol),
      ["mUSD", "USDC"],
    );
    assert.equal(options[0].chains.length, 2);
  });

  it("returns nothing when no probed chain reported tokens", () => {
    assert.deepEqual(groupFeeTokenOptions([monadTestnet], new Map()), []);
  });

  it("skips blank symbols and duplicate chain entries", () => {
    const tokens = new Map<string, FeeToken[]>([
      [monad.key, [tok("", "0x0"), tok("USDC", "0x1"), tok("usdc", "0x1")]],
    ]);
    const options = groupFeeTokenOptions([monad], tokens);
    assert.equal(options.length, 1);
    assert.equal(options[0].chains.length, 1);
  });
});
