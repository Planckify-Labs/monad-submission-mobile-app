/**
 * Executor-path tests for the Sui Intent Engine tools (spec §6.4, §8.4).
 *
 * Covers the orchestration the other suites don't: the namespace gate, the
 * affordability gate, the `inspected` (live-read) surfacing, and — critically
 * — the SI-5 invariant that a previewed-`block`ed (or now-reverting) intent
 * can NEVER reach signing. The real `intentStore` is used so the
 * preview→execute hand-off + the block gate are exercised genuinely; only the
 * heavy / RN-pulling deps (compiler, guardian, dry-run, kit, RPC) are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  compileIntentToPtb: vi.fn(),
  simulateSuiTransaction: vi.fn(),
  runGuardian: vi.fn(),
  getBalance: vi.fn(),
  signAndExecuteSuiPtb: vi.fn(),
  recordTransferHistory: vi.fn(),
  getPool: vi.fn(),
  getStrategy: vi.fn(),
  getObject: vi.fn(),
  getCoinMetadata: vi.fn(),
}));

vi.mock("../sui/executorContext", () => ({
  getActiveSuiChain: () => ({
    namespace: "sui",
    network: "testnet",
    rpcUrl: "http://localhost",
  }),
  getSuiKit: () => ({ signAndExecuteSuiPtb: h.signAndExecuteSuiPtb }),
  loadSuiTokens: async () => [],
}));
vi.mock("@/services/chains/sui/intent/compileIntentToPtb", () => ({
  compileIntentToPtb: h.compileIntentToPtb,
}));
vi.mock("@/services/chains/sui/simulation", () => ({
  simulateSuiTransaction: h.simulateSuiTransaction,
}));
vi.mock("@/services/chains/sui/intent/guardian/riskCheckRegistry", () => ({
  runGuardian: h.runGuardian,
}));
vi.mock("../wallet/recordTransferHistory", () => ({
  recordTransferHistory: h.recordTransferHistory,
}));
vi.mock("@mysten/sui/jsonRpc", () => ({
  SuiJsonRpcClient: class {
    getBalance = h.getBalance;
    getObject = h.getObject;
    getCoinMetadata = h.getCoinMetadata;
  },
}));
// Dynamically imported by the executor for the pool-level path; mocked so a
// `poolId` intent resolves a real `depositTarget` and the safety pipeline has
// something to verify.
vi.mock("@/api/endpoints/strategies", () => ({
  strategiesApi: { getPool: h.getPool, getStrategy: h.getStrategy },
}));

import { intentStore } from "@/services/chains/sui/intent/intentStore";
import { resetDefiSafetyBootstrap } from "@/services/defi/safety/bootstrap";
import { setKilledFamilies } from "@/services/defi/safety/checks/layer3-policy";
import {
  registerChainSafetyProvider,
  resetSafetyRegistry,
} from "@/services/defi/safety/registry";
import type { ChainSafetyProvider } from "@/services/defi/safety/types";
import type { ExecutorContext } from "../types";
import {
  defiIntentExecute,
  defiIntentPreview,
  isVersionGateDryRunArtifact,
} from "./intentExecutors";

const SUI = "0x2::sui::SUI";

const suiCtx = {
  wallet: { namespace: "sui", address: "0xabc" },
  account: null,
  blockchains: [],
} as unknown as ExecutorContext;

const swapInput = {
  action: "swap",
  fromAsset: "SUI",
  toAsset: "USDC",
  amount: { human: "5" },
  maxSlippageBps: 50,
};

const compiledSwap = {
  ptbBase64: "AAA=",
  decoded: [{ kind: "MoveCall" }],
  summary: "Swap 5 SUI to USDC",
  expectedOut: 9_000_000n,
  priceImpact: 0.01,
  poolObjectId: "0xpool",
  inputCoinType: SUI,
  inputAmountRaw: 5_000_000_000n,
  outputCoinType: "0xUSDC::usdc::USDC",
};

const okDryRun = {
  status: "success",
  gasUsed: {
    computation: 0n,
    storage: 0n,
    storageRebate: 0n,
    nonRefundableStorageFee: 0n,
  },
  balanceChanges: [],
  objectChanges: [],
  warnings: [],
};

beforeEach(() => {
  intentStore.clear();
  vi.clearAllMocks();
  h.compileIntentToPtb.mockResolvedValue(compiledSwap);
  h.simulateSuiTransaction.mockResolvedValue(okDryRun);
  h.runGuardian.mockResolvedValue([]);
  h.getBalance.mockResolvedValue({ totalBalance: "10000000000" }); // 10 SUI
  h.signAndExecuteSuiPtb.mockResolvedValue("DIGEST_base58");
  h.recordTransferHistory.mockResolvedValue("txrec_1");
  h.getPool.mockResolvedValue(null);
  h.getStrategy.mockResolvedValue(null);
  h.getObject.mockResolvedValue(null);
  h.getCoinMetadata.mockResolvedValue({ decimals: 9 });
  resetSafetyRegistry();
});

describe("defiIntentPreview", () => {
  it("rejects when the user owns no Sui wallet at all", async () => {
    const r = await defiIntentPreview(swapInput, {
      ...suiCtx,
      wallet: { namespace: "eip155", address: "0x1" },
      wallets: [{ namespace: "eip155", address: "0x1" }],
    } as unknown as ExecutorContext);
    expect(r).toEqual({
      status: "failed",
      error: "unsupported_chain",
      reason: "wallet_not_sui",
    });
  });

  it("previews against an owned Sui wallet even when EVM is active", async () => {
    // A preview never signs, so it has no business requiring the Sui
    // wallet to be the active one. Gating on the active wallet made a
    // Sui-owning user switch wallets just to read a plan.
    const suiWallet = { namespace: "sui", address: "0xSUI_OWNED" };
    const r = await defiIntentPreview(swapInput, {
      ...suiCtx,
      wallet: { namespace: "eip155", address: "0x1" },
      wallets: [{ namespace: "eip155", address: "0x1" }, suiWallet],
    } as unknown as ExecutorContext);
    expect(r.status).toBe("success");
    // The dry-run must be attributed to the wallet the PTB was compiled
    // for, not the active EVM one.
    expect(h.simulateSuiTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sender: "0xSUI_OWNED" }),
    );
  });

  it("rejects an intent that fails zod validation", async () => {
    const r = await defiIntentPreview({ action: "borrow" }, suiCtx);
    expect(r).toEqual({
      status: "failed",
      error: "invalid_input",
      reason: "invalid_intent",
    });
  });

  it("compiles a safe swap and surfaces the live reads (inspected)", async () => {
    const r = await defiIntentPreview(swapInput, suiCtx);
    expect(r.status).toBe("success");
    const data = r.data as {
      intent_id: string;
      blocked: boolean;
      inspected: string[];
    };
    expect(typeof data.intent_id).toBe("string");
    expect(data.blocked).toBe(false);
    // The guardian's real reads are surfaced, honestly, per what ran.
    expect(data.inspected).toContain("Simulated this exact transaction on Sui");
    expect(data.inspected).toContain("Checked your live balance");
    expect(data.inspected).toContain("Checked the pool's live state");
    // The compiled PTB is stashed for execute.
    expect(intentStore.get(data.intent_id)).not.toBeNull();
  });

  it("marks blocked when the guardian returns a block flag", async () => {
    h.runGuardian.mockResolvedValue([
      {
        code: "concentration.high",
        severity: "block",
        title: "x",
        detail: "y",
      },
    ]);
    const r = await defiIntentPreview(swapInput, suiCtx);
    expect((r.data as { blocked: boolean }).blocked).toBe(true);
  });

  it("marks blocked when the dry-run would revert", async () => {
    h.simulateSuiTransaction.mockResolvedValue({
      ...okDryRun,
      status: "failure",
    });
    const r = await defiIntentPreview(swapInput, suiCtx);
    expect((r.data as { blocked: boolean }).blocked).toBe(true);
  });

  it("fails with insufficient_funds when the wallet can't fund the input", async () => {
    h.getBalance.mockResolvedValue({ totalBalance: "1000000000" }); // 1 SUI < 5
    const r = await defiIntentPreview(swapInput, suiCtx);
    expect(r).toEqual({
      status: "failed",
      error: "insufficient_funds",
      reason: "insufficient_balance",
    });
  });

  it("does NOT block on a null dry-run (transient RPC, not a revert)", async () => {
    h.simulateSuiTransaction.mockResolvedValue(null);
    const r = await defiIntentPreview(swapInput, suiCtx);
    expect(r.status).toBe("success");
    expect((r.data as { blocked: boolean }).blocked).toBe(false);
  });
});

describe("defiIntentExecute", () => {
  function putEntry(over: Partial<{ flags: unknown[] }> = {}) {
    return intentStore.put({
      ptbBase64: "AAA=",
      intent: swapInput as never,
      flags: (over.flags ?? []) as never,
      summary: "Swap 5 SUI to USDC",
      inputCoinType: SUI,
      inputAmountRaw: 5_000_000_000n,
    });
  }

  it("rejects a non-Sui wallet", async () => {
    const r = await defiIntentExecute({ intent_id: putEntry() }, {
      ...suiCtx,
      wallet: { namespace: "eip155", address: "0x1" },
    } as unknown as ExecutorContext);
    expect(r).toEqual({
      status: "failed",
      error: "unsupported_chain",
      reason: "wallet_not_sui",
    });
  });

  it("rejects a watch-only wallet with no address", async () => {
    const r = await defiIntentExecute({ intent_id: putEntry() }, {
      ...suiCtx,
      wallet: { namespace: "sui" },
    } as unknown as ExecutorContext);
    expect(r).toEqual({
      status: "failed",
      error: "wallet_type_cannot_execute",
      reason: "no_connected_wallet",
    });
  });

  it("rejects an unknown / expired intent_id as a stale precondition", async () => {
    const r = await defiIntentExecute({ intent_id: "nope" }, suiCtx);
    expect(r).toEqual({
      status: "failed",
      error: "stale_precondition",
      reason: "intent_expired",
    });
  });

  it("SI-5: a previewed-blocked intent can never be signed", async () => {
    const id = putEntry({
      flags: [
        {
          code: "concentration.high",
          severity: "block",
          title: "x",
          detail: "y",
        },
      ],
    });
    const r = await defiIntentExecute({ intent_id: id }, suiCtx);
    expect(r).toEqual({
      status: "failed",
      error: "stale_precondition",
      reason: "intent_no_longer_safe",
    });
    expect(h.signAndExecuteSuiPtb).not.toHaveBeenCalled();
  });

  it("refuses to sign when the re-guard dry-run now reverts", async () => {
    h.simulateSuiTransaction.mockResolvedValue({
      ...okDryRun,
      status: "failure",
    });
    const r = await defiIntentExecute({ intent_id: putEntry() }, suiCtx);
    expect(r).toEqual({
      status: "failed",
      error: "stale_precondition",
      reason: "intent_no_longer_safe",
    });
    expect(h.signAndExecuteSuiPtb).not.toHaveBeenCalled();
  });

  it("returns a retryable network_error (not invalid_input) when the re-guard dry-run is unobtainable", async () => {
    h.simulateSuiTransaction.mockResolvedValue(null); // RPC blip, not a revert
    const r = await defiIntentExecute({ intent_id: putEntry() }, suiCtx);
    expect(r).toEqual({
      status: "failed",
      error: "network_error",
      reason: "reguard_unavailable",
    });
    expect(h.signAndExecuteSuiPtb).not.toHaveBeenCalled();
  });

  it("signs a safe intent, returns the base58 digest, and consumes the entry", async () => {
    const id = putEntry();
    const r = await defiIntentExecute({ intent_id: id }, suiCtx);
    expect(r.status).toBe("success");
    expect(r.tx_confirmed).toBe(true);
    expect((r.data as { digest: string; network: string }).digest).toBe(
      "DIGEST_base58",
    );
    expect((r.data as { network: string }).network).toBe("testnet");
    // Never the hex-typed tx_hash (§6.4).
    expect(r.tx_hash).toBeUndefined();
    // A previewed PTB signs at most once.
    expect(intentStore.get(id)).toBeNull();
  });
});

// The version-gate dry-run bypass MUST stay tightly scoped: it only downgrades a
// KNOWN false-positive (an `assert_version` abort on a `simulationUnreliable`
// venue). Every other revert — and any missing flag — must still block.
describe("isVersionGateDryRunArtifact (scoped bypass)", () => {
  const assertVersionAbort = {
    status:
      'MoveAbort(MoveLocation { module: ..., function_name: Some("assert_version") }, 1)',
  };

  it("bypasses ONLY an assert_version revert on a flagged venue", () => {
    expect(isVersionGateDryRunArtifact(true, assertVersionAbort)).toBe(true);
  });

  it("does NOT bypass when the venue isn't flagged (fail-safe)", () => {
    expect(isVersionGateDryRunArtifact(false, assertVersionAbort)).toBe(false);
    expect(isVersionGateDryRunArtifact(undefined, assertVersionAbort)).toBe(
      false,
    );
  });

  it("does NOT bypass a different revert on a flagged venue", () => {
    expect(
      isVersionGateDryRunArtifact(true, {
        status: "MoveAbort(... EInsufficientBalance ..., 3)",
      }),
    ).toBe(false);
    expect(
      isVersionGateDryRunArtifact(true, { status: "InsufficientGas" }),
    ).toBe(false);
  });

  it("does NOT bypass a successful or missing dry-run", () => {
    expect(isVersionGateDryRunArtifact(true, { status: "success" })).toBe(
      false,
    );
    expect(isVersionGateDryRunArtifact(true, null)).toBe(false);
  });
});

/**
 * The Sui Intent Engine used to be the one write path that never called
 * `runSafetyPipeline` — the guardian was the whole of its policy layer. These
 * two tests pin both halves of the fix: the gate fires, and it does not fire
 * when it shouldn't.
 */
