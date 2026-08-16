/**
 * Slippage policy (spec §12 Q4, §11 Layer 2).
 *
 * The property under test is a refusal, not a calculation: there must be NO
 * input for which this module returns a zero minimum. A zero `min_mint_amount`
 * does not revert and does not look wrong in a log — it just lets the deposit
 * be sandwiched, which is why the policy is a hard block rather than a default.
 */

import { describe, expect, it } from "vitest";
import { DefiError } from "./errors/defiErrors";
import {
  applySlippage,
  MAX_SLIPPAGE_BPS,
  minOutFor,
  slippageBpsFor,
} from "./slippage";

describe("slippageBpsFor", () => {
  it("tightens the budget for conservative users", () => {
    expect(slippageBpsFor({ tier: "conservative", stable: true })).toBe(25);
    expect(slippageBpsFor({ tier: "conservative", stable: false })).toBe(50);
    expect(slippageBpsFor({ tier: "balanced", stable: true })).toBe(50);
    expect(slippageBpsFor({ tier: "balanced", stable: false })).toBe(100);
  });

  it("defaults to balanced when no tier is resolved", () => {
    expect(slippageBpsFor({ stable: true })).toBe(50);
  });

  it("refuses an override above the hard ceiling rather than clamping it", () => {
    // Clamping would silently substitute a number nobody chose.
    expect(() => slippageBpsFor({ overrideBps: MAX_SLIPPAGE_BPS + 1 })).toThrow(
      DefiError,
    );
    expect(slippageBpsFor({ overrideBps: MAX_SLIPPAGE_BPS })).toBe(
      MAX_SLIPPAGE_BPS,
    );
  });

  it("refuses a negative or non-finite budget", () => {
    expect(() => slippageBpsFor({ overrideBps: -1 })).toThrow(DefiError);
    expect(() => slippageBpsFor({ overrideBps: Number.NaN })).toThrow(
      DefiError,
    );
  });
});

describe("applySlippage", () => {
  it("subtracts exactly the budget", () => {
    // 1_000_000 at 50bps = 0.5% -> 995_000
    expect(applySlippage(1_000_000n, 50)).toBe(995_000n);
    expect(applySlippage(1_000_000n, 300)).toBe(970_000n);
  });

  it("refuses to floor an unpriced quote", () => {
    // A view that returned 0 could not price the deposit; a 0 minimum would be
    // the sandwich hole, so the build must fail instead.
    expect(() => applySlippage(0n, 50)).toThrow(DefiError);
    expect(() => applySlippage(-1n, 50)).toThrow(DefiError);
  });

  it("refuses when rounding would produce a zero minimum", () => {
    // A dust deposit whose minimum floors to zero is still a zero minimum.
    expect(() => applySlippage(1n, 10_000)).toThrow(DefiError);
  });

  it("never returns zero for any accepted budget", () => {
    for (const bps of [1, 25, 50, 100, 300]) {
      expect(minOutFor(10n ** 18n, { overrideBps: bps })).toBeGreaterThan(0n);
    }
  });
});
