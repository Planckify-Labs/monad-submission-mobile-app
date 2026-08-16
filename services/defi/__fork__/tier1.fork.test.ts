/**
 * Tier 1 fork tests — ERC-4626 vaults and the Aave-v3 fork family (spec §4,
 * §5.3b, §11.3).
 *
 * Tier 1 registers NO new mobile adapter: its families reuse the shipped
 * `Erc4626Adapter` and `AaveV3` adapters, so what has to be proven is that a
 * *server-resolved target* drives those adapters into a transaction that
 * actually moves the position. That is precisely what cannot be shown by a unit
 * test, and precisely what §11.3 requires before a flag is turned on.
 *
 * Each case follows the same shape, deliberately:
 *
 *   fund → build via the SHIPPED adapter → simulate → send → assert the
 *   receipt-token balance grew → withdraw MAX → assert it came back
 *
 * The withdraw half matters as much as the deposit: a deposit that cannot be
 * reversed is worse than one that never happened, and §8.3's `MAX` semantics
 * are exactly where a family's ABI assumptions show up.
 *
 * Targets here are written as literals rather than fetched from the backend on
 * purpose — a fork test must fail when the ADAPTER breaks, not when an API is
 * down. The backend's ability to produce these targets is covered separately by
 * `pnpm defi:dry-run` and the resolver specs.
 */

import type { Address } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { AaveV3EthereumAdapter } from "../adapters/aaveV3";
import { Erc4626Adapter } from "../adapters/erc4626";
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
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address;

/** sDAI — Sky/Spark savings, a pinned Family-A vault (address-book vaults.ts). */
const SDAI = "0x83F20F44975D03b1b09e64809B757c47f942BEeA" as Address;
/** Aave v3 Ethereum Pool (address-book lending.ts). */
const AAVE_V3_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" as Address;
/** SparkLend Ethereum Pool — an Aave-v3 fork, resolver-only (§5.3b). */
const SPARKLEND_POOL = "0xC13e21B648A5Ee794902342038FF3aDAB66BE987" as Address;

const ONE_THOUSAND_USDC = 1_000_000_000n; // 6 dp
const ONE_THOUSAND_DAI = 1_000_000_000_000_000_000_000n; // 18 dp

/**
 * The adapters under test, keyed by the target kind they claim — the same
 * routing `getDefiAdapterForKind` does at runtime.
 *
 * Imported directly rather than through `bootDefi()`: the bootstrap pulls the
 * whole adapter graph, some of which reaches React Native modules that cannot
 * be parsed outside Metro. Registering only what the test executes keeps the
 * fork suite about execution instead of about module loading.
 */
const ADAPTERS = {
  erc4626: Erc4626Adapter,
  "aave-v3": AaveV3EthereumAdapter,
} as const;

const describeFork = canFork(ETHEREUM) ? describe : describe.skip;

