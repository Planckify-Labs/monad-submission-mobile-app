/**
 * Fork tests for the 2026-08-21 EVM onboarding pass (runbook §11.6a).
 *
 * Everything onboarded in that pass reuses an already-shipped adapter, so what
 * needs proving is NOT "does the family work" — Tier 1 and Tier 3 already
 * proved that — but the two things an entry in `protocols.ts` or the address
 * book actually asserts:
 *
 *   1. **the pinned address is the contract we think it is**, i.e. it accepts
 *      the deposit the device builds and gives the position back on a MAX
 *      withdraw, and
 *   2. **the one genuinely new encoder works**: Lido's
 *      `submit(address _referral)` payable, the `payable-submit-referral`
 *      stake shape added for it.
 *
 * A dry run cannot show either. It proves the backend can PRODUCE a target;
 * these tests put the bytes the device would sign on a real chain and check the
 * user's position moved (§11.5, "Resolving is NOT shipping").
 *
 * ## The block pin
 *
 * These use `FORK_BLOCKS_RECENT`, not `FORK_BLOCKS`. Avant's `savETH` and
 * Tokemak's `baseUSD` have ZERO code at 23,000,000 / 28,000,000 — they were
 * deployed later — and a fork test against an undeployed address fails for a
 * reason that has nothing to do with the adapter. Bumping the shared pin
 * instead would silently re-date every existing case.
 *
 * ## Running
 *
 *   FORK_TESTS=1 FORK_RPC_URL_1=https://... FORK_RPC_URL_8453=https://... \
 *   npx vitest run services/defi/__fork__/onboarding.fork.test.ts
 *
 * Needs an ARCHIVE endpoint: a pinned block is an archive request.
 */

import type { Address } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { Erc4626Adapter } from "../adapters/erc4626";
import { LstStakeAdapter } from "../adapters/lstStake";
import type { DepositTarget } from "../types";
import { approvalsOf } from "../types";
import {
  canFork,
  dealErc20,
  dealNative,
  erc20Balance,
  executeCall,
  FORK_BLOCKS_RECENT,
  type ForkContext,
  positionBalance,
  startFork,
} from "./harness";

const ETHEREUM = 1;
const BASE = 8453;

const NATIVE = "0x0000000000000000000000000000000000000000" as Address;

// ── Ethereum ───────────────────────────────────────────────────────────────
/** Lido stETH. The stake entry contract and the receipt are one address. */
const STETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" as Address;
/** Mantle mETH: the Staking contract and its receipt token. */
const MANTLE_STAKING = "0xe3cBd06D7dadB3F4e6557bAb7EdD924CD1489E8f" as Address;
const METH = "0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa" as Address;
const KELP_POOL = "0x036676389e48133B63a802f8635AD39E752D375D" as Address;
const RSETH = "0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7" as Address;

/** Avant `savETH` (address-book vaults.ts, AVANT_VAULTS) and its underlying. */
const SAVETH = "0xDA06eE2dACF9245Aa80072a4407deBDea0D7e341" as Address;
const AVETH = "0x9469470C9878bf3d6d0604831d9A3A366156f7EE" as Address;
/** An Auto Finance (Tokemak) USDC autopool, discovered from their own API. */
const AUTOFI_USDC = "0xa7569a44f348d3d70d8ad5889e50f78e33d80d35" as Address;
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;

// ── Base ───────────────────────────────────────────────────────────────────
/** Avantis `avUSDC` (AVANTIS_VAULTS). */
const AVUSDC = "0x944766f715b51967E56aFdE5f0Aa76cEaCc9E7f9" as Address;
/** 40 Acres Base USDC vault (FORTY_ACRES_VAULTS). */
const FORTY_ACRES_BASE =
  "0xB99B6dF96d4d5448cC0a5B3e0ef7896df9507Cf5" as Address;
/** Auto Finance `baseUSD`. */
const AUTOFI_BASE_USD = "0x9c6864105aec23388c89600046213a44c384c831" as Address;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

const TEN_ETH = 10n * 10n ** 18n;
const ONE_ETH = 10n ** 18n;
const ONE_THOUSAND_USDC = 1_000_000_000n; // 6 dp

const describeEth = canFork(ETHEREUM) ? describe : describe.skip;
const describeBase = canFork(BASE) ? describe : describe.skip;

