/**
 * Unit tests for the hand-typed spending cap.
 *
 * This function turns keystrokes into the integer that goes into signed
 * `approve` calldata, so the cases below are the ones where getting it wrong
 * is expensive rather than merely annoying.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types --import ./services/walletKit/evm/_test-resolver.mjs components/dapps-browser/approvals/spendingCapInput.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  groupDigits,
  parseSpendingCapInput,
  spendingCapError,
} from "./spendingCapInput.ts";

const ok = (text: string, decimals: number): bigint => {
  const r = parseSpendingCapInput(text, decimals);
  assert.ok(r.ok, `expected "${text}" to parse`);
  return r.value;
};
const reason = (text: string, decimals: number): string => {
  const r = parseSpendingCapInput(text, decimals);
  assert.ok(!r.ok, `expected "${text}" to be rejected`);
  return r.reason;
};

describe("parseSpendingCapInput — decimal amounts", () => {
  it("accepts fractional input at the token's scale", () => {
    assert.equal(ok("10.6", 6), 10_600_000n);
    assert.equal(ok("7.833", 6), 7_833_000n);
    assert.equal(ok("0.000001", 6), 1n);
    assert.equal(ok("1", 18), 10n ** 18n);
  });

  it("accepts a decimal comma — the Android keyboard emits the locale mark", () => {
    // The bug this file exists for: a phone set to id-ID types "10,6" and the
    // field used to reject it as invalid, which reads as "this app is broken"
    // rather than "wrong separator".
    assert.equal(ok("10,6", 6), 10_600_000n);
    assert.equal(ok("7,833", 6), 7_833_000n);
    assert.equal(ok("10,6", 6), ok("10.6", 6));
  });

  it("tolerates the partial input a person types on the way", () => {
    assert.equal(ok("10.", 6), 10_000_000n);
    assert.equal(ok(".5", 6), 500_000n);
    assert.equal(ok(" 10.6 ", 6), 10_600_000n);
  });
});

describe("parseSpendingCapInput — refusals", () => {
  it("refuses excess precision instead of silently rounding it away", () => {
    // viem's parseUnits would return 1123457 here, quietly editing the amount
    // somebody is approving. Naming it is the whole point.
    assert.equal(reason("1.1234567", 6), "tooPrecise");
    assert.equal(
      spendingCapError("tooPrecise", 6),
      "This token supports up to 6 decimal places.",
    );
  });

  it("refuses mixed separators rather than guessing a locale", () => {
    // "1,234.5" and "1.234,5" mean different numbers in different places, and
    // guessing wrong moves the cap by 1000x.
    assert.equal(reason("1,234.5", 6), "ambiguous");
    assert.equal(reason("1.234,5", 6), "ambiguous");
    assert.equal(reason("1.2.3", 6), "ambiguous");
    assert.equal(reason("1,2,3", 6), "ambiguous");
  });

  it("refuses junk", () => {
    assert.equal(reason("abc", 6), "invalid");
    assert.equal(reason("-5", 6), "invalid");
    assert.equal(reason("", 6), "empty");
    assert.equal(reason("   ", 6), "empty");
  });

  it("carries a very large cap without loss", () => {
    // Whole-token input at 18 decimals still has to land exactly; float math
    // anywhere in this path would round the top of the range away.
    assert.equal(ok("1000000000000", 18), 10n ** 30n);
    assert.equal(ok("0.000000000000000001", 18), 1n);
  });

  it("accepts the everyday amounts a person actually types", () => {
    assert.equal(ok("5.19", 6), 5_190_000n);
    assert.equal(ok("100", 6), 100_000_000n);
    assert.equal(ok("5,19", 6), 5_190_000n);
  });
});

describe("groupDigits", () => {
  it("groups so a raw-unit preview can be checked at a glance", () => {
    assert.equal(groupDigits(6_000_000n), "6,000,000");
    assert.equal(groupDigits(1n), "1");
    assert.equal(groupDigits(1000n), "1,000");
  });
});
