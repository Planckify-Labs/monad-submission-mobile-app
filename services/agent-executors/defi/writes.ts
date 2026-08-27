/**
 * DeFi write executors — deposit / withdraw / claim / rebalance.
 *
 * Spec: docs/defi-strategies-spec.md §11, §15, §25.3.
 *
 * Each write enforces the spec's safety envelope before touching the
 * chain:
 *   • Tier-ceiling check (§15.7): `OpportunityCache.tier` ≤ user's
 *     `UserStrategy.tier`.
 *   • Whitelist check (§15.8): `protocol_slug` ∈ user's whitelist
 *     (or curated default when `allowAllInTier=false`).
 *   • APY-drift check (§15.6): `expected_apy` from the LLM must be
 *     within ±5% of `OpportunityCache.apy`.
 *   • Strategy-paused kill-switch (§15.9).
 *
 * Failures throw `DefiError(code, …)`; `safeExecute` maps `code` to
 * `ToolResult.error` so the agent never sees raw text.
 */

import {
  type Address,
  decodeEventLog,
  erc20Abi,
  formatUnits,
  type PublicClient,
  parseAbi,
  type TransactionReceipt,
} from "viem";
import { strategiesApi } from "@/api/endpoints/strategies";
import type { TBlockchain } from "@/api/types/blockchain";
import type { TOpportunity, TUserStrategy } from "@/api/types/strategy";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import {
  buildChainConfigFromBlockchain,
  resolveNamespace,
} from "@/hooks/useWallet.helpers";
import { toChainTag } from "@/services/analytics/chainTag";
import { track } from "@/services/analytics/posthog";
import { decimalsForSymbol } from "@/services/defi/assetDecimals";
import {
  classifyDefiError,
  DefiError,
} from "@/services/defi/errors/defiErrors";
import { readPosition } from "@/services/defi/positions/reader";
import {
  getDefiAdapter,
  getDefiAdapterForTarget,
  listDefiAdapters,
} from "@/services/defi/registry";
import { releaseSubmission } from "@/services/defi/safety/checks/layer4-execution";
import { takeExitConsent } from "@/services/defi/safety/exitConsent";
import {
  POSTEXEC_UNCONFIRMED_NOTE,
  type PostExecVerdict,
  snapshotPositionBefore,
  verifyPostExecution,
} from "@/services/defi/safety/postexec";
import { setEvmChainResolver } from "@/services/defi/safety/providers/eip155";
import { setSolanaChainResolver } from "@/services/defi/safety/providers/solana";
import {
  assertSafetyResult,
  runSafetyPipeline,
} from "@/services/defi/safety/registry";
import type { SafetyContext } from "@/services/defi/safety/types";
import type { PositionReadContext } from "@/services/defi/types";
import {
  approvalsOf,
  type DepositTarget,
  NATIVE_ASSET_SENTINEL,
  targetUnderlying,
  type UnsignedCall,
} from "@/services/defi/types";
import { getDefaultTokens } from "@/services/tokens/tokenList";
import { walletKitRegistry } from "@/services/walletKit/registry";
import { resolveChainClients } from "../chainRouter";
import {
  ExecutorError,
  ExecutorErrorCode,
  type MobileToolExecutor,
  requireBigInt,
  requireString,
  resolveChainId,
  safeExecute,
  type ToolInput,
} from "../types";
import { toExecutorErrorCode } from "./defiErrorMapping";
import { submitEvmCall } from "./submitTx";

const APY_DRIFT_TOLERANCE_PCT = 5;

const TIER_RANK = {
  conservative: 0,
  balanced: 1,
  aggressive: 2,
} as const;

type TierKey = keyof typeof TIER_RANK;

export function toTierKey(tier: string | undefined): TierKey {
  if (tier === "balanced" || tier === "aggressive") return tier;
  return "conservative";
}

// Address-bearing DepositTarget fields the LLM must NEVER supply (spec §8:
// "No LLM-supplied addresses"). The executor re-fetches the authoritative
// target server-side by `pool_id`; a call carrying any of these is rejected.
// `asset_contract` (the deposited asset) is intentionally NOT here — it's the
// user's token, validated against the resolved target inside the adapter.
const FORBIDDEN_TARGET_KEYS = [
  "deposit_target",
  "depositTarget",
  "target",
  "vault",
  "vault_address",
  "market",
  "market_address",
  "comet",
  "reserve",
  "program",
  "pool_address",
] as const;

function assertNoLlmSuppliedTarget(input: ToolInput): void {
  for (const key of FORBIDDEN_TARGET_KEYS) {
    const value = input[key];
    if (value !== undefined && value !== null && value !== "") {
      if (__DEV__) {
        console.warn("[defi/deposit] REJECT llm-supplied target field", {
          key,
        });
      }
      // Fail closed. The server owns target resolution (§6); the model only
      // passes pool_id. Friendly copy via classifyDefiError → deposit_failed.
      throw new DefiError(
        "deposit_failed",
        `address-shaped field "${key}" is not accepted from the model; the target is resolved server-side by pool_id`,
      );
    }
  }
}

/**
 * Point the eip155 + solana safety providers at the chains the backend has
 * published.
 *
 * Chains are data (the API's blockchain rows), not a bundled constant, so
 * each provider is handed a resolver rather than looking one up. Rebinding
 * per invocation keeps it in step with a chain list that can change under
 * us. The eip155 side keys on numeric `chainId`; Solana rows carry
 * `chainId: null` (`api/types/blockchain.ts`'s own documented convention —
 * "EVM numeric chainId, or `null` for non-EVM networks"), so the Solana
 * resolver instead matches on the `cluster` string the safety pipeline uses
 * as ITS `chainId` for Solana targets (see `resolveSolanaChain` below,
 * which is the one place that string gets minted).
 */
function bindSafetyChainResolver(context: {
  blockchains: TBlockchain[];
}): void {
  setEvmChainResolver((chainId) => {
    const blockchain = context.blockchains.find((b) => b.chainId === chainId);
    return blockchain ? buildChainConfigFromBlockchain(blockchain) : null;
  });
  setSolanaChainResolver((cluster) => {
    const blockchain = context.blockchains.find((b) => {
      if (resolveNamespace(b) !== "solana") return false;
      const config = buildChainConfigFromBlockchain(b);
      return (
        config.namespace === "solana" && config.cluster === String(cluster)
      );
    });
    return blockchain ? buildChainConfigFromBlockchain(blockchain) : null;
  });
}

/**
 * Resolve the Solana blockchain row + `ChainConfig` for a DeFi write.
 *
 * This is deliberately NOT `resolveChainId` + `context.blockchains.find(b =>
 * b.chainId === chainId)` — that pair is EVM-only machinery (`resolveChainId`
 * requires a positive integer; Solana rows carry `chainId: null`, so no
 * numeric match can ever succeed for them). This was the real, structural
 * reason a Solana `defi_deposit`/`defi_withdraw` never reached ANY of this
 * file's logic in any prior session, independent of the `unsigned call kind
 * "solana-ix"` gates further down — those gates were unreachable dead code
 * on top of an already-unreachable chain lookup. Mirrors the SAME
 * namespace + `isTestnet` lookup `services/agent-executors/wallet/
 * solana.ts`'s `getActiveSolanaChain`/`resolveSolanaNativeMeta` already use
 * for the working `send_sol`/`get_wallet_spl_tokens` tools, rather than
 * inventing a second convention.
 *
 * The safety pipeline's `chainId: number | string` field takes the
 * resulting `cluster` string ("mainnet-beta" / "devnet") for Solana
 * targets — matching `DefiOpportunity.chainId`'s own documented union
 * ("EVM number or Solana cluster string").
 */
function resolveSolanaChain(context: { blockchains: TBlockchain[] }): {
  chainConfig: Extract<ChainConfig, { namespace: "solana" }>;
  chainId: string;
} {
  const isTestnetWanted = false; // agent-driven writes only ever target mainnet
  const blockchain = context.blockchains.find(
    (b) =>
      resolveNamespace(b) === "solana" &&
      b.isActive &&
      (b.isTestnet ?? false) === isTestnetWanted,
  );
  if (!blockchain) {
    throw new DefiError(
      "unsupported_chain",
      "no active Solana mainnet blockchain row in context",
    );
  }
  const chainConfig = buildChainConfigFromBlockchain(blockchain);
  if (chainConfig.namespace !== "solana") {
    throw new DefiError(
      "unsupported_chain",
      "solana blockchain row resolved to a non-solana chain config",
    );
  }
  return { chainConfig, chainId: chainConfig.cluster };
}

/**
 * Sign and submit a `solana-ix` `UnsignedCall` — the missing half of the
 * Solana DeFi write path (see this file's header note). Reuses
 * `SolanaWalletKit.sendAnchorInstruction`, the SAME generic
 * sign-arbitrary-instructions primitive already used by the TakumiPay
 * on-chain settlement rail (`wallet/solanaTakumiPay.ts`'s
 * `executeBookingSol`/`depositPointsSol`) — not a new signing path.
 * Presence-checked (optional capability, chain-extension discipline): if a
 * future Solana wallet-kit build ever omits it, this fails closed with a
 * curated reason rather than silently no-op'ing.
 */
async function submitSolanaCall(
  wallet: TWallet,
  chainConfig: ChainConfig,
  call: Extract<UnsignedCall, { kind: "solana-ix" }>,
): Promise<string> {
  const kit = walletKitRegistry.get("solana");
  if (!kit || typeof kit.sendAnchorInstruction !== "function") {
    throw new DefiError(
      "wallet_cannot_execute",
      "solana wallet kit does not expose sendAnchorInstruction",
    );
  }
  return kit.sendAnchorInstruction({
    wallet,
    chain: chainConfig,
    instructions: call.instructions,
    additionalSigners: call.additionalSigners,
  });
}

/**
 * How long to wait for a receipt before giving up on verifying settlement.
 *
 * Short on purpose: this runs inside an agent tool call, and the point is to
 * catch the common case (an L2 deposit confirms in a couple of seconds), not
 * to hold the turn open until an L1 block arrives. A timeout is reported as
 * UNVERIFIED, which is what it is, and never as a failure.
 */
const POSTEXEC_RECEIPT_TIMEOUT_MS = 15_000;

/**
 * Bounded wait for a just-broadcast transaction's receipt, so the postexec
 * stage has real state to verify against and `tx_confirmed` stops being
 * hardcoded `false` on a deposit that has already settled.
 *
 * `null` means the receipt did not arrive inside the window. That is NOT a
 * failure: the transaction is very likely still in flight, and the caller
 * reports exactly what it did before this existed.
 */
async function awaitReceiptForVerification(
  publicClient: PublicClient,
  hash: `0x${string}`,
): Promise<{
  receipt: TransactionReceipt;
  success: boolean;
  confirmations: number;
} | null> {
  let receipt: TransactionReceipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: POSTEXEC_RECEIPT_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  // The receipt itself is one confirmation; anything deeper needs the head,
  // and a head read that fails must not inflate or invent a depth.
  let confirmations = 1;
  try {
    const head = await publicClient.getBlockNumber();
    if (head > receipt.blockNumber) {
      confirmations = Number(head - receipt.blockNumber) + 1;
    }
  } catch {
    // Keep the floor of 1 — `FinalityCheck` treats "not deep enough yet" as
    // a PENDING state, which is the correct reading of an unknown head.
  }
  return { receipt, success: receipt.status === "success", confirmations };
}

/**
 * Fold a post-execution verdict into the fields a tool result carries.
 *
 * `mismatch` is a reconciliation alert, never an error: the transaction
 * landed. The user gets one hand-written line; the check id and code go to
 * the audit trail and the dev log only (CLAUDE.md).
 */
