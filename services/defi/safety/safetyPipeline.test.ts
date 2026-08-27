/**
 * Safety pipeline (spec §11).
 *
 * Two properties matter more than any individual check:
 *
 *  1. **Fail-closed short-circuit.** The first failure stops the pipeline, and
 *     a check that THROWS counts as a failure — an exception is exactly the
 *     case where we do not know whether the property holds, and "we don't
 *     know" must never authorise moving funds.
 *  2. **Chain-agnosticism is real, not aspirational.** The runner and the
 *     universal checks must work against a stub provider with no EVM anywhere,
 *     because that is the claim §11.0 makes about adding a chain.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { DepositTarget } from "../types";
import {
  LAYER0_CHECKS,
  WithdrawBalanceCheck,
  WithdrawHintMatchCheck,
} from "./checks/layer0-input";
import { LAYER1_CHECKS, PoolAnomalyCheck } from "./checks/layer1-identity";
import {
  ExposureCapCheck,
  FamilyKillSwitchCheck,
  LAYER3_CHECKS,
  SanctionsScreenCheck,
  setCounterpartyDenyList,
  setDefiEnabledChains,
  setKilledFamilies,
  UserPolicyCheck,
  VelocityCapCheck,
} from "./checks/layer3-policy";
import {
  DecodedIntentMatchCheck,
  DestinationBoundToTargetCheck,
  IdempotencyCheck,
  resetInFlightSubmissions,
} from "./checks/layer4-execution";
import { LAYER5_CHECKS } from "./checks/layer5-state";
import {
  registerChainSafetyProvider,
  registerSafetyCheck,
  resetSafetyRegistry,
  runSafetyPipeline,
  selectChecks,
} from "./registry";
import type { ChainSafetyProvider, SafetyCheck, SafetyContext } from "./types";

const VAULT = "0x2222222222222222222222222222222222222222";
const ASSET = "0x1111111111111111111111111111111111111111";
const WALLET = "0x3333333333333333333333333333333333333333";

const target: DepositTarget = {
  kind: "erc4626",
  vault: VAULT,
  asset: ASSET,
};

/**
 * A provider for a chain that does not exist. If the universal checks need
 * anything EVM-shaped, this stub will not satisfy them — which is the point.
 */
function stubProvider(
  overrides: Partial<ChainSafetyProvider> = {},
): ChainSafetyProvider {
  return {
    namespace: "eip155",
    targetExists: async () => true,
    readUnderlying: async () => ASSET,
    isAllowlisted: async () => true,
    assertChainBinding: () => true,
    decodeIntent: async () => ({
      destination: VAULT,
      action: "deposit",
      assetIn: ASSET,
      amountIn: 1000n,
      recipient: WALLET,
      valueNative: 0n,
      spender: VAULT,
      approvalAmount: 1000n,
      minOut: 990n,
      deadline: null,
    }),
    simulate: async () => ({ ok: true }),
    isProtocolHalted: async () => false,
    readPositionBalance: async () => 1n,
    readDecimals: async () => 6,
    ...overrides,
  };
}

function ctx(overrides: Partial<SafetyContext> = {}): SafetyContext {
  return {
    namespace: "eip155",
    action: "deposit",
    target,
    chainId: 1,
    wallet: WALLET,
    requestedAmount: 1000n,
    underlyingExpected: ASSET,
    previewOut: null,
    tvlUsdSnapshot: 1_000_000,
    sim: null,
    feeEstimate: null,
    stage: "presign",
    ...overrides,
  };
}

beforeEach(() => {
  resetSafetyRegistry();
  resetInFlightSubmissions();
  setKilledFamilies([]);
  setCounterpartyDenyList([]);
  setDefiEnabledChains(null);
});