/**
 * Deposit → assert the position grew → MAX withdraw → assert the asset came
 * back. Same shape as `tier1.fork.test.ts`'s `roundTrip`, deliberately: a
 * newly onboarded vault must be held to exactly what the shipped families are.
 */
async function erc4626RoundTrip(
  ctx: ForkContext,
  opts: {
    vault: Address;
    asset: { symbol: string; contract: Address; decimals: number };
    amount: bigint;
    /**
     * How much of the deposit a full round trip is allowed to cost, in basis
     * points of the deposited amount.
     *
     * The Tier-1 cases assert `assetBefore - 2n` because sDAI has neither a fee
     * nor a spread, and copying that here failed FOUR cases at once — not
     * because anything was wrong, but because a real vault can charge to leave.
     * Measured at the pinned blocks (2026-08-21): 40 Acres 0.0008bp (pure 4626
     * rounding), Auto Finance 1.3-5.3bp, Avantis ~50bp. So each case states
     * what it costs, and the number is a MEASUREMENT to be re-checked on a
     * bump, not a slack constant — a vault that starts costing 10x more should
     * fail this.
     */
    maxLossBps: bigint;
  },
): Promise<void> {
  const { vault, asset, amount, maxLossBps } = opts;
  const holder = ctx.account.address;
  const target: DepositTarget = {
    kind: "erc4626",
    vault,
    asset: asset.contract,
  };

  await dealErc20(ctx, asset.contract, holder, amount * 2n);
  const assetBefore = await erc20Balance(ctx, asset.contract, holder);
  expect(
    assetBefore,
    `could not fund ${asset.symbol} — the balance slot probe found nothing, so ` +
      "this case proves nothing about the vault",
  ).toBeGreaterThanOrEqual(amount);

  const positionBefore = await positionBalance(ctx, target, holder);

  const deposit = await Erc4626Adapter.buildDeposit({
    wallet: ctx.wallet,
    chain: ctx.chain,
    asset,
    amount,
    target,
  });
  // An ERC-20 deposit must approve, and scoped to the amount — never infinite.
  const approvals = approvalsOf(deposit);
  expect(approvals.length).toBeGreaterThan(0);
  expect(await executeCall(ctx, deposit)).toMatchObject({ status: "success" });

  const positionAfter = await positionBalance(ctx, target, holder);
  expect(
    positionAfter,
    "deposit succeeded but the position did not grow — the pinned address is " +
      "not the vault we think it is",
  ).toBeGreaterThan(positionBefore);
  expect(await erc20Balance(ctx, asset.contract, holder)).toBe(
    assetBefore - amount,
  );

  const withdraw = await Erc4626Adapter.buildWithdraw({
    wallet: ctx.wallet,
    chain: ctx.chain,
    asset,
    amount: "MAX",
    target,
  });
  expect(await executeCall(ctx, withdraw)).toMatchObject({ status: "success" });

  expect(
    await positionBalance(ctx, target, holder),
    "MAX withdraw left a residual position",
  ).toBeLessThan(positionAfter);

  const assetFinal = await erc20Balance(ctx, asset.contract, holder);
  const loss = assetBefore - assetFinal;
  const allowed = (amount * maxLossBps) / 10_000n;
  expect(
    loss,
    `round trip cost ${loss} of ${amount} ${asset.symbol} ` +
      `(${(Number(loss) * 10_000) / Number(amount)}bp), over the ${maxLossBps}bp ` +
      "this vault is expected to charge — either the vault changed its fee or " +
      "the withdraw is not exiting the whole position",
  ).toBeLessThanOrEqual(allowed);
  // A round trip must never RETURN more than went in: that would mean the MAX
  // withdraw took someone else's assets, or the funding step over-dealt.
  expect(assetFinal).toBeLessThanOrEqual(assetBefore);
}