function postExecResultFields(
  verdict: PostExecVerdict,
  label: string,
): { position_verified: boolean | null; note?: string } {
  if (verdict.status === "verified") return { position_verified: true };
  if (verdict.status === "unverified") {
    if (__DEV__) {
      console.warn(`[${label}] settlement unverified`, {
        reason: verdict.reason,
        ran: verdict.ran,
      });
    }
    return { position_verified: null };
  }
  if (__DEV__) {
    console.error(`[${label}] POSITION DID NOT MOVE after a successful tx`, {
      fail: verdict.fail,
      detail: verdict.detail,
      ran: verdict.ran,
    });
  }
  return { position_verified: false, note: POSTEXEC_UNCONFIRMED_NOTE };
}

/**
 * Resolve user strategy + opportunity in parallel and apply the spec
 * §15 guards. Returns the validated opportunity for downstream code.
 */
export async function resolveAndGuard({
  protocolSlug,
  poolId,
  expectedApy,
  expectedTier,
}: {
  protocolSlug: string;
  /**
   * When present, guards + the returned `depositTarget` are read from the
   * EXACT DeFiLlama pool (spec §6/§8: "APY-drift already per-row — fetch by
   * poolId, not slug"). Falls back to the protocol-slug row otherwise.
   */
  poolId?: string;
  expectedApy?: number;
  expectedTier?: TierKey;
}): Promise<{
  opportunity: TOpportunity | null;
  strategy: TUserStrategy | null;
}> {
  const opportunityFetch = poolId
    ? strategiesApi.getPool(poolId).catch(() => null)
    : strategiesApi.getOpportunity(protocolSlug).catch(() => null);
  const [strategyResult, opportunityResult] = await Promise.allSettled([
    strategiesApi.getStrategy(),
    opportunityFetch,
  ]);

  const strategy =
    strategyResult.status === "fulfilled" ? strategyResult.value : null;
  const opportunity =
    opportunityResult.status === "fulfilled" ? opportunityResult.value : null;

  if (__DEV__) {
    if (strategyResult.status === "rejected") {
      console.warn("[defi/guard] getStrategy rejected", strategyResult.reason);
    }
    if (opportunityResult.status === "rejected") {
      console.warn(
        "[defi/guard] getOpportunity rejected",
        opportunityResult.reason,
      );
    }
    console.warn("[defi/guard] resolved", {
      protocolSlug,
      hasStrategy: !!strategy,
      strategyTier: strategy?.tier,
      strategyPaused: !!strategy?.pausedAt,
      allowAllInTier: !!strategy?.allowAllInTier,
      whitelistLen: strategy?.protocolWhitelist?.length ?? 0,
      hasOpportunity: !!opportunity,
      opportunityTier: opportunity?.tier,
      opportunityApy: opportunity?.apy,
      expectedApy,
      expectedTier,
    });
  }

  // Strategy-paused kill-switch.
  if (strategy?.pausedAt) {
    if (__DEV__) {
      console.warn("[defi/guard] REJECT strategy_paused", {
        pausedAt: strategy.pausedAt,
      });
    }
    throw new DefiError("strategy_paused");
  }

  if (opportunity) {
    // Tier ceiling — opportunity.tier ≤ user.tier.
    if (strategy) {
      const userTier = toTierKey(strategy.tier);
      const oppTier = toTierKey(opportunity.tier);
      if (TIER_RANK[oppTier] > TIER_RANK[userTier]) {
        if (__DEV__) {
          console.warn("[defi/guard] REJECT tier_exceeds_user_policy", {
            userTier,
            oppTier,
            userTierRank: TIER_RANK[userTier],
            oppTierRank: TIER_RANK[oppTier],
          });
        }
        throw new DefiError(
          "tier_exceeds_user_policy",
          `opportunity tier ${oppTier} exceeds user tier ${userTier}`,
        );
      }

      // Whitelist enforcement.
      const list = strategy.protocolWhitelist ?? [];
      const allowAll = !!strategy.allowAllInTier;
      if (!allowAll && list.length > 0 && !list.includes(protocolSlug)) {
        if (__DEV__) {
          console.warn("[defi/guard] REJECT protocol_not_in_whitelist", {
            protocolSlug,
            allowAll,
            whitelist: list,
          });
        }
        throw new DefiError("protocol_not_in_whitelist", protocolSlug);
      }
    }

    // APY drift — compare expected_apy against backend cache (±5%).
    if (typeof expectedApy === "number" && Number.isFinite(expectedApy)) {
      const cached = parseFloat(opportunity.apy);
      if (Number.isFinite(cached) && cached > 0) {
        const driftPct = Math.abs((cached - expectedApy) / cached) * 100;
        if (driftPct > APY_DRIFT_TOLERANCE_PCT) {
          if (__DEV__) {
            console.warn("[defi/guard] REJECT apy_drift_too_high", {
              expectedApy,
              cachedApy: cached,
              driftPct,
              tolerancePct: APY_DRIFT_TOLERANCE_PCT,
            });
          }
          throw new DefiError(
            "apy_drift_too_high",
            `expected ${expectedApy}% vs cached ${cached}%`,
          );
        }
      }
    }

    // Optional sanity: expected_tier matches cached tier.
    if (expectedTier && expectedTier !== toTierKey(opportunity.tier)) {
      // Soft — pass through but log in dev. The tier-ceiling check
      // above is the binding rule.
      if (__DEV__) {
        console.warn(
          `[defi/guard] SOFT expected_tier mismatch: expected=${expectedTier} cached=${opportunity.tier}`,
        );
      }
    }
  } else if (__DEV__) {
    console.warn(
      "[defi/guard] no cached opportunity row — APY/tier guards skipped",
      { protocolSlug },
    );
  }

  return { opportunity, strategy };
}

/**
 * `defi_deposit` — execute a single-step deposit into a DeFi protocol.
 */