describe("safety pipeline on the Sui intent path (§11.1)", () => {
  const supplyInput = {
    action: "supply",
    venue: "scallop",
    asset: "SUI",
    amount: { human: "5" },
    poolId: "pool-uuid-1234",
  };

  const scallopTarget = {
    kind: "scallop-market",
    market: "0xmarket",
    coinType: SUI,
  };

  /** Answers every required primitive; the pipeline should clear it. */
  function passingSuiProvider(
    overrides: Partial<ChainSafetyProvider> = {},
  ): ChainSafetyProvider {
    return {
      namespace: "sui",
      targetExists: async () => true,
      readUnderlying: async () => SUI,
      isAllowlisted: async () => true,
      assertChainBinding: () => true,
      decodeIntent: async () => ({
        destination: "0xpkg::mint::mint",
        action: "deposit",
        assetIn: null,
        amountIn: null,
        recipient: null,
        valueNative: 0n,
        spender: null,
        approvalAmount: null,
        minOut: null,
        deadline: null,
      }),
      simulate: async () => ({ ok: true }),
      isProtocolHalted: async () => false,
      readPositionBalance: async () => 1n,
      readExitTerms: async () => ({ kind: "instant" }),
      readDecimals: async () => 9,
      readBalance: async () => 10_000_000_000n,
      ...overrides,
    };
  }

  beforeEach(() => {
    h.getPool.mockResolvedValue({ depositTarget: scallopTarget });
    h.compileIntentToPtb.mockResolvedValue({
      ...compiledSwap,
      summary: "Supply 5 SUI to Scallop",
    });
    // Boot FIRST, then override: `bootDefiSafety` is idempotent, so the
    // provider registered here is the one the executor's own boot leaves in
    // place.
    resetDefiSafetyBootstrap();
  });

  it("blocks the preview when a layer refuses, and the block survives to execute", async () => {
    const { bootDefiSafety } = await import("@/services/defi/safety/bootstrap");
    bootDefiSafety();
    registerChainSafetyProvider(
      passingSuiProvider({
        // The venue's own object cannot be verified on chain. Layer 1's
        // refusal is the one that used to be impossible to reach here.
        targetExists: async () => false,
      }),
    );

    const preview = await defiIntentPreview(supplyInput, suiCtx);
    expect(preview.status).toBe("success");
    const data = (
      preview as {
        data: {
          blocked: boolean;
          risk_flags: { title: string; severity: string }[];
          intent_id: string;
        };
      }
    ).data;
    expect(data.blocked).toBe(true);
    expect(
      data.risk_flags.some(
        (f) => f.title === "Safety check failed" && f.severity === "block",
      ),
    ).toBe(true);

    // SI-5: the same block that stopped the preview stops the signature.
    const executed = await defiIntentExecute(
      { intent_id: data.intent_id },
      suiCtx,
    );
    expect(executed).toMatchObject({ reason: "intent_no_longer_safe" });
    expect(h.signAndExecuteSuiPtb).not.toHaveBeenCalled();
  });

  it("leaves a clean intent alone", async () => {
    const { bootDefiSafety } = await import("@/services/defi/safety/bootstrap");
    bootDefiSafety();
    registerChainSafetyProvider(passingSuiProvider());

    const preview = await defiIntentPreview(supplyInput, suiCtx);
    const data = (
      preview as { data: { blocked: boolean; risk_flags: unknown[] } }
    ).data;
    expect(data.risk_flags).toEqual([]);
    expect(data.blocked).toBe(false);
  });
});

