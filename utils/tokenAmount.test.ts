import { describe, expect, it } from "vitest";
import { formatExactTokenAmount, formatTokenAmount } from "./tokenAmount";

describe("formatExactTokenAmount", () => {
  it("keeps every decimal a receipt was paid in", () => {
    // The bug this exists for: the activity-detail hero rendered 5.8 while
    // the Amount row right below it rendered 5.852888.
    expect(formatExactTokenAmount("5852888", 6)).toBe("5.852888");
  });

  it("trims trailing zeros", () => {
    expect(formatExactTokenAmount("5800000", 6)).toBe("5.8");
    expect(formatExactTokenAmount("5000000", 6)).toBe("5");
    expect(formatExactTokenAmount("500000", 6)).toBe("0.5");
  });

  it("groups the integer part", () => {
    expect(formatExactTokenAmount("12345678900", 6)).toBe("12,345.6789");
    expect(formatExactTokenAmount("1000000000000", 6)).toBe("1,000,000");
  });

  it("stays exact past float precision", () => {
    // 18-decimal amounts have more significant digits than a double
    // holds, so any float round-trip in here would corrupt the tail.
    expect(formatExactTokenAmount("1234567890123456789", 18)).toBe(
      "1.234567890123456789",
    );
  });

  it("handles 0 decimals and zero amounts", () => {
    expect(formatExactTokenAmount("42", 0)).toBe("42");
    expect(formatExactTokenAmount("0", 6)).toBe("0");
    expect(formatExactTokenAmount("", 6)).toBe("0");
    expect(formatExactTokenAmount(undefined, 6)).toBe("0");
  });

  it("keeps the sign", () => {
    expect(formatExactTokenAmount("-5852888", 6)).toBe("-5.852888");
  });

  it("falls back to the raw string rather than inventing a scale", () => {
    expect(formatExactTokenAmount("5852888", undefined)).toBe("5852888");
    expect(formatExactTokenAmount("not-a-number", 6)).toBe("not-a-number");
  });
});

describe("formatTokenAmount", () => {
  it("truncates without binary float error", () => {
    // `Math.trunc(0.29 * 100) / 100` is 0.28 — these used to render one
    // digit low.
    expect(formatTokenAmount("0.29")).toBe("0.29");
    expect(formatTokenAmount("0.57")).toBe("0.57");
    expect(formatTokenAmount("0.58")).toBe("0.58");
  });

  it("still truncates to the compact width for lists", () => {
    expect(formatTokenAmount("5.852888")).toBe("5.8");
    expect(formatTokenAmount("0.293456")).toBe("0.29");
    expect(formatTokenAmount("0")).toBe("0");
  });

  it("keeps the K/M/B suffixes", () => {
    expect(formatTokenAmount("1500")).toBe("1.5K");
    expect(formatTokenAmount("1000000")).toBe("1M");
    expect(formatTokenAmount("2500000000")).toBe("2.5B");
  });
});
