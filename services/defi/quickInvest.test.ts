/**
 * Quick Invest allocation (docs/defi-quick-invest-spec.md §10).
 *
 * Covers the four things the spec names as worth a dedicated test: the
 * §5.0 single-asset filter, weights summing to 1, `Σamount_i === total`
 * after rounding, `in_app` filtering, and the §5.2 collapse to `N = 1`
 * (flat floor as the primary path, plus the presence-checked
 * `minDepositRaw` refinement where an adapter supplies one).
 */

import { describe, expect, it } from "vitest";
import {
  allocatableRows,
  allocate,
  bestScoringAsset,
  buildDepositPrompt,
  formatUsd,
  isUsdPegged,
  legCount,
  MIN_LEG_USD,
  projectionApy,
  type QuickInvestRow,
  resolveTargetAsset,
  sliderBounds,
  snapToStep,
  starterAmountUsd,
  usdToTokenAmount,
  valueAtPageX,
} from "./quickInvest";

function row(over: Partial<QuickInvestRow> = {}): QuickInvestRow {
  return {
    protocol_slug: "aave-v3",
    asset_symbol: "USDC",
    chain_id: 42161,
    chain_name: "Arbitrum",
    namespace: "eip155",
    in_app: true,
    apy: 3.1,
    apy_7d_avg: 3.0,
    score: 80,
    tier: "balanced",
    ...over,
  };
}

const sumOf = (ns: number[]) =>
  Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100;

describe("projectionApy", () => {
  it("prefers the 7d average over the current APY (§11.5)", () => {
    // The shipped Gmx V2 Perps row: 5.55% current vs 9.69% 7d.
    expect(projectionApy(row({ apy: 5.55, apy_7d_avg: 9.69 }))).toBe(9.69);
  });

  it("falls back to current APY when there is no 7d average", () => {
    expect(projectionApy(row({ apy: 4.2, apy_7d_avg: undefined }))).toBe(4.2);
  });

  it("parses string APYs and treats unparseable ones as zero", () => {
    expect(projectionApy(row({ apy_7d_avg: "2.5" }))).toBe(2.5);
    expect(projectionApy(row({ apy: "n/a", apy_7d_avg: undefined }))).toBe(0);
  });
});

describe("legCount (§11.2)", () => {
  it("expresses the floor as a minimum leg size, not a total threshold", () => {
    expect(legCount(750, 10)).toBe(3);
    expect(legCount(120, 10)).toBe(2);
    expect(legCount(40, 10)).toBe(1);
    expect(legCount(MIN_LEG_USD, 10)).toBe(1);
  });

  it("caps at the number of pools actually available", () => {
    expect(legCount(750, 2)).toBe(2);
    expect(legCount(750, 0)).toBe(0);
  });

  it("never exceeds three legs however large the total", () => {
    expect(legCount(5_000_000, 40)).toBe(3);
  });
});

