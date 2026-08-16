/**
 * Liquid-staking venue config — the mobile twin of
 * `api/src/strategies/targets/address-book/lst.ts`
 * (docs/defi-evm-protocol-expansion-spec.md §6.4).
 *
 * `DepositTarget.venue` is the join key. The backend owns resolution and
 * validation; this file owns the CALL SHAPE, because that is what the device
 * has to encode. Keeping them as two pinned tables joined by a stable key is
 * the same pattern the Sui LST adapter uses (`adapters/sui/lst.config.ts`):
 * adding a venue is a row on each side, never a branch.
 *
 * The two tables must agree on `entry`, `receipt`, `asset` and `exit` — the
 * backend validator checks exactly that before a target is trusted, so a drift
 * between them fails closed rather than building a call against the wrong
 * contract.
 */

import type { Address } from "viem";

/**
 * The stake call's shape. A closed union, so one adapter is parameterised by
 * config instead of branching on venue names; a new venue that reuses a shape
 * is pure config, and a genuinely new calling convention adds one entry here.
 */
export type LstStakeShape =
  /** `deposit()` payable — Rocket Pool `RocketDepositPool`, ether.fi `LiquidityPool`. */
  | "payable-deposit"
  /** `deposit(address receiver)` payable — Stader. */
  | "payable-deposit-receiver"
  /** `deposit(address referral)` payable — Binance `wBETH`. */
  | "payable-deposit-referral"
  /** `submit()` payable — Benqi `StakedAvax`. */
  | "payable-submit";

export interface LstVenueConfig {
  readonly key: string;
  readonly chainId: number;
  readonly entry: Address;
  readonly receipt: Address;
  readonly shape: LstStakeShape;
  readonly displayName: string;
  /**
   * How the position is valued from the receipt balance:
   *  - `"rate"`  — a rebasing/1:1 receipt (eETH): balance IS the position.
   *  - `"share"` — a rate token (rETH, ETHx, wBETH, sAVAX): balance × rate.
   */
  readonly valuation: "rate" | "share";
  /**
   * The view that converts one receipt unit to the staked asset, for `"share"`
   * valuation. Read on the receipt token itself.
   */
  readonly rateView?: string;
}

export const LST_VENUE_CONFIGS: readonly LstVenueConfig[] = [
  {
    key: "rocket-pool",
    chainId: 1,
    entry: "0xDD3f50F8A6CafbE9b31a427582963f465E745AF8",
    receipt: "0xae78736Cd615f374D3085123A210448E74Fc6393",
    shape: "payable-deposit",
    displayName: "Rocket Pool",
    valuation: "share",
    rateView: "getExchangeRate",
  },
  {
    key: "etherfi",
    chainId: 1,
    entry: "0x308861A430be4cce5502d0A12724771Fc6DaF216",
    receipt: "0x35fA164735182de50811E8e2E824cFb9B6118ac2",
    shape: "payable-deposit",
    displayName: "ether.fi",
    // eETH rebases, so the balance already reads in ETH terms.
    valuation: "rate",
  },
  {
    key: "stader-ethx",
    chainId: 1,
    entry: "0xcf5EA1b38380f6aF39068375516Daf40Ed70D299",
    receipt: "0xA35b1B31Ce002FBF2058D22F30f95D405200A15b",
    shape: "payable-deposit-receiver",
    displayName: "Stader ETHx",
    valuation: "share",
    rateView: "getExchangeRate",
  },
  {
    key: "binance-wbeth",
    chainId: 1,
    entry: "0xa2E3356610840701BDf5611a53974510Ae27E2e1",
    receipt: "0xa2E3356610840701BDf5611a53974510Ae27E2e1",
    shape: "payable-deposit-referral",
    displayName: "Binance Staked ETH",
    valuation: "share",
    rateView: "exchangeRate",
  },
  {
    key: "benqi-savax",
    chainId: 43114,
    entry: "0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE",
    receipt: "0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE",
    shape: "payable-submit",
    displayName: "BENQI Liquid Staking",
    valuation: "share",
    // sAVAX exposes AVAX-per-share through this view.
    rateView: "getPooledAvaxByShares",
  },
];

export function lstVenueConfig(key: string): LstVenueConfig | null {
  return LST_VENUE_CONFIGS.find((v) => v.key === key) ?? null;
}
