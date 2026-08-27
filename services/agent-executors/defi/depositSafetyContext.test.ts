/**
 * The deposit executor's half of the safety pipeline: the `SafetyContext` it
 * hands the checks (spec §11.1 anchor 1).
 *
 * The checks themselves are covered by `safety/safetyPipeline.test.ts` with a
 * hand-built context. What that suite cannot see is whether the EXECUTOR fills
 * that context with the right values — and it did not: `underlyingExpected`
 * was taken from the tool's optional `asset_contract`, which the agent omits on
 * essentially every call, so it defaulted to the zero address and Layer 1
 * compared a real `asset()` / reserve read against `0x0`. Every ERC-20 pool
 * deposit died on `underlying-matches` (live: Aave V3 cbBTC on Base).
 *
 * So these tests drive the real executor with the real checks and only stub
 * what is genuinely off-device (API rows, adapter, chain clients, broadcast).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TOpportunity } from "@/api/types/strategy";
import type { ExecutorContext } from "../types";

const POOL = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";
const ASSET = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const OTHER_ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WALLET = "0x0141781aad86a023fac70c6aad0a8e7253164db6";
const POOL_ID = "89bc7c4c-d71c-435c-ab28-56c803d51320";

const h = vi.hoisted(() => ({
  getPool: vi.fn(),
  getStrategy: vi.fn(),
  getOpportunity: vi.fn(),
  getAssetPrices: vi.fn(),
  createPosition: vi.fn(),
  submitEvmCall: vi.fn(),
  /** balanceOf / allowance answers, and the order things happened in. */
  balance: 0n,
  allowance: 0n,
  trace: [] as string[],
}));

vi.mock("@/api/endpoints/strategies", () => ({
  strategiesApi: {
    getPool: h.getPool,
    getStrategy: h.getStrategy,
    getOpportunity: h.getOpportunity,
    // Reached only after a successful submit (USD valuation of the
    // position) — mocked so that path doesn't throw into its own
    // try/catch and leaves `amountAtDepositUsd` at 0 for this suite,
    // which doesn't assert on it.
    getAssetPrices: h.getAssetPrices.mockImplementation(async () => []),
    createPosition: h.createPosition.mockImplementation(async () => ({})),
  },
}));
vi.mock("@/hooks/useWallet.helpers", () => ({
  buildChainConfigFromBlockchain: () => ({
    namespace: "eip155",
    chain: { id: 8453, name: "Base" },
  }),
}));
vi.mock("./submitTx", () => ({ submitEvmCall: h.submitEvmCall }));
vi.mock("../chainRouter", () => ({
  resolveChainClients: () => ({
    chainId: 8453,
    walletClient: {
      account: { address: WALLET },
      chain: { id: 8453 },
      writeContract: async () => {
        h.trace.push("approve");
        h.allowance = 2n ** 255n; // the grant the deposit was waiting on
        return "0xdead";
      },
    },
    publicClient: {
      readContract: async () => h.allowance,
      waitForTransactionReceipt: async () => ({ status: "success" }),
    },
  }),
}));

/**
 * The adapter is the seam between the resolved target and the calldata; a
 * faithful stub encodes the same three facts an Aave build does — destination,
 * approved token, amount — so Layer 4 has something real to decode.
 */
vi.mock("@/services/defi/registry", () => ({
  listDefiAdapters: () => [],
  getDefiAdapter: () => null,
  getDefiAdapterForTarget: () => ({
    slug: "aave-v3",
    namespace: "eip155",
    buildDeposit: async ({
      target,
      amount,
    }: {
      target: { pool: string; asset: string };
      amount: bigint;
    }) => ({
      kind: "evm-call",
      to: target.pool,
      data: "0x617ba037",
      needsApproval: {
        token: target.asset,
        spender: target.pool,
        amount,
      },
    }),
  }),
}));