export const deposit: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    try {
      // Reject any LLM-supplied address BEFORE anything else (spec §8).
      assertNoLlmSuppliedTarget(input);

      // `chainId` resolution is namespace-dependent (see `resolveSolanaChain`'s
      // header) and can't happen until the adapter's namespace is known below
      // — deferred rather than called eagerly here like the EVM-only version
      // used to.
      const protocolSlug = requireString(input, "protocol_slug");
      const assetSymbol = requireString(input, "asset_symbol");
      const amountRaw = requireBigInt(input, "amount_raw");
      const assetContract = input.asset_contract as string | undefined;
      // The exact DeFiLlama pool the user picked (spec §6). Optional →
      // backward compatible: without it we route by slug to the canonical
      // market (legacy behaviour).
      const poolId =
        typeof input.pool_id === "string" && input.pool_id
          ? input.pool_id
          : undefined;
      const expectedApy =
        typeof input.expected_apy === "number" ? input.expected_apy : undefined;
      const expectedTier =
        typeof input.expected_tier === "string"
          ? toTierKey(input.expected_tier)
          : undefined;
      const goal = input.goal as string | undefined;
      const targetDate = input.target_date as string | undefined;

      if (__DEV__) {
        console.warn("[defi/deposit] ENTER", {
          protocolSlug,
          poolId,
          assetSymbol,
          assetContract,
          amountRaw: amountRaw.toString(),
          expectedApy,
          expectedTier,
          goal,
          targetDate,
          walletAddress: context.wallet.address,
        });
      }

      // Guards must run BEFORE we resolve the adapter / clients — they're the
      // cheapest rejections. When `poolId` is present this ALSO re-fetches the
      // authoritative `depositTarget` from the exact pool row server-side
      // (§6): the model never handed us an address.
      const { opportunity, strategy } = await resolveAndGuard({
        protocolSlug,
        poolId,
        expectedApy,
        expectedTier,
      });
      const depositTarget: DepositTarget | undefined =
        opportunity?.depositTarget ?? undefined;

      if (__DEV__) {
        console.warn("[defi/deposit] resolved depositTarget", {
          poolId,
          kind: depositTarget?.kind ?? "none (manual/legacy slug route)",
        });
      }

      // Route by the resolved target's `kind` when present (the generic
      // family adapter — Erc4626/Aave/Scallop), else by slug (canonical
      // market). Never a namespace/slug branch here — the registry owns it.
      const adapter = getDefiAdapterForTarget(protocolSlug, depositTarget);
      if (!adapter) {
        if (__DEV__) {
          console.warn("[defi/deposit] protocol_not_found", {
            protocolSlug,
            registered: listDefiAdapters().map((a) => a.slug),
          });
        }
        throw new DefiError("protocol_not_found", protocolSlug);
      }

      // Sui venues still deposit through their own path (the Sui Intent
      // Engine's defi_intent_preview/execute) — fail closed with a curated
      // reason rather than handing a Sui adapter an EVM chain config. Solana
      // is now wired through this SAME executor (see `resolveSolanaChain` /
      // `submitSolanaCall` above and this file's header note) rather than
      // being refused here.
      if (adapter.namespace !== "eip155" && adapter.namespace !== "solana") {
        if (__DEV__) {
          console.warn("[defi/deposit] non-EVM venue routed to EVM executor", {
            protocolSlug,
            namespace: adapter.namespace,
          });
        }
        throw new DefiError(
          "unsupported_chain",
          `${protocolSlug}: non-EVM venue — deposit via the Sui Intent Engine (defi_intent_preview)`,
        );
      }

      let chainId: number | string;
      let chainConfig: ChainConfig;
      if (adapter.namespace === "solana") {
        const solana = resolveSolanaChain(context);
        chainConfig = solana.chainConfig;
        chainId = solana.chainId;
      } else {
        chainId = resolveChainId(input, context);
        const blockchain = context.blockchains.find(
          (b) => b.chainId === chainId,
        );
        if (!blockchain) {
          if (__DEV__) {
            console.warn(
              "[defi/deposit] unsupported_chain — no blockchain row in context",
              {
                chainId,
                available: context.blockchains.map((b) => b.chainId),
              },
            );
          }
          throw new DefiError("unsupported_chain", `chainId=${chainId}`);
        }
        chainConfig = buildChainConfigFromBlockchain(blockchain);
      }
      const decimals = decimalsForSymbol(assetSymbol);

      // ── Safety pipeline, anchor 1 of 2 (§11.1, §11.4) ──────────────────
      // Layers 0-3 and the identity half of Layer 1 run BEFORE anything is
      // built: input provenance, target identity, policy, economics. This is
      // the cheap half, and a failure here means nothing was ever encoded.
      bindSafetyChainResolver(context);
      // What the pipeline holds the built call to. It comes from the
      // SERVER-RESOLVED target, never from `asset_contract`: that field is an
      // optional model-supplied hint the agent omits on almost every call, so
      // anchoring on it left the expected underlying at the zero address and
      // Layer 1 compared a real `asset()`/reserve read against 0x0 — every
      // ERC-20 pool deposit failed `underlying-matches`. The catalogue row is
      // the fallback for kinds that do not name their input asset.
      const underlyingExpected =
        (depositTarget ? targetUnderlying(depositTarget) : null) ??
        opportunity?.assetContract ??
        assetContract ??
        NATIVE_ASSET_SENTINEL;
      const safetyBase: SafetyContext = {
        namespace: adapter.namespace,
        action: "deposit",
        // Absent for a slug-routed legacy deposit, which names a protocol and
        // not a pool. It used to be a fake zero-address `erc4626` target that
        // nothing ever read (the `if (depositTarget)` guards below skipped the
        // whole pipeline), so a slug-routed deposit ran no checks at all — not
        // the ops kill switch, not the per-chain DeFi gate, not the user's own
        // tier/whitelist/pause, none of which needs a target. `SafetyContext`
        // now carries it as optional and the target-dependent checks scope
        // themselves out (`appliesTo.requiresTarget`), so the rest run.
        target: depositTarget,
        chainId,
        wallet: context.wallet.address,
        requestedAmount: amountRaw,
        underlyingExpected,
        previewOut: null,
        tvlUsdSnapshot: opportunity ? Number(opportunity.tvlUsd) : null,
        sim: null,
        feeEstimate: null,
        stage: "presign",
        toolInput: input,
        poolId,
        protocolSlug,
        family: depositTarget?.kind,
        assetDecimals: decimals,
        // §12 Q2a — the lockup the USER was shown and accepted on the approval
        // card, consumed once. Deliberately not a tool argument: a consent the
        // model can emit is the agent approving its own write (§11 Layer 0).
        // `undefined` means nobody was asked, and the Layer-3 check refuses.
        exitDelayAcknowledgedSec: takeExitConsent(poolId),
        expectedApy,
        cachedApy: opportunity ? Number.parseFloat(opportunity.apy) : undefined,
        policy: {
          tier: strategy ? toTierKey(strategy.tier) : undefined,
          protocolWhitelist: strategy?.protocolWhitelist ?? undefined,
          allowAllInTier: !!strategy?.allowAllInTier,
          paused: !!strategy?.pausedAt,
        },
        submissionKey: `${context.wallet.address}:${poolId ?? protocolSlug}:${amountRaw}`,
      };
      // Runs for every deposit now, resolved target or not: the checks that
      // need one declare `requiresTarget` and the runner drops exactly those.
      assertSafetyResult(await runSafetyPipeline(safetyBase));

      // ERC-7540 vaults cannot settle in one transaction: the deposit is a
      // REQUEST that an off-chain fulfilment later makes claimable (§7). Ask
      // the adapter by capability, never by kind — an adapter exposing
      // `buildRequestDeposit` is async, and everything downstream (the result
      // the agent reports, the position phase) follows from that one fact.
      const isAsyncDeposit = typeof adapter.buildRequestDeposit === "function";

      let unsignedCall;
      try {
        const buildArgs = {
          wallet: context.wallet,
          chain: chainConfig,
          asset: { symbol: assetSymbol, contract: assetContract, decimals },
          amount: amountRaw,
          target: depositTarget,
          // Router-calldata families round-trip to the backend proxy by
          // pool id; the tier drives the slippage budget (§12 Q4).
          poolId,
          tier: strategy ? toTierKey(strategy.tier) : undefined,
        };
        unsignedCall = isAsyncDeposit
          ? // biome-ignore lint/style/noNonNullAssertion: guarded by isAsyncDeposit
            await adapter.buildRequestDeposit!(buildArgs)
          : await adapter.buildDeposit(buildArgs);
      } catch (buildErr) {
        if (__DEV__) {
          console.error("[defi/deposit] adapter.buildDeposit threw", {
            protocolSlug,
            assetSymbol,
            assetContract,
            error: buildErr,
          });
        }
        throw buildErr;
      }

      if (__DEV__) {
        console.warn("[defi/deposit] unsignedCall built", {
          kind: unsignedCall.kind,
          to: (unsignedCall as { to?: string }).to,
          dataLen: (unsignedCall as { data?: string }).data?.length,
          value: (unsignedCall as { value?: bigint }).value?.toString(),
          needsApproval: approvalsOf(unsignedCall).map((a) => ({
            token: a.token,
            spender: a.spender,
            amount: a.amount.toString(),
          })),
        });
      }

      if (unsignedCall.kind === "solana-ix") {
        // ── Safety pipeline, anchor 2 of 2 (§11.1, §11 Layer 4) ──────────
        assertSafetyResult(
          await runSafetyPipeline({
            ...safetyBase,
            stage: "submit",
            call: unsignedCall,
          }),
        );
        // No ERC-20-style approval preamble here: every Solana adapter in
        // this file embeds the SPL transfer directly in the deposit
        // instruction itself (`approvalsOf` is a no-op for a `solana-ix`
        // call by construction — see its own definition in
        // `services/defi/types.ts`).
        const preflight = await runSafetyPipeline({
          ...safetyBase,
          stage: "broadcast",
          call: unsignedCall,
        });
        if (!preflight.ok) {
          releaseSubmission(safetyBase.submissionKey ?? "");
        }
        assertSafetyResult(preflight);

        // "before" half of the postexec delta assertion, read as late as
        // possible (same reasoning as the EVM path below).
        const solPositionBefore = await snapshotPositionBefore(safetyBase);

        let signature: string;
        try {
          if (__DEV__) {
            console.warn("[defi/deposit] submitting solana-ix", {
              instructionCount: unsignedCall.instructions.length,
            });
          }
          signature = await submitSolanaCall(
            context.wallet,
            chainConfig,
            unsignedCall,
          );
        } catch (err) {
          // Same phantom-failure posture as `submitEvmCall`: a broadcast
          // error is never assumed to mean nothing happened, so the
          // idempotency key is released for a genuine retry but the error
          // itself still propagates rather than being swallowed.
          releaseSubmission(safetyBase.submissionKey ?? "");
          throw err;
        }
        if (__DEV__) {
          console.warn("[defi/deposit] solana-ix submitted", { signature });
        }

        // Backend-facing numeric chainId — `TStrategyPosition`/`TOpportunity`
        // type this field as a plain `number` (unlike `Blockchain.chainId`,
        // which is `null` for non-EVM rows per its own doc comment); this
        // codebase's own Solana coverage tooling already reports Solana rows
        // as chainId `0` in `OpportunityCache` — reused here rather than
        // inventing a second convention.
        const SOLANA_BACKEND_CHAIN_ID = 0;

        let amountAtDepositUsd = 0;
        try {
          const [price] = await strategiesApi.getAssetPrices([
            { chainId: SOLANA_BACKEND_CHAIN_ID, assetSymbol, assetContract },
          ]);
          const humanAmount = parseFloat(formatUnits(amountRaw, decimals));
          const computed = humanAmount * (price?.usd ?? 0);
          amountAtDepositUsd = Number.isFinite(computed) ? computed : 0;
        } catch (priceErr) {
          if (__DEV__) {
            console.warn(
              "[defi/deposit] asset price fetch failed (best-effort)",
              { assetSymbol, error: priceErr },
            );
          }
        }

        try {
          await strategiesApi.createPosition({
            protocolSlug,
            chainId: SOLANA_BACKEND_CHAIN_ID,
            namespace: adapter.namespace,
            assetSymbol,
            assetContract,
            poolId,
            amountAtDeposit: amountRaw.toString(),
            amountAtDepositUsd,
            openTxHash: signature,
            goal,
            targetDate,
            ...(isAsyncDeposit
              ? {
                  asyncPhase: "deposit_requested" as const,
                  asyncRequestedRaw: amountRaw.toString(),
                }
              : {}),
          });
        } catch (err) {
          if (__DEV__) {
            console.error("[defi/deposit] createPosition api failed", {
              protocolSlug,
              signature,
              error: err,
            });
          }
        }

        track("defi_deposit_completed", {
          chain: toChainTag(adapter.namespace),
          protocol_slug: protocolSlug,
          chain_id: SOLANA_BACKEND_CHAIN_ID,
          asset_symbol: assetSymbol,
          amount: parseFloat(formatUnits(amountRaw, decimals)),
          amount_usd: amountAtDepositUsd,
        });

        // Post-execution verification (§11 Layer 5). No `confirmations`: the
        // Solana wallet kit polls `getSignatureStatuses` and returns the
        // signature either way, so a confirmed submission and a poll that
        // timed out are indistinguishable from here. Claiming a depth we did
        // not observe would be worse than omitting it, and Solana declares no
        // `finalityDepth`, so `FinalityCheck` stays quiet regardless.
        const solVerdict = isAsyncDeposit
          ? ({ status: "unverified", ran: [] } as PostExecVerdict)
          : await verifyPostExecution(safetyBase, {
              positionBefore: solPositionBefore,
            });
        const solVerification = postExecResultFields(
          solVerdict,
          "defi/deposit",
        );

        return {
          status: "success" as const,
          tx_confirmed: !isAsyncDeposit,
          data: {
            protocol_slug: protocolSlug,
            chain_id: chainId,
            amount_raw: amountRaw.toString(),
            signature,
            ...(isAsyncDeposit
              ? {
                  settlement: "pending" as const,
                  async_phase: "deposit_requested" as const,
                  note: "Deposit requested. This pool settles off-chain, so the position becomes claimable once the protocol fulfils the request. We'll notify you when it's ready to claim.",
                }
              : solVerification),
          },
        };
      }

      if (unsignedCall.kind !== "evm-call") {
        // Sui submission goes through its own path (the Sui Intent Engine).
        if (__DEV__) {
          console.warn(
            "[defi/deposit] unsupported_chain — non-EVM unsigned call",
            { kind: unsignedCall.kind },
          );
        }
        throw new DefiError(
          "unsupported_chain",
          `unsigned call kind "${unsignedCall.kind}" not yet supported by the EVM executor pipeline`,
        );
      }

      // `chainId` is guaranteed numeric here: the solana-ix branch above
      // always returns, and Sui non-evm-call kinds already threw, so
      // reaching this point means `unsignedCall.kind === "evm-call"` and
      // `chainId` came from the `resolveChainId` (EVM) branch above.
      const { walletClient, publicClient } = resolveChainClients(
        chainId as number,
        context,
      );
      if (!walletClient || !walletClient.account) {
        if (__DEV__) {
          console.warn("[defi/deposit] wallet_cannot_execute", {
            hasWalletClient: !!walletClient,
            hasAccount: !!walletClient?.account,
            chainId,
          });
        }
        throw new DefiError("wallet_cannot_execute");
      }

      // ── Safety pipeline, anchor 2 of 2 (§11.1, §11 Layer 4) ────────────
      // The on-device anchor. These checks read the call that is ABOUT TO BE
      // SIGNED — chain binding, decoded-intent match, approval scoping, quote
      // freshness, simulate, idempotency. A compromised backend cannot argue
      // its way past them, because they do not consult it.
      assertSafetyResult(
        await runSafetyPipeline({
          ...safetyBase,
          stage: "submit",
          call: unsignedCall,
        }),
      );

      // 1. Approval preamble. A two-sided LP add needs BOTH tokens approved in
      //    the same build, so iterate the normalised list rather than the
      //    single field — one dropped approve makes the deposit revert.
      for (const approval of approvalsOf(unsignedCall)) {
        try {
          if (__DEV__) {
            console.warn("[defi/deposit] reading allowance", {
              token: approval.token,
              owner: walletClient.account.address,
              spender: approval.spender,
            });
          }
          const allowance = await publicClient.readContract({
            address: approval.token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [walletClient.account.address as Address, approval.spender],
          });
          if (__DEV__) {
            console.warn("[defi/deposit] allowance read OK", {
              allowance: allowance.toString(),
              required: approval.amount.toString(),
              sufficient: allowance >= approval.amount,
            });
          }
          if (allowance < approval.amount) {
            if (__DEV__) {
              console.warn("[defi/deposit] submitting approve tx", {
                token: approval.token,
                spender: approval.spender,
                amount: approval.amount.toString(),
              });
            }
            const approveHash = await walletClient.writeContract({
              address: approval.token,
              abi: erc20Abi,
              functionName: "approve",
              args: [approval.spender, approval.amount],
              account: walletClient.account,
              chain: walletClient.chain,
            });
            if (__DEV__) {
              console.warn("[defi/deposit] approve tx submitted", {
                approveHash,
              });
            }
            await publicClient.waitForTransactionReceipt({ hash: approveHash });
            if (__DEV__) {
              console.warn("[defi/deposit] approve tx confirmed", {
                approveHash,
              });
            }
          }
        } catch (err) {
          if (__DEV__) {
            console.error("[defi/deposit] approval_failed", {
              token: approval.token,
              spender: approval.spender,
              required: approval.amount.toString(),
              error: err,
            });
          }
          throw new DefiError("approval_failed");
        }
      }

      // ── Safety pipeline, the last word before broadcast ─────────────────
      // The dry-run belongs HERE, not with the rest of Layer 4: the approvals
      // above are separate transactions, so until they are mined the deposit
      // has no allowance and a simulation of it can only ever revert. Anything
      // it reports now is about the deposit itself.
      const preflight = await runSafetyPipeline({
        ...safetyBase,
        stage: "broadcast",
        call: unsignedCall,
      });
      if (!preflight.ok) {
        // Nothing was broadcast, so the idempotency key claimed at submit
        // must not outlive the attempt — a genuine retry is not a duplicate.
        releaseSubmission(safetyBase.submissionKey ?? "");
      }
      assertSafetyResult(preflight);

      // The "before" half of the post-execution delta assertion (§11 Layer
      // 5). Read HERE, as late as possible: every second between this and the
      // "after" reading is a window in which something else could move the
      // position and get credited to this deposit.
      const positionBefore = await snapshotPositionBefore(safetyBase);

      // 2. Submit the protocol call (phantom-failure-safe — see
      //    submitTx.ts). A broadcast error is never silently treated as
      //    "didn't happen": funds could have moved.
      if (__DEV__) {
        console.warn("[defi/deposit] submitting protocol tx", {
          to: unsignedCall.to,
          dataLen: unsignedCall.data?.length,
          value: (unsignedCall.value ?? 0n).toString(),
          account: walletClient.account.address,
          chainId: walletClient.chain?.id,
        });
      }
      const submit = await submitEvmCall(walletClient, publicClient, {
        to: unsignedCall.to,
        data: unsignedCall.data,
        value: unsignedCall.value ?? 0n,
      });

      if (submit.kind === "not_broadcast") {
        if (__DEV__) {
          console.warn("[defi/deposit] not broadcast — no deposit made", {
            to: unsignedCall.to,
          });
        }
        // Definitely nothing happened, so free the idempotency key: a genuine
        // retry should not be told it is a duplicate of a deposit that never
        // existed. An UNCONFIRMED submission keeps its key, because there the
        // whole risk is that it DID land.
        releaseSubmission(safetyBase.submissionKey ?? "");
        throw new DefiError("deposit_failed");
      }
      if (submit.kind === "mined" && !submit.success) {
        if (__DEV__) {
          console.warn("[defi/deposit] reverted on-chain", {
            hash: submit.hash,
          });
        }
        releaseSubmission(safetyBase.submissionKey ?? "");
        throw new DefiError("deposit_failed");
      }
      if (submit.kind === "unconfirmed") {
        // May have landed — don't record a position we can't verify, and
        // don't claim success. Surface the hash for reconciliation.
        if (__DEV__) {
          console.warn("[defi/deposit] submission_unconfirmed", {
            hash: submit.hash,
          });
        }
        return {
          status: "failed" as const,
          tx_hash: submit.hash,
          error: "submission_unconfirmed",
          data: {
            protocol_slug: protocolSlug,
            chain_id: chainId,
            amount_raw: amountRaw.toString(),
          },
        };
      }

      const hash = submit.hash;
      if (__DEV__) {
        console.warn("[defi/deposit] protocol tx submitted", { hash });
      }

      // 2a. Bounded wait for the receipt. Three things need it: the
      // post-execution position assertion below, an honest `tx_confirmed`,
      // and the ERC-7540 `requestId` decode (which used to call
      // `getTransactionReceipt` the instant after broadcast — before the
      // transaction could possibly be mined — and swallow the resulting
      // not-found error, so the id was effectively never read).
      const settled = await awaitReceiptForVerification(publicClient, hash);

      // A `submitted` outcome means the node ACCEPTED the broadcast, not that
      // the transaction succeeded; until the receipt existed there was no way
      // to tell a landed deposit from one that reverted, and a revert was
      // reported to the user as a success with a hash. Same handling as the
      // `mined && !success` branch above, which is the identical situation
      // reached by a different route.
      if (settled && !settled.success) {
        if (__DEV__) {
          console.warn("[defi/deposit] reverted on-chain (post-broadcast)", {
            hash,
          });
        }
        releaseSubmission(safetyBase.submissionKey ?? "");
        throw new DefiError("deposit_failed");
      }

      // 2b. ERC-7540 `requestId`, read from the request tx's own emitted
      // event rather than simulated or guessed. `requestDeposit`/
      // `requestRedeem` RETURN the id, but a signed-and-broadcast
      // transaction has no return value to read — only logs. The standard
      // event carries it as an indexed topic (`DepositRequest(controller,
      // owner, requestId, sender, assets)` / `RedeemRequest` mirrors it), so
      // this decodes the receipt rather than defaulting to the spec's
      // 0-partition convention, which would silently mis-track any vault
      // that DOES partition requests.
      let asyncRequestId: string | undefined;
      if (isAsyncDeposit && settled) {
        try {
          const receipt = settled.receipt;
          const eventAbi = parseAbi([
            "event DepositRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 assets)",
            "event RedeemRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares)",
          ]);
          for (const log of receipt.logs) {
            try {
              const decoded = decodeEventLog({
                abi: eventAbi,
                data: log.data,
                topics: log.topics,
              });
              if (
                decoded.eventName === "DepositRequest" ||
                decoded.eventName === "RedeemRequest"
              ) {
                asyncRequestId = decoded.args.requestId.toString();
                break;
              }
            } catch {
              // Not this event — the receipt has other logs too (Transfer,
              // Approval, …); keep scanning.
            }
          }
        } catch (err) {
          if (__DEV__) {
            console.warn(
              "[defi/deposit] could not read requestId from receipt — " +
                "position will still be tracked with requestId undefined; " +
                "the claim path falls back to ERC-7540's request-id-0 default " +
                "(most vaults, including Centrifuge, don't partition requests)",
              { hash, error: err },
            );
          }
        }
        if (__DEV__) {
          console.warn("[defi/deposit] async requestId", { asyncRequestId });
        }
      }

      // 3. USD value snapshot for `StrategyPosition.amountAtDepositUsd`.
      //
      // Previously called `exchangeRateApi.getLatestExchangeRate({...,
      // toCurrency: "USD"})`, but that table only ever holds crypto->IDR/SGD
      // payout rates for the QRIS/PPOB rails (seeded by
      // api/src/scripts/prisma/seed.ts) — there is no `toCurrency: "USD"`
      // row for any asset, so that call was a guaranteed `null` and this
      // snapshot was always 0. `strategiesApi.getAssetPrices` proxies
      // Alchemy's Prices API instead, which actually has a USD quote.
      let amountAtDepositUsd = 0;
      try {
        const [price] = await strategiesApi.getAssetPrices([
          { chainId: chainId as number, assetSymbol, assetContract },
        ]);
        const humanAmount = parseFloat(formatUnits(amountRaw, decimals));
        const computed = humanAmount * (price?.usd ?? 0);
        amountAtDepositUsd = Number.isFinite(computed) ? computed : 0;
      } catch (priceErr) {
        if (__DEV__) {
          console.warn(
            "[defi/deposit] asset price fetch failed (best-effort)",
            {
              assetSymbol,
              error: priceErr,
            },
          );
        }
      }

      // 4. Record the position on the backend.
      try {
        await strategiesApi.createPosition({
          protocolSlug,
          chainId: chainId as number,
          namespace: adapter.namespace,
          assetSymbol,
          assetContract,
          poolId,
          amountAtDeposit: amountRaw.toString(),
          amountAtDepositUsd,
          openTxHash: hash,
          goal,
          targetDate,
          // §7 requirement 2 — this is what makes the request DURABLE. Set
          // from `isAsyncDeposit` (capability-detected above), never from
          // anything the model could assert: a normal sync deposit must
          // never carry an asyncPhase, or the claim-watcher would park a
          // settled position waiting for a settlement that already happened.
          ...(isAsyncDeposit
            ? {
                asyncPhase: "deposit_requested" as const,
                asyncRequestId,
                asyncRequestedRaw: amountRaw.toString(),
              }
            : {}),
        });
        if (__DEV__) {
          console.warn("[defi/deposit] position row created", {
            hash,
            protocolSlug,
            chainId,
          });
        }
      } catch (err) {
        if (__DEV__) {
          console.error("[defi/deposit] createPosition api failed", {
            protocolSlug,
            chainId,
            hash,
            error: err,
          });
        }
      }

      track("defi_deposit_completed", {
        chain: toChainTag(adapter.namespace),
        protocol_slug: protocolSlug,
        chain_id: chainId,
        asset_symbol: assetSymbol,
        amount: parseFloat(formatUnits(amountRaw, decimals)),
        amount_usd: amountAtDepositUsd,
      });

      // ── Safety pipeline, stage 4 of 4: after the receipt (§11 Layer 5) ──
      // "The transaction succeeded" and "the user got what they paid for"
      // are different claims, and only this one checks the second. It cannot
      // block anything and never throws: the money has already moved, so the
      // verdict is reported, not enforced. An ASYNC deposit is skipped
      // outright, because a 7540 request is not supposed to move the position
      // yet and asserting that it did would flag every correct one.
      const depositVerdict = isAsyncDeposit
        ? ({ status: "unverified", ran: [] } as PostExecVerdict)
        : await verifyPostExecution(safetyBase, {
            positionBefore,
            confirmations: settled?.confirmations,
          });
      const depositVerification = postExecResultFields(
        depositVerdict,
        "defi/deposit",
      );

      // §7 requirement 3 — an async deposit is a REQUEST, not a completed
      // deposit. Reporting "done" here is what would let the agent tell the
      // user their money is earning when it is actually sitting in a queue.
      return {
        status: "success" as const,
        tx_hash: hash,
        // Read from the receipt now rather than hardcoded `false`. An async
        // deposit is never "confirmed" in the sense the agent uses the word:
        // the request landed, the position has not.
        tx_confirmed: !isAsyncDeposit && settled !== null,
        data: {
          protocol_slug: protocolSlug,
          chain_id: chainId,
          amount_raw: amountRaw.toString(),
          ...(isAsyncDeposit
            ? {
                settlement: "pending" as const,
                async_phase: "deposit_requested" as const,
                note: "Deposit requested. This pool settles off-chain, so the position becomes claimable once the protocol fulfils the request. We'll notify you when it's ready to claim.",
              }
            : depositVerification),
        },
      };
    } catch (err) {
      const code = classifyDefiError(err);
      if (__DEV__) {
        console.warn("[defi/deposit] EXIT failed", { code, error: err });
      }
      throw new ExecutorError(toExecutorErrorCode(code), code);
    }
  });

