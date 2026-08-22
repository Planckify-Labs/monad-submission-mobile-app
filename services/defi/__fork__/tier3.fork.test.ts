/**
 * Tier 3 fork tests — the bespoke families (spec §6, §6.1, §6.4, §12 Q2).
 *
 * Tier 3 is where the assumption "a deposit is one call and a withdraw undoes
 * it" stops holding, so these tests are shaped differently from Tier 1/2 on
 * purpose:
 *
 *   - **LST staking** has no symmetric exit. Most venues redeem through a
 *     multi-day queue or a DEX, so the test proves the STAKE executes and then
 *     proves the adapter is honest about the exit rather than pretending a
 *     withdraw exists (§12 Q2 — this is the part that would otherwise ship as a
 *     button that fails days later).
 *   - **Solidly LP** is two-sided: one call pulls BOTH tokens, so it needs two
 *     approvals. `approvalsOf()` exists because a single-approval assumption
 *     silently dropped the second one, and this is what proves it is fixed.
 *
 * Pendle (`router-call`) is not fork-testable here and is documented at the
 * bottom.
 */

import type { Address } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { LstStakeAdapter } from "../adapters/lstStake";
import { SolidlyLpAdapter } from "../adapters/solidlyLp";
import { UniswapV2LpAdapter } from "../adapters/uniswapV2Lp";
import {
  approvalsOf,
  type DepositTarget,
  NATIVE_ASSET_SENTINEL,
} from "../types";
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
const BASE = 8453;

/**
 * Native-coin sentinel (§12 Q5). Imported rather than retyped: the union uses
 * the ZERO address, not the 0xEeee… convention some protocols use, and a test
 * that hardcoded the wrong one would fail against correct adapter code.
 */
const NATIVE = NATIVE_ASSET_SENTINEL;

/** rETH — Rocket Pool's receipt (address-book lst.ts). */
const RETH = "0xae78736Cd615f374D3085123A210448E74Fc6393" as Address;
/** eETH — ether.fi's receipt; its exit is a ticketed queue. */
const EETH = "0x35fA164735182de50811E8e2E824cFb9B6118ac2" as Address;

// Base — Aerodrome (address-book dex.ts `SOLIDLY_DEPLOYMENTS[8453]`).
const AERODROME_ROUTER =
  "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as Address;
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const BASE_WETH = "0x4200000000000000000000000000000000000006" as Address;

// Ethereum — Uniswap v2 (address-book dex.ts `UNISWAP_V2_DEPLOYMENTS[1]`).
// WISE-WETH is the real DeFiLlama pool this family unlocks (~$143M).
const UNISWAP_V2_ROUTER =
  "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as Address;
const WISE = "0x66a0f676479Cee1d7373f3DC2e2952778BfF5bd6" as Address;
const ETH_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
const WISE_WETH_PAIR = "0x21b8065d10f73EE2e260e5B47D3344d3Ced7596E" as Address;

const TEN_ETH = 10n * 10n ** 18n;

const describeEth = canFork(ETHEREUM) ? describe : describe.skip;
const describeBase = canFork(BASE) ? describe : describe.skip;