describe("resolveTargetAsset (§5.0)", () => {
  const rows = [
    row({ asset_symbol: "USDC", score: 70 }),
    row({ asset_symbol: "USDT", score: 90, protocol_slug: "compound-v3" }),
    row({
      asset_symbol: "WETH",
      score: 95,
      protocol_slug: "fluid",
      in_app: false,
    }),
  ];

  it("honours the asset the model passed", () => {
    expect(resolveTargetAsset(rows, { inputAsset: "usdc" })).toBe("USDC");
  });

  it("falls back to the detected idle balance's asset", () => {
    expect(resolveTargetAsset(rows, { detectedAsset: "USDT" })).toBe("USDT");
  });

  it("ignores a candidate with no allocatable row and uses the best score", () => {
    // WETH only appears on a manual row, so it is not depositable here.
    expect(resolveTargetAsset(rows, { inputAsset: "WETH" })).toBe("USDT");
    expect(bestScoringAsset(rows)).toBe("USDT");
  });

  it("skips an asset the card cannot price, even if it scores best", () => {
    // The shipped Avalanche bug, verbatim: BTC.B on Aave V3 had the best
    // safety score, so the card allocated into it at 0.01% APY — an asset
    // with no resolvable USD price, so the projection read $0.00 and the
    // CTA was dead, while the agent's own reply recommended USDC at ~4.7%.
    const avalanche = [
      row({
        protocol_slug: "aave-v3",
        asset_symbol: "BTC.B",
        score: 95,
        apy_7d_avg: 0.01,
      }),
      row({
        protocol_slug: "benqi-lending",
        asset_symbol: "BTC.B",
        score: 90,
        apy_7d_avg: 1.23,
      }),
      row({
        protocol_slug: "centrifuge",
        asset_symbol: "USDC",
        score: 80,
        apy_7d_avg: 4.72,
      }),
    ];
    const canPrice = (sym: string) => sym === "USDC";

    expect(resolveTargetAsset(avalanche, { canPrice })).toBe("USDC");
    // Without the predicate the old behaviour is preserved, which is what
    // makes this a real guard rather than a tautology.
    expect(resolveTargetAsset(avalanche, {})).toBe("BTC.B");
  });

  it("still honours a named or held asset it cannot price", () => {
    // Deliberate: an asset the user named, or is actually holding, is what
    // they meant. The card has an honest "we can't price this" state.
    const rows = [
      row({ asset_symbol: "BTC.B", score: 95 }),
      row({ asset_symbol: "USDC", score: 10, protocol_slug: "centrifuge" }),
    ];
    const canPrice = (sym: string) => sym === "USDC";
    expect(resolveTargetAsset(rows, { inputAsset: "BTC.B", canPrice })).toBe(
      "BTC.B",
    );
    expect(resolveTargetAsset(rows, { detectedAsset: "BTC.B", canPrice })).toBe(
      "BTC.B",
    );
  });

  it("falls back to an unpriceable asset rather than rendering nothing", () => {
    const rows = [row({ asset_symbol: "BTC.B", score: 95 })];
    expect(resolveTargetAsset(rows, { canPrice: () => false })).toBe("BTC.B");
  });

  it("returns null when nothing is allocatable", () => {
    expect(resolveTargetAsset([row({ in_app: false })], {})).toBeNull();
  });
});