/**
 * A plain-language supply ("supply 5 SUI to Scallop") carries no `poolId`, so
 * the server never resolves a `DepositTarget` and `runSuiSafety` used to
 * return before running anything. That silently exempted the whole
 * venue-routed path from the ops kill switch, the per-chain DeFi gate and the
 * user's own tier/whitelist/pause — none of which needs a pool.
 */
describe("venue-routed Sui intents (no poolId)", () => {
  const venueSupply = {
    action: "supply",
    venue: "scallop",
    asset: "SUI",
    amount: { human: "5" },
  };

  beforeEach(() => {
    // No pool: the resolved-target branch never runs.
    h.getPool.mockResolvedValue(null);
    h.getStrategy.mockResolvedValue(null);
    h.compileIntentToPtb.mockResolvedValue({
      ...compiledSwap,
      summary: "Supply 5 SUI to Scallop",
    });
    resetDefiSafetyBootstrap();
    setKilledFamilies([]);
  });

  afterEach(() => {
    setKilledFamilies([]);
  });

  it("blocks when ops has killed the venue", async () => {
    const { bootDefiSafety } = await import("@/services/defi/safety/bootstrap");
    bootDefiSafety();
    // Keyed by the protocol slug — the only key a venue-routed intent has.
    setKilledFamilies(["scallop"]);

    const preview = await defiIntentPreview(venueSupply, suiCtx);
    const data = (
      preview as {
        data: {
          blocked: boolean;
          risk_flags: { title: string; severity: string }[];
        };
      }
    ).data;
    expect(data.blocked).toBe(true);
    expect(
      data.risk_flags.some(
        (f) => f.title === "Safety check failed" && f.severity === "block",
      ),
    ).toBe(true);
  });

  it("blocks when the user's strategy is paused", async () => {
    const { bootDefiSafety } = await import("@/services/defi/safety/bootstrap");
    bootDefiSafety();
    h.getStrategy.mockResolvedValue({
      tier: "conservative",
      pausedAt: "2026-08-27T00:00:00.000Z",
      allowAllInTier: true,
      protocolWhitelist: [],
    });

    const preview = await defiIntentPreview(venueSupply, suiCtx);
    expect((preview as { data: { blocked: boolean } }).data.blocked).toBe(true);
  });

  /**
   * Not blocked, but not silently treated as fully verified either: the
   * identity and exit-terms checks could not look at a pool nobody resolved,
   * and the user is told so.
   */
  it("warns that the pool itself was not verified, without blocking", async () => {
    const { bootDefiSafety } = await import("@/services/defi/safety/bootstrap");
    bootDefiSafety();

    const preview = await defiIntentPreview(venueSupply, suiCtx);
    const data = (
      preview as {
        data: {
          blocked: boolean;
          risk_flags: { title: string; severity: string }[];
        };
      }
    ).data;
    expect(data.blocked).toBe(false);
    expect(
      data.risk_flags.some(
        (f) =>
          f.title === "Pool not verified on chain" && f.severity === "warn",
      ),
    ).toBe(true);
  });

  it("does not warn about an unverified pool on a plain swap", async () => {
    const { bootDefiSafety } = await import("@/services/defi/safety/bootstrap");
    bootDefiSafety();

    const preview = await defiIntentPreview(swapInput, suiCtx);
    const data = (preview as { data: { risk_flags: { title: string }[] } })
      .data;
    expect(
      data.risk_flags.some((f) => f.title === "Pool not verified on chain"),
    ).toBe(false);
  });
});