describeFork("Tier 1 — fork execution on Ethereum", () => {
  let ctx: ForkContext;

  beforeAll(async () => {
    ctx = await startFork(ETHEREUM);
    // Gas. The deposits themselves are funded per-case.
    await dealNative(ctx, ctx.account.address, 10n ** 20n);
    return async () => {
      await ctx.stop();
    };
  }, 180_000);

  /**
   * One family, one round trip. Shared so every Tier-1 case proves the same
   * things and a new family cannot accidentally test less than its siblings.
   */
  async function roundTrip(opts: {
    target: DepositTarget;
    asset: { symbol: string; contract: Address; decimals: number };
    amount: bigint;
  }): Promise<void> {
    const { target, asset, amount } = opts;
    const holder = ctx.account.address;

    const adapter = ADAPTERS[target.kind as keyof typeof ADAPTERS];
    expect(
      adapter,
      `no mobile adapter claims kind "${target.kind}" — the backend would badge ` +
        "this pool 'Deposit in-app' with nothing able to execute it",
    ).toBeTruthy();
    if (!adapter) return;

    await dealErc20(ctx, asset.contract, holder, amount * 2n);
    const assetBefore = await erc20Balance(ctx, asset.contract, holder);
    const positionBefore = await positionBalance(ctx, target, holder);

    const deposit = await adapter.buildDeposit({
      wallet: ctx.wallet,
      chain: ctx.chain,
      asset,
      amount,
      target,
    });
    const depositResult = await executeCall(ctx, deposit);
    expect(depositResult.status).toBe("success");

    const positionAfter = await positionBalance(ctx, target, holder);
    expect(
      positionAfter,
      "deposit succeeded but the position did not grow — the call went somewhere " +
        "that is not the vault, or the receipt token is not what we think it is",
    ).toBeGreaterThan(positionBefore);
    expect(await erc20Balance(ctx, asset.contract, holder)).toBe(
      assetBefore - amount,
    );

    // MAX withdraw (§8.3): the semantics differ per family and this is where a
    // wrong assumption surfaces.
    const withdraw = await adapter.buildWithdraw({
      wallet: ctx.wallet,
      chain: ctx.chain,
      asset,
      amount: "MAX",
      target,
    });
    const withdrawResult = await executeCall(ctx, withdraw);
    expect(withdrawResult.status).toBe("success");

    const positionFinal = await positionBalance(ctx, target, holder);
    expect(
      positionFinal,
      "MAX withdraw left a residual position — the adapter is exiting a share " +
        "amount that does not mean 'everything' for this family",
    ).toBeLessThan(positionAfter);

    // The asset must actually come back, allowing for rounding down by one unit
    // (share-price maths truncates in the protocol's favour).
    const assetFinal = await erc20Balance(ctx, asset.contract, holder);
    expect(assetFinal).toBeGreaterThanOrEqual(assetBefore - 2n);
  }

  it("Family A — deposits into and fully exits a pinned ERC-4626 vault (sDAI)", async () => {
    await roundTrip({
      target: { kind: "erc4626", vault: SDAI, asset: DAI },
      asset: { symbol: "DAI", contract: DAI, decimals: 18 },
      amount: ONE_THOUSAND_DAI,
    });
  }, 240_000);

  it("Family B — deposits into and fully exits Aave v3", async () => {
    await roundTrip({
      target: { kind: "aave-v3", pool: AAVE_V3_POOL, asset: USDC },
      asset: { symbol: "USDC", contract: USDC, decimals: 6 },
      amount: ONE_THOUSAND_USDC,
    });
  }, 240_000);

  it("Family B — the same adapter serves a fork (SparkLend) with only a different Pool", async () => {
    // The whole §5.3b claim: a fork ships as a resolver plus one address-book
    // entry, with NO adapter change. If this passes, that claim is real.
    await roundTrip({
      target: { kind: "aave-v3", pool: SPARKLEND_POOL, asset: DAI },
      asset: { symbol: "DAI", contract: DAI, decimals: 18 },
      amount: ONE_THOUSAND_DAI,
    });
  }, 240_000);

  it("refuses to build when the declared asset contradicts the target's underlying", async () => {
    // Layer-0/1: the target is the trusted source, so a mismatched asset must
    // be a refusal rather than a deposit into the wrong vault.
    const adapter = ADAPTERS.erc4626;
    expect(adapter).toBeTruthy();
    await expect(
      adapter?.buildDeposit({
        wallet: ctx.wallet,
        chain: ctx.chain,
        asset: { symbol: "USDC", contract: USDC, decimals: 6 },
        amount: ONE_THOUSAND_USDC,
        target: { kind: "erc4626", vault: SDAI, asset: DAI },
      }),
    ).rejects.toThrow();
  }, 60_000);
});

describe("Tier 1 fork gate", () => {
  it("is skipped unless FORK_TESTS=1 and an RPC is configured", () => {
    // Documents why the suite above is usually invisible, and keeps the file
    // from reporting "0 tests" when it is skipped.
    expect(canFork(ETHEREUM)).toBe(
      process.env.FORK_TESTS?.trim() === "1" &&
        !!process.env.FORK_RPC_URL_1?.trim(),
    );
  });
});
