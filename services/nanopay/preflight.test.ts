import { describe, expect, it } from "vitest";
import { preflightShortfall } from "./preflight.ts";

const ausd = {
  decimals: 6,
  contractAddress: "0x1aC593085Fa34c651E805085da4b2cabAC676F99",
};
const intent = {
  nanopayUsdcAmountMicros: "2966861",
  tokenAmountMinor: "2966861",
};
const loaded = { isLoadingTokenBalance: false, isLoadingBalance: false };

describe("preflightShortfall — say it before the PIN prompt, in the right token", () => {
  it("empty wallet on Monad: the token comes first (that's what the merchant gets)", () => {
    expect(
      preflightShortfall({
        ...loaded,
        paymentToken: ausd,
        tokenBalance: "0",
        nativeBalance: 0n,
        feePaidInNative: true,
        intent,
      }),
    ).toBe("insufficient_funds");
  });

  it("enough AUSD but no MON: the fee coin is what's missing", () => {
    expect(
      preflightShortfall({
        ...loaded,
        paymentToken: ausd,
        tokenBalance: "907734",
        nativeBalance: 0n,
        feePaidInNative: true,
        intent,
      }),
    ).toBe("insufficient_fee");
  });

  it("with a live fee estimate, MON > 0 is not enough: it has to cover the fee", () => {
    const base = {
      ...loaded,
      paymentToken: ausd,
      tokenBalance: "907734",
      feePaidInNative: true,
      intent,
    };
    // 0.0231 MON held, 0.0439 MON needed
    expect(
      preflightShortfall({
        ...base,
        nativeBalance: 23_130_164_000_000_000n,
        feeNeededWei: 43_864_368_000_000_000n,
      }),
    ).toBe("insufficient_fee");
    expect(
      preflightShortfall({
        ...base,
        nativeBalance: 50_000_000_000_000_000n,
        feeNeededWei: 43_864_368_000_000_000n,
      }),
    ).toBeNull();
  });

  it("enough of both: nothing to say", () => {
    expect(
      preflightShortfall({
        ...loaded,
        paymentToken: ausd,
        tokenBalance: "907734",
        nativeBalance: 993_500_000_000_000_000n,
        feePaidInNative: true,
        intent,
      }),
    ).toBeNull();
  });

  it("exactly the amount is enough; one unit short is not", () => {
    const base = {
      ...loaded,
      paymentToken: ausd,
      nativeBalance: 1n,
      feePaidInNative: true,
      intent,
    };
    expect(
      preflightShortfall({ ...base, tokenBalance: "2.966861" }),
    ).toBeNull();
    expect(preflightShortfall({ ...base, tokenBalance: "2.96686" })).toBe(
      "insufficient_funds",
    );
  });

  it("scales by the token's decimals when the api didn't send tokenAmountMinor", () => {
    const tok18 = {
      decimals: 18,
      contractAddress: "0x2222222222222222222222222222222222222222",
    };
    const legacy = { nanopayUsdcAmountMicros: "2966861" };
    expect(
      preflightShortfall({
        ...loaded,
        paymentToken: tok18,
        tokenBalance: "2.966861",
        nativeBalance: 1n,
        feePaidInNative: true,
        intent: legacy,
      }),
    ).toBeNull();
    expect(
      preflightShortfall({
        ...loaded,
        paymentToken: tok18,
        tokenBalance: "2.9",
        nativeBalance: 1n,
        feePaidInNative: true,
        intent: legacy,
      }),
    ).toBe("insufficient_funds");
  });

  it("never rules a payment out while balances are still loading", () => {
    expect(
      preflightShortfall({
        paymentToken: ausd,
        tokenBalance: "0",
        isLoadingTokenBalance: true,
        nativeBalance: 0n,
        isLoadingBalance: true,
        feePaidInNative: true,
        intent,
      }),
    ).toBeNull();
  });

  it("skips the fee check on rails that don't pay it from the native balance", () => {
    expect(
      preflightShortfall({
        ...loaded,
        paymentToken: ausd,
        tokenBalance: "907734",
        nativeBalance: 0n,
        feePaidInNative: false,
        intent,
      }),
    ).toBeNull();
  });
});
