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
  | "payable-submit"
  /** `submit(address _referral)` payable — Lido `stETH`. */
  | "payable-submit-referral"
  /**
   * `stake(uint256 minMETHAmount)` payable — Mantle `Staking`.
   *
   * The only shape that carries slippage. The minimum is read from the
   * protocol's own `previewView` at build time and floored by the tier policy;
   * a venue on this shape without a `previewView` cannot build (§12 Q4 forbids
   * a zero minimum).
   */
  | "payable-stake-minout";

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
   * The view that converts the receipt to the staked asset, for `"share"`
   * valuation.
   */
  readonly rateView?: string;
  /**
   * Which contract `rateView` lives on. Defaults to the receipt token, which
   * is where every venue had it until Mantle — `mETHToETH` is on the Staking
   * contract, not on mETH.
   */
  readonly rateViewOn?: "receipt" | "entry";
  /**
   * `true` when `rateView` takes the share amount and returns the asset amount
   * directly; `false`/absent when it returns a per-unit rate to multiply by.
   *
   * This used to be inferred by comparing `rateView` to the string
   * `"getPooledAvaxByShares"` — a branch on a venue's function NAME, which is
   * exactly the per-venue special-casing this config table exists to avoid. It
   * silently mis-valued the second venue to use that convention (Mantle's
   * `mETHToETH`), so it is now declared.
   */
  readonly rateTakesAmount?: boolean;
  /**
   * Assets-in → shares-out quote, read on `entry`. Required by
   * `payable-stake-minout`; the twin of the backend book's `previewView`.
   */
  readonly previewView?: string;
  /** Smallest stake the contract accepts, in wei, when it enforces one. */
  readonly minStakeWei?: bigint;
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
    // Lido. The stake goes to the stETH token itself, which is both the entry
    // contract and the receipt.
    //
    // `valuation: "rate"` — stETH REBASES, so a balance already reads in ETH
    // terms and there is no share rate to apply. Getting this wrong is the
    // subtle failure mode of this table: treating a rebasing receipt as a
    // share token would multiply an already-correct balance by a rate.
    //
    // The backend pins `exit: "queue"`, so this venue is deposit-only through
    // `LstStakeAdapter`. `adapters/lido.ts` already implements the real
    // two-step exit (requestWithdrawals -> claimWithdrawals) and is the
    // implementation to wire in when the Tier-4 request/claim flow lands.
    key: "lido",
    chainId: 1,
    entry: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
    receipt: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
    shape: "payable-submit-referral",
    displayName: "Lido",
    valuation: "rate",
  },
  {
    key: "benqi-savax",
    chainId: 43114,
    entry: "0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE",
    receipt: "0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE",
    shape: "payable-submit",
    displayName: "BENQI Liquid Staking",
    valuation: "share",
    // sAVAX exposes AVAX-per-share through this view, taking the amount.
    rateView: "getPooledAvaxByShares",
    rateTakesAmount: true,
  },
  {
    // Mantle mETH. The stake takes a caller-supplied minimum, so this is the
    // one venue whose deposit reads chain state before encoding: `ethToMETH`
    // on the Staking contract quotes the mETH for a given ETH amount, and the
    // tier policy floors it. LST/native is a CORRELATED pair, so it draws the
    // `stable` budget (25bp conservative / 50bp balanced), not the volatile one.
    //
    // `mETHToETH` lives on the Staking contract too, not on the mETH token,
    // which is why `rateViewOn` exists.
    key: "mantle-meth",
    chainId: 1,
    entry: "0xe3cBd06D7dadB3F4e6557bAb7EdD924CD1489E8f",
    receipt: "0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa",
    shape: "payable-stake-minout",
    previewView: "ethToMETH",
    minStakeWei: 20_000_000_000_000_000n,
    displayName: "Mantle mETH",
    valuation: "share",
    rateView: "mETHToETH",
    rateViewOn: "entry",
    rateTakesAmount: true,
  },
];

export function lstVenueConfig(key: string): LstVenueConfig | null {
  return LST_VENUE_CONFIGS.find((v) => v.key === key) ?? null;
}
