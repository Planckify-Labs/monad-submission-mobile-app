/**
 * Gate 4 — the whole on-device write path, on a fork.
 *
 * ## What this proves that the other fork suites do not
 *
 * `tier*.fork.test.ts` call `adapter.buildDeposit` directly. That proves the
 * BYTES are right, which is necessary and is roughly one step of the twelve a
 * real deposit takes. Everything else in `agent-executors/defi/writes.ts` —
 * the LLM-supplied-address rejection, `resolveAndGuard`'s tier/whitelist/
 * APY-drift/pause guards, the safety pipeline at all three of its anchors, the
 * allowance read and approve preamble, the phantom-failure-safe submit, the
 * live-balance preflight on withdraw, the position registration — has never run
 * against real protocol state.
 *
 * That span is exactly what a human was covering by hand, on mainnet, with
 * their own money (runbook §12.3 requirement 9). This suite is how that stops
 * being a person's job.
 *
 * So these tests call the SAME executors the agent dispatcher calls, with the
 * same tool-input shape the model emits, and stub only what is genuinely off
 * device: the backend rows. Nothing about the chain, the adapter, the safety
 * checks or the submission is faked.
 *
 * ## What is stubbed, and why that is not cheating
 *
 * `strategiesApi` is the device's view of the backend. It is mocked here for
 * two reasons, neither of which weakens the result:
 *
 *   1. What it returns is DATA, not logic. Whether the backend can resolve a
 *      `depositTarget` is Gate 1's question (`pnpm defi:dry-run`), already
 *      answered before anyone gets here.
 *   2. The mock is STATEFUL — `createPosition` stores what the deposit really
 *      passed it, and `getPosition` hands that same row to the withdraw. So the
 *      round trip is joined by the executor's own output rather than by a
 *      hand-written fixture, and a deposit that registered a wrong pool id or a
 *      wrong tx hash breaks the withdraw exactly as it would in production.
 *
 * ## Adding a protocol
 *
 * Append one row to `EXECUTOR_FORK_CASES` (`./executorCases.ts`).
 * `forkCoverage.test.ts` fails the build when a NEW execution shape appears
 * with no row there, so this is not a step anyone can forget.
 *
 * ## Running
 *
 *   FORK_TESTS=1 FORK_RPC_URL_42161=https://... \
 *   npx vitest run services/defi/__fork__/executor.fork.test.ts
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
  TOpportunity,
  TStrategyPosition,
  TUserStrategy,
} from "@/api/types/strategy";

// ── The stateful fake backend ──────────────────────────────────────────────
// Hoisted so `vi.mock` can close over it. Holds the rows a real API would
// serve, plus the positions the executor itself creates.

const backend = vi.hoisted(() => {
  const pools = new Map<string, unknown>();
  const positions = new Map<string, Record<string, unknown>>();
  let strategy: unknown = null;
  let positionSeq = 0;
  const calls: { method: string; args: unknown[] }[] = [];

  const record = (method: string, args: unknown[]) => {
    calls.push({ method, args });
  };

  return {
    pools,
    positions,
    calls,
    setStrategy(s: unknown) {
      strategy = s;
    },
    reset() {
      pools.clear();
      positions.clear();
      calls.length = 0;
      positionSeq = 0;
    },
    api: {
      getStrategy: async () => {
        record("getStrategy", []);
        return strategy;
      },
      getOpportunity: async (slug: string) => {
        record("getOpportunity", [slug]);
        return null;
      },
      getPool: async (poolId: string) => {
        record("getPool", [poolId]);
        const row = pools.get(poolId);
        if (!row) throw new Error(`no pool row seeded for ${poolId}`);
        return row;
      },
      // Deliberately empty: the USD snapshot is best-effort in the executor
      // (its own try/catch) and asserting on a live price would make this
      // suite depend on a third-party quote. `amountAtDepositUsd` lands at 0
      // and nothing here asserts on it.
      getAssetPrices: async () => {
        record("getAssetPrices", []);
        return [];
      },
      createPosition: async (payload: Record<string, unknown>) => {
        record("createPosition", [payload]);
        positionSeq += 1;
        const id = `fork-position-${positionSeq}`;
        const row = {
          id,
          userStrategyId: "fork-strategy",
          walletAddress: "",
          chainName: "fork",
          status: "active",
          amountAtDepositUsd: "0",
          currentAmountRaw: null,
          currentAmountUsd: null,
          closeTxHash: null,
          openedAt: new Date().toISOString(),
          closedAt: null,
          currentApy: null,
          ...payload,
          // `createPosition`'s payload uses `amountAtDeposit`; the read model
          // is `TStrategyPosition`. Keep both spellings consistent with the
          // real API rather than inventing a third.
          poolId: (payload.poolId as string | undefined) ?? null,
          assetContract: (payload.assetContract as string | undefined) ?? null,
          goal: (payload.goal as string | undefined) ?? null,
          targetDate: (payload.targetDate as string | undefined) ?? null,
        } as unknown as TStrategyPosition;
        positions.set(id, row as unknown as Record<string, unknown>);
        return row;
      },
      getPosition: async (id: string) => {
        record("getPosition", [id]);
        const row = positions.get(id);
        if (!row) throw new Error(`no position ${id}`);
        return row;
      },
      getPositions: async () => {
        record("getPositions", []);
        return [...positions.values()];
      },
    },
  };
});

vi.mock("@/api/endpoints/strategies", () => ({ strategiesApi: backend.api }));

/**
 * The rpc-proxy token mint. `buildChainConfigFromBlockchain` calls
 * `registerProxyOrigin(rpcUrl)`, which fires a best-effort mint at whatever
 * origin it is handed — here, anvil, which is not a proxy and would answer
 * with an error to a request that has nothing to do with this test. Stubbed to
 * keep the run quiet; `rpcFetchOptions` already returns no headers for an
 * origin with no token, so the RPC path is unchanged either way.
 */