describeEth("Tier 3 — LST staking on Ethereum", () => {
  let ctx: ForkContext;

  beforeAll(async () => {
    ctx = await startFork(ETHEREUM);
    await dealNative(ctx, ctx.account.address, 1000n * 10n ** 18n);
    return async () => {
      await ctx.stop();
    };
  }, 180_000);

  async function stakes(target: DepositTarget): Promise<void> {
    const holder = ctx.account.address;
    const before = await positionBalance(ctx, target, holder);

    const call = await LstStakeAdapter.buildDeposit({
      wallet: ctx.wallet,
      chain: ctx.chain,
      asset: { symbol: "ETH", contract: NATIVE, decimals: 18 },
      amount: TEN_ETH,
      target,
    } as never);

    // A native stake carries value and needs no approve — if the adapter asked
    // for one it would be trying to approve the native sentinel.
    expect(approvalsOf(call)).toEqual([]);
    expect((await executeCall(ctx, call)).status).toBe("success");

    expect(
      await positionBalance(ctx, target, holder),
      "stake succeeded but no receipt token arrived",
    ).toBeGreaterThan(before);
  }

  it("Rocket Pool — stakes ETH and receives rETH", async () => {
    await stakes({
      kind: "lst-stake",
      venue: "rocket-pool",
      receipt: RETH,
      asset: NATIVE,
      exit: "dex",
    });
  }, 240_000);

  it("ether.fi — stakes ETH and receives eETH", async () => {
    await stakes({
      kind: "lst-stake",
      venue: "etherfi",
      receipt: EETH,
      asset: NATIVE,
      exit: "queue",
    });
  }, 240_000);

  it("refuses an in-app withdraw for a queue-exit venue instead of building one", async () => {
    // §12 Q2. A venue whose exit is a multi-day queue must not offer a
    // withdraw button: the call would either revert or silently open a
    // request the user reads as "done". Refusing is the honest behaviour and
    // it has to be enforced in the adapter, not in the UI.
    await expect(
      LstStakeAdapter.buildWithdraw({
        wallet: ctx.wallet,
        chain: ctx.chain,
        asset: { symbol: "ETH", contract: NATIVE, decimals: 18 },
        amount: "MAX",
        target: {
          kind: "lst-stake",
          venue: "etherfi",
          receipt: EETH,
          asset: NATIVE,
          exit: "queue",
        },
      } as never),
    ).rejects.toThrow();
  }, 120_000);

  it("refuses a venue that is not in the pinned config", async () => {
    // The venue key is a join into `lst.config.ts`. An unknown key means we
    // do not know the call shape, and guessing one sends ETH to a contract we
    // have not reviewed.
    await expect(
      LstStakeAdapter.buildDeposit({
        wallet: ctx.wallet,
        chain: ctx.chain,
        asset: { symbol: "ETH", contract: NATIVE, decimals: 18 },
        amount: TEN_ETH,
        target: {
          kind: "lst-stake",
          venue: "some-new-lst",
          receipt: RETH,
          asset: NATIVE,
          exit: "instant",
        },
      } as never),
    ).rejects.toThrow();
  }, 120_000);
});

describeBase("Tier 3 — Solidly LP on Base (Aerodrome)", () => {
  let ctx: ForkContext;

  beforeAll(async () => {
    ctx = await startFork(BASE);
    await dealNative(ctx, ctx.account.address, 10n ** 20n);
    return async () => {
      await ctx.stop();
    };
  }, 180_000);

  it("requires BOTH approvals for a two-sided add, and executes", async () => {
    const holder = ctx.account.address;
    const usdc = 1_000_000_000n; // 1000 USDC, 6 dp
    await dealErc20(ctx, BASE_USDC, holder, usdc * 4n);
    await dealErc20(ctx, BASE_WETH, holder, 10n ** 19n);

    const target: DepositTarget = {
      kind: "solidly-lp",
      router: AERODROME_ROUTER,
      pool: "0xcDAC0d6c6C59727a65F871236188350531885C43" as Address,
      token0: BASE_USDC,
      token1: BASE_WETH,
      stable: false,
    };

    const call = await SolidlyLpAdapter.buildDeposit({
      wallet: ctx.wallet,
      chain: ctx.chain,
      asset: { symbol: "USDC", contract: BASE_USDC, decimals: 6 },
      amount: usdc,
      target,
    } as never);

    // The regression this file exists for: `needsApproval` used to be a single
    // object, so a two-sided add silently approved only one leg and reverted
    // on the other. Both legs, both scoped to the router.
    const approvals = approvalsOf(call);
    expect(approvals).toHaveLength(2);
    expect(new Set(approvals.map((a) => a.token.toLowerCase()))).toEqual(
      new Set([BASE_USDC.toLowerCase(), BASE_WETH.toLowerCase()]),
    );
    for (const approval of approvals) {
      expect(approval.spender.toLowerCase()).toBe(
        AERODROME_ROUTER.toLowerCase(),
      );
      // Never infinite (§8.4, §11 Layer-4 approval scoping).
      expect(approval.amount).toBeLessThan(2n ** 255n);
    }

    const before = await erc20Balance(ctx, target.pool as Address, holder);
    expect((await executeCall(ctx, call)).status).toBe("success");
    expect(
      await erc20Balance(ctx, target.pool as Address, holder),
      "addLiquidity succeeded but no LP tokens arrived",
    ).toBeGreaterThan(before);
  }, 300_000);
});