describe("selectChecks", () => {
  it("filters by namespace, kind and stage, and orders by layer", () => {
    const make = (
      id: string,
      layer: SafetyCheck["layer"],
      appliesTo?: SafetyCheck["appliesTo"],
    ): SafetyCheck => ({
      id,
      layer,
      appliesTo,
      run: async () => ({ ok: true }),
    });

    registerSafetyCheck(make("late", 4));
    registerSafetyCheck(make("early", 0));
    registerSafetyCheck(make("other-chain", 1, { namespaces: ["sui"] }));
    registerSafetyCheck(make("other-kind", 1, { kinds: ["curve-lp"] }));
    registerSafetyCheck(make("other-stage", 1, { stages: ["submit"] }));

    const selected = selectChecks(ctx()).map((c) => c.id);
    expect(selected).toEqual(["early", "late"]);
  });
});

describe("runSafetyPipeline", () => {
  it("short-circuits on the first failure and reports which check fired", async () => {
    const ran: string[] = [];
    registerSafetyCheck({
      id: "first",
      layer: 0,
      run: async () => {
        ran.push("first");
        return { ok: true };
      },
    });
    registerSafetyCheck({
      id: "blocker",
      layer: 1,
      run: async () => {
        ran.push("blocker");
        return { ok: false, fail: "target_not_allowlisted" };
      },
    });
    registerSafetyCheck({
      id: "never",
      layer: 2,
      run: async () => {
        ran.push("never");
        return { ok: true };
      },
    });

    const result = await runSafetyPipeline(ctx());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.fail).toBe("target_not_allowlisted");
    expect(result.layer).toBe(1);
    expect(result.id).toBe("blocker");
    // The expensive later layer never ran.
    expect(ran).toEqual(["first", "blocker"]);
  });

  it("treats a thrown check as a failure, not a pass", async () => {
    registerSafetyCheck({
      id: "explodes",
      layer: 1,
      run: async () => {
        throw new Error("rpc down");
      },
    });
    const result = await runSafetyPipeline(ctx());
    expect(result.ok).toBe(false);
  });

  it("passes when every applicable check passes", async () => {
    registerSafetyCheck({
      id: "ok",
      layer: 1,
      run: async () => ({ ok: true }),
    });
    const result = await runSafetyPipeline(ctx());
    expect(result.ok).toBe(true);
  });
});