vi.mock("@/services/rpc/proxyToken", () => ({
  ensureProxyToken: async () => null,
  currentProxyToken: () => null,
}));

import { deposit, withdraw } from "@/services/agent-executors/defi/writes";
import { registerDefiAdapter } from "../registry";
import { bootDefiSafety } from "../safety/bootstrap";
import { EXECUTOR_FORK_CASES, type ExecutorForkCase } from "./executorCases";
import { forkExecutorContext } from "./executorContext";
import {
  canFork,
  dealErc20,
  dealNative,
  erc20Balance,
  type ForkContext,
  positionBalance,
  startFork,
} from "./harness";

/** A permissive strategy row — the guards are covered by their own suite. */
function forkStrategy(walletAddress: string): TUserStrategy {
  return {
    id: "fork-strategy",
    userId: "fork-user",
    walletAddress,
    namespace: "eip155",
    tier: "aggressive",
    assetPreferences: ["stable"],
    liquidityPref: "instant",
    chainPref: null,
    allocationPct: 100,
    rebalanceTrigger: null,
    protocolWhitelist: [],
    allowAllInTier: true,
    autoCompound: false,
    notificationLevel: "all",
    activatedAt: new Date().toISOString(),
    pausedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as TUserStrategy;
}

/** The `OpportunityCache` row the backend would serve for this pool. */
function forkOpportunity(c: ExecutorForkCase): TOpportunity {
  return {
    id: c.poolId,
    protocolSlug: c.protocolSlug,
    chainId: c.chainId,
    namespace: "eip155",
    chainName: `fork-${c.chainId}`,
    assetSymbol: c.assetSymbol,
    assetContract: c.assetContract,
    poolId: c.poolId,
    poolMeta: null,
    depositTarget: c.target,
    targetResolvedAt: new Date().toISOString(),
    appUrl: null,
    apy: "5.0",
    apy7dAvg: "5.0",
    apyStddev30d: "0.1",
    tvlUsd: "100000000",
    tvl7dDelta: "0",
    emissionsToFeesRatio: null,
    ilExposure: false,
    score: 80,
    tier: "conservative",
    scoredAt: new Date().toISOString(),
  } as unknown as TOpportunity;
}

// ── The suite ──────────────────────────────────────────────────────────────

for (const c of EXECUTOR_FORK_CASES) {
  const describeFork = canFork(c.chainId) ? describe : describe.skip;

  describeFork(`Gate 4 — ${c.name}`, () => {
    let ctx: ForkContext;

    beforeAll(async () => {
      ctx = await startFork(c.chainId);

      // Register teardown BEFORE anything that can throw. Vitest only receives
      // the cleanup function this hook RETURNS, so a failure in the funding
      // below would otherwise leave anvil running after the run exits — which
      // it did, on the first attempt at this suite. `onTestFinished` is not
      // available in a `beforeAll`, so the fork is torn down here and the
      // returned function is left to cover the ordinary path.
      const stop = async () => {
        await ctx.stop();
      };
      try {
        await setUpCase(c, ctx);
      } catch (err) {
        await stop();
        throw err;
      }
      return stop;
    }, 240_000);

    /** Everything the case needs in place before the first `it` runs. */
    async function setUpCase(): Promise<void> {
      // Register only what this case needs. Deliberately NOT `bootDefi()`:
      // that gates registration on `EXPO_PUBLIC_FF_DEFI_EVM_TIER*`, and
      // whether a family is FLAGGED ON is a deployment decision that must not
      // decide whether it is TESTED. A family being dark is the normal state
      // while it is being proven (runbook §12.1).
      for (const adapter of c.adapters) registerDefiAdapter(adapter);
      bootDefiSafety();

      backend.reset();
      backend.setStrategy(forkStrategy(ctx.account.address));
      backend.pools.set(c.poolId, forkOpportunity(c));

      // Gas, plus the asset itself.
      await dealNative(ctx, ctx.account.address, 10n ** 20n);
      await dealErc20(ctx, c.assetContract, ctx.account.address, c.amount * 2n);
    }

    it("deposits through the agent executor and the position moves", async () => {
      const before = await positionBalance(ctx, c.target, ctx.account.address);

      const result = await deposit(
        {
          chain_id: c.chainId,
          protocol_slug: c.protocolSlug,
          asset_symbol: c.assetSymbol,
          amount_raw: c.amount.toString(),
          pool_id: c.poolId,
        },
        forkExecutorContext(ctx),
      );

      expect(result.status).toBe("success");
      expect(result.tx_hash).toMatch(/^0x[0-9a-f]{64}$/i);

      // The position actually moved — the assertion the whole gate exists for.
      const after = await positionBalance(ctx, c.target, ctx.account.address);
      expect(after).toBeGreaterThan(before);

      // The backend row the device registered is what a restart would read the
      // position back from, so a wrong pool id or tx hash here is a position
      // that silently disappears. Asserted from the call the executor really
      // made, not from a fixture.
      const created = backend.calls.find((x) => x.method === "createPosition");
      expect(created).toBeDefined();
      const payload = created?.args[0] as Record<string, unknown>;
      expect(payload.poolId).toBe(c.poolId);
      expect(payload.chainId).toBe(c.chainId);
      expect(payload.openTxHash).toBe(result.tx_hash);
      expect(payload.amountAtDeposit).toBe(c.amount.toString());
    }, 240_000);

    it("scopes the approval to the exact amount, leaving no standing allowance", async () => {
      // Read AFTER the deposit above. An exact-amount approve is fully
      // consumed by the transfer it was granted for, so a non-zero remainder
      // here means the executor granted more than the deposit needed — the
      // difference between an approval a user consented to and one that
      // outlives the action.
      const allowance = await ctx.publicClient.readContract({
        address: c.assetContract,
        abi: [
          {
            name: "allowance",
            type: "function",
            stateMutability: "view",
            inputs: [
              { name: "owner", type: "address" },
              { name: "spender", type: "address" },
            ],
            outputs: [{ name: "", type: "uint256" }],
          },
        ] as const,
        functionName: "allowance",
        args: [ctx.account.address, c.approvalSpender],
      });
      expect(allowance).toBe(0n);
    }, 120_000);

    it('empties the position on a "MAX" withdraw and returns the underlying', async () => {
      const positionId = [...backend.positions.keys()][0];
      expect(positionId).toBeDefined();

      const walletBefore = await erc20Balance(
        ctx,
        c.assetContract,
        ctx.account.address,
      );

      const result = await withdraw(
        { position_id: positionId, amount_raw: "MAX" },
        forkExecutorContext(ctx),
      );

      expect(result.status).toBe("success");

      // Dust ≈ 0 — the §11.2 bar for a family going live.
      const remaining = await positionBalance(
        ctx,
        c.target,
        ctx.account.address,
      );
      expect(remaining).toBeLessThanOrEqual(c.maxDust);

      // And the money is actually back in the wallet, not merely gone from the
      // protocol. A withdraw that burns the receipt and sends the underlying
      // somewhere else would pass the assertion above.
      const walletAfter = await erc20Balance(
        ctx,
        c.assetContract,
        ctx.account.address,
      );
      expect(walletAfter).toBeGreaterThan(walletBefore);
    }, 240_000);

    it("refuses a withdraw from the now-empty position with a typed reason", async () => {
      // Runs immediately after the MAX above, so the position is empty.
      //
      // `withdraw`'s preflight exists precisely for this: "a MAX withdraw
      // against a position with no live balance reverts with an opaque error.
      // Read the live position first so we can fail with a clear, typed reason
      // instead of submitting a doomed transaction." This asserts the guard
      // actually fires, which no unit test can — it needs a real emptied
      // position on a real chain.
      const positionId = [...backend.positions.keys()][0];

      const result = await withdraw(
        { position_id: positionId, amount_raw: "MAX" },
        forkExecutorContext(ctx),
      );

      expect(result.status).toBe("failed");
      expect(result.reason ?? result.error).toBe("no_onchain_balance");
      // Nothing was broadcast — the whole point is that the guard is reached
      // before a transaction is built.
      expect(result.tx_hash).toBeUndefined();
    }, 240_000);
  });
}
