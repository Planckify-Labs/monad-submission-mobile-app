/**
 * EVM family adapters (docs/defi-evm-protocol-expansion-spec.md §5, §6).
 *
 * These tests cover the two things that are easy to get subtly wrong and
 * impossible to notice from a passing build:
 *
 *  - **The encoded call.** One adapter serves every market of its family, so a
 *    wrong selector or argument order is wrong everywhere at once.
 *  - **The `"MAX"` semantics table (§8.3).** Each family exits differently —
 *    a uint256 sentinel, a share read, a supply-share read — and using the
 *    wrong one either reverts on a wei of rounding or silently leaves dust.
 */

import { decodeFunctionData, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";

// The family adapters build against a live client for their MAX/preview reads.
// Stub it so the ENCODING is what's under test, not the network.
const readContract = vi.fn();
vi.mock("@/utils/clients", () => ({
  getPublicClient: () => ({ readContract }),
  getWalletClient: () => ({}),
}));

import { BalancerLpAdapter } from "./balancerLp";
import { CometV3Adapter } from "./cometV3";
import { CompoundV2Adapter } from "./compoundV2";
import { CurveLpAdapter } from "./curveLp";
import { LstStakeAdapter } from "./lstStake";
import { MorphoBlueAdapter } from "./morphoBlue";
import { SolidlyLpAdapter } from "./solidlyLp";

const WALLET_ADDRESS = "0x3333333333333333333333333333333333333333" as const;
const ASSET = "0x1111111111111111111111111111111111111111" as const;
const COMET = "0x4444444444444444444444444444444444444444" as const;
const CTOKEN = "0x5555555555555555555555555555555555555555" as const;
const MORPHO_SINGLETON = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const;

const wallet = { address: WALLET_ADDRESS } as unknown as TWallet;
const chain: ChainConfig = { namespace: "eip155", chain: mainnet };
const asset = { symbol: "USDC", contract: ASSET, decimals: 6 };

const MAX_UINT256 = (1n << 256n) - 1n;

beforeEach(() => {
  readContract.mockReset();
});

describe("CometV3Adapter (§5.1)", () => {
  it("encodes supply(asset, amount) to the market and approves the market", async () => {
    const call = await CometV3Adapter.buildDeposit({
      wallet,
      chain,
      asset,
      amount: 1_000_000n,
      target: { kind: "compound-v3", comet: COMET, asset: ASSET },
    });
    if (call.kind !== "evm-call") throw new Error("expected evm-call");
    expect(call.to).toBe(COMET);
    expect(call.needsApproval).toEqual({
      token: ASSET,
      spender: COMET,
      amount: 1_000_000n,
    });
    const decoded = decodeFunctionData({
      abi: parseAbi(["function supply(address asset, uint256 amount)"]),
      data: call.data,
    });
    expect(decoded.args).toEqual([ASSET, 1_000_000n]);
  });

  it("uses type(uint256).max as the MAX sentinel rather than reading a balance", async () => {
    // Comet reads max as "the caller's entire base balance", which is safer
    // than a device-side balanceOf racing interest accrual.
    const call = await CometV3Adapter.buildWithdraw({
      wallet,
      chain,
      asset,
      amount: "MAX",
      target: { kind: "compound-v3", comet: COMET, asset: ASSET },
    });
    if (call.kind !== "evm-call") throw new Error("expected evm-call");
    const decoded = decodeFunctionData({
      abi: parseAbi(["function withdraw(address asset, uint256 amount)"]),
      data: call.data,
    });
    expect(decoded.args).toEqual([ASSET, MAX_UINT256]);
    expect(readContract).not.toHaveBeenCalled();
  });

  it("refuses an asset that is not the market's base token", async () => {
    await expect(
      CometV3Adapter.buildDeposit({
        wallet,
        chain,
        asset: { symbol: "DAI", contract: "0x9".padEnd(42, "9"), decimals: 18 },
        amount: 1n,
        target: { kind: "compound-v3", comet: COMET, asset: ASSET },
      }),
    ).rejects.toThrow();
  });

  it("refuses to build without a resolved target", async () => {
    await expect(
      CometV3Adapter.buildDeposit({ wallet, chain, asset, amount: 1n }),
    ).rejects.toThrow();
  });
});

describe("CompoundV2Adapter (§5.4)", () => {
  it("encodes mint(amount) and approves the cToken itself", async () => {
    const call = await CompoundV2Adapter.buildDeposit({
      wallet,
      chain,
      asset,
      amount: 500n,
      target: { kind: "compound-v2", cToken: CTOKEN, asset: ASSET },
    });
    if (call.kind !== "evm-call") throw new Error("expected evm-call");
    expect(call.to).toBe(CTOKEN);
    expect(call.needsApproval).toEqual({
      token: ASSET,
      spender: CTOKEN,
      amount: 500n,
    });
  });

  it("exits MAX by shares, not by underlying", async () => {
    // redeemUnderlying(balance) races the exchange rate: it can exceed the
    // position by a wei and revert, or leave dust. redeem(shares) is exact.
    readContract.mockResolvedValueOnce(777n);
    const call = await CompoundV2Adapter.buildWithdraw({
      wallet,
      chain,
      asset,
      amount: "MAX",
      target: { kind: "compound-v2", cToken: CTOKEN, asset: ASSET },
    });
    if (call.kind !== "evm-call") throw new Error("expected evm-call");
    const decoded = decodeFunctionData({
      abi: parseAbi([
        "function redeem(uint256 redeemTokens) returns (uint256)",
      ]),
      data: call.data,
    });
    expect(decoded.args).toEqual([777n]);
  });

  it("uses redeemUnderlying for a partial exit", async () => {
    const call = await CompoundV2Adapter.buildWithdraw({
      wallet,
      chain,
      asset,
      amount: 250n,
      target: { kind: "compound-v2", cToken: CTOKEN, asset: ASSET },
    });
    if (call.kind !== "evm-call") throw new Error("expected evm-call");
    const decoded = decodeFunctionData({
      abi: parseAbi([
        "function redeemUnderlying(uint256 redeemAmount) returns (uint256)",
      ]),
      data: call.data,
    });
    expect(decoded.args).toEqual([250n]);
  });

  it("refuses a full exit with no cTokens", async () => {
    readContract.mockResolvedValueOnce(0n);
    await expect(
      CompoundV2Adapter.buildWithdraw({
        wallet,
        chain,
        asset,
        amount: "MAX",
        target: { kind: "compound-v2", cToken: CTOKEN, asset: ASSET },
      }),
    ).rejects.toThrow();
  });
});

describe("MorphoBlueAdapter (§5.2, §3.1)", () => {
  const params = {
    loanToken: ASSET,
    collateralToken: "0x6666666666666666666666666666666666666666" as const,
    oracle: "0x7777777777777777777777777777777777777777" as const,
    irm: "0x8888888888888888888888888888888888888888" as const,
    lltv: "860000000000000000",
  };
  const target = {
    kind: "morpho-blue" as const,
    marketId: `0x${"ab".repeat(32)}` as `0x${string}`,
    params,
    asset: ASSET,
  };

  it("supplies to the pinned singleton with the FULL MarketParams struct", async () => {
    const call = await MorphoBlueAdapter.buildDeposit({
      wallet,
      chain,
      asset,
      amount: 1_000n,
      target,
    });
    if (call.kind !== "evm-call") throw new Error("expected evm-call");
    // The `to` is the singleton, never the market id.
    expect(call.to.toLowerCase()).toBe(MORPHO_SINGLETON.toLowerCase());
    expect(call.needsApproval).toEqual({
      token: ASSET,
      spender: MORPHO_SINGLETON,
      amount: 1_000n,
    });

    const decoded = decodeFunctionData({
      abi: parseAbi([
        "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
        "function supply(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)",
      ]),
      data: call.data,
    });
    const [struct, assets, shares, onBehalf] = decoded.args as [
      { lltv: bigint },
      bigint,
      bigint,
      string,
      string,
    ];
    // The wire type carries lltv as a decimal string; it must reach the chain
    // as a uint256.
    expect(struct.lltv).toBe(860000000000000000n);
    // Morpho's rule: exactly one of assets/shares is zero.
    expect(assets).toBe(1_000n);
    expect(shares).toBe(0n);
    // A lender supplies on their own behalf, never a third party's.
    expect(onBehalf.toLowerCase()).toBe(WALLET_ADDRESS.toLowerCase());
  });

  it("exits MAX by supplyShares read from the position", async () => {
    // Withdrawing a full balance by assets races interest accrual; by shares
    // it is exact — the same reasoning as 4626 preferring redeem.
    readContract.mockResolvedValueOnce([4242n, 0n, 0n]);
    const call = await MorphoBlueAdapter.buildWithdraw({
      wallet,
      chain,
      asset,
      amount: "MAX",
      target,
    });
    if (call.kind !== "evm-call") throw new Error("expected evm-call");
    const decoded = decodeFunctionData({
      abi: parseAbi([
        "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
        "function withdraw(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)",
      ]),
      data: call.data,
    });
    const [, assets, shares, onBehalf, receiver] = decoded.args as [
      unknown,
      bigint,
      bigint,
      string,
      string,
    ];
    expect(assets).toBe(0n);
    expect(shares).toBe(4242n);
    expect(onBehalf.toLowerCase()).toBe(WALLET_ADDRESS.toLowerCase());
    expect(receiver.toLowerCase()).toBe(WALLET_ADDRESS.toLowerCase());
  });

  it("refuses a target that carries only a marketId (the pre-fix shape)", async () => {
    // The whole reason §3.1 exists: a hash cannot be inverted into the struct
    // `supply` needs, so this must fail loudly rather than encode zeros.
    await expect(
      MorphoBlueAdapter.buildDeposit({
        wallet,
        chain,
        asset,
        amount: 1n,
        target: {
          kind: "morpho-blue",
          marketId: target.marketId,
        } as unknown as typeof target,
      }),
    ).rejects.toThrow();
  });
});

describe("LstStakeAdapter (§6.4, §12 Q2/Q5)", () => {
  const target = {
    kind: "lst-stake" as const,
    venue: "rocket-pool",
    receipt: "0xae78736Cd615f374D3085123A210448E74Fc6393" as const,
    asset: "0x0000000000000000000000000000000000000000" as const,
    exit: "dex" as const,
  };

  it("sends the amount as value and emits NO approval for a native stake", async () => {
    // §12 Q5: an approve on a native deposit is a no-op that would mask a
    // mis-build, so its absence is the assertion.
    const call = await LstStakeAdapter.buildDeposit({
      wallet,
      chain,
      asset: { symbol: "ETH", decimals: 18 },
      amount: 10n ** 18n,
      target,
    });
    if (call.kind !== "evm-call") throw new Error("expected evm-call");
    expect(call.value).toBe(10n ** 18n);
    expect(call.needsApproval).toBeUndefined();
    expect(call.to.toLowerCase()).toBe(
      "0xDD3f50F8A6CafbE9b31a427582963f465E745AF8".toLowerCase(),
    );
  });

  it("refuses a queue-exit withdraw instead of promising an instant one", async () => {
    // §8.3/§12 Q2: never promise an exit we cannot honour.
    await expect(
      LstStakeAdapter.buildWithdraw({
        wallet,
        chain,
        asset: { symbol: "ETH", decimals: 18 },
        amount: "MAX",
        target: { ...target, venue: "etherfi", exit: "queue" },
      }),
    ).rejects.toThrow();
  });

  it("refuses a DEX-exit withdraw, which belongs to the swap layer", async () => {
    await expect(
      LstStakeAdapter.buildWithdraw({
        wallet,
        chain,
        asset: { symbol: "ETH", decimals: 18 },
        amount: "MAX",
        target,
      }),
    ).rejects.toThrow();
  });

  it("refuses a venue that is not on the pinned config for this chain", async () => {
    await expect(
      LstStakeAdapter.buildDeposit({
        wallet,
        chain,
        asset: { symbol: "ETH", decimals: 18 },
        amount: 1n,
        target: { ...target, venue: "not-a-real-venue" },
      }),
    ).rejects.toThrow();
  });
});

/**
 * `requiresTarget` is what stops a kind-routed family adapter from being
 * offered through the slug fallback (`getDefiAdapter` matches `externalSlugs`)
 * for a pool the backend never resolved.
 *
 * The bug this guards against shipped and was measured on device: 5 Aerodrome,
 * 2 Curve, 2 Benqi and 1 ether.fi pool reported `in_app: true` with no
 * `depositTarget`, because their adapters carry `externalSlugs`. Every one of
 * them would have thrown at build time. Benqi is the sharpest case — its chain
 * is not in the directory at all, so no target for it can ever exist.
 *
 * Rather than trust the flag, this EXECUTES the no-target path: an adapter that
 * throws must declare `requiresTarget`, and one that declares it must throw.
 * Both directions, so the flag cannot drift away from the behaviour.
 */
describe("requiresTarget matches what buildDeposit actually does", () => {
  // RouterCallAdapter is absent on purpose: it imports `@/api/endpoints/strategies`,
  // which drags the RN api client into this runtime. It sets `requiresTarget`
  // and is covered by the same `if (!target) throw` guard; stubbing an HTTP
  // client here would test the stub.
  const FAMILY_ADAPTERS = [
    BalancerLpAdapter,
    CometV3Adapter,
    CompoundV2Adapter,
    CurveLpAdapter,
    LstStakeAdapter,
    SolidlyLpAdapter,
  ];

  it.each(FAMILY_ADAPTERS.map((a) => [a.slug, a] as const))(
    "%s refuses a target-less deposit and says so via requiresTarget",
    async (_slug, adapter) => {
      const attempt = adapter.buildDeposit({
        wallet,
        chain,
        asset,
        amount: 1_000_000n,
        // The whole point: no `target`.
      } as never);

      let threw = false;
      await attempt.catch(() => {
        threw = true;
      });

      expect(
        threw,
        `${adapter.slug} built a deposit with no target, so it must NOT set ` +
          "requiresTarget — or it is silently depositing into a default market",
      ).toBe(true);
      expect(
        adapter.requiresTarget,
        `${adapter.slug} throws without a target but does not declare ` +
          "requiresTarget, so the slug fallback will report its pools " +
          "agent-executable when they are not",
      ).toBe(true);
    },
  );

  it("keeps every externalSlugs-carrying adapter honest about the fallback", () => {
    // `externalSlugs` is ONLY consulted when no target was resolved. An adapter
    // that both declares slugs and requires a target is fine — the flag makes
    // the fallback skip it — but it must have the flag.
    for (const adapter of FAMILY_ADAPTERS) {
      if ((adapter.externalSlugs ?? []).length === 0) continue;
      expect(
        adapter.requiresTarget,
        `${adapter.slug} claims ${JSON.stringify(adapter.externalSlugs)} but ` +
          "does not declare requiresTarget",
      ).toBe(true);
    }
  });
});

/**
 * Mantle mETH — the only stake shape that carries slippage (§12 Q4).
 *
 * `stake(uint256 minMETHAmount)` takes a caller-supplied floor, which is why
 * this venue sat in `LST_VENUES_DEFERRED` rather than shipping with a guessed
 * ABI. What has to be true, and is tested here, is that the floor comes from
 * the protocol's own quote and is never zero — a zero minimum is an open
 * invitation to sandwich the deposit.
 */
describe("LstStakeAdapter — min-out stake (Mantle mETH)", () => {
  const STAKING = "0xe3cBd06D7dadB3F4e6557bAb7EdD924CD1489E8f";
  const METH = "0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa";
  const target = {
    kind: "lst-stake" as const,
    venue: "mantle-meth",
    receipt: METH as `0x${string}`,
    asset: "0x0000000000000000000000000000000000000000" as const,
    exit: "queue" as const,
  };
  const ONE_ETH = 10n ** 18n;
  /** What `ethToMETH(1e18)` really returns on mainnet, read 2026-08-21. */
  const QUOTED = 910_917_712_782_086_411n;

  function stakeArg(data: `0x${string}`): bigint {
    const { args } = decodeFunctionData({
      abi: parseAbi(["function stake(uint256 minMETHAmount)"]),
      data,
    });
    return args[0] as bigint;
  }

  it("floors the minimum with the protocol's own quote and the tier budget", async () => {
    readContract.mockResolvedValueOnce(QUOTED);
    const call = await LstStakeAdapter.buildDeposit({
      wallet,
      chain,
      asset: { symbol: "ETH", decimals: 18 },
      amount: ONE_ETH,
      target,
      tier: "conservative",
    });
    if (call.kind !== "evm-call") throw new Error("expected evm-call");

    expect(call.to?.toLowerCase()).toBe(STAKING.toLowerCase());
    expect(call.value).toBe(ONE_ETH);
    // Native stake: value, never an approval.
    expect(call.needsApproval).toBeUndefined();

    // LST/native is a CORRELATED pair, so conservative draws the 25bp stable
    // budget — not the 50bp volatile one. Getting that wrong is invisible
    // until someone is sandwiched.
    const min = stakeArg(call.data as `0x${string}`);
    expect(min).toBe((QUOTED * 9_975n) / 10_000n);
    expect(min).toBeGreaterThan(0n);
    expect(min).toBeLessThan(QUOTED);
  });

  it("gives a balanced user a wider floor than a conservative one", async () => {
    readContract.mockResolvedValueOnce(QUOTED);
    const conservative = await LstStakeAdapter.buildDeposit({
      wallet,
      chain,
      asset: { symbol: "ETH", decimals: 18 },
      amount: ONE_ETH,
      target,
      tier: "conservative",
    });
    readContract.mockResolvedValueOnce(QUOTED);
    const balanced = await LstStakeAdapter.buildDeposit({
      wallet,
      chain,
      asset: { symbol: "ETH", decimals: 18 },
      amount: ONE_ETH,
      target,
      tier: "balanced",
    });
    if (conservative.kind !== "evm-call" || balanced.kind !== "evm-call") {
      throw new Error("expected evm-call");
    }
    expect(stakeArg(balanced.data as `0x${string}`)).toBeLessThan(
      stakeArg(conservative.data as `0x${string}`),
    );
  });

  it("refuses rather than staking with a zero floor when the quote is zero", async () => {
    // §12 Q4's hard rule. A venue quoting nothing must not fall back to
    // `stake(0)`, which would accept any output at all.
    readContract.mockResolvedValueOnce(0n);
    await expect(
      LstStakeAdapter.buildDeposit({
        wallet,
        chain,
        asset: { symbol: "ETH", decimals: 18 },
        amount: ONE_ETH,
        target,
      }),
    ).rejects.toThrow();
  });

  it("refuses below the venue's on-chain minimum instead of paying for a revert", async () => {
    // `minimumStakeBound()` is 0.02 ETH on chain. Catching it here costs the
    // user nothing; letting it through costs them gas.
    await expect(
      LstStakeAdapter.buildDeposit({
        wallet,
        chain,
        asset: { symbol: "ETH", decimals: 18 },
        amount: 10n ** 16n, // 0.01 ETH
        target,
      }),
    ).rejects.toThrow();
    // And the quote is never even requested for an amount that cannot work.
    expect(readContract).not.toHaveBeenCalled();
  });
});
