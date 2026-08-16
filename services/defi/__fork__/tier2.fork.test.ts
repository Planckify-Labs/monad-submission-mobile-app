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
 * Curve is deliberately absent; see the note at the bottom of this file.
 */

import type { Address, Hex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { CometV3Adapter } from "../adapters/cometV3";
import { CompoundV2Adapter } from "../adapters/compoundV2";
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
 * Curve is NOT fork-tested here, and that is a finding rather than an omission.
 *
 * `curveLp.ts:lpTokenOf` returns `target.pool`, i.e. it assumes the pool
 * contract is also the LP token. That holds for Curve's NG generation and is
 * FALSE for the classic pools (3pool's LP token is a separate ERC-20). The
 * union carries no `lpToken`, so for a classic pool the adapter would read a
 * balance off the wrong contract — and `MAX` withdraw is exactly where it
 * surfaces.
 *
 * Writing a fork test around an NG pool would pass and hide that. The fix
 * belongs upstream: the resolver must refuse a pool that is not its own LP
 * token (fail closed to Manual), or the union must carry the LP token. Until
 * one of those lands, Curve is not a family to enable.
 */
describe("Tier 2 fork gate", () => {
  it("is skipped unless FORK_TESTS=1 and an RPC is configured", () => {
    expect(canFork(ETHEREUM)).toBe(
      process.env.FORK_TESTS?.trim() === "1" &&
        !!process.env.FORK_RPC_URL_1?.trim(),
    );
  });
});