import { LAYER0_CHECKS } from "@/services/defi/safety/checks/layer0-input";
import { LAYER1_CHECKS } from "@/services/defi/safety/checks/layer1-identity";
import { LAYER2_CHECKS } from "@/services/defi/safety/checks/layer2-economic";
import {
  LAYER4_CHECKS,
  resetInFlightSubmissions,
} from "@/services/defi/safety/checks/layer4-execution";
import {
  registerChainSafetyProvider,
  registerSafetyCheck,
  resetSafetyRegistry,
} from "@/services/defi/safety/registry";
import type { ChainSafetyProvider } from "@/services/defi/safety/types";
import { deposit } from "./writes";

/**
 * Stands in for the chain, not for the check: `readUnderlying` answers what an
 * Aave Pool with `ASSET` listed would answer, so a context naming any other
 * asset genuinely fails identity rather than being waved through.
 */
function chainStub(): ChainSafetyProvider {
  return {
    namespace: "eip155",
    targetExists: async () => true,
    readUnderlying: async (target) =>
      target.kind === "aave-v3" && target.asset.toLowerCase() === ASSET
        ? target.asset
        : null,
    isAllowlisted: async () => true,
    assertChainBinding: () => true,
    decodeIntent: async (call) =>
      call.kind === "evm-call"
        ? {
            destination: call.to,
            action: "deposit" as const,
            assetIn: ASSET,
            amountIn: 200000000n,
            recipient: WALLET,
            valueNative: 0n,
            spender: POOL,
            approvalAmount: 200000000n,
            minOut: null,
            deadline: null,
          }
        : null,
    simulate: async () => {
      h.trace.push("simulate");
      // The chain would revert while the allowance is still zero. Modelling
      // that is the whole point: a dry-run scheduled before the approve can
      // only ever report a failure that says nothing about the deposit.
      return h.allowance >= 200000000n
        ? { ok: true }
        : { ok: false, revertReason: "allowance" };
    },
    isProtocolHalted: async () => false,
    readPositionBalance: async () => 1n,
    readDecimals: async () => 8,
    readBalance: async () => h.balance,
  };
}

function opportunity(overrides: Partial<TOpportunity> = {}): TOpportunity {
  return {
    id: "row-1",
    protocolSlug: "aave-v3",
    chainId: 8453,
    namespace: "eip155",
    chainName: "Base",
    assetSymbol: "CBBTC",
    assetContract: ASSET,
    poolId: POOL_ID,
    poolMeta: null,
    depositTarget: { kind: "aave-v3", pool: POOL, asset: ASSET },
    targetResolvedAt: new Date().toISOString(),
    appUrl: null,
    apy: "0.01158",
    apy7dAvg: "0.01158",
    apyStddev30d: "0",
    tvlUsd: "156200000",
    tvl7dDelta: "0",
    emissionsToFeesRatio: null,
    ilExposure: false,
    score: 75,
    tier: "balanced",
    scoredAt: new Date().toISOString(),
    ...overrides,
  } as TOpportunity;
}

const context = {
  wallet: { address: WALLET, namespace: "eip155" },
  account: null,
  blockchains: [{ chainId: 8453, name: "Base" }],
  wallets: [],
  activeChainId: 8453,
} as unknown as ExecutorContext;