describe("allocate (§5.1)", () => {
  const rows = [
    row({ protocol_slug: "compound-v3", score: 90, apy_7d_avg: 1.97 }),
    row({ protocol_slug: "aave-v3", score: 80, apy_7d_avg: 3.1 }),
    row({ protocol_slug: "fluid", score: 70, apy_7d_avg: 1.04 }),
    row({ protocol_slug: "morpho", score: 60, apy_7d_avg: 6.0 }),
  ];

  it("splits by score, safest first, capped at three legs", () => {
    const a = allocate({ rows, totalUsd: 750, assetSymbol: "USDC" });
    expect(a.legs.map((l) => l.row.protocol_slug)).toEqual([
      "compound-v3",
      "aave-v3",
      "fluid",
    ]);
    // 90/80/70 of 240 → 37.5% / 33.3% / 29.2%
    expect(a.legs[0].amountUsd).toBeGreaterThan(a.legs[1].amountUsd);
    expect(a.legs[1].amountUsd).toBeGreaterThan(a.legs[2].amountUsd);
  });

  it("sums to the total exactly after rounding, remainder in the largest leg", () => {
    for (const total of [750, 100.01, 333.33, 1_000, 12_345.67]) {
      const a = allocate({ rows, totalUsd: total, assetSymbol: "USDC" });
      expect(sumOf(a.legs.map((l) => l.amountUsd))).toBe(a.totalUsd);
    }
  });

  it("keeps weights summing to 1 and derives them from the rounded amounts", () => {
    const a = allocate({ rows, totalUsd: 750, assetSymbol: "USDC" });
    expect(a.legs.reduce((s, l) => s + l.weight, 0)).toBeCloseTo(1, 10);
    for (const leg of a.legs) {
      expect(leg.weight).toBeCloseTo(leg.amountUsd / a.totalUsd, 10);
    }
  });

  it("filters to a single asset before splitting (§5.0)", () => {
    const mixed = [
      ...rows,
      row({ protocol_slug: "venus", asset_symbol: "USDT", score: 99 }),
    ];
    const a = allocate({ rows: mixed, totalUsd: 750, assetSymbol: "USDC" });
    expect(a.legs.every((l) => l.row.asset_symbol === "USDC")).toBe(true);
    // The higher-scoring USDT row must not displace a USDC leg.
    expect(a.legs.map((l) => l.row.protocol_slug)).not.toContain("venus");
  });

  it("never allocates into a manual pool", () => {
    const withManual = [
      row({ protocol_slug: "pendle", score: 99, in_app: false }),
      ...rows,
    ];
    const a = allocate({
      rows: withManual,
      totalUsd: 750,
      assetSymbol: "USDC",
    });
    expect(a.legs.map((l) => l.row.protocol_slug)).not.toContain("pendle");
    expect(a.legs.every((l) => l.row.in_app === true)).toBe(true);
  });

  it("never allocates into a row outside the user's risk tier", () => {
    // The server returns these ONLY when the saved-tier filter matched
    // nothing, so the card can stop claiming the chain has no options. They
    // exist to be *named*, never to be deposited into: auto-allocating one
    // would turn "here is what you're missing" into "here is where I put
    // your money", straight through the risk ceiling.
    const arbitrumUsdt = [
      row({
        protocol_slug: "compound-v3",
        asset_symbol: "USDT",
        tier: "balanced",
        outside_tier: true,
        score: 77,
      }),
      row({
        protocol_slug: "zerobase-cedefi",
        asset_symbol: "USDT",
        tier: "balanced",
        outside_tier: true,
        score: 77,
      }),
    ];
    expect(allocatableRows(arbitrumUsdt)).toEqual([]);
    expect(
      allocate({ rows: arbitrumUsdt, totalUsd: 500, assetSymbol: "USDT" }).legs,
    ).toEqual([]);
    // ...and it must not be picked as the target asset either.
    expect(resolveTargetAsset(arbitrumUsdt, {})).toBeNull();
  });

  it("still allocates the in-tier rows when a payload mixes both", () => {
    const mixed = [
      row({ protocol_slug: "outside", score: 99, outside_tier: true }),
      row({ protocol_slug: "inside", score: 50 }),
    ];
    const a = allocate({ rows: mixed, totalUsd: 100, assetSymbol: "USDC" });
    expect(a.legs.map((l) => l.row.protocol_slug)).toEqual(["inside"]);
  });

  it("collapses to one leg below the dust floor (§11.2)", () => {
    const a = allocate({ rows, totalUsd: 40, assetSymbol: "USDC" });
    expect(a.legs).toHaveLength(1);
    expect(a.legs[0].row.protocol_slug).toBe("compound-v3");
    expect(a.legs[0].amountUsd).toBe(40);
  });

  it("blends APY off the 7d basis and projects monthly from it (§11.5)", () => {
    const two = [
      row({ protocol_slug: "a", score: 50, apy: 99, apy_7d_avg: 4 }),
      row({ protocol_slug: "b", score: 50, apy: 99, apy_7d_avg: 6 }),
    ];
    const a = allocate({ rows: two, totalUsd: 200, assetSymbol: "USDC" });
    expect(a.legs).toHaveLength(2);
    expect(a.blendedApy).toBeCloseTo(5, 6);
    expect(a.projectedMonthlyUsd).toBeCloseTo((200 * 5) / 100 / 12, 6);
    expect(a.projectedYearlyUsd).toBeCloseTo(10, 6);
  });

  it("splits evenly when no row carries a usable score", () => {
    const unscored = [
      row({ protocol_slug: "a", score: undefined }),
      row({ protocol_slug: "b", score: 0 }),
    ];
    const a = allocate({ rows: unscored, totalUsd: 100, assetSymbol: "USDC" });
    expect(a.legs.map((l) => l.amountUsd)).toEqual([50, 50]);
  });

  it("returns nothing for a zero total or an unresolved asset", () => {
    expect(allocate({ rows, totalUsd: 0, assetSymbol: "USDC" }).legs).toEqual(
      [],
    );
    expect(allocate({ rows, totalUsd: 750, assetSymbol: null }).legs).toEqual(
      [],
    );
    expect(allocate({ rows, totalUsd: 750, assetSymbol: "DAI" }).legs).toEqual(
      [],
    );
  });

  describe("minDepositRaw refinement (§5.2)", () => {
    it("drops to fewer legs rather than under-funding one", () => {
      // Fluid demands $300; at $750 its ~29% share is only ~$219.
      const minFor = (r: QuickInvestRow) =>
        r.protocol_slug === "fluid" ? 300 : undefined;
      const a = allocate({
        rows,
        totalUsd: 750,
        assetSymbol: "USDC",
        minLegUsdFor: minFor,
      });
      expect(a.legs).toHaveLength(2);
      expect(a.legs.map((l) => l.row.protocol_slug)).toEqual([
        "compound-v3",
        "aave-v3",
      ]);
      expect(sumOf(a.legs.map((l) => l.amountUsd))).toBe(750);
    });

    it("excludes a pool whose minimum exceeds the whole budget", () => {
      const minFor = (r: QuickInvestRow) =>
        r.protocol_slug === "compound-v3" ? 10_000 : undefined;
      const a = allocate({
        rows,
        totalUsd: 300,
        assetSymbol: "USDC",
        minLegUsdFor: minFor,
      });
      expect(a.legs.map((l) => l.row.protocol_slug)).not.toContain(
        "compound-v3",
      );
      expect(a.legs.length).toBeGreaterThan(0);
    });

    it("is inert when no adapter supplies a minimum (the common case)", () => {
      const withHook = allocate({
        rows,
        totalUsd: 750,
        assetSymbol: "USDC",
        minLegUsdFor: () => undefined,
      });
      const without = allocate({ rows, totalUsd: 750, assetSymbol: "USDC" });
      expect(withHook.legs.map((l) => l.amountUsd)).toEqual(
        without.legs.map((l) => l.amountUsd),
      );
    });
  });
});