/**
 * `defi_withdraw` — withdraw from a position. Accepts `amount_raw =
 * "MAX"` for full exit.
 */
export const withdraw: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    try {
      const positionId = requireString(input, "position_id");
      const amountRawInput = input.amount_raw;
      const amountRaw: bigint | "MAX" =
        amountRawInput === "MAX" ? "MAX" : requireBigInt(input, "amount_raw");

      if (__DEV__) {
        console.warn("[defi/withdraw] ENTER", {
          positionId,
          amountRaw:
            typeof amountRaw === "string" ? amountRaw : amountRaw.toString(),
          walletAddress: context.wallet.address,
        });
      }

      const position = await strategiesApi
        .getPosition(positionId)
        .catch((err) => {
          if (__DEV__) {
            console.warn("[defi/withdraw] getPosition rejected", {
              positionId,
              error: err,
            });
          }
          return null;
        });
      if (!position) {
        if (__DEV__) {
          console.warn("[defi/withdraw] position_not_found", { positionId });
        }
        throw new DefiError("position_not_found", positionId);
      }

      const { protocolSlug, chainId, assetSymbol, assetContract, namespace } =
        position;

      // Pool-level positions (spec §4.2, §7): re-fetch the authoritative
      // depositTarget by the pinned poolId so the withdraw routes to the SAME
      // vault the deposit used (the generic family adapter), not the protocol's
      // canonical market. Legacy positions (no poolId) route by slug as before.
      let withdrawTarget: DepositTarget | undefined;
      let withdrawOpportunity: TOpportunity | null = null;
      if (position.poolId) {
        withdrawOpportunity = await strategiesApi
          .getPool(position.poolId)
          .catch(() => null);
        withdrawTarget = withdrawOpportunity?.depositTarget ?? undefined;
      }

      if (__DEV__) {
        console.warn("[defi/withdraw] position resolved", {
          positionId,
          protocolSlug,
          poolId: position.poolId,
          targetKind: withdrawTarget?.kind ?? "none (slug route)",
          chainId,
          assetSymbol,
          assetContract,
          namespace,
          status: position.status,
        });
      }

      const adapter = getDefiAdapterForTarget(protocolSlug, withdrawTarget);
      if (!adapter) {
        if (__DEV__) {
          console.warn("[defi/withdraw] protocol_not_found", {
            protocolSlug,
            registered: listDefiAdapters().map((a) => a.slug),
          });
        }
        throw new DefiError("protocol_not_found", protocolSlug);
      }

      // Strategy-paused still allows withdraw (kill-switch lets users exit) —
      // the strategy is read only for the tier that sets the slippage budget
      // on LP/router exits (§12 Q4), never to gate the exit itself.
      const strategy = await strategiesApi.getStrategy().catch(() => null);

      // Solana positions carry the SAME numeric sentinel `chainId` deposit
      // just started writing (see `deposit`'s `SOLANA_BACKEND_CHAIN_ID`
      // note) — it does not identify a row in `Blockchain` (whose `chainId`
      // is `null` for non-EVM networks), so the lookup for a Solana adapter
      // has to go by namespace instead, same as `deposit`'s own fix.
      let chainConfig: ChainConfig;
      // The safety pipeline's `chainId` (used for the Solana provider's own
      // chain-resolver lookup, `bindSafetyChainResolver`'s doc comment) is
      // the CLUSTER string for Solana, distinct from `chainId` above (the
      // numeric backend sentinel `position.chainId` carries).
      let pipelineChainId: number | string = chainId;
      if (adapter.namespace === "solana") {
        const solana = resolveSolanaChain(context);
        chainConfig = solana.chainConfig;
        pipelineChainId = solana.chainId;
      } else {
        const blockchain = context.blockchains.find(
          (b) => b.chainId === chainId,
        );
        if (!blockchain) {
          if (__DEV__) {
            console.warn(
              "[defi/withdraw] unsupported_chain — no blockchain row in context",
              {
                chainId,
                available: context.blockchains.map((b) => b.chainId),
              },
            );
          }
          throw new DefiError("unsupported_chain", `chainId=${chainId}`);
        }
        chainConfig = buildChainConfigFromBlockchain(blockchain);
      }
      const decimals = decimalsForSymbol(assetSymbol);

      // ── Safety pipeline (§11) — same runner deposit uses, action-scoped.
      // `SafetyAction` is how a check like the tier/whitelist/exposure/
      // velocity policy trio or the pool-anomaly circuit-breaker declares
      // itself deposit-only: applying a ceiling-on-new-capital check to an
      // EXIT would trap a user's funds in exactly the protocol they are
      // trying to leave. Identity (Layer 1) and execution-integrity
      // (Layer 4) checks are NOT scoped away — a withdraw call still needs
      // to be signing a real, allowlisted target and pay out to the
      // caller's own wallet.
      bindSafetyChainResolver(context);
      const withdrawUnderlyingExpected =
        (withdrawTarget ? targetUnderlying(withdrawTarget) : null) ??
        withdrawOpportunity?.assetContract ??
        assetContract ??
        NATIVE_ASSET_SENTINEL;
      const withdrawSafetyBase: SafetyContext = {
        namespace: adapter.namespace,
        action: "withdraw",
        // Absent for a legacy slug-routed position, same as deposit above:
        // optional on the context, with the target-dependent checks scoping
        // themselves out rather than the whole pipeline being skipped.
        target: withdrawTarget,
        chainId: pipelineChainId,
        wallet: context.wallet.address,
        requestedAmount: amountRaw,
        underlyingExpected: withdrawUnderlyingExpected,
        previewOut: null,
        tvlUsdSnapshot: null,
        sim: null,
        feeEstimate: null,
        stage: "presign",
        toolInput: input,
        poolId: position.poolId ?? undefined,
        protocolSlug,
        family: withdrawTarget?.kind,
        assetDecimals: decimals,
        assetSymbol,
        submissionKey: `withdraw:${context.wallet.address}:${position.poolId ?? protocolSlug}:${
          typeof amountRaw === "string" ? amountRaw : amountRaw.toString()
        }`,
      };
      assertSafetyResult(await runSafetyPipeline(withdrawSafetyBase));

      // Pre-flight the on-chain balance. A MAX withdraw against a
      // position with no live balance (stale DB row, deposit that never
      // settled on-chain, wrong address) reverts with an opaque error.
      // Read the live position first so we can fail with a clear,
      // typed reason instead of submitting a doomed transaction. Only a
      // positively-confirmed zero balance blocks — a read failure is
      // non-fatal and falls through to the normal path. The balance is
      // also handed to the safety pipeline below (`WithdrawBalanceCheck`)
      // so a non-MAX over-request fails the same way, pre-signing.
      //
      // NOTE ON ORDER: this MUST stay above `buildWithdraw`. It used to sit
      // ~80 lines BELOW it, so "read the live position first" was not what the
      // code did, and the guard was unreachable for any adapter that refuses
      // an empty position while BUILDING — `erc4626` throws
      // `position_not_found` ("no shares") there, so a drained 4626 vault
      // reported a missing position rather than an empty one, which is a
      // different recovery class and is not even true. `compound-v3` reached
      // the guard only because Comet's builder does not throw, which is why
      // one situation produced two error codes depending on the family. Found
      // by the Gate-4 fork case, 2026-08-22. Takes the address from
      // `context.wallet` rather than the wallet client, so it needs nothing
      // resolved downstream.
      let liveBalance: bigint | undefined;
      try {
        const live = await readPosition({
          protocolSlug,
          chainId: pipelineChainId,
          walletAddress: context.wallet.address,
          assetSymbol,
          assetContract: assetContract ?? undefined,
          // Kind-routed EVM adapters have no fixed deployment, so they need
          // the pool target AND a chain to read against.
          poolId: position.poolId ?? undefined,
          chain: chainConfig,
        });
        if (live && live.currentAmount <= 0n) {
          if (__DEV__) {
            console.warn("[defi/withdraw] no_onchain_balance — preflight", {
              positionId,
              protocolSlug,
              chainId,
            });
          }
          throw new DefiError("no_onchain_balance", positionId);
        }
        liveBalance = live?.currentAmount;
      } catch (preflightErr) {
        if (preflightErr instanceof DefiError) throw preflightErr;
        if (__DEV__) {
          console.warn(
            "[defi/withdraw] balance preflight read failed (non-fatal)",
            { positionId, error: preflightErr },
          );
        }
      }

      // ERC-7540-style exit (§7): a redeem is a REQUEST an off-chain
      // fulfilment later makes claimable, exactly the same "ask by
      // capability, never by kind" rule `deposit`'s `isAsyncDeposit` already
      // follows. This branch did not exist before 2026-08-27 — `withdraw`
      // unconditionally called `adapter.buildWithdraw`, which is why every
      // adapter that implements ONLY `buildRequestRedeem`/`buildClaimRedeem`
      // (Kyros's `jito-vault-deposit`, and — already registered and live —
      // Centrifuge's `AsyncVaultAdapter`, "7540-both" flavor) had a withdraw
      // that was guaranteed to fail: `AsyncVaultAdapter.buildWithdraw`
      // deliberately throws `"async-vault: use buildRequestRedeem /
      // buildClaimRedeem"` (its own header comment says so), so every real
      // Centrifuge withdraw attempt hit that throw. Fixing this for Solana
      // fixes that pre-existing EVM bug too, not just Kyros.
      const isAsyncWithdraw = typeof adapter.buildRequestRedeem === "function";

      let unsignedCall;
      try {
        const withdrawBuildArgs = {
          wallet: context.wallet,
          chain: chainConfig,
          asset: {
            symbol: assetSymbol,
            contract: assetContract ?? undefined,
            decimals,
          },
          amount: amountRaw,
          target: withdrawTarget,
          poolId: position.poolId ?? undefined,
          tier: strategy ? toTierKey(strategy.tier) : undefined,
        };
        unsignedCall = isAsyncWithdraw
          ? // biome-ignore lint/style/noNonNullAssertion: guarded by isAsyncWithdraw
            await adapter.buildRequestRedeem!(withdrawBuildArgs)
          : await adapter.buildWithdraw(withdrawBuildArgs);
      } catch (buildErr) {
        if (__DEV__) {
          console.error("[defi/withdraw] adapter.buildWithdraw threw", {
            protocolSlug,
            assetSymbol,
            error: buildErr,
          });
        }
        throw buildErr;
      }

      if (__DEV__) {
        console.warn("[defi/withdraw] unsignedCall built", {
          kind: unsignedCall.kind,
          to: (unsignedCall as { to?: string }).to,
          dataLen: (unsignedCall as { data?: string }).data?.length,
          needsApproval: approvalsOf(unsignedCall).map((a) => ({
            token: a.token,
            spender: a.spender,
            amount: a.amount.toString(),
          })),
        });
      }

      if (unsignedCall.kind === "solana-ix") {
        assertSafetyResult(
          await runSafetyPipeline({
            ...withdrawSafetyBase,
            stage: "submit",
            call: unsignedCall,
            positionBalance: liveBalance,
          }),
        );
        const solPreflight = await runSafetyPipeline({
          ...withdrawSafetyBase,
          stage: "broadcast",
          call: unsignedCall,
          positionBalance: liveBalance,
        });
        if (!solPreflight.ok) {
          releaseSubmission(withdrawSafetyBase.submissionKey ?? "");
        }
        assertSafetyResult(solPreflight);

        // "before" half of the postexec delta assertion. For a withdraw the
        // assertion is inverted (the position must SHRINK), which the check
        // reads off `ctx.action` rather than from the stage.
        const solWithdrawBefore =
          await snapshotPositionBefore(withdrawSafetyBase);

        let signature: string;
        try {
          if (__DEV__) {
            console.warn("[defi/withdraw] submitting solana-ix", {
              instructionCount: unsignedCall.instructions.length,
            });
          }
          signature = await submitSolanaCall(
            context.wallet,
            chainConfig,
            unsignedCall,
          );
        } catch (err) {
          releaseSubmission(withdrawSafetyBase.submissionKey ?? "");
          throw err;
        }

        // A redeem REQUEST (`isAsyncWithdraw`) needs the SAME durable
        // `asyncPhase` tracking `deposit`'s request phase gets — otherwise
        // the backend claim-watcher has nothing to poll and the position
        // never becomes claimable. `createPosition`'s payload already types
        // `asyncPhase: "redeem_requested"` for exactly this call (it was
        // never actually sent with that value before this fix). Best-effort:
        // the on-chain enqueue already succeeded, so a tracking failure here
        // is logged, not thrown — same posture as every other post-submit
        // bookkeeping call in this file.
        if (isAsyncWithdraw) {
          try {
            await strategiesApi.createPosition({
              protocolSlug,
              chainId: position.chainId,
              namespace: adapter.namespace,
              assetSymbol,
              assetContract: assetContract ?? undefined,
              poolId: position.poolId ?? undefined,
              amountAtDeposit: position.amountAtDeposit,
              amountAtDepositUsd: Number.parseFloat(
                position.amountAtDepositUsd,
              ),
              openTxHash: signature,
              asyncPhase: "redeem_requested" as const,
              asyncRequestedRaw:
                typeof amountRaw === "string"
                  ? amountRaw
                  : amountRaw.toString(),
            });
          } catch (err) {
            if (__DEV__) {
              console.error(
                "[defi/withdraw] createPosition (redeem_requested) failed after a successful on-chain enqueue",
                { positionId, signature, error: err },
              );
            }
          }
        }

        // Post-execution verification (§11 Layer 5). Skipped for a redeem
        // REQUEST: the position is supposed to still be there until the
        // cooldown elapses, so asserting it shrank would flag every correct
        // async exit.
        const solWithdrawVerdict = isAsyncWithdraw
          ? ({ status: "unverified", ran: [] } as PostExecVerdict)
          : await verifyPostExecution(withdrawSafetyBase, {
              positionBefore: solWithdrawBefore,
            });
        const solWithdrawVerification = postExecResultFields(
          solWithdrawVerdict,
          "defi/withdraw",
        );

        return {
          status: "success" as const,
          tx_confirmed: !isAsyncWithdraw,
          data: {
            position_id: positionId,
            protocol_slug: protocolSlug,
            chain_id: pipelineChainId,
            asset_symbol: assetSymbol,
            namespace,
            amount_raw:
              typeof amountRaw === "string" ? amountRaw : amountRaw.toString(),
            signature,
            ...(isAsyncWithdraw
              ? {
                  settlement: "pending" as const,
                  async_phase: "redeem_requested" as const,
                  note: "Withdrawal requested. This exits through a cooldown period, so the funds become claimable once it elapses. We'll notify you when it's ready to claim.",
                }
              : solWithdrawVerification),
          },
        };
      }

      if (unsignedCall.kind !== "evm-call") {
        if (__DEV__) {
          console.warn(
            "[defi/withdraw] unsupported_chain — non-EVM unsigned call",
            {
              kind: unsignedCall.kind,
            },
          );
        }
        throw new DefiError(
          "unsupported_chain",
          `unsigned call kind "${unsignedCall.kind}"`,
        );
      }

      const { walletClient, publicClient } = resolveChainClients(
        chainId as number,
        context,
      );
      if (!walletClient || !walletClient.account) {
        if (__DEV__) {
          console.warn("[defi/withdraw] wallet_cannot_execute", {
            hasWalletClient: !!walletClient,
            hasAccount: !!walletClient?.account,
            chainId,
          });
        }
        throw new DefiError("wallet_cannot_execute");
      }

      // ── Safety pipeline, on-device anchor (§11.1, §11 Layer 4) — reads
      // the call that is ABOUT TO BE SIGNED: chain binding, decoded-intent
      // match (destination vouched-for, recipient is the caller's OWN
      // wallet, amount matches), approval scoping, gas sanity, idempotency,
      // plus `WithdrawBalanceCheck` now that the live balance is known.
      assertSafetyResult(
        await runSafetyPipeline({
          ...withdrawSafetyBase,
          stage: "submit",
          call: unsignedCall,
          positionBalance: liveBalance,
        }),
      );

      // Some withdrawals (Lido, Ethena cooldown) require an approval
      // to the queue/redemption manager — handle the preamble the
      // same as deposit.
      for (const approval of approvalsOf(unsignedCall)) {
        try {
          if (__DEV__) {
            console.warn("[defi/withdraw] reading allowance", {
              token: approval.token,
              owner: walletClient.account.address,
              spender: approval.spender,
            });
          }
          const allowance = await publicClient.readContract({
            address: approval.token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [walletClient.account.address as Address, approval.spender],
          });
          if (__DEV__) {
            console.warn("[defi/withdraw] allowance read OK", {
              allowance: allowance.toString(),
              required: approval.amount.toString(),
            });
          }
          if (allowance < approval.amount) {
            const approveHash = await walletClient.writeContract({
              address: approval.token,
              abi: erc20Abi,
              functionName: "approve",
              args: [approval.spender, approval.amount],
              account: walletClient.account,
              chain: walletClient.chain,
            });
            if (__DEV__) {
              console.warn("[defi/withdraw] approve tx submitted", {
                approveHash,
              });
            }
            await publicClient.waitForTransactionReceipt({ hash: approveHash });
            if (__DEV__) {
              console.warn("[defi/withdraw] approve tx confirmed", {
                approveHash,
              });
            }
          }
        } catch (err) {
          if (__DEV__) {
            console.error("[defi/withdraw] approval_failed", {
              token: approval.token,
              spender: approval.spender,
              error: err,
            });
          }
          throw new DefiError("approval_failed");
        }
      }

      // ── Safety pipeline, the last word before broadcast ─────────────────
      // The dry-run belongs HERE, not with Layer 4 above: the queue/cooldown
      // approvals above are separate transactions, so until they're mined a
      // simulation of the withdraw itself is the only thing this reports on.
      const preflight = await runSafetyPipeline({
        ...withdrawSafetyBase,
        stage: "broadcast",
        call: unsignedCall,
        positionBalance: liveBalance,
      });
      if (!preflight.ok) {
        // Nothing was broadcast, so the idempotency key claimed at submit
        // must not outlive the attempt — a genuine retry is not a duplicate.
        releaseSubmission(withdrawSafetyBase.submissionKey ?? "");
      }
      assertSafetyResult(preflight);

      if (__DEV__) {
        console.warn("[defi/withdraw] submitting protocol tx", {
          to: unsignedCall.to,
          dataLen: unsignedCall.data?.length,
          account: walletClient.account.address,
          chainId: walletClient.chain?.id,
        });
      }
      // "before" half of the postexec delta assertion, read as late as
      // possible. For a withdraw the assertion is inverted (the position must
      // SHRINK), which the check reads off `ctx.action`.
      const withdrawPositionBefore =
        await snapshotPositionBefore(withdrawSafetyBase);

      // Phantom-failure-safe submission: sign locally, then broadcast,
      // so a broadcast-RPC error never gets mislabelled as "nothing
      // happened" while the tx actually moved funds (the reported bug).
      const submit = await submitEvmCall(walletClient, publicClient, {
        to: unsignedCall.to,
        data: unsignedCall.data,
        value: unsignedCall.value ?? 0n,
      });

      if (submit.kind === "not_broadcast") {
        // Pre-broadcast failure (gas estimate revert, bad nonce, …):
        // chain state is genuinely unchanged.
        if (__DEV__) {
          console.warn("[defi/withdraw] not broadcast — position unchanged", {
            to: unsignedCall.to,
          });
        }
        releaseSubmission(withdrawSafetyBase.submissionKey ?? "");
        throw new DefiError("withdraw_failed");
      }
      if (submit.kind === "mined" && !submit.success) {
        // Broadcast then reverted on-chain — funds unchanged.
        if (__DEV__) {
          console.warn("[defi/withdraw] reverted on-chain", {
            hash: submit.hash,
          });
        }
        releaseSubmission(withdrawSafetyBase.submissionKey ?? "");
        throw new DefiError("withdraw_failed");
      }
      if (submit.kind === "unconfirmed") {
        // The signed tx may have landed — DO NOT claim unchanged, DO NOT
        // retry. Surface the hash so the activity feed can reconcile it.
        if (__DEV__) {
          console.warn("[defi/withdraw] submission_unconfirmed", {
            hash: submit.hash,
          });
        }
        return {
          status: "failed" as const,
          tx_hash: submit.hash,
          error: "submission_unconfirmed",
          data: {
            position_id: positionId,
            protocol_slug: protocolSlug,
            chain_id: chainId,
          },
        };
      }

      // "submitted" or "mined" + success.
      const hash = submit.hash;
      if (__DEV__) {
        console.warn("[defi/withdraw] protocol tx submitted", { hash });
      }

      // Bounded wait for the receipt — the same reasoning as deposit's: a
      // `submitted` outcome says the node accepted the broadcast, not that
      // the withdraw succeeded, and a reverted withdraw reported as a success
      // is the exact "we told them it worked" failure this file's phantom-
      // failure handling exists to avoid.
      const withdrawSettled = await awaitReceiptForVerification(
        publicClient,
        hash,
      );
      if (withdrawSettled && !withdrawSettled.success) {
        if (__DEV__) {
          console.warn("[defi/withdraw] reverted on-chain (post-broadcast)", {
            hash,
          });
        }
        releaseSubmission(withdrawSafetyBase.submissionKey ?? "");
        throw new DefiError("withdraw_failed");
      }

      // ── Safety pipeline, stage 4 of 4: after the receipt (§11 Layer 5) ──
      // Never throws: the funds have already left the protocol.
      const withdrawVerdict = isAsyncWithdraw
        ? ({ status: "unverified", ran: [] } as PostExecVerdict)
        : await verifyPostExecution(withdrawSafetyBase, {
            positionBefore: withdrawPositionBefore,
            confirmations: withdrawSettled?.confirmations,
          });
      const withdrawVerification = postExecResultFields(
        withdrawVerdict,
        "defi/withdraw",
      );

      return {
        status: "success" as const,
        tx_hash: hash,
        tx_confirmed: submit.kind === "mined" || withdrawSettled !== null,
        data: {
          position_id: positionId,
          protocol_slug: protocolSlug,
          chain_id: chainId,
          // Already resolved above (ground truth from `getPosition`, not the
          // model's hints) — echoing them back means the post-execution
          // receipt card has the same context the pre-approval card did,
          // instead of just a bare tx hash.
          asset_symbol: assetSymbol,
          namespace,
          amount_raw:
            typeof amountRaw === "string" ? amountRaw : amountRaw.toString(),
          ...withdrawVerification,
        },
      };
    } catch (err) {
      const code = classifyDefiError(err);
      if (__DEV__) {
        console.warn("[defi/withdraw] EXIT failed", { code, error: err });
      }
      throw new ExecutorError(toExecutorErrorCode(code), code);
    }
  });