describeEth("Onboarding — Ethereum", () => {
  let ctx: ForkContext;

  beforeAll(async () => {
    ctx = await startFork(ETHEREUM, { block: FORK_BLOCKS_RECENT[ETHEREUM] });
    await dealNative(ctx, ctx.account.address, 1000n * 10n ** 18n);
    return async () => {
      await ctx.stop();
    };
  }, 180_000);

  it("Lido — the new payable-submit-referral shape stakes ETH and mints stETH", async () => {
    // The only new ENCODER in this pass. `submit(address _referral)` differs
    // from the existing `payable-submit` (Benqi, no args) by one argument, and
    // getting it wrong would send ETH to stETH with calldata it rejects — or,
    // worse, with a selector that happens to hit something else.
    const target: DepositTarget = {
      kind: "lst-stake",
      venue: "lido",
      receipt: STETH,
      asset: NATIVE,
      exit: "queue",
    };
    const before = await positionBalance(ctx, target, ctx.account.address);

    const call = await LstStakeAdapter.buildDeposit({
      wallet: ctx.wallet,
      chain: ctx.chain,
      asset: { symbol: "ETH", contract: NATIVE, decimals: 18 },
      amount: TEN_ETH,
      target,
    } as never);

    // Native stake: value, never an approval (§12 Q5).
    expect(approvalsOf(call)).toEqual([]);
    expect(call.to?.toLowerCase()).toBe(STETH.toLowerCase());
    expect(await executeCall(ctx, call)).toMatchObject({ status: "success" });

    expect(
      await positionBalance(ctx, target, ctx.account.address),
      "submit() succeeded but no stETH arrived",
    ).toBeGreaterThan(before);
  }, 240_000);

  it("Lido — refuses an in-app withdraw, because its exit is a queue", async () => {
    // §12 Q2. Lido's real exit is `requestWithdrawals` then `claimWithdrawals`
    // once finalised (1-5 days). `adapters/lido.ts` implements that flow, but
    // it is two-phase and this adapter is one-shot, so the honest answer here
    // is a refusal rather than a button that opens a request the user reads as
    // "done". Ships deposit-only until the Tier-4 machinery lands.
    await expect(
      LstStakeAdapter.buildWithdraw({
        wallet: ctx.wallet,
        chain: ctx.chain,
        asset: { symbol: "ETH", contract: NATIVE, decimals: 18 },
        amount: "MAX",
        target: {
          kind: "lst-stake",
          venue: "lido",
          receipt: STETH,
          asset: NATIVE,
          exit: "queue",
        },
      } as never),
    ).rejects.toThrow();
  }, 120_000);

  it("Mantle mETH — the min-out stake mints mETH, with a non-zero floor", async () => {
    // The one stake shape that carries slippage. A unit test can prove the
    // encoding; only a fork can prove the floor the tier policy computes is
    // one the contract will actually accept — too tight and every deposit
    // reverts, which is a failure mode that looks like "the protocol is down".
    const target: DepositTarget = {
      kind: "lst-stake",
      venue: "mantle-meth",
      receipt: METH,
      asset: NATIVE,
      exit: "queue",
    };
    const before = await positionBalance(ctx, target, ctx.account.address);

    const call = await LstStakeAdapter.buildDeposit({
      wallet: ctx.wallet,
      chain: ctx.chain,
      asset: { symbol: "ETH", contract: NATIVE, decimals: 18 },
      amount: TEN_ETH,
      target,
      tier: "conservative",
    } as never);

    expect(approvalsOf(call)).toEqual([]);
    expect(call.to?.toLowerCase()).toBe(MANTLE_STAKING.toLowerCase());
    expect(call.value).toBe(TEN_ETH);

    // The floor is in the calldata and it is not zero — §12 Q4's hard rule,
    // asserted against the bytes rather than against the helper that made them.
    const minOut = BigInt(`0x${(call.data as string).slice(10)}`);
    expect(minOut).toBeGreaterThan(0n);

    expect(await executeCall(ctx, call)).toMatchObject({ status: "success" });

    const after = await positionBalance(ctx, target, ctx.account.address);
    expect(after, "stake succeeded but no mETH arrived").toBeGreaterThan(
      before,
    );
    // The contract must have honoured at least the minimum we demanded.
    expect(after - before).toBeGreaterThanOrEqual(minOut);
  }, 240_000);

  it("Mantle mETH — refuses a stake below the venue's on-chain minimum", async () => {
    // `minimumStakeBound()` is 0.02 ETH. Refusing in the adapter turns a
    // paid-for revert into a message.
    await expect(
      LstStakeAdapter.buildDeposit({
        wallet: ctx.wallet,
        chain: ctx.chain,
        asset: { symbol: "ETH", contract: NATIVE, decimals: 18 },
        amount: 10n ** 16n, // 0.01 ETH
        target: {
          kind: "lst-stake",
          venue: "mantle-meth",
          receipt: METH,
          asset: NATIVE,
          exit: "queue",
        },
      } as never),
    ).rejects.toThrow();
  }, 120_000);

  it("Kelp rsETH — the second min-out shape mints rsETH against a real floor", async () => {
    // The whole reason Kelp was deferred was that nobody had confirmed it had
    // a quote to derive a floor from. `getRsETHAmountToMint` is that quote,
    // and this proves the device can read it and that the contract honours
    // the minimum the tier policy computes from it.
    //
    // Two things here are new versus Mantle and both are config, not code:
    // the referral is a STRING (so the calldata is head+tail encoded, not two
    // flat words), and the preview view takes the native SENTINEL as its
    // first argument. Passing the zero address there reverts (0x762798e1),
    // which a unit test with a mocked client would never have surfaced.
    const target: DepositTarget = {
      kind: "lst-stake",
      venue: "kelp-rseth",
      receipt: RSETH,
      asset: NATIVE,
      exit: "queue",
    };
    const before = await positionBalance(ctx, target, ctx.account.address);

    const call = await LstStakeAdapter.buildDeposit({
      wallet: ctx.wallet,
      chain: ctx.chain,
      asset: { symbol: "ETH", contract: NATIVE, decimals: 18 },
      amount: TEN_ETH,
      target,
      tier: "conservative",
    } as never);

    // A native stake never needs an allowance.
    expect(approvalsOf(call)).toEqual([]);
    expect(call.to?.toLowerCase()).toBe(KELP_POOL.toLowerCase());
    expect(call.value).toBe(TEN_ETH);

    // §12 Q4 asserted against the BYTES, not the helper that built them. The
    // first word after the selector is `minRSETHAmountExpected`; the string
    // referral lives past it, so this slice is the minimum regardless of how
    // the tail is encoded.
    const minOut = BigInt(`0x${(call.data as string).slice(10, 74)}`);
    expect(minOut).toBeGreaterThan(0n);

    expect(await executeCall(ctx, call)).toMatchObject({ status: "success" });

    const after = await positionBalance(ctx, target, ctx.account.address);
    expect(after, "stake succeeded but no rsETH arrived").toBeGreaterThan(
      before,
    );
    expect(after - before).toBeGreaterThanOrEqual(minOut);
  }, 240_000);

  it("Kelp rsETH — refuses a stake below the venue's on-chain minimum", async () => {
    // `minAmountToDeposit()` is 1e14 wei. Catching it in the adapter costs the
    // user nothing; letting it reach the chain costs them gas for a certain
    // revert.
    await expect(
      LstStakeAdapter.buildDeposit({
        wallet: ctx.wallet,
        chain: ctx.chain,
        asset: { symbol: "ETH", contract: NATIVE, decimals: 18 },
        amount: 10n ** 13n, // 0.00001 ETH, an order of magnitude under
        target: {
          kind: "lst-stake",
          venue: "kelp-rseth",
          receipt: RSETH,
          asset: NATIVE,
          exit: "queue",
        },
      } as never),
    ).rejects.toThrow();
  }, 120_000);

  it("Kelp rsETH — refuses an in-app withdraw, because the exit is a queue", async () => {
    // §12 Q2. Kelp's exit is initiate -> complete on its withdrawal manager,
    // so the honest answer is a refusal rather than a button that reverts.
    // This is the assertion that would have caught Avant.
    await expect(
      LstStakeAdapter.buildWithdraw({
        wallet: ctx.wallet,
        chain: ctx.chain,
        asset: { symbol: "ETH", contract: NATIVE, decimals: 18 },
        amount: "MAX",
        target: {
          kind: "lst-stake",
          venue: "kelp-rseth",
          receipt: RSETH,
          asset: NATIVE,
          exit: "queue",
        },
      } as never),
    ).rejects.toThrow();
  }, 120_000);

  it("Avant — deposits, but a 4626 redeem REVERTS under cooldown (why it is withheld)", async () => {
    // This is the case that stopped Avant shipping, and it is the reason the
    // fork suite exists rather than the dry run being enough.
    //
    // savETH passes every structural check: `asset()`, `totalAssets()`,
    // `convertToShares()` and `maxDeposit()` all answer, the deposit below
    // succeeds, and `readExitTerms` reports `delayed` because
    // `cooldownDuration()` is readable. Everything looks right.
    //
    // But the contract follows Ethena's `StakedUSDeV2` pattern: while
    // `cooldownDuration != 0` (it is 86400), `withdraw`/`redeem` revert with
    // `OperationNotAllowed()` (0xf50a3b52) and the ONLY exit is
    // `cooldownShares()` -> wait -> `unstake()`. So the generic
    // `Erc4626Adapter` would ship a working deposit and a withdraw button that
    // always reverts, which fails §11.2's round-trip bar.
    //
    // `adapters/ethena.ts` is the shape this needs. Until a cooldown-aware
    // 4626 exit exists, `avant` stays withheld and this test pins the reason.
    const holder = ctx.account.address;
    const target: DepositTarget = {
      kind: "erc4626",
      vault: SAVETH,
      asset: AVETH,
    };
    const asset = { symbol: "avETH", contract: AVETH, decimals: 18 };

    await dealErc20(ctx, AVETH, holder, ONE_ETH * 2n);
    const before = await positionBalance(ctx, target, holder);

    const deposit = await Erc4626Adapter.buildDeposit({
      wallet: ctx.wallet,
      chain: ctx.chain,
      asset,
      amount: ONE_ETH,
      target,
    });
    expect(await executeCall(ctx, deposit)).toMatchObject({
      status: "success",
    });
    expect(
      await positionBalance(ctx, target, holder),
      "the deposit half genuinely works — the address book pin is correct",
    ).toBeGreaterThan(before);

    // And the exit does not.
    const withdraw = await Erc4626Adapter.buildWithdraw({
      wallet: ctx.wallet,
      chain: ctx.chain,
      asset,
      amount: "MAX",
      target,
    });
    await expect(
      executeCall(ctx, withdraw),
      "savETH redeemed without a cooldown — Avant may have set cooldownDuration " +
        "to 0, in which case revisit the withheld entry in protocols.ts",
    ).rejects.toThrow(/0xf50a3b52|OperationNotAllowed|revert/i);
  }, 240_000);

  it("Auto Finance — round-trips a USDC autopool found via the Tokemak API", async () => {
    // Proves the DISCOVERY output is executable, not just well-formed: this
    // address came from `autopools-api.tokemaklabs.com`, and an entry that
    // returns a plausible-but-wrong address is exactly what §12 Q7 is about.
    await erc4626RoundTrip(ctx, {
      vault: AUTOFI_USDC,
      asset: { symbol: "USDC", contract: USDC_ETH, decimals: 6 },
      amount: ONE_THOUSAND_USDC,
      maxLossBps: 5n,
    });
  }, 240_000);
});

