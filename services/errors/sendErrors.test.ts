import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifySendError, sendErrorCopy } from "./sendErrors.ts";

describe("classifySendError", () => {
  it("maps a viem insufficient-funds error (fresh wallet, no native)", () => {
    const err = Object.assign(
      new Error(
        "insufficient funds for gas * price + value: address 0xabc have 0 want 80000000000000",
      ),
      { name: "InsufficientFundsError" },
    );
    assert.equal(classifySendError(err), "insufficient_fee");
  });

  it("finds the code inside a viem cause chain", () => {
    const err = new Error("Execution reverted", {
      cause: new Error("ERC20: transfer amount exceeds balance"),
    });
    assert.equal(classifySendError(err), "insufficient_balance");
  });

  it("maps Solana / Sui / Stellar fee wording to insufficient_fee", () => {
    assert.equal(
      classifySendError(
        new Error("Transfer: insufficient lamports 0, need 5000"),
      ),
      "insufficient_fee",
    );
    assert.equal(
      classifySendError(new Error("InsufficientGas")),
      "insufficient_fee",
    );
    assert.equal(
      classifySendError(new Error("tx_insufficient_fee")),
      "insufficient_fee",
    );
  });

  it("maps user cancellation", () => {
    assert.equal(
      classifySendError(new Error("User rejected the request")),
      "user_cancelled",
    );
    assert.equal(
      classifySendError({ code: 4001, message: "4001" }),
      "user_cancelled",
    );
  });

  it("maps network failures", () => {
    assert.equal(
      classifySendError(new Error("Network request failed")),
      "network",
    );
    assert.equal(
      classifySendError(
        Object.assign(new Error("x"), { name: "HttpRequestError" }),
      ),
      "network",
    );
  });

  it("falls back to unknown", () => {
    assert.equal(classifySendError(null), "unknown");
    assert.equal(classifySendError(new Error("something odd")), "unknown");
  });
});

describe("sendErrorCopy", () => {
  it("never leaks crypto vocabulary", () => {
    const banned =
      /\bgas\b|\bMON\b|\btoken\b|\bchain\b|\bwallet\b|\brpc\b|\bnonce\b|0x/i;
    for (const code of [
      "insufficient_fee",
      "insufficient_balance",
      "user_cancelled",
      "network",
      "unknown",
    ] as const) {
      const { title, message } = sendErrorCopy(code, "AUSD");
      assert.doesNotMatch(`${title} ${message}`, banned, code);
    }
  });

  it("names the chosen asset for a balance shortfall", () => {
    assert.match(sendErrorCopy("insufficient_balance", "AUSD").message, /AUSD/);
  });
});