/**
 * `defi_claim` — claim rewards / matured withdrawal. Routes through
 * the adapter's optional `buildClaim?` capability.
 */
export const claim: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    try {
      const positionId = requireString(input, "position_id");
      if (__DEV__) {
        console.warn("[defi/claim] ENTER", {
          positionId,
          walletAddress: context.wallet.address,
        });
      }
      const position = await strategiesApi
        .getPosition(positionId)
        .catch((err) => {
          if (__DEV__) {
            console.warn("[defi/claim] getPosition rejected", {
              positionId,
              error: err,
            });
          }
          return null;
        });
      if (!position) {
        if (__DEV__)
          console.warn("[defi/claim] position_not_found", { positionId });
        throw new DefiError("position_not_found", positionId);
      }

      const adapter = getDefiAdapter(position.protocolSlug);
      if (!adapter) {
        if (__DEV__) {
          console.warn("[defi/claim] protocol_not_found", {
            protocolSlug: position.protocolSlug,
            registered: listDefiAdapters().map((a) => a.slug),
          });
        }
        throw new DefiError("protocol_not_found", position.protocolSlug);
      }

      // Same namespace-aware resolution `deposit`/`withdraw` use — Solana
      // positions carry the numeric backend sentinel `chainId`, which does
      // not identify a row in `Blockchain` (whose `chainId` is `null` for
      // non-EVM networks).
      let chainConfig: ChainConfig;
      let pipelineChainId: number | string = position.chainId;
      if (adapter.namespace === "solana") {
        const solana = resolveSolanaChain(context);
        chainConfig = solana.chainConfig;
        pipelineChainId = solana.chainId;
      } else {
        const blockchain = context.blockchains.find(
          (b) => b.chainId === position.chainId,
        );
        if (!blockchain) {
          if (__DEV__) {
            console.warn(
              "[defi/claim] unsupported_chain — no blockchain row in context",
              {
                chainId: position.chainId,
                available: context.blockchains.map((b) => b.chainId),
              },
            );
          }
          throw new DefiError(
            "unsupported_chain",
            `chainId=${position.chainId}`,
          );
        }
        chainConfig = buildChainConfigFromBlockchain(blockchain);
      }
      const decimals = decimalsForSymbol(position.assetSymbol);

      // ERC-7540 async vaults (§7) claim through a DIFFERENT capability pair
      // than the generic reward/matured-withdrawal `buildClaim` below —
      // `buildClaimDeposit`/`buildClaimRedeem`, because which one applies
      // depends on which REQUEST is settling, not just on the protocol. A
      // position only reaches this branch once the backend watcher has
      // independently confirmed the vault reports a non-zero claimable
      // amount (`asyncPhase` flips to `*_claimable` there, never on the
      // device's own say-so) — this executor still re-reads that amount
      // itself rather than trusting the cached position, since a stale
      // "claimable" read would burn against a number the chain no longer
      // honours.
      const isAsyncClaim =
        position.asyncPhase === "deposit_claimable" ||
        position.asyncPhase === "redeem_claimable";
      if (isAsyncClaim) {
        if (
          typeof adapter.buildClaimDeposit !== "function" ||
          typeof adapter.buildClaimRedeem !== "function" ||
          typeof adapter.readAsyncRequest !== "function"
        ) {
          throw new DefiError(
            "no_claimable_balance",
            `${position.protocolSlug}: adapter is missing the async claim capability`,
          );
        }
        if (!position.poolId) {
          throw new DefiError(
            "position_not_found",
            `${positionId}: async position has no poolId to re-resolve a target from`,
          );
        }
        // Re-fetch the authoritative depositTarget by poolId — the same
        // pattern `withdraw` uses (§4.2, §7): the model never supplies an
        // address, and a claim is a `tx.to` for the user's settled funds
        // exactly as much as a deposit is.
        const opportunity = await strategiesApi
          .getPool(position.poolId)
          .catch(() => null);
        const claimTarget = opportunity?.depositTarget;
        // Every kind with the async-claim capability, not just EVM's
        // `async-vault` — `jito-vault-deposit` (Kyros) is the same shape
        // (request → cooldown → claim) on Solana. This was hardcoded to
        // `"async-vault"` only before 2026-08-27, which meant a Solana async
        // claim would have failed here even once every other gate below is
        // fixed.
        if (
          !claimTarget ||
          (claimTarget.kind !== "async-vault" &&
            claimTarget.kind !== "jito-vault-deposit")
        ) {
          throw new DefiError(
            "protocol_not_found",
            `${position.protocolSlug}: pool ${position.poolId} no longer resolves an async-claimable target`,
          );
        }

        const claimCtx: PositionReadContext = {
          target: claimTarget,
          assetContract: position.assetContract ?? undefined,
          assetSymbol: position.assetSymbol,
          assetDecimals: decimals,
          chain: chainConfig,
        };
        const requestState = await adapter.readAsyncRequest(
          context.wallet.address,
          claimCtx,
        );
        if (!requestState || requestState.claimable <= 0n) {
          // The chain disagrees with the backend's last observation — refuse
          // rather than build a claim for zero, which is the same
          // "never trust a cache for a fund-moving amount" rule every other
          // write in this file follows.
          throw new DefiError(
            "no_claimable_balance",
            `${position.protocolSlug}: vault reports nothing claimable right now`,
          );
        }

        const claimBuildArgs = {
          wallet: context.wallet,
          chain: chainConfig,
          asset: {
            symbol: position.assetSymbol,
            contract: position.assetContract ?? undefined,
            decimals,
          },
          amount: requestState.claimable,
          target: claimTarget,
        };
        let claimUnsignedCall;
        try {
          claimUnsignedCall =
            position.asyncPhase === "deposit_claimable"
              ? await adapter.buildClaimDeposit(claimBuildArgs as never)
              : await adapter.buildClaimRedeem(claimBuildArgs as never);
        } catch (buildErr) {
          if (__DEV__) {
            console.error("[defi/claim] async buildClaim* threw", {
              protocolSlug: position.protocolSlug,
              asyncPhase: position.asyncPhase,
              error: buildErr,
            });
          }
          throw buildErr;
        }
        if (claimUnsignedCall.kind === "solana-ix") {
          let signature: string;
          try {
            signature = await submitSolanaCall(
              context.wallet,
              chainConfig,
              claimUnsignedCall,
            );
          } catch (err) {
            const c = classifyDefiError(err);
            throw new DefiError(c === "unknown" ? "claim_failed" : c);
          }
          try {
            await strategiesApi.claimAsyncPosition(positionId, signature);
          } catch (recordErr) {
            if (__DEV__) {
              console.error(
                "[defi/claim] claimAsyncPosition failed after a successful on-chain claim",
                { positionId, signature, error: recordErr },
              );
            }
          }
          return {
            status: "success" as const,
            tx_confirmed: false,
            data: {
              position_id: positionId,
              protocol_slug: position.protocolSlug,
              chain_id: pipelineChainId,
              signature,
            },
          };
        }

        if (claimUnsignedCall.kind !== "evm-call") {
          throw new DefiError(
            "unsupported_chain",
            `unsigned call kind "${claimUnsignedCall.kind}"`,
          );
        }
        const { walletClient: asyncWalletClient } = resolveChainClients(
          position.chainId,
          context,
        );
        if (!asyncWalletClient || !asyncWalletClient.account) {
          throw new DefiError("wallet_cannot_execute");
        }
        let asyncHash: `0x${string}`;
        try {
          asyncHash = await asyncWalletClient.sendTransaction({
            to: claimUnsignedCall.to,
            data: claimUnsignedCall.data,
            value: claimUnsignedCall.value ?? 0n,
            account: asyncWalletClient.account,
            chain: asyncWalletClient.chain,
          });
        } catch (err) {
          const c = classifyDefiError(err);
          throw new DefiError(c === "unknown" ? "claim_failed" : c);
        }
        // Record the claim BEFORE reporting success to the agent — this is
        // what clears `asyncPhase` server-side and removes the position from
        // the watcher's scan (§7 requirement 2's other half). A failure here
        // is logged, not thrown: the on-chain claim already succeeded, and
        // the watcher will simply keep polling a vault that now reports
        // nothing claimable rather than lose track of the position.
        try {
          await strategiesApi.claimAsyncPosition(positionId, asyncHash);
        } catch (recordErr) {
          if (__DEV__) {
            console.error(
              "[defi/claim] claimAsyncPosition failed after a successful on-chain claim",
              { positionId, hash: asyncHash, error: recordErr },
            );
          }
        }
        return {
          status: "success" as const,
          tx_hash: asyncHash,
          tx_confirmed: false,
          data: {
            position_id: positionId,
            protocol_slug: position.protocolSlug,
            chain_id: position.chainId,
          },
        };
      }

      if (!adapter.buildClaim) {
        if (__DEV__) {
          console.warn(
            "[defi/claim] no_claimable_balance — adapter has no buildClaim primitive",
            {
              protocolSlug: position.protocolSlug,
            },
          );
        }
        throw new DefiError(
          "no_claimable_balance",
          `${position.protocolSlug}: no claim primitive`,
        );
      }

      let unsignedCall;
      try {
        unsignedCall = await adapter.buildClaim({
          wallet: context.wallet,
          chain: chainConfig,
          asset: {
            symbol: position.assetSymbol,
            contract: position.assetContract ?? undefined,
            decimals,
          },
          amount: 0n,
        });
      } catch (buildErr) {
        if (__DEV__) {
          console.error("[defi/claim] adapter.buildClaim threw", {
            protocolSlug: position.protocolSlug,
            error: buildErr,
          });
        }
        throw buildErr;
      }

      if (__DEV__) {
        console.warn("[defi/claim] unsignedCall built", {
          kind: unsignedCall.kind,
          to: (unsignedCall as { to?: string }).to,
          dataLen: (unsignedCall as { data?: string }).data?.length,
        });
      }

      if (unsignedCall.kind !== "evm-call") {
        if (__DEV__) {
          console.warn(
            "[defi/claim] unsupported_chain — non-EVM unsigned call",
            {
              kind: unsignedCall.kind,
            },
          );
        }
        throw new DefiError(
          "unsupported_chain",
          `unsigned call kind "${unsignedCall.kind}"`,
        );
      }

      const { walletClient } = resolveChainClients(position.chainId, context);
      if (!walletClient || !walletClient.account) {
        if (__DEV__) {
          console.warn("[defi/claim] wallet_cannot_execute", {
            hasWalletClient: !!walletClient,
            hasAccount: !!walletClient?.account,
            chainId: position.chainId,
          });
        }
        throw new DefiError("wallet_cannot_execute");
      }

      let hash: `0x${string}`;
      try {
        if (__DEV__) {
          console.warn("[defi/claim] submitting claim tx", {
            to: unsignedCall.to,
            dataLen: unsignedCall.data?.length,
          });
        }
        hash = await walletClient.sendTransaction({
          to: unsignedCall.to,
          data: unsignedCall.data,
          value: unsignedCall.value ?? 0n,
          account: walletClient.account,
          chain: walletClient.chain,
        });
        if (__DEV__) {
          console.warn("[defi/claim] claim tx submitted", { hash });
        }
      } catch (err) {
        const c = classifyDefiError(err);
        if (__DEV__) {
          console.error("[defi/claim] sendTransaction failed", {
            classified: c,
            to: unsignedCall.to,
            error: err,
          });
        }
        throw new DefiError(c === "unknown" ? "claim_failed" : c);
      }

      return {
        status: "success" as const,
        tx_hash: hash,
        tx_confirmed: false,
        data: {
          position_id: positionId,
          protocol_slug: position.protocolSlug,
          chain_id: position.chainId,
        },
      };
    } catch (err) {
      const code = classifyDefiError(err);
      if (__DEV__) {
        console.warn("[defi/claim] EXIT failed", { code, error: err });
      }
      throw new ExecutorError(toExecutorErrorCode(code), code);
    }
  });