describe("Layer 0 — input provenance", () => {
  beforeEach(() => {
    for (const check of LAYER0_CHECKS) registerSafetyCheck(check);
  });

  it("rejects an address-shaped field supplied by the model", async () => {
    const result = await runSafetyPipeline(
      ctx({ toolInput: { pool_id: "abc12345", vault: VAULT } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("target_not_allowlisted");
  });

  it("accepts a tool call that only carries a pool id", async () => {
    const result = await runSafetyPipeline(
      ctx({
        toolInput: { pool_id: "abc12345", amount_raw: "1000" },
        poolId: "abc12345",
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a non-positive amount rather than coercing it", async () => {
    const result = await runSafetyPipeline(ctx({ requestedAmount: 0n }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("below_min_deposit");
  });
});

describe("Layer 1 — identity, through the provider seam", () => {
  beforeEach(() => {
    for (const check of LAYER1_CHECKS) registerSafetyCheck(check);
  });

  it("blocks when no provider is registered for the namespace", async () => {
    // §11.3: a chain without a trustworthy provider is Manual, never in-app.
    const result = await runSafetyPipeline(ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("unsupported_chain");
  });

  it("blocks a target with no code", async () => {
    registerChainSafetyProvider(
      stubProvider({ targetExists: async () => false }),
    );
    const result = await runSafetyPipeline(ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("target_not_a_contract");
  });

  it("blocks a look-alike whose underlying disagrees with the pool", async () => {
    registerChainSafetyProvider(
      stubProvider({
        readUnderlying: async () =>
          "0x9999999999999999999999999999999999999999",
      }),
    );
    const result = await runSafetyPipeline(ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("decoded_intent_mismatch");
  });

  it("blocks a destination that is not on the pinned allowlist", async () => {
    registerChainSafetyProvider(
      stubProvider({ isAllowlisted: async () => false }),
    );
    const result = await runSafetyPipeline(ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("target_not_allowlisted");
  });

  it("flags a pool whose numbers were never plausible", async () => {
    registerChainSafetyProvider(stubProvider());
    const result = await runSafetyPipeline(ctx({ cachedApy: 5000 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("pool_anomaly_flagged");
  });

  it("passes a well-formed target", async () => {
    registerChainSafetyProvider(stubProvider());
    expect((await runSafetyPipeline(ctx())).ok).toBe(true);
  });
});

describe("Layer 3 — policy, with no chain involvement at all", () => {
  beforeEach(() => {
    for (const check of LAYER3_CHECKS) registerSafetyCheck(check);
  });

  it("honours the ops kill-switch for a family", async () => {
    setKilledFamilies(["erc4626"]);
    const result = await runSafetyPipeline(ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("family_disabled");
  });

  it("honours per-chain DeFi enablement, separate from chain support", async () => {
    setDefiEnabledChains([8453]);
    const result = await runSafetyPipeline(ctx({ chainId: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("family_disabled");
  });

  it("blocks a sanctioned counterparty as a hard gate", async () => {
    setCounterpartyDenyList([VAULT]);
    const result = await runSafetyPipeline(ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("counterparty_blocked");
  });

  it("blocks once the exposure cap is reached", async () => {
    const result = await runSafetyPipeline(
      ctx({ policy: { currentExposurePct: 0.5, maxExposurePct: 0.4 } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("exposure_cap_exceeded");
  });

  it("blocks once the velocity cap is reached", async () => {
    const result = await runSafetyPipeline(
      ctx({ policy: { recentDepositCount: 10, maxDepositsPerWindow: 10 } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("velocity_exceeded");
  });

  it("enforces the user's protocol whitelist", async () => {
    const result = await runSafetyPipeline(
      ctx({
        protocolSlug: "some-venue",
        policy: { protocolWhitelist: ["aave-v3"], allowAllInTier: false },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("protocol_not_in_whitelist");
  });
});

describe("Layer 4 — idempotency", () => {
  beforeEach(() => {
    registerSafetyCheck(IdempotencyCheck);
    registerChainSafetyProvider(stubProvider());
  });

  it("lets the first submission through and blocks an identical retry", async () => {
    const submitCtx = ctx({
      stage: "submit",
      submissionKey: "wallet:pool:1000",
    });
    expect((await runSafetyPipeline(submitCtx)).ok).toBe(true);

    const second = await runSafetyPipeline(submitCtx);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.fail).toBe("duplicate_submission");
  });

  it("does not confuse two different deposits", async () => {
    expect(
      (await runSafetyPipeline(ctx({ stage: "submit", submissionKey: "a" })))
        .ok,
    ).toBe(true);
    expect(
      (await runSafetyPipeline(ctx({ stage: "submit", submissionKey: "b" })))
        .ok,
    ).toBe(true);
  });
});

describe("SafetyAction scoping — withdraw must not inherit deposit-only policy", () => {
  it("selectChecks drops a deposit-only check for a withdraw context", () => {
    registerSafetyCheck({
      id: "deposit-only",
      layer: 1,
      appliesTo: { actions: ["deposit"] },
      run: async () => ({ ok: true }),
    });
    registerSafetyCheck({
      id: "unscoped",
      layer: 1,
      run: async () => ({ ok: true }),
    });
    const selected = selectChecks(ctx({ action: "withdraw" })).map((c) => c.id);
    expect(selected).toEqual(["unscoped"]);
  });

  it("pool-anomaly never blocks an exit, even from an implausible pool", async () => {
    registerSafetyCheck(PoolAnomalyCheck);
    const result = await runSafetyPipeline(
      ctx({ action: "withdraw", cachedApy: 5000 }),
    );
    expect(result.ok).toBe(true);
  });

  it("tier/whitelist/pause never blocks a withdraw", async () => {
    registerSafetyCheck(UserPolicyCheck);
    const result = await runSafetyPipeline(
      ctx({
        action: "withdraw",
        protocolSlug: "some-venue",
        policy: { paused: true, protocolWhitelist: ["aave-v3"] },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("exposure cap never blocks a withdraw", async () => {
    registerSafetyCheck(ExposureCapCheck);
    const result = await runSafetyPipeline(
      ctx({
        action: "withdraw",
        policy: { currentExposurePct: 0.9, maxExposurePct: 0.1 },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("velocity cap never blocks a withdraw", async () => {
    registerSafetyCheck(VelocityCapCheck);
    const result = await runSafetyPipeline(
      ctx({
        action: "withdraw",
        policy: { recentDepositCount: 99, maxDepositsPerWindow: 1 },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("family kill-switch never blocks a withdraw", async () => {
    setKilledFamilies(["erc4626"]);
    registerSafetyCheck(FamilyKillSwitchCheck);
    const result = await runSafetyPipeline(ctx({ action: "withdraw" }));
    expect(result.ok).toBe(true);
  });

  it("deposit still gets every deposit-only check", async () => {
    registerSafetyCheck(UserPolicyCheck);
    const result = await runSafetyPipeline(
      ctx({ action: "deposit", policy: { paused: true } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("strategy_paused");
  });
});

describe("Withdraw-only Layer 0 checks", () => {
  beforeEach(() => {
    registerSafetyCheck(WithdrawHintMatchCheck);
    registerSafetyCheck(WithdrawBalanceCheck);
  });

  it("passes a withdraw with no hints at all", async () => {
    const result = await runSafetyPipeline(
      ctx({ action: "withdraw", protocolSlug: "compound-v3-arbitrum" }),
    );
    expect(result.ok).toBe(true);
  });

  it("blocks a protocol_slug hint that disagrees with the position", async () => {
    const result = await runSafetyPipeline(
      ctx({
        action: "withdraw",
        protocolSlug: "compound-v3-arbitrum",
        toolInput: { protocol_slug: "aave-v3-base" },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("decoded_intent_mismatch");
  });

  it("blocks a chain_id hint that disagrees with the position", async () => {
    const result = await runSafetyPipeline(
      ctx({
        action: "withdraw",
        chainId: 42161,
        toolInput: { chain_id: 8453 },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("decoded_intent_mismatch");
  });

  it("blocks an asset_symbol hint that disagrees with the position", async () => {
    const result = await runSafetyPipeline(
      ctx({
        action: "withdraw",
        assetSymbol: "USDT",
        toolInput: { asset_symbol: "USDC" },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("decoded_intent_mismatch");
  });

  it("is not fooled by case differences", async () => {
    const result = await runSafetyPipeline(
      ctx({
        action: "withdraw",
        protocolSlug: "Compound-V3-Arbitrum",
        assetSymbol: "usdt",
        toolInput: {
          protocol_slug: "compound-v3-arbitrum",
          asset_symbol: "USDT",
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("passes a MAX withdraw regardless of live balance", async () => {
    const result = await runSafetyPipeline(
      ctx({
        action: "withdraw",
        stage: "submit",
        requestedAmount: "MAX",
        positionBalance: 1n,
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("blocks a non-MAX amount that exceeds the live balance", async () => {
    const result = await runSafetyPipeline(
      ctx({
        action: "withdraw",
        stage: "submit",
        requestedAmount: 1_000_000n,
        positionBalance: 500_000n,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("withdraw_exceeds_balance");
  });

  it("does not block when the live balance read failed (non-fatal)", async () => {
    const result = await runSafetyPipeline(
      ctx({
        action: "withdraw",
        stage: "submit",
        requestedAmount: 1_000_000n,
        positionBalance: undefined,
      }),
    );
    expect(result.ok).toBe(true);
  });
});

/**
 * A deposit that names a PROTOCOL rather than a pool (a venue-routed Sui
 * intent, a legacy slug-routed EVM deposit) has no resolved `DepositTarget`.
 * Both call sites used to skip the pipeline outright for those, which quietly
 * exempted an entire class of deposits from every check that never needed a
 * target in the first place.
 */
describe("deposits with no resolved target", () => {
  it("drops the target-dependent checks and keeps the rest", () => {
    registerChainSafetyProvider(stubProvider());
    for (const check of [
      ...LAYER1_CHECKS,
      ...LAYER3_CHECKS,
      ...LAYER5_CHECKS,
    ]) {
      registerSafetyCheck(check);
    }

    const withTarget = selectChecks(ctx()).map((c) => c.id);
    const withoutTarget = selectChecks(ctx({ target: undefined })).map(
      (c) => c.id,
    );

    // Provider-backed identity and exit terms need a pool to look at.
    expect(withTarget).toContain("target-has-code");
    expect(withTarget).toContain("exit-terms-consent");
    expect(withoutTarget).not.toContain("target-has-code");
    expect(withoutTarget).not.toContain("underlying-matches");
    expect(withoutTarget).not.toContain("target-allowlisted");
    expect(withoutTarget).not.toContain("exit-terms-consent");

    // Everything about the USER and the POLICY still runs.
    for (const id of [
      "family-kill-switch",
      "user-policy",
      "chain-enabled-for-defi",
      "sanctions-screen",
      "pool-anomaly",
    ]) {
      expect(withoutTarget).toContain(id);
    }
  });

  it("still answers the ops kill switch on a venue-routed deposit", async () => {
    // Keyed by the protocol slug, which is what a venue-routed deposit
    // carries and what ops actually types during an incident.
    setKilledFamilies(["scallop"]);
    registerSafetyCheck(FamilyKillSwitchCheck);
    const result = await runSafetyPipeline(
      ctx({ target: undefined, protocolSlug: "scallop" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("family_disabled");
  });

  it("still enforces the user's tier/whitelist/pause", async () => {
    registerSafetyCheck(UserPolicyCheck);
    const result = await runSafetyPipeline(
      ctx({
        target: undefined,
        protocolSlug: "scallop",
        policy: { paused: true },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("strategy_paused");
  });

  it("still screens the user's own wallet against the deny list", async () => {
    setCounterpartyDenyList([WALLET]);
    registerSafetyCheck(SanctionsScreenCheck);
    const result = await runSafetyPipeline(ctx({ target: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("counterparty_blocked");
  });

  it("still binds the built call to the chain and the user's own wallet", async () => {
    registerChainSafetyProvider(
      stubProvider({
        decodeIntent: async () => ({
          destination: VAULT,
          action: "deposit",
          assetIn: ASSET,
          amountIn: 1000n,
          // Pays out somewhere that is not the user.
          recipient: "0x9999999999999999999999999999999999999999",
          valueNative: 0n,
          spender: null,
          approvalAmount: null,
          minOut: null,
          deadline: null,
        }),
      }),
    );
    registerSafetyCheck(DecodedIntentMatchCheck);
    const result = await runSafetyPipeline(
      ctx({
        target: undefined,
        stage: "submit",
        call: { kind: "evm-call", to: VAULT, chainId: 1 } as never,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fail).toBe("decoded_intent_mismatch");
  });

  /**
   * The destination binding is the half that genuinely needs a target, so it
   * is its own check rather than a silently-skipped branch inside
   * `decoded-intent-match`. The audit trail has to be able to say which of
   * the two ran.
   */
  it("reports the destination binding as absent, not as passed", async () => {
    registerChainSafetyProvider(stubProvider());
    registerSafetyCheck(DecodedIntentMatchCheck);
    registerSafetyCheck(DestinationBoundToTargetCheck);
    const call = { kind: "evm-call", to: VAULT, chainId: 1 } as never;

    const withTarget = await runSafetyPipeline(
      ctx({ stage: "submit", call, submissionKey: undefined }),
    );
    expect(withTarget.ran).toContain("decoded-destination-allowlisted");

    const withoutTarget = await runSafetyPipeline(
      ctx({ target: undefined, stage: "submit", call }),
    );
    expect(withoutTarget.ran).toContain("decoded-intent-match");
    expect(withoutTarget.ran).not.toContain("decoded-destination-allowlisted");
  });
});
