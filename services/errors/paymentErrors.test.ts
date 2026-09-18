import { describe, expect, it } from "vitest";
import {
  classifyPaymentError,
  paymentErrorCopy,
  resolvePaymentErrorCopy,
} from "./paymentErrors.ts";

describe("classifyPaymentError — the fee coin and the token are different problems", () => {
  it("viem's gas shortfall is the fee, even though the token balance may also be zero", () => {
    const err = Object.assign(
      new Error(
        "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.\n\nDetails: Insufficient funds for gas * price + value",
      ),
      { name: "TransactionExecutionError" },
    );
    expect(classifyPaymentError(err)).toBe("insufficient_fee");
    expect(
      classifyPaymentError(
        Object.assign(new Error("boom"), { name: "InsufficientFundsError" }),
      ),
    ).toBe("insufficient_fee");
  });

  it("an ERC-20 shortfall is the token", () => {
    expect(
      classifyPaymentError(new Error("ERC20: transfer amount exceeds balance")),
    ).toBe("insufficient_funds");
    expect(classifyPaymentError(new Error("insufficient balance"))).toBe(
      "insufficient_funds",
    );
  });
});

describe("resolvePaymentErrorCopy — names what the payment was actually in", () => {
  const monad = {
    tokenSymbol: "AUSD",
    feeSymbol: "MON",
    networkName: "Monad Testnet",
  };

  it("token shortfall on Monad speaks AUSD and points at the real way out, never a top-up", () => {
    const copy = resolvePaymentErrorCopy("insufficient_funds", monad);
    expect(copy.title).toBe("Not enough AUSD");
    expect(copy.body).toContain("AUSD");
    expect(copy.body).toContain("another wallet");
    expect(copy.cta).toEqual({
      label: "Change wallet or token",
      action: "back",
    });
    expect(
      `${copy.title} ${copy.body} ${copy.cta?.label}`.toLowerCase(),
    ).not.toMatch(/top up|usdc/);
  });

  it("fee shortfall on Monad speaks MON and names the network, without 'gas' or a top-up", () => {
    const copy = resolvePaymentErrorCopy("insufficient_fee", monad);
    expect(copy.title).toBe("This wallet has no MON");
    expect(copy.body).toContain("Monad Testnet");
    expect(copy.body).toContain("MON");
    expect(copy.cta).toEqual({
      label: "Change wallet or network",
      action: "back",
    });
    expect(
      `${copy.title} ${copy.body} ${copy.cta?.label}`.toLowerCase(),
    ).not.toMatch(/gas|top up/);
  });

  it("fee shortfall with numbers says how much, and that a little more will do", () => {
    const copy = resolvePaymentErrorCopy("insufficient_fee", {
      ...monad,
      feeNeeded: "0.0439",
      feeHave: "0.0231",
    });
    expect(copy.title).toBe("Not enough MON for the fee");
    expect(copy.body).toContain("about 0.0439 MON");
    expect(copy.body).toContain("has 0.0231 MON");
    expect(copy.body).toContain("Add a little MON");
  });

  it("the typed pre-sign error classifies as the fee", () => {
    expect(
      classifyPaymentError(
        Object.assign(new Error("x"), { name: "InsufficientFeeError" }),
      ),
    ).toBe("insufficient_fee");
  });

  it("nanopay callers pass USDC explicitly", () => {
    expect(
      resolvePaymentErrorCopy("insufficient_funds", { tokenSymbol: "USDC" })
        .title,
    ).toBe("Not enough USDC");
  });

  it("with no context it never guesses a currency", () => {
    for (const code of ["insufficient_funds", "insufficient_fee"] as const) {
      const copy = resolvePaymentErrorCopy(code);
      expect(`${copy.title} ${copy.body} ${copy.cta?.label}`).not.toMatch(
        /USDC|AUSD|MON\b/,
      );
      expect(copy).toEqual(paymentErrorCopy[code]);
    }
  });

  it("every other code is the static table", () => {
    expect(resolvePaymentErrorCopy("quote_expired", monad)).toBe(
      paymentErrorCopy.quote_expired,
    );
  });
});