/**
 * `defi_rebalance` — sequential withdraw-from-A + deposit-into-B.
 *
 * Each leg gets its own threshold check and its own PendingTxCard
 * upstream. If the second leg fails after the first succeeded, we
 * report `rebalance_partial_failure` so the agent narrates the right
 * follow-up.
 */
export const rebalance: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    try {
      const fromPositionId = requireString(input, "from_position_id");
      const toProtocolSlug = requireString(input, "to_protocol_slug");
      const toAssetSymbol = requireString(input, "to_asset_symbol");
      const toAssetContract = input.to_asset_contract as string | undefined;

      if (__DEV__) {
        console.warn("[defi/rebalance] ENTER", {
          fromPositionId,
          toProtocolSlug,
          toAssetSymbol,
          toAssetContract,
          toAmountRaw: input.to_amount_raw,
          expectedApy: input.expected_apy,
        });
      }

      // 1. Withdraw the full from-position.
      if (__DEV__) {
        console.warn("[defi/rebalance] leg 1 — withdraw MAX", {
          fromPositionId,
        });
      }
      const withdrawResult = await withdraw(
        { position_id: fromPositionId, amount_raw: "MAX" },
        context,
      );
      // A Solana withdraw never sets `tx_hash` (it's typed `0x${string}` and
      // would reject a base58 signature — the signature lives under
      // `data.signature` instead, same convention `sendSol` established).
      // Without this, a genuinely successful Solana leg 1 would be
      // misreported as `rebalance_failed` here. `rebalance`'s OWN
      // `*_tx_hash` display fields further below still only carry the EVM
      // hash — a cosmetic gap for a Solana leg, not a correctness one, and
      // out of scope for this fix.
      const withdrawSucceeded =
        withdrawResult.status === "success" &&
        (!!withdrawResult.tx_hash ||
          !!(withdrawResult.data as { signature?: string } | undefined)
            ?.signature);
      if (!withdrawSucceeded) {
        if (__DEV__) {
          console.warn(
            "[defi/rebalance] rebalance_failed — leg 1 (withdraw) did not succeed",
            {
              withdrawResult,
            },
          );
        }
        throw new DefiError("rebalance_failed", "first leg (withdraw) failed");
      }
      if (__DEV__) {
        console.warn("[defi/rebalance] leg 1 OK", {
          withdrawTxHash: withdrawResult.tx_hash,
        });
      }

      // 2. Resolve the from-position to find the chain we're operating on.
      const fromPosition = await strategiesApi
        .getPosition(fromPositionId)
        .catch((err) => {
          if (__DEV__) {
            console.warn("[defi/rebalance] getPosition rejected", {
              fromPositionId,
              error: err,
            });
          }
          return null;
        });
      if (!fromPosition) {
        if (__DEV__) {
          console.warn(
            "[defi/rebalance] rebalance_partial_failure — withdraw OK but from-position metadata missing",
            {
              fromPositionId,
              withdrawTxHash: withdrawResult.tx_hash,
            },
          );
        }
        throw new DefiError(
          "rebalance_partial_failure",
          "withdraw succeeded but couldn't load from-position metadata",
        );
      }
      const expectedApy =
        typeof input.expected_apy === "number" ? input.expected_apy : undefined;

      // 3. Deposit into B. We use the same chain and the asset
      // requested. If the executor's withdraw + deposit chains
      // mismatch, this would need LI.FI (deferred to Phase 2). For
      // same-chain rebalance, the user's wallet now holds the
      // underlying asset received from the withdraw.
      try {
        const amountRaw =
          typeof input.to_amount_raw === "string"
            ? input.to_amount_raw
            : fromPosition.currentAmountRaw || fromPosition.amountAtDeposit;

        if (__DEV__) {
          console.warn("[defi/rebalance] leg 2 — deposit", {
            toProtocolSlug,
            toAssetSymbol,
            toAssetContract,
            chainId: fromPosition.chainId,
            amountRaw,
          });
        }
        const depositResult = await deposit(
          {
            protocol_slug: toProtocolSlug,
            chain_id: fromPosition.chainId,
            asset_symbol: toAssetSymbol,
            asset_contract: toAssetContract,
            amount_raw: amountRaw,
            ...(expectedApy !== undefined ? { expected_apy: expectedApy } : {}),
          },
          context,
        );
        if (depositResult.status !== "success") {
          if (__DEV__) {
            console.warn(
              "[defi/rebalance] rebalance_partial_failure — leg 2 (deposit) did not succeed",
              {
                depositResult,
                withdrawTxHash: withdrawResult.tx_hash,
              },
            );
          }
          throw new DefiError("rebalance_partial_failure");
        }
        if (__DEV__) {
          console.warn("[defi/rebalance] leg 2 OK", {
            depositTxHash: depositResult.tx_hash,
          });
        }
        return {
          status: "success" as const,
          tx_hash: depositResult.tx_hash,
          tx_confirmed: false,
          data: {
            withdraw_tx_hash: withdrawResult.tx_hash,
            deposit_tx_hash: depositResult.tx_hash,
            to_protocol_slug: toProtocolSlug,
            chain_id: fromPosition.chainId,
          },
        };
      } catch (err) {
        if (__DEV__) {
          console.error(
            "[defi/rebalance] rebalance_partial_failure — leg 2 threw",
            {
              withdrawTxHash: withdrawResult.tx_hash,
              error: err,
            },
          );
        }
        throw new DefiError("rebalance_partial_failure");
      }
    } catch (err) {
      const code = classifyDefiError(err);
      if (__DEV__) {
        console.warn("[defi/rebalance] EXIT failed", { code, error: err });
      }
      throw new ExecutorError(toExecutorErrorCode(code), code);
    }
  });