describe("starterAmountUsd (§11.1)", () => {
  it("is a quarter of the detected balance, clamped to $50–$500", () => {
    expect(starterAmountUsd(1_000)).toBe(250);
    expect(starterAmountUsd(100)).toBe(50); // 25% = $25 → floor
    expect(starterAmountUsd(50_000)).toBe(500); // 25% = $12.5k → ceiling
  });

  it("falls back to a flat $100 when no balance is detectable (§11.6)", () => {
    expect(starterAmountUsd(null)).toBe(100);
    expect(starterAmountUsd(undefined)).toBe(100);
    expect(starterAmountUsd(0)).toBe(100);
    expect(starterAmountUsd(Number.NaN)).toBe(100);
  });

  it("never suggests more than the user actually holds", () => {
    expect(starterAmountUsd(30)).toBe(30);
  });

  it("does not vary by tier — it takes no tier at all", () => {
    // Encoded as a signature check on purpose: scaling the default by risk
    // tier would imply "aggressive means invest more".
    expect(starterAmountUsd.length).toBe(1);
  });
});

describe("sliderBounds / snapToStep", () => {
  it("uses the detected balance as the ceiling", () => {
    const b = sliderBounds({ openingAmountUsd: 250, idleUsd: 1_000 });
    expect(b.max).toBe(1_000);
    expect(b.min).toBeLessThanOrEqual(250);
  });

  it("never lets the track reach past the balance, at any awkward figure", () => {
    // Rounding the ceiling up to a "nice" step would let the user pick more
    // than they hold, which can only fail at the executor.
    for (const idleUsd of [1_003.42, 1_006, 87.5, 49_999.99]) {
      const b = sliderBounds({ openingAmountUsd: 0, idleUsd });
      expect(b.max).toBe(idleUsd);
      expect(snapToStep(idleUsd + 500, b)).toBeLessThanOrEqual(idleUsd);
    }
  });

  it("keeps a stated amount above the balance reachable on the track", () => {
    const b = sliderBounds({ openingAmountUsd: 5_000, idleUsd: 100 });
    expect(b.max).toBeGreaterThanOrEqual(5_000);
  });

  it("still produces a usable range with no balance at all (§11.6)", () => {
    const b = sliderBounds({ openingAmountUsd: 0, idleUsd: null });
    // Explorable, not pocket change: with no signal at all the user has to
    // be able to reach a real amount by dragging.
    expect(b.max).toBeGreaterThanOrEqual(1_000);
    expect(b.min).toBeGreaterThan(0);
    expect(b.step).toBeGreaterThan(0);
  });

  it("holds the range still while the value moves (the thumb-chase bug)", () => {
    // The card must never feed the LIVE value back in: with no balance the
    // ceiling is derived from the amount, so a growing value raised `max`
    // mid-drag and the thumb chased the finger. The parameter is named
    // `openingAmountUsd` to make that contract impossible to misread, and
    // the card passes the amount it opened on.
    const opening = sliderBounds({ openingAmountUsd: 250, idleUsd: null });
    for (const dragged of [250, 500, 900, 1_400]) {
      const b = sliderBounds({ openingAmountUsd: 250, idleUsd: null });
      expect(b).toEqual(opening);
      // Every value the user can drag to stays reachable within it.
      expect(snapToStep(dragged, opening)).toBeLessThanOrEqual(opening.max);
    }
  });

  it("snaps inside the bounds", () => {
    const b = sliderBounds({ openingAmountUsd: 250, idleUsd: 1_000 });
    expect(snapToStep(-50, b)).toBe(b.min);
    expect(snapToStep(99_999, b)).toBe(b.max);
    expect(snapToStep(253, b) % b.step).toBe(0);
  });
});

