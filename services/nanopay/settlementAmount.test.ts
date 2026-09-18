import { describe, expect, it } from "vitest";
import { settlementAmountLabel } from "./settlementAmount.ts";

const ausd = {
  id: "ausd-monad-testnet-token",
  symbol: "AUSD",
  decimals: 6,
  contractAddress: "0x1aC593085Fa34c651E805085da4b2cabAC676F99",
};

describe("settlementAmountLabel", () => {
  it("on-chain rail: labels with the token the api names, never USDC", () => {
    expect(
      settlementAmountLabel({
        path: "takumipay",
        nanopayUsdcAmountMicros: "2966861",
        tokenAmountMinor: "2966861",
        sourceToken: ausd,
      }),
    ).toBe("2.97 AUSD");
  });

  it("on-chain rail: uses the token's own decimals for tokenAmountMinor", () => {
    expect(
      settlementAmountLabel({
        path: "takumipay",
        nanopayUsdcAmountMicros: "2966861",
        tokenAmountMinor: "2966861000000000000",
        sourceToken: { ...ausd, symbol: "X18", decimals: 18 },
      }),
    ).toBe("2.97 X18");
  });

  it("on-chain rail, older api without sourceToken: uses the caller's resolved token on the 6-dec micros", () => {
    expect(
      settlementAmountLabel(
        { path: "takumipay", nanopayUsdcAmountMicros: "2966861" },
        { symbol: "AUSD", decimals: 6 },
      ),
    ).toBe("2.97 AUSD");
  });

  it("on-chain rail, token not known yet: shows the amount with no symbol rather than guessing USDC", () => {
    const label = settlementAmountLabel({
      path: "takumipay",
      nanopayUsdcAmountMicros: "2966861",
    });
    expect(label).toBe("2.97");
    expect(label).not.toContain("USDC");
  });

  it("nanopay rail is USDC by construction", () => {
    expect(
      settlementAmountLabel({
        path: "nanopay",
        nanopayUsdcAmountMicros: "941294",
      }),
    ).toBe("0.9413 USDC");
  });

  it("sourceToken alone marks the rail as on-chain even without path", () => {
    expect(
      settlementAmountLabel({
        nanopayUsdcAmountMicros: "5541189",
        tokenAmountMinor: "5541189",
        sourceToken: ausd,
      }),
    ).toBe("5.54 AUSD");
  });
});
