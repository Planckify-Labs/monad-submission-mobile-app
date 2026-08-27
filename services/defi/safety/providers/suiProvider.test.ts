/**
 * The `sui` ChainSafetyProvider's PURE surface (spec §11.0b, §11.3).
 *
 * Offline by construction, and deliberately narrower than
 * `solanaProvider.test.ts` in one respect: several Sui venues resolve their
 * call package from a live source (an on-chain `UpgradeCap` for Suilend, a
 * vendor endpoint for NAVI/Turbos/Ember/Scallop), so asserting package
 * coverage for those would either hit the network or assert the pinned
 * fallback, which proves nothing about the live path. What IS asserted here
 * is everything that is pure: the per-kind exit terms, the per-kind target
 * object, and the two package families that genuinely are constants.
 *
 * The ratchet is the same as Solana's: a new Sui kind that forgets its
 * provider entries fails this file rather than shipping a pool that quietly
 * refuses at Layer 1 or, worse, one that claims an exit it cannot honour.
 */

import { describe, expect, it } from "vitest";
import type { DepositTarget, DepositTargetKind } from "../../types";
import { SuiSafetyProvider, targetObjectOf, venuePackagesFor } from "./sui";

const OBJ =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const COIN = "0x2::sui::SUI";

/**
 * Every Sui `DepositTarget` kind the app can resolve today. Hand-maintained
 * for the same reason the Solana list is: the union is namespace-less, and
 * the edit is where "did you give this venue exit terms?" gets asked.
 */
const SUI_TARGETS: readonly DepositTarget[] = [
  { kind: "scallop-market", market: OBJ, coinType: COIN },
  { kind: "navi-pool", pool: OBJ, assetId: 0, coinType: COIN },
  { kind: "ember-vault", vault: OBJ, coinType: COIN, shareType: COIN },
  { kind: "kai-vault", vault: OBJ, coinType: COIN, shareType: COIN },
  {
    kind: "suilend-market",
    lendingMarket: OBJ,
    marketType: `${OBJ}::suilend::MAIN_POOL`,
    reserveArrayIndex: 0,
    coinType: COIN,
  },
  {
    kind: "current-market",
    app: OBJ,
    market: OBJ,
    marketType: `${OBJ}::market::Market`,
    coinType: COIN,
  },
  { kind: "sui-lst", venue: "haedal", lstType: COIN },
  { kind: "sui-lst", venue: "aftermath", lstType: COIN },
  {
    kind: "cetus-clmm-pool",
    pool: OBJ,
    coinTypeA: COIN,
    coinTypeB: COIN,
    tickSpacing: 2,
  },
  {
    kind: "turbos-clmm-pool",
    pool: OBJ,
    coinTypeA: COIN,
    coinTypeB: COIN,
    feeType: `${OBJ}::fee::FEE`,
    tickSpacing: 2,
  },
  {
    kind: "bluefin-spot-pool",
    pool: OBJ,
    coinTypeA: COIN,
    coinTypeB: COIN,
    tickSpacing: 2,
  },
];

describe("readExitTerms (§12 Q2)", () => {
  it("characterises every registered Sui kind — none falls through to unknown", async () => {
    for (const target of SUI_TARGETS) {
      const terms = await SuiSafetyProvider.readExitTerms?.(target, "mainnet");
      expect(terms, `${target.kind} has no exit terms`).toBeDefined();
      expect(
        terms?.kind,
        `${target.kind}${"venue" in target ? `/${target.venue}` : ""} exit terms`,
      ).not.toBe("unknown");
    }
  });

  it("reports Aftermath's epoch-settled unstake as queued, and Haedal's buffer as instant", async () => {
    await expect(
      SuiSafetyProvider.readExitTerms?.(
        { kind: "sui-lst", venue: "aftermath", lstType: COIN },
        "mainnet",
      ),
    ).resolves.toEqual({ kind: "queued", source: "declared" });
    await expect(
      SuiSafetyProvider.readExitTerms?.(
        { kind: "sui-lst", venue: "haedal", lstType: COIN },
        "mainnet",
      ),
    ).resolves.toEqual({ kind: "instant" });
  });

  it("fails closed on a kind nobody has characterised", async () => {
    await expect(
      SuiSafetyProvider.readExitTerms?.(
        {
          kind: "erc4626",
          vault: "0x0",
          asset: "0x0",
        } as unknown as DepositTarget,
        "mainnet",
      ),
    ).resolves.toEqual({ kind: "unknown" });
  });
});

describe("kind coverage", () => {
  it("knows which on-chain object each Sui kind deposits into", () => {
    const uncovered: DepositTargetKind[] = [];
    for (const target of SUI_TARGETS) {
      if (targetObjectOf(target) === null) uncovered.push(target.kind);
    }
    expect(uncovered).toEqual([]);
  });

  it("returns null for a kind it has no object for, rather than a guess", () => {
    expect(
      targetObjectOf({
        kind: "erc4626",
        vault: "0x0",
        asset: "0x0",
      } as unknown as DepositTarget),
    ).toBeNull();
  });

  it("pins the constant-package venues without a network read", async () => {
    // Cetus, Bluefin, Current and the LST venues are genuine constants; the
    // rest resolve live and are deliberately not asserted here (see header).
    for (const target of SUI_TARGETS.filter((t) =>
      [
        "cetus-clmm-pool",
        "bluefin-spot-pool",
        "current-market",
        "sui-lst",
      ].includes(t.kind),
    )) {
      const packages = await venuePackagesFor(target, "mainnet");
      expect(packages, `${target.kind} packages`).toBeTruthy();
      expect(
        (packages ?? []).length,
        `${target.kind} packages`,
      ).toBeGreaterThan(0);
      for (const pkg of packages ?? []) expect(pkg.startsWith("0x")).toBe(true);
    }
  });

  it("refuses a kind with no package rather than passing it", async () => {
    await expect(
      SuiSafetyProvider.isAllowedDestination?.(
        {
          kind: "erc4626",
          vault: "0x0",
          asset: "0x0",
        } as unknown as DepositTarget,
        "0xabc::mod::fn",
        "mainnet",
      ),
    ).resolves.toBe(false);
  });
});