describe("buildDepositPrompt", () => {
  it("matches the browse list's single-leg wording", () => {
    expect(
      buildDepositPrompt([
        {
          amount: "100.50",
          symbol: "USDC",
          protocolLabel: "Aave V3",
          chain: "Arbitrum",
          poolId: "abc",
        },
      ]),
    ).toBe(
      "Deposit 100.50 USDC into Aave V3 on Arbitrum (pool_id abc) from my wallet. Please proceed.",
    );
  });

  it("joins multiple legs with a semicolon and keeps pool metadata", () => {
    expect(
      buildDepositPrompt([
        {
          amount: "300",
          symbol: "USDC",
          protocolLabel: "Compound V3",
          chain: "Base",
        },
        {
          amount: "200",
          symbol: "USDC",
          protocolLabel: "Morpho",
          poolMeta: "Steakhouse USDC",
          chain: "Base",
        },
      ]),
    ).toBe(
      "Deposit the following from my wallet: 300 USDC into Compound V3 on Base; " +
        "200 USDC into Morpho — Steakhouse USDC on Base. Please proceed.",
    );
  });
});

describe("usdToTokenAmount", () => {
  it("is 1:1 at a dollar price and trims trailing zeros", () => {
    expect(usdToTokenAmount(300, 1)).toBe("300");
  });

  it("converts at a non-unit price", () => {
    expect(usdToTokenAmount(300, 2_000, 8)).toBe("0.15");
  });

  it("refuses to guess when the price is unknown (§6.1)", () => {
    expect(usdToTokenAmount(300, null)).toBeNull();
    expect(usdToTokenAmount(300, 0)).toBeNull();
  });
});

describe("isUsdPegged / formatUsd", () => {
  it("recognises the stablecoins this surface is dominated by", () => {
    expect(isUsdPegged("usdc")).toBe(true);
    expect(isUsdPegged("USDT")).toBe(true);
    expect(isUsdPegged("WETH")).toBe(false);
    expect(isUsdPegged(undefined)).toBe(false);
  });

  it("shows cents on small amounts and none on large ones", () => {
    expect(formatUsd(2.9)).toBe("$2.90");
    expect(formatUsd(1_000)).toBe("$1,000");
  });
});

describe("valueAtPageX — the slider's position math", () => {
  const bounds = sliderBounds({ openingAmountUsd: 0, idleUsd: 1_000 });
  const track = { trackOriginX: 40, trackWidth: 300, bounds };

  it("maps the track's ends to the bounds' ends", () => {
    expect(valueAtPageX({ ...track, pageX: 40 })).toBe(bounds.min);
    expect(valueAtPageX({ ...track, pageX: 340 })).toBe(bounds.max);
  });

  it("maps the midpoint to the middle of the range", () => {
    const mid = valueAtPageX({ ...track, pageX: 190 }) as number;
    // Within one step: the exact midpoint of the value range rarely sits ON
    // the step grid, and landing on the grid is the point.
    expect(Math.abs(mid - (bounds.min + bounds.max) / 2)).toBeLessThanOrEqual(
      bounds.step,
    );
  });

  it("clamps past either end instead of running away", () => {
    expect(valueAtPageX({ ...track, pageX: -500 })).toBe(bounds.min);
    expect(valueAtPageX({ ...track, pageX: 9_999 })).toBe(bounds.max);
  });

  it("subtracts the track origin — the bug that made it jump", () => {
    // Reverting to a raw coordinate (origin treated as 0) would read a
    // touch on the track's left edge as 13% along instead of 0%.
    expect(valueAtPageX({ ...track, pageX: 40 })).toBe(bounds.min);
    expect(
      valueAtPageX({ ...track, trackOriginX: 0, pageX: 40 }),
    ).toBeGreaterThan(bounds.min);
  });

  it("never answers before the track has been measured", () => {
    // A zero width would divide by zero and put the thumb anywhere.
    expect(valueAtPageX({ ...track, trackWidth: 0, pageX: 100 })).toBeNull();
  });

  it("only ever returns values on the step grid", () => {
    for (let px = 40; px <= 340; px += 7) {
      const v = valueAtPageX({ ...track, pageX: px });
      expect(v).not.toBeNull();
      expect(
        Math.round((v as number) * 100) % Math.round(bounds.step * 100),
      ).toBe(0);
    }
  });
});
