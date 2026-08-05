/**
 * Bridge card formatting.
 *
 * Spec: docs/bridge-capability-spec.md §6, §7.2, §7.7.1.
 *
 * The decimals cases are the load-bearing ones: §6 exists because we used
 * to return amounts WITHOUT decimals and every call site guessed, and
 * Stellar USDC is 7 decimals while USDC everywhere else is 6.
 */

import { describe, expect, it } from "vitest";
import type { TBridgeFee, TBridgeToken } from "@/api/types/bridge";
import {
  chainLabel,
  effectiveRatePercent,
  formatDuration,
  formatSlippage,
  formatTokenAmount,
  formatTokenValue,
  formatUsd,
  mechanismLabel,
  noRouteCopy,
  outcomeCopy,
  partitionFees,
  phaseCopy,
  truncateAddress,
} from "./bridgeFormat";

const usdcBase: TBridgeToken = {
  caip19: "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  chain: "eip155:8453",
  address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  symbol: "USDC",
  decimals: 6,
  isNative: false,
  verification: "verified",
};

const usdcStellar: TBridgeToken = {
  ...usdcBase,
  caip19: "stellar:pubnet/credit_alphanum4:USDC-GA5Z",
  chain: "stellar:pubnet",
  address: "USDC:GA5Z",
  // SEVEN, not six.
  decimals: 7,
};

describe("formatTokenAmount", () => {
  it("formats using the token's own decimals", () => {
    expect(formatTokenAmount("10000000", 6)).toBe("10");
    expect(formatTokenAmount("1234567", 6)).toBe("1.234567");
  });

  it("does not misprice a 7-decimal Stellar amount as a 6-decimal one", () => {
    // The exact §6 bug: a shared USDC_DECIMALS = 6 constant would render
    // this Stellar balance as 100 USDC instead of 10.
    const stellarTenUsdc = "100000000";
    expect(formatTokenAmount(stellarTenUsdc, 7)).toBe("10");
    expect(formatTokenAmount(stellarTenUsdc, 6)).toBe("100");
  });

  it("keeps precision on amounts too large for a float", () => {
    // 2^64 + 1 in wei. Round-tripping through Number would lose the tail.
    expect(formatTokenAmount("18446744073709551617", 0)).toBe(
      "18,446,744,073,709,551,617",
    );
  });

  it("trims trailing zeros but keeps significant digits", () => {
    expect(formatTokenAmount("1500000", 6)).toBe("1.5");
    expect(formatTokenAmount("1000000", 6)).toBe("1");
  });

  it("handles zero, missing input, and malformed input without throwing", () => {
    expect(formatTokenAmount("0", 6)).toBe("0");
    expect(formatTokenAmount(undefined, 6)).toBe("0");
    expect(formatTokenAmount("not-a-number", 6)).toBe("0");
  });

  it("appends the symbol from the token itself", () => {
    expect(formatTokenValue("100000000", usdcStellar)).toBe("10 USDC");
    expect(formatTokenValue("10000000", usdcBase)).toBe("10 USDC");
  });
});

describe("formatSlippage", () => {
  it("renders bps as a visible percentage", () => {
    expect(formatSlippage(30)).toBe("0.30%");
    expect(formatSlippage(300)).toBe("3%");
    expect(formatSlippage(0)).toBe("0%");
    expect(formatSlippage(undefined)).toBe("0%");
  });
});

describe("formatDuration", () => {
  it("prefers a range when the provider gives one", () => {
    expect(formatDuration(1140, [900, 1140])).toBe("15 to 19 min");
  });

  it("falls back to a single estimate", () => {
    expect(formatDuration(45)).toBe("45 sec");
    expect(formatDuration(600)).toBe("10 min");
  });

  it("says Unknown rather than inventing a number", () => {
    expect(formatDuration(undefined)).toBe("Unknown");
    expect(formatDuration(0)).toBe("Unknown");
  });
});

describe("partitionFees", () => {
  const fee = (label: string, included: boolean): TBridgeFee => ({
    key: "bridge",
    label,
    amountRaw: "1000",
    token: usdcBase,
    included,
  });

  it("separates deducted-from-output from charged-on-top", () => {
    // Conflating these means either double-counting or under-reporting.
    const { deducted, onTop } = partitionFees([
      fee("Bridge fee", true),
      fee("Network fee", false),
    ]);
    expect(deducted.map((f) => f.label)).toEqual(["Bridge fee"]);
    expect(onTop.map((f) => f.label)).toEqual(["Network fee"]);
  });

  it("handles an absent fee list", () => {
    expect(partitionFees(undefined)).toEqual({ deducted: [], onTop: [] });
  });
});

