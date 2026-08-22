/**
 * Tier 2 fork tests — the families that ship a NEW mobile adapter (spec §5.2,
 * §5.4, §8.3, §11.3).
 *
 * Tier 1 could lean on adapters that were already in production. Tier 2 cannot:
 * Comet, the Compound-v2 cToken family and Morpho Blue each encode a calling
 * convention this app had never executed. That makes the fork test the first
 * time the bytes are known to be right, and it is why §11.3 puts the bar here
 * rather than at "the unit test decodes what we encoded".
 *
 * The three families are chosen to cover the three ways a position can be
 * represented, because that is where the wrong assumption usually hides:
 *
 *   Comet         the market contract IS the receipt token
 *   cToken        a separate receipt token with an exchange rate
 *   Morpho Blue   no receipt token at all — shares inside the singleton
 *
 * Curve is a fourth: an NG pool is BOTH the market and the receipt, but a
 * classic pool (3pool's lineage) mints a SEPARATE receipt the pool contract
 * itself cannot even read a balance of. Both cases are proven below — see the
 * note at the bottom of this file for how this family got here.
 */

import type { Address, Hex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { CometV3Adapter } from "../adapters/cometV3";
import { CompoundV2Adapter } from "../adapters/compoundV2";
import { CurveLpAdapter } from "../adapters/curveLp";
import { MorphoBlueAdapter } from "../adapters/morphoBlue";
import type { DepositTarget } from "../types";
import {
  canFork,
  dealErc20,
  dealNative,
  erc20Balance,
  executeCall,
  type ForkContext,
  positionBalance,
  startFork,
} from "./harness";

const ETHEREUM = 1;

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;

/** Compound III cUSDCv3 (address-book lending.ts `COMET_MARKETS[1]`). */
const COMET_USDC = "0xc3d688B66703497DAA19211EEdff47f25384cdc3" as Address;
/** Compound III cWBTCv3, added 2026-08-21 (address-book lending.ts `COMET_MARKETS[1]`). */
const COMET_WBTC = "0xe85Dc543813B8c2CFEaAc371517b925a166a9293" as Address;
const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address;
/**
 * Compound v2 cUSDC. The registered Tier-2 cToken resolvers are forks (Venus,
 * Benqi, Sonne) on chains the `Blockchain` table does not carry yet, so the
 * canonical Compound deployment is what proves the SHAPE the family shares.
 */
const CUSDC = "0x39AA39c021dfbaE8faC545936693aC917d5E7563" as Address;

/**
 * A real Morpho Blue market, read from Morpho's API and pinned here.
 *
 * The struct is the whole point of the §3.1 union fix: `marketId` alone is a
 * one-way hash, so `supply` cannot be built from it. If these params are wrong,
 * the singleton reverts with `MARKET_NOT_CREATED` — which is exactly the check
 * the validator's `keccak256(abi.encode(params)) === marketId` performs
 * off-chain.
 */
const MORPHO_MARKET = {
  id: "0xe83d72fa5b00dcd46d9e0e860d95aa540d5ec106da5833108a9f826f21f36f52" as Hex,
  params: {
    loanToken: USDC,
    collateralToken: "0xC26A6Fa2C37b38E549a4a1807543801Db684f99C" as Address,
    oracle: "0x52eA2C12734B5bB61e1edf52Bb0f01D9206493Fc" as Address,
    irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC" as Address,
    lltv: "770000000000000000",
  },
} as const;

const ONE_THOUSAND_USDC = 1_000_000_000n; // 6 dp
const ONE_WBTC = 100_000_000n; // 8 dp
const ONE_THOUSAND_DAI = 1_000n * 10n ** 18n; // 18 dp
const ONE_THOUSAND_CRVUSD = 1_000n * 10n ** 18n; // 18 dp

const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address;
/**
 * Curve 3pool (DAI/USDC/USDT) — the classic-generation case. The pool
 * contract itself has no `balanceOf`; the LP token is a separate ERC-20
 * fetched from Curve's own MetaRegistry (`get_lp_token`), added 2026-08-21.
 */
const CURVE_3POOL = "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7" as Address;
const CURVE_3CRV = "0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490" as Address;
/**
 * Curve crvUSD/WETH — an NG pool, where the pool IS its own LP token. Proves
 * the pre-existing shape still works with `lpToken` absent from the target.
 */
const CURVE_CRVUSD_WETH =
  "0x4eBdF703948ddCEA3B11f675B4D1Fba9d2414A14" as Address;
const CRVUSD = "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E" as Address;

const describeFork = canFork(ETHEREUM) ? describe : describe.skip;

describeFork("Tier 2 — fork execution on Ethereum", () => {
  let ctx: ForkContext;

  beforeAll(async () => {
    ctx = await startFork(ETHEREUM);
    await dealNative(ctx, ctx.account.address, 10n ** 20n);
    return async () => {
      await ctx.stop();
    };
  }, 180_000);

  async function roundTrip(opts: {
    adapter: {
      buildDeposit: (args: never) => Promise<never>;
      buildWithdraw: (args: never) => Promise<never>;
    };
    target: DepositTarget;
    asset: { symbol: string; contract: Address; decimals: number };
    amount: bigint;
  }): Promise<void> {
    const { adapter, target, asset, amount } = opts;
    const holder = ctx.account.address;

    await dealErc20(ctx, asset.contract, holder, amount * 2n);
    const assetBefore = await erc20Balance(ctx, asset.contract, holder);
    const positionBefore = await positionBalance(ctx, target, holder);

    const build = { wallet: ctx.wallet, chain: ctx.chain, asset, target };

    const deposit = await adapter.buildDeposit({
      ...build,
      amount,
    } as never);
    expect((await executeCall(ctx, deposit)).status).toBe("success");

    const positionAfter = await positionBalance(ctx, target, holder);
    expect(
      positionAfter,
      "deposit succeeded but the position did not grow — the receipt is not " +
        "where we think it is, or the call went to the wrong contract",
    ).toBeGreaterThan(positionBefore);
    expect(await erc20Balance(ctx, asset.contract, holder)).toBe(
      assetBefore - amount,
    );

    const withdraw = await adapter.buildWithdraw({
      ...build,
      amount: "MAX",
    } as never);
    expect((await executeCall(ctx, withdraw)).status).toBe("success");

    const positionFinal = await positionBalance(ctx, target, holder);
    expect(
      positionFinal,
      "MAX withdraw left a residual position — this family's 'everything' " +
        "sentinel is not what the adapter assumes (§8.3)",
    ).toBeLessThan(positionAfter);

    // Interest accrues in the protocol's favour, so allow a small shortfall
    // rather than asserting the exact amount back.
    const assetFinal = await erc20Balance(ctx, asset.contract, holder);
    expect(assetFinal).toBeGreaterThan(assetBefore - amount / 1000n);
  }

  it("Comet — supplies and fully withdraws, with the market as its own receipt", async () => {
    await roundTrip({
      adapter: CometV3Adapter,
      target: { kind: "compound-v3", comet: COMET_USDC, asset: USDC },
      asset: { symbol: "USDC", contract: USDC, decimals: 6 },
      amount: ONE_THOUSAND_USDC,
    });
  }, 240_000);

  it("Comet cWBTCv3 — the largest of three markets added 2026-08-21", async () => {
    // Ethereum had three Comet markets missing from the book entirely
    // (cWBTCv3, cWstETHv3, cUSDSv3) — CompoundV3Resolver already iterates
    // every pinned market and validates baseToken(), so this was purely a
    // missing address, not a resolver gap, and it was the single largest
    // coverage item on the three seeded chains (~$536M across cWBTCv3's two
    // DeFiLlama rows). The shape is identical to cUSDCv3 above; this proves
    // the SPECIFIC address rather than the calling convention — an 8-decimal
    // base asset is also a different decimals path than USDC's 6 to exercise.
    await roundTrip({
      adapter: CometV3Adapter,
      target: { kind: "compound-v3", comet: COMET_WBTC, asset: WBTC },
      asset: { symbol: "WBTC", contract: WBTC, decimals: 8 },
      amount: ONE_WBTC,
    });
  }, 240_000);

  it("cToken — mints and redeems, with a separate exchange-rate receipt", async () => {
    // The exchange rate makes cToken shares ≠ underlying, so this is where a
    // MAX that means "my share balance" and one that means "my underlying"
    // diverge.
    await roundTrip({
      adapter: CompoundV2Adapter,
      target: { kind: "compound-v2", cToken: CUSDC, asset: USDC },
      asset: { symbol: "USDC", contract: USDC, decimals: 6 },
      amount: ONE_THOUSAND_USDC,
    });
  }, 240_000);

  it("Morpho Blue — supplies to a market identified only by its params struct", async () => {
    await roundTrip({
      adapter: MorphoBlueAdapter,
      target: {
        kind: "morpho-blue",
        marketId: MORPHO_MARKET.id,
        params: MORPHO_MARKET.params,
        asset: USDC,
      },
      asset: { symbol: "USDC", contract: USDC, decimals: 6 },
      amount: ONE_THOUSAND_USDC,
    });
  }, 240_000);

  it("Curve NG — crvUSD/WETH/CRV, the pool IS its own LP token", async () => {
    // No `lpToken` on the target — proves the pre-existing shape is untouched
    // by the classic-pool addition below.
    await roundTrip({
      adapter: CurveLpAdapter,
      target: {
        kind: "curve-lp",
        pool: CURVE_CRVUSD_WETH,
        asset: CRVUSD,
        index: 0,
        nCoins: 3,
        isNg: true,
      },
      asset: { symbol: "crvUSD", contract: CRVUSD, decimals: 18 },
      amount: ONE_THOUSAND_CRVUSD,
    });
  }, 240_000);

  it("Curve classic — 3pool mints a SEPARATE LP token (3Crv), fetched from the MetaRegistry", async () => {
    // This is the case the file's header note tracked as a finding rather
    // than an omission: `lpTokenOf` used to assume `pool` doubled as the
    // receipt, which is false for 3pool. `target.lpToken` is what makes the
    // MAX withdraw below burn the RIGHT token instead of reading a balance
    // off a contract that has no `balanceOf` at all.
    await roundTrip({
      adapter: CurveLpAdapter,
      target: {
        kind: "curve-lp",
        pool: CURVE_3POOL,
        asset: DAI,
        index: 0,
        nCoins: 3,
        isNg: false,
        lpToken: CURVE_3CRV,
      },
      asset: { symbol: "DAI", contract: DAI, decimals: 18 },
      amount: ONE_THOUSAND_DAI,
    });
  }, 240_000);

  it("Curve classic — omitting lpToken on a classic pool is the bug this fixed", async () => {
    // Regression guard for the exact failure the header note describes: with
    // `lpToken` absent, `lpTokenOf` falls back to `pool`, which is 3pool
    // itself — a contract with no `balanceOf`. The MAX withdraw path reads
    // that balance to decide how much LP to burn, so it must fail rather than
    // silently proceeding with a wrong (or zero) amount.
    const holder = ctx.account.address;
    await dealErc20(ctx, DAI, holder, ONE_THOUSAND_DAI * 2n);
    const target: DepositTarget = {
      kind: "curve-lp",
      pool: CURVE_3POOL,
      asset: DAI,
      index: 0,
      nCoins: 3,
      isNg: false,
      // lpToken deliberately omitted.
    };
    const deposit = await CurveLpAdapter.buildDeposit({
      wallet: ctx.wallet,
      chain: ctx.chain,
      asset: { symbol: "DAI", contract: DAI, decimals: 18 },
      amount: ONE_THOUSAND_DAI,
      target,
    } as never);
    expect((await executeCall(ctx, deposit)).status).toBe("success");

    await expect(
      CurveLpAdapter.buildWithdraw({
        wallet: ctx.wallet,
        chain: ctx.chain,
        asset: { symbol: "DAI", contract: DAI, decimals: 18 },
        amount: "MAX",
        target,
      } as never),
    ).rejects.toThrow();
  }, 240_000);

  it("Morpho Blue — a params struct that does not hash to its marketId cannot supply", async () => {
    // The §5.2 hole this family exists to close: if a compromised API returned
    // a struct pointing somewhere else, the singleton must not accept it.
    // On-chain the market simply does not exist, so the call reverts — the
    // backend validator refuses the same target before it ever ships.
    const holder = ctx.account.address;
    await dealErc20(ctx, USDC, holder, ONE_THOUSAND_USDC * 2n);

    const tampered = await MorphoBlueAdapter.buildDeposit({
      wallet: ctx.wallet,
      chain: ctx.chain,
      asset: { symbol: "USDC", contract: USDC, decimals: 6 },
      amount: ONE_THOUSAND_USDC,
      target: {
        kind: "morpho-blue",
        marketId: MORPHO_MARKET.id,
        params: {
          ...MORPHO_MARKET.params,
          // One field changed: a different oracle is a different market.
          oracle: "0x1111111111111111111111111111111111111111" as Address,
        },
        asset: USDC,
      },
    } as never);

    await expect(executeCall(ctx, tampered)).rejects.toThrow();
  }, 240_000);
});

/**
 * Curve was NOT fork-tested for exactly the reason the two cases above now
 * prove: `curveLp.ts:lpTokenOf` used to return `target.pool` unconditionally,
 * which is right for Curve's NG generation and wrong for the classic pools —
 * 3pool's LP token (3Crv) is a separate ERC-20, and the pool contract itself
 * has no `balanceOf` at all.
 *
 * Writing a fork test around an NG pool alone would have passed and hidden
 * that, which is why one case exists for each generation plus a regression
 * guard that asserts the OLD behaviour (omit `lpToken`, fall back to `pool`)
 * fails loudly on a classic pool rather than silently misreading a balance.
 *
 * Fixed 2026-08-21: `lpToken` on the target, fetched from Curve's own
 * MetaRegistry (`get_lp_token`) at resolve time and re-derived independently
 * by the Layer-1 validator — see `curve.resolver.ts` and `validation.ts` in
 * the backend repo.
 */
describe("Tier 2 fork gate", () => {
  it("is skipped unless FORK_TESTS=1 and an RPC is configured", () => {
    expect(canFork(ETHEREUM)).toBe(
      process.env.FORK_TESTS?.trim() === "1" &&
        !!process.env.FORK_RPC_URL_1?.trim(),
    );
  });
});
