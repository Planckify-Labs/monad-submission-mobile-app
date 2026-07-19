import { describe, expect, it } from "vitest";
import { foldAddressForKey } from "./addressCompare";

const EVM_CHECKSUM = "0x877862C2B7DEfD1beeD83f4654b040f70809c9Dc";
const SOLANA = "7EqQdEULxWcraVx3mXKFjc84LhCkMGZCkRuDpvcMwJeK";
const STELLAR = "GAKONCKYJ7PRRKBZSWVPG3MURUNX7FDMTKM6H2DXNTNBFHFZC2LFK6RS";

describe("foldAddressForKey", () => {
  it("folds 0x-hex (EVM / Sui) to lowercase", () => {
    expect(foldAddressForKey(EVM_CHECKSUM)).toBe(EVM_CHECKSUM.toLowerCase());
    expect(foldAddressForKey("0xABCDEF")).toBe("0xabcdef");
  });

  it("keeps case-significant Solana base58 verbatim", () => {
    expect(foldAddressForKey(SOLANA)).toBe(SOLANA);
    expect(foldAddressForKey(SOLANA)).not.toBe(SOLANA.toLowerCase());
  });

  it("keeps case-significant Stellar base32 verbatim", () => {
    expect(foldAddressForKey(STELLAR)).toBe(STELLAR);
    expect(foldAddressForKey(STELLAR)).not.toBe(STELLAR.toLowerCase());
  });
});