/** Exactly what the agent sends: a pool id and a symbol, never an address. */
function depositInput(extra: Record<string, unknown> = {}) {
  return {
    protocol_slug: "aave-v3",
    chain_id: 8453,
    asset_symbol: "CBBTC",
    amount_raw: "200000000",
    pool_id: POOL_ID,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSafetyRegistry();
  resetInFlightSubmissions();
  h.trace = [];
  // A funded wallet with the approval already in place: the baseline where
  // nothing should stand between the request and the broadcast.
  h.balance = 500000000n;
  h.allowance = 2n ** 255n;
  for (const check of [
    ...LAYER0_CHECKS,
    ...LAYER1_CHECKS,
    ...LAYER2_CHECKS,
    ...LAYER4_CHECKS,
  ]) {
    registerSafetyCheck(check);
  }
  registerChainSafetyProvider(chainStub());
  h.getPool.mockResolvedValue(opportunity());
  // Mirrors the live device: no strategy row yet, so the guard that reads it
  // rejects. A deposit must still be able to pass safety in that state.
  h.getStrategy.mockRejectedValue(new Error("no strategy"));
  // Stops one step past the pipeline: nothing was broadcast, so the assertion
  // is about which failure we get, and no chain state is invented.
  h.submitEvmCall.mockResolvedValue({ kind: "not_broadcast" });
});

describe("deposit → SafetyContext", () => {
  it("passes identity with no asset_contract, anchoring on the resolved target", async () => {
    const result = await deposit(depositInput(), context);

    expect(h.submitEvmCall).toHaveBeenCalledTimes(1);
    // The only failure left is the stubbed non-broadcast, not the identity
    // check that used to reject every ERC-20 pool here.
    expect(result.reason).toBe("deposit_failed");
  });

  it("still rejects a target whose underlying the chain does not confirm", async () => {
    h.getPool.mockResolvedValue(
      opportunity({
        assetContract: OTHER_ASSET,
        depositTarget: { kind: "aave-v3", pool: POOL, asset: OTHER_ASSET },
      }),
    );

    const result = await deposit(depositInput(), context);

    expect(h.submitEvmCall).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
  });

  it("keeps anchoring on the target when the model does supply asset_contract", async () => {
    const result = await deposit(
      depositInput({ asset_contract: ASSET }),
      context,
    );

    expect(h.submitEvmCall).toHaveBeenCalledTimes(1);
    expect(result.reason).not.toBe("decoded_intent_mismatch");
  });
});

describe("deposit → what the agent is told when it fails", () => {
  it("names an empty wallet as insufficient_funds, before spending approval gas", async () => {
    h.balance = 0n;
    h.allowance = 0n;

    const result = await deposit(depositInput(), context);

    // The live failure this replaces: a generic reverted dry-run, which the
    // agent read as "bad parameters" and answered with a decimals theory.
    expect(result.error).toBe("insufficient_funds");
    expect(h.trace).not.toContain("approve");
    expect(h.submitEvmCall).not.toHaveBeenCalled();
  });

  it("simulates only after the approval is in place, never before", async () => {
    h.allowance = 0n; // first-ever deposit of this token

    await deposit(depositInput(), context);

    // Approve first, then dry-run: the reverse order reverts on the missing
    // allowance and blames the deposit for it.
    expect(h.trace).toEqual(["approve", "simulate"]);
    // Reached the broadcast: with the old ordering this deposit died at
    // `simulate-before-sign` on an allowance that had not been granted yet.
    expect(h.submitEvmCall).toHaveBeenCalledTimes(1);
  });

  it("never reports a chain-side failure as invalid_input", async () => {
    // Funded and approved, but the deposit itself reverts.
    h.allowance = 2n ** 255n;
    const provider = chainStub();
    resetSafetyRegistry();
    for (const check of [
      ...LAYER0_CHECKS,
      ...LAYER1_CHECKS,
      ...LAYER2_CHECKS,
      ...LAYER4_CHECKS,
    ]) {
      registerSafetyCheck(check);
    }
    registerChainSafetyProvider({
      ...provider,
      simulate: async () => ({ ok: false, revertReason: "revert" }),
    });

    const result = await deposit(depositInput(), context);

    expect(h.submitEvmCall).not.toHaveBeenCalled();
    // "I couldn't read that request. Try rephrasing what you want." is a lie
    // about a call whose parameters were fine.
    expect(result.error).not.toBe("invalid_input");
    expect(result.error).toBe("unknown_error");
    expect(result.reason).toBe("deposit_failed");
  });
});