describe("effectiveRatePercent", () => {
  it("makes a haircut visible", () => {
    expect(effectiveRatePercent("100", "97")).toBeCloseTo(-3, 5);
  });

  it("returns null rather than inventing a rate", () => {
    expect(effectiveRatePercent(undefined, "97")).toBeNull();
    expect(effectiveRatePercent("0", "97")).toBeNull();
  });
});

describe("outcomeCopy (§7.7.1 — DONE does not mean success)", () => {
  it("treats completed as the only success", () => {
    expect(outcomeCopy("completed", {}).tone).toBe("success");
  });

  it("treats partial as an OUTCOME, not an error, and names the token", () => {
    const copy = outcomeCopy("partial", { receivedSymbol: "USDT" });
    expect(copy.tone).toBe("notice");
    expect(copy.tone).not.toBe("error");
    expect(copy.body).toContain("USDT");
  });

  it("treats refunded as an OUTCOME and names the chain", () => {
    const copy = outcomeCopy("refunded", { refundChainLabel: "Base" });
    expect(copy.tone).toBe("notice");
    expect(copy.body).toContain("Base");
  });

  it("treats failed as the only error tone", () => {
    expect(outcomeCopy("failed", {}).tone).toBe("error");
  });

  it("reports in-progress for a non-terminal state", () => {
    expect(outcomeCopy(null, {}).title).toBe("In progress");
  });

  it("uses no em-dashes anywhere in user-facing copy", () => {
    const outcomes = [
      "completed",
      "partial",
      "refunded",
      "failed",
      null,
    ] as const;
    for (const outcome of outcomes) {
      const copy = outcomeCopy(outcome, {
        receivedSymbol: "USDT",
        refundChainLabel: "Base",
      });
      expect(copy.title).not.toContain("—");
      expect(copy.body ?? "").not.toContain("—");
    }
    for (const phase of [
      "pending_source",
      "pending_attestation",
      "pending_destination",
      "settled",
    ] as const) {
      expect(phaseCopy(phase)).not.toContain("—");
    }
    for (const reason of [
      "same_chain",
      "chain_not_supported",
      "asset_not_supported",
      "check_unavailable",
      undefined,
    ]) {
      expect(noRouteCopy(reason)).not.toContain("—");
    }
  });
});

describe("noRouteCopy (§7.6 — capability boundary, not an error)", () => {
  it("explains each boundary plainly without provider text", () => {
    expect(noRouteCopy("same_chain")).toContain("same chain");
    expect(noRouteCopy("chain_not_supported")).toContain("cannot move funds");
    // A failed CHECK must not be reported as "unsupported".
    expect(noRouteCopy("check_unavailable")).toContain("could not check");
    expect(noRouteCopy("check_unavailable")).not.toContain("not supported");
  });
});

describe("mechanismLabel (§7.3 — trust model disclosure)", () => {
  it("names each trust model in plain language", () => {
    expect(mechanismLabel("burn_mint")).toContain("Burned");
    expect(mechanismLabel("liquidity_pool")).toContain("liquidity pool");
    expect(mechanismLabel("intent_filler")).toContain("filler");
    expect(mechanismLabel("unknown")).toBeNull();
  });
});

describe("chainLabel", () => {
  it("prefers a name from the queried support matrix", () => {
    expect(
      chainLabel("eip155:8453", [{ chain: "eip155:8453", name: "Base" }]),
    ).toBe("Base");
  });

  it("resolves every namespace from the same lookup, with no branching", () => {
    // Names come from DATA (the backend resolves them per provider), not
    // from a chain-family comparison in shared UI. That is what keeps
    // `pnpm check:chains` green and makes adding a chain a registration
    // rather than an edit to this file.
    const known = [
      { chain: "stellar:pubnet", name: "Stellar" },
      { chain: "sui:mainnet", name: "Sui" },
      { chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", name: "Solana" },
    ];
    expect(chainLabel("stellar:pubnet", known)).toBe("Stellar");
    expect(chainLabel("sui:mainnet", known)).toBe("Sui");
    expect(chainLabel("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", known)).toBe(
      "Solana",
    );
  });

  it("falls back to the raw id rather than guessing a name", () => {
    // Honest beats wrong: an unrecognised chain shows its CAIP-2 id.
    expect(chainLabel("eip155:999999")).toBe("eip155:999999");
    expect(chainLabel(undefined)).toBe("Unknown chain");
  });
});

describe("truncateAddress", () => {
  it("keeps both ends visible", () => {
    const addr = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const out = truncateAddress(addr);
    expect(out.startsWith("0x8335")).toBe(true);
    expect(out.endsWith("a02913")).toBe(true);
  });

  it("leaves short values alone", () => {
    expect(truncateAddress("short")).toBe("short");
  });
});

describe("formatUsd", () => {
  it("formats and rejects non-numbers", () => {
    expect(formatUsd("1234.5")).toBe("$1,234.50");
    expect(formatUsd(undefined)).toBeNull();
    expect(formatUsd("nope")).toBeNull();
  });
});