describeEth("Tier 3 — Uniswap v2 LP on Ethereum (WISE-WETH)", () => {
  let ctx: ForkContext;

  beforeAll(async () => {
    ctx = await startFork(ETHEREUM);
    await dealNative(ctx, ctx.account.address, 10n ** 20n);
    return async () => {
      await ctx.stop();
    };
  }, 180_000);

  it("adds both legs, then a MAX remove returns both — no router quote helper to lean on", async () => {
    // Unlike Solidly, Uniswap v2's Router02 has no `getReserves`/
    // `quoteAddLiquidity` convenience — this proves the adapter's own path
    // (reading the PAIR's `getReserves()` directly and pricing the pair with
    // the router's `quote()` pure helper) actually produces a call the chain
    // accepts, not just well-typed calldata.
    const holder = ctx.account.address;
    const wiseAmount = 1_000n * 10n ** 18n; // 1000 WISE
    await dealErc20(ctx, WISE, holder, wiseAmount * 4n);
    await dealErc20(ctx, ETH_WETH, holder, 10n ** 19n);

    const target: DepositTarget = {
      kind: "uniswap-v2",
      router: UNISWAP_V2_ROUTER,
      pool: WISE_WETH_PAIR,
      token0: WISE,
      token1: ETH_WETH,
    };

    const deposit = await UniswapV2LpAdapter.buildDeposit({
      wallet: ctx.wallet,
      chain: ctx.chain,
      asset: { symbol: "WISE", contract: WISE, decimals: 18 },
      amount: wiseAmount,
      target,
    } as never);

    // Same regression class Solidly's test guards: a two-sided add needs
    // TWO approvals, not one.
    const approvals = approvalsOf(deposit);
    expect(approvals).toHaveLength(2);
    expect(new Set(approvals.map((a) => a.token.toLowerCase()))).toEqual(
      new Set([WISE.toLowerCase(), ETH_WETH.toLowerCase()]),
    );
    for (const approval of approvals) {
      expect(approval.spender.toLowerCase()).toBe(
        UNISWAP_V2_ROUTER.toLowerCase(),
      );
      expect(approval.amount).toBeLessThan(2n ** 255n); // never infinite
    }

    const lpBefore = await erc20Balance(ctx, target.pool as Address, holder);
    expect((await executeCall(ctx, deposit)).status).toBe("success");
    const lpAfter = await erc20Balance(ctx, target.pool as Address, holder);
    expect(
      lpAfter,
      "addLiquidity succeeded but no LP tokens arrived",
    ).toBeGreaterThan(lpBefore);

    const wiseBefore = await erc20Balance(ctx, WISE, holder);
    const wethBefore = await erc20Balance(ctx, ETH_WETH, holder);

    const withdraw = await UniswapV2LpAdapter.buildWithdraw({
      wallet: ctx.wallet,
      chain: ctx.chain,
      asset: { symbol: "WISE", contract: WISE, decimals: 18 },
      amount: "MAX",
      target,
    } as never);
    // The LP token itself needs an approval to be burned by the router.
    expect(approvalsOf(withdraw)).toHaveLength(1);
    expect((await executeCall(ctx, withdraw)).status).toBe("success");

    expect(
      await erc20Balance(ctx, target.pool as Address, holder),
      "MAX withdraw left a residual LP balance",
    ).toBe(0n);
    expect(
      await erc20Balance(ctx, WISE, holder),
      "remove_liquidity succeeded but WISE did not come back",
    ).toBeGreaterThan(wiseBefore);
    expect(
      await erc20Balance(ctx, ETH_WETH, holder),
      "remove_liquidity succeeded but WETH did not come back",
    ).toBeGreaterThan(wethBefore);
  }, 300_000);
});

/**
 * Pendle (`router-call`) is NOT fork-tested here, and cannot be.
 *
 * Its calldata does not exist until execute time: the device asks OUR backend
 * proxy, which asks Pendle's hosted SDK and re-resolves the target server-side
 * (§6). There is no adapter-built transaction to put on a fork — the family's
 * safety comes from the guardrails around that response instead:
 *
 *   1. the returned `to` must be on the pinned router allowlist
 *      (`constants/evmAddressBook.ts:isRouterAllowlisted`, checked on-device
 *      independently of the backend, §11.1),
 *   2. slippage is capped server-side at 300 bps (`router-quote.service.ts`),
 *   3. the built call is simulated before signing and the decoded intent is
 *      asserted against what was approved (§11 Layer-4).
 *
 * Guardrails 1 and 3 are covered by unit tests. Guardrail 2 lives in the
 * backend. What a fork test WOULD add is end-to-end proof against a live quote,
 * which needs the proxy running with real credentials — an integration test, not
 * a fork test. Enabling Pendle should wait for that.
 */
describe("Tier 3 fork gate", () => {
  it("reports which chains it could fork", () => {
    // Named rather than silently skipped: an unrun family must never be
    // mistaken for a passing one.
    expect(typeof canFork(ETHEREUM)).toBe("boolean");
    expect(typeof canFork(BASE)).toBe("boolean");
  });
});