/**
 * `defi_compound` — claim accrued rewards and redeposit them into the
 * same position in a single, signed cycle. Spec §21.3.
 *
 * V1 scope: the executor measures the **balance delta of the position's
 * base asset** (claim before vs. after) and deposits that delta back.
 * Adapters whose `buildClaim` emits a different reward token (e.g. GMX
 * → WETH/esGMX, Aave → WMATIC bonuses) will land on zero delta and
 * fail with `no_claimable_balance`; the user can compound manually by
 * claiming, swapping in-app, and depositing.
 *
 * Adapters with rebasing yield (Lido stETH) accrue inline and do not
 * surface a `buildClaim` primitive — those get rejected at the
 * "no claim primitive" guard.
 */
export const compound: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    try {
      const positionId = requireString(input, "position_id");

      if (__DEV__) {
        console.warn("[defi/compound] ENTER", {
          positionId,
          walletAddress: context.wallet.address,
        });
      }

      const position = await strategiesApi
        .getPosition(positionId)
        .catch((err) => {
          if (__DEV__) {
            console.warn("[defi/compound] getPosition rejected", {
              positionId,
              error: err,
            });
          }
          return null;
        });
      if (!position) {
        throw new DefiError("position_not_found", positionId);
      }

      const { protocolSlug, chainId, assetSymbol, assetContract } = position;

      // Strategy-paused KEEPS users from compounding (compound = write
      // that grows the position; if they paused, respect it).
      const strategy = await strategiesApi.getStrategy().catch(() => null);
      if (strategy?.pausedAt) {
        throw new DefiError("strategy_paused");
      }

      const adapter = getDefiAdapter(protocolSlug);
      if (!adapter) {
        throw new DefiError("protocol_not_found", protocolSlug);
      }
      if (!adapter.buildClaim) {
        if (__DEV__) {
          console.warn(
            "[defi/compound] no_claimable_balance — adapter has no buildClaim",
            { protocolSlug },
          );
        }
        throw new DefiError(
          "no_claimable_balance",
          `${protocolSlug}: no claim primitive (nothing to compound)`,
        );
      }
      if (!adapter.buildDeposit) {
        // Should never happen — interface requires buildDeposit — but
        // guard anyway so a stub adapter can't brick the executor.
        throw new DefiError(
          "deposit_failed",
          `${protocolSlug}: missing buildDeposit`,
        );
      }

      const blockchain = context.blockchains.find((b) => b.chainId === chainId);
      if (!blockchain) {
        throw new DefiError("unsupported_chain", `chainId=${chainId}`);
      }
      const chainConfig = buildChainConfigFromBlockchain(blockchain);
      const decimals = decimalsForSymbol(assetSymbol);

      const { walletClient, publicClient } = resolveChainClients(
        chainId,
        context,
      );
      if (!walletClient || !walletClient.account) {
        throw new DefiError("wallet_cannot_execute");
      }

      const walletAddress = walletClient.account.address as Address;
      const baseAssetContract = assetContract
        ? (assetContract.toLowerCase() as Address)
        : null;

      // 1. Snapshot user's wallet balance of the position's base asset
      //    BEFORE the claim, so we can compute the claimed delta after.
      let balanceBefore: bigint;
      try {
        if (baseAssetContract) {
          balanceBefore = await publicClient.readContract({
            address: baseAssetContract,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [walletAddress],
          });
        } else {
          balanceBefore = await publicClient.getBalance({
            address: walletAddress,
          });
        }
      } catch (err) {
        if (__DEV__) {
          console.error("[defi/compound] balance-before read failed", { err });
        }
        throw new DefiError("network_error", "balance-before read failed");
      }
      if (__DEV__) {
        console.warn("[defi/compound] balance snapshot before claim", {
          asset: baseAssetContract ?? "native",
          balanceBefore: balanceBefore.toString(),
        });
      }

      // 2. Build + submit the claim.
      let claimCall;
      try {
        claimCall = await adapter.buildClaim({
          wallet: context.wallet,
          chain: chainConfig,
          asset: {
            symbol: assetSymbol,
            contract: assetContract ?? undefined,
            decimals,
          },
          amount: 0n,
        });
      } catch (err) {
        if (__DEV__) {
          console.error("[defi/compound] adapter.buildClaim threw", { err });
        }
        throw err;
      }
      if (claimCall.kind !== "evm-call") {
        throw new DefiError(
          "unsupported_chain",
          `compound: non-EVM claim kind "${claimCall.kind}"`,
        );
      }

      let claimHash: `0x${string}`;
      try {
        claimHash = await walletClient.sendTransaction({
          to: claimCall.to,
          data: claimCall.data,
          value: claimCall.value ?? 0n,
          account: walletClient.account,
          chain: walletClient.chain,
        });
        if (__DEV__) {
          console.warn("[defi/compound] claim tx submitted", { claimHash });
        }
        await publicClient.waitForTransactionReceipt({ hash: claimHash });
        if (__DEV__) {
          console.warn("[defi/compound] claim tx confirmed", { claimHash });
        }
      } catch (err) {
        const c = classifyDefiError(err);
        if (__DEV__) {
          console.error("[defi/compound] claim send/confirm failed", {
            classified: c,
            err,
          });
        }
        throw new DefiError(c === "unknown" ? "claim_failed" : c);
      }

      // 3. Snapshot AFTER and compute the delta. V1 only compounds
      //    deltas in the position's base asset; reward tokens that
      //    require a swap land on zero delta and fail-fast.
      let balanceAfter: bigint;
      try {
        if (baseAssetContract) {
          balanceAfter = await publicClient.readContract({
            address: baseAssetContract,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [walletAddress],
          });
        } else {
          balanceAfter = await publicClient.getBalance({
            address: walletAddress,
          });
        }
      } catch (err) {
        if (__DEV__) {
          console.error("[defi/compound] balance-after read failed", { err });
        }
        throw new DefiError("network_error", "balance-after read failed");
      }

      const delta = balanceAfter - balanceBefore;
      if (__DEV__) {
        console.warn("[defi/compound] balance snapshot after claim", {
          balanceAfter: balanceAfter.toString(),
          delta: delta.toString(),
        });
      }
      if (delta <= 0n) {
        if (__DEV__) {
          console.warn(
            "[defi/compound] no_claimable_balance — no delta in base asset (reward likely a different token)",
            { protocolSlug, assetSymbol },
          );
        }
        throw new DefiError(
          "no_claimable_balance",
          "claim produced no balance in the position's base asset (rewards may be in a different token — manual swap required)",
        );
      }

      // 4. Build + submit the deposit for the claimed delta.
      let depositCall;
      try {
        depositCall = await adapter.buildDeposit({
          wallet: context.wallet,
          chain: chainConfig,
          asset: {
            symbol: assetSymbol,
            contract: assetContract ?? undefined,
            decimals,
          },
          amount: delta,
        });
      } catch (err) {
        if (__DEV__) {
          console.error("[defi/compound] adapter.buildDeposit threw", { err });
        }
        throw err;
      }
      if (depositCall.kind !== "evm-call") {
        throw new DefiError(
          "unsupported_chain",
          `compound: non-EVM deposit kind "${depositCall.kind}"`,
        );
      }

      // 4a. Approval preamble for ERC20 deposits.
      for (const approval of approvalsOf(depositCall)) {
        try {
          const allowance = await publicClient.readContract({
            address: approval.token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [walletAddress, approval.spender],
          });
          if (allowance < approval.amount) {
            const approveHash = await walletClient.writeContract({
              address: approval.token,
              abi: erc20Abi,
              functionName: "approve",
              args: [approval.spender, approval.amount],
              account: walletClient.account,
              chain: walletClient.chain,
            });
            await publicClient.waitForTransactionReceipt({ hash: approveHash });
          }
        } catch (err) {
          if (__DEV__) {
            console.error("[defi/compound] approval_failed", { err });
          }
          throw new DefiError("approval_failed");
        }
      }

      let depositHash: `0x${string}`;
      try {
        depositHash = await walletClient.sendTransaction({
          to: depositCall.to,
          data: depositCall.data,
          value: depositCall.value ?? 0n,
          account: walletClient.account,
          chain: walletClient.chain,
        });
        if (__DEV__) {
          console.warn("[defi/compound] redeposit tx submitted", {
            depositHash,
            amount: delta.toString(),
          });
        }
      } catch (err) {
        const c = classifyDefiError(err);
        if (__DEV__) {
          console.error("[defi/compound] redeposit failed", {
            classified: c,
            err,
          });
        }
        throw new DefiError(c === "unknown" ? "deposit_failed" : c);
      }

      return {
        status: "success" as const,
        tx_hash: depositHash,
        tx_confirmed: false,
        data: {
          position_id: positionId,
          protocol_slug: protocolSlug,
          chain_id: chainId,
          claim_tx_hash: claimHash,
          deposit_tx_hash: depositHash,
          compounded_amount_raw: delta.toString(),
        },
      };
    } catch (err) {
      const code = classifyDefiError(err);
      if (__DEV__) {
        console.warn("[defi/compound] EXIT failed", { code, error: err });
      }
      throw new ExecutorError(toExecutorErrorCode(code), code);
    }
  });