describeBase("Onboarding — Base", () => {
  let ctx: ForkContext;

  beforeAll(async () => {
    ctx = await startFork(BASE, { block: FORK_BLOCKS_RECENT[BASE] });
    await dealNative(ctx, ctx.account.address, 100n * 10n ** 18n);
    return async () => {
      await ctx.stop();
    };
  }, 180_000);

  it("Avantis — round-trips the pinned avUSDC vault (~50bp exit cost)", async () => {
    await erc4626RoundTrip(ctx, {
      vault: AVUSDC,
      asset: { symbol: "USDC", contract: USDC_BASE, decimals: 6 },
      amount: ONE_THOUSAND_USDC,
      maxLossBps: 75n,
    });
  }, 240_000);

  it("40 Acres — round-trips the pinned Base USDC vault", async () => {
    await erc4626RoundTrip(ctx, {
      vault: FORTY_ACRES_BASE,
      asset: { symbol: "USDC", contract: USDC_BASE, decimals: 6 },
      amount: ONE_THOUSAND_USDC,
      maxLossBps: 5n,
    });
  }, 240_000);

  it("Auto Finance — round-trips baseUSD", async () => {
    await erc4626RoundTrip(ctx, {
      vault: AUTOFI_BASE_USD,
      asset: { symbol: "USDC", contract: USDC_BASE, decimals: 6 },
      amount: ONE_THOUSAND_USDC,
      maxLossBps: 15n,
    });
  }, 240_000);
});

describe("Onboarding fork gate", () => {
  it("is skipped unless FORK_TESTS=1 and an RPC is configured", () => {
    expect(canFork(ETHEREUM)).toBe(
      process.env.FORK_TESTS?.trim() === "1" &&
        !!process.env.FORK_RPC_URL_1?.trim(),
    );
  });

  it("pins its blocks rather than floating to the head", () => {
    // The whole point of FORK_BLOCKS_RECENT. A `0` or a missing entry would
    // mean anvil forks the head and a failure stops being reproducible.
    expect(FORK_BLOCKS_RECENT[ETHEREUM]).toBeGreaterThan(0n);
    expect(FORK_BLOCKS_RECENT[BASE]).toBeGreaterThan(0n);
  });
});
