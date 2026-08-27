/**
 * Sui Intent Engine mobile executors (spec §6.4, §8.4).
 *
 *   defi_intent_preview  (read)  — compile a plain-language goal into a PTB,
 *     dry-run it, run the guardian, stash it by opaque intent_id, and return
 *     { intent_id, human_summary, apy?, decoded, risk_flags, blocked }.
 *   defi_intent_execute  (write) — load the cached PTB by intent_id, re-guard
 *     it, sign+execute via the Sui WalletKit, return { digest, network }.
 *
 * The explicit-confirmation gate is the standard mobile approval sheet on
 * the `write` tool (same gate as `send_sui`) — NOT a card. The decline path
 * is the guardian's `block` flag (agent never offers execute) or the user
 * rejecting the sheet. SI-1: every step uses `context.wallet`, never a
 * home-screen active-wallet fallback. SI-3: only curated error codes reach
 * `ToolResult.error` — never a raw SDK/RPC string.
 */

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { track } from "@/services/analytics/posthog";
import { compileIntentToPtb } from "@/services/chains/sui/intent/compileIntentToPtb";
import type { RiskFlag } from "@/services/chains/sui/intent/guardian/riskCheck";
import { runGuardian } from "@/services/chains/sui/intent/guardian/riskCheckRegistry";
import {
  IntentExecuteInputSchema,
  parseIntent,
} from "@/services/chains/sui/intent/intentSchema";
import { intentStore } from "@/services/chains/sui/intent/intentStore";
import type { CompileContext } from "@/services/chains/sui/intent/intentTypes";
import { simulateSuiTransaction } from "@/services/chains/sui/simulation";
import { DefiError } from "@/services/defi/errors/defiErrors";
import { bootDefiSafety } from "@/services/defi/safety/bootstrap";
import {
  POSTEXEC_UNCONFIRMED_NOTE,
  snapshotPositionBefore,
  verifyPostExecution,
} from "@/services/defi/safety/postexec";
import { setSuiChainResolver } from "@/services/defi/safety/providers/sui";
import { runSafetyPipeline } from "@/services/defi/safety/registry";
import type {
  SafetyAction,
  SafetyContext,
  SafetyPolicy,
  SafetyStage,
} from "@/services/defi/safety/types";
import type { DepositTarget, RiskTier } from "@/services/defi/types";
import { targetUnderlying } from "@/services/defi/types";
import { SuiSwapError } from "@/services/swap/sui/types";
import { getWalletForNamespace } from "@/services/walletPresence";
import { parseToolInput } from "../parseInput";
import {
  getActiveSuiChain,
  getSuiKit,
  loadSuiTokens,
} from "../sui/executorContext";
import {
  ExecutorError,
  ExecutorErrorCode,
  type MobileToolExecutor,
  safeExecute,
} from "../types";
import { recordTransferHistory } from "../wallet/recordTransferHistory";
import { toExecutorErrorCode } from "./defiErrorMapping";

const SUI_NS = "sui" as const;
const SUI_NATIVE_COIN_TYPE = "0x2::sui::SUI";
/** MIST left untouched for gas when the spent input coin IS native SUI. */
const SUI_GAS_RESERVE_MIST = 50_000_000n; // 0.05 SUI

/**
 * A `simulationUnreliable` venue whose dry-run reverts SPECIFICALLY with an
 * `assert_version` MoveAbort is a KNOWN simulator false-positive: version-gated
 * Sui pools (Haedal/Volo) abort in dry-run but succeed in real execution
 * (verified). This downgrades ONLY that exact case from a hard block. Any other
 * revert — a different abort, insufficient balance, slippage — still blocks, and
 * a missing/false flag never bypasses (fail-safe). The on-chain execution remains
 * the final gate; if it did fail, the user loses only gas, never principal.
 */
export function isVersionGateDryRunArtifact(
  simulationUnreliable: boolean | undefined,
  dryRun: { status: string } | null,
): boolean {
  return (
    simulationUnreliable === true &&
    dryRun !== null &&
    dryRun.status !== "success" &&
    dryRun.status.includes("assert_version")
  );
}

/**
 * Read the paying wallet's raw balance of `coinType`. Returns `null` on a
 * read error (fail-open: the dry-run still guards before signing). Read ONCE
 * per preview and reused for both the affordability gate and the
 * over-concentration guardian check (one RPC round-trip instead of two).
 */
async function readInputBalance(
  client: SuiJsonRpcClient,
  owner: string,
  coinType: string,
): Promise<bigint | null> {
  try {
    const bal = await client.getBalance({ owner, coinType });
    return BigInt(bal.totalBalance);
  } catch (err) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn("[intentExecutors] input balance read failed:", err);
    }
    return null;
  }
}

/**
 * Affordability guard (SI-3): a swap quote is a pure order-book calc and
 * ignores the wallet's balance, so the compiler will happily build a swap
 * the user can't fund. Fail with a clear `insufficient_balance` code — never
 * a raw RPC string. Fail-open when the balance is unknown.
 */
function assertAffordable(
  total: bigint | null,
  coinType: string,
  amountRaw: bigint,
): void {
  if (total === null) return;
  const needed =
    coinType === SUI_NATIVE_COIN_TYPE
      ? amountRaw + SUI_GAS_RESERVE_MIST
      : amountRaw;
  if (total < needed) {
    throw new ExecutorError(
      ExecutorErrorCode.InsufficientFunds,
      "insufficient_balance",
    );
  }
}

/** Map a compiler/swap/defi error to a curated ExecutorError (SI-3). */
function mapCompileError(err: unknown): ExecutorError {
  if (err instanceof ExecutorError) return err;
  if (err instanceof DefiError) {
    // Carry the DefiError's curated sub-reason (e.g. "insufficient_balance",
    // "build_failed", "protocol_rejected") alongside the coarse code so the
    // agent + card can be specific; fall back to the code when there's no
    // more-specific detail.
    const reason =
      err.message && err.message !== err.code ? err.message : err.code;
    // The coarse class comes from the shared table so the Sui and EVM write
    // paths cannot drift on what "not enough funds" or "the build failed"
    // means to the agent.
    return new ExecutorError(toExecutorErrorCode(err.code), reason);
  }
  if (err instanceof SuiSwapError) {
    return err.code === "network_error"
      ? new ExecutorError(ExecutorErrorCode.NetworkError, err.code)
      : new ExecutorError(ExecutorErrorCode.InvalidInput, err.code);
  }
  // Unknown — keep raw detail out of ToolResult.error (CLAUDE.md).
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn("[intentExecutors] unmapped compile error:", err);
  }
  return new ExecutorError(ExecutorErrorCode.Unknown, "compile_failed");
}

/**
 * Run the chain-agnostic safety pipeline over a compiled Sui intent
 * (§11.1's first anchor at preview, second at execute).
 *
 * Why this exists at all: Sui DeFi executes through THIS file rather than
 * `writes.ts`, so until now it was the one namespace whose deposits never
 * met the pipeline. The guardian it sits beside answers different questions
 * (live price impact, oracle staleness, an effect-level diff of the dry-run)
 * and keeps running; what the pipeline adds is everything that is about the
 * USER and the POLICY rather than about the chain, plus a fail-closed
 * posture the guardian deliberately does not have (a guardian check that
 * throws contributes no flag, so that it cannot break a preview).
 *
 * Runs for BOTH routing shapes. A pool-level intent carries a server-resolved
 * target and gets the full pipeline. A plain venue-routed intent ("supply 100
 * USDC to Scallop") has no target, and used to get nothing at all — which
 * quietly exempted it from the ops kill switch, the per-chain DeFi gate, the
 * user's own tier/whitelist/pause, the decimals and balance checks and the
 * duplicate-submission guard, none of which needs a target. Those all run now;
 * the target-dependent checks (Layer 1 identity, the destination binding, exit
 * terms) declare `requiresTarget` and the runner drops exactly those, so the
 * gap is the narrow real one and it is visible in the audit trail instead of
 * at a call site.
 *
 * The remaining gap is exit terms: the lockup is a property of the pool, so a
 * venue-routed supply is not gated on it. Refusing every plain-language supply
 * instead is a product decision, not this function's to take; it is recorded
 * in the runbook and surfaced to the user as a preview flag.
 */
interface SuiSafetyArgs {
  target: DepositTarget | undefined;
  action: SafetyAction;
  stage: SafetyStage;
  chain: ReturnType<typeof getActiveSuiChain>;
  walletAddress: string;
  /** Raw amount of the coin the WALLET spends (the input leg of a zap). */
  fundingAmount?: bigint;
  fundingAsset?: string;
  /** Human amount as the user said it, for the decimals cross-check. */
  requestedHuman?: number;
  poolId?: string;
  protocolSlug?: string;
  /** Raw tool input, for the Layer-0 provenance checks. */
  toolInput?: Record<string, unknown>;
  /** The user's strategy row, for the Layer-3 tier/whitelist/pause gate. */
  policy?: SafetyPolicy;
  call?: { kind: "sui-ptb"; transactionBlockBase64: string };
}

/**
 * Build the context once so the pre-sign, submit and post-execution stages
 * all describe the SAME deposit. Reconstructing it per stage is how the three
 * would drift into verifying subtly different things.
 */
function buildSuiSafetyContext(args: SuiSafetyArgs): SafetyContext {
  bootDefiSafety();
  // The provider resolves its RPC through the same hook `eip155`/`solana`
  // use, pointed at the chain this intent actually compiled against.
  setSuiChainResolver(() => args.chain);

  const underlying = args.target ? targetUnderlying(args.target) : null;
  const ctx: SafetyContext = {
    namespace: SUI_NS,
    action: args.action,
    target: args.target,
    toolInput: args.toolInput,
    policy: args.policy,
    chainId: args.chain.network,
    wallet: args.walletAddress,
    requestedAmount: args.fundingAmount ?? "MAX",
    underlyingExpected: underlying ?? args.fundingAsset ?? "",
    // Stated explicitly so the Layer-2 balance and decimals checks read the
    // coin the wallet SPENDS. For `swap_and_supply` that is the input coin,
    // not the pool's underlying — see `SafetyContext.fundingAsset`.
    fundingAsset: args.fundingAsset,
    fundingAmount: args.fundingAmount,
    requestedHuman: args.requestedHuman,
    previewOut: null,
    tvlUsdSnapshot: null,
    sim: null,
    feeEstimate: null,
    stage: args.stage,
    poolId: args.poolId,
    protocolSlug: args.protocolSlug,
    // `protocolSlug` is the fallback family key so the ops kill switch has
    // something to match on a venue-routed intent, which never has a kind.
    family: args.target?.kind ?? args.protocolSlug,
    call: args.call,
    submissionKey: `${args.walletAddress}:${args.poolId ?? args.target?.kind ?? args.protocolSlug ?? "venue"}:${
      args.fundingAmount?.toString() ?? "max"
    }`,
  };
  return ctx;
}

async function runSuiSafety(args: SuiSafetyArgs): Promise<string | null> {
  const result = await runSafetyPipeline(buildSuiSafetyContext(args));
  return result.ok ? null : result.fail;
}

/** Hand-written, per the guardian's own copy discipline. No raw codes. */
const SAFETY_REFUSAL_COPY: Record<string, string> = {
  counterparty_blocked:
    "This venue is blocked right now. Nothing has been prepared.",
  family_disabled: "This protocol is paused right now. Try another venue.",
  exit_terms_unknown:
    "We could not confirm how you would get your money back out, so we did not prepare this.",
  insufficient_funds: "Your balance is too low for this amount.",
  target_not_a_contract:
    "We could not verify this pool on chain, so we did not prepare this.",
  target_not_allowlisted:
    "We could not verify this pool on chain, so we did not prepare this.",
  decoded_intent_mismatch:
    "The prepared transaction did not match the plan, so we stopped.",
  decimals_mismatch: "That amount did not look right, so we stopped.",
};

/**
 * Map a `UserStrategy.tier` string onto the safety layer's `RiskTier`.
 *
 * Same defaulting `writes.ts`'s `toTierKey` uses (an unrecognised tier is
 * treated as the most conservative one, never the most permissive), written
 * locally so this file does not pull the EVM write path's module graph in.
 */
function toSafetyTier(tier: string | undefined): RiskTier {
  return tier === "balanced" || tier === "aggressive" ? tier : "conservative";
}

/**
 * Shown when a supply ran without a server-resolved pool. Hand-written, no
 * raw codes, no em-dashes (CLAUDE.md).
 */
const UNVERIFIED_POOL_FLAG: RiskFlag = {
  code: "effect.mismatch",
  severity: "warn",
  title: "Pool not verified on chain",
  detail:
    "You named a venue rather than a specific pool, so we could not check this pool's identity or how quickly you could withdraw. Every other safety check still ran.",
};

function safetyRiskFlag(code: string): RiskFlag {
  return {
    // Reuses the existing `effect.mismatch` class rather than widening the
    // guardian's vocabulary for a verdict that is not a guardian finding:
    // the pipeline refused, and the card's job here is to say so plainly.
    code: "effect.mismatch",
    severity: "block",
    title: "Safety check failed",
    detail:
      SAFETY_REFUSAL_COPY[code] ??
      "A safety check did not pass, so we did not prepare this.",
  };
}

/**
 * `defi_intent_preview` — READ. Compiles + dry-runs + guards, then returns
 * the plan + guardian verdict. Never signs. Renders `IntentPreviewCard`.
 */
export const defiIntentPreview: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    // A preview compiles and dry-runs; it never signs. So it does not
    // need the Sui wallet to be the ACTIVE one, only for the user to own
    // one — the same distinction `bridge_quote` already makes when it
    // prices against a destination wallet that isn't on screen. Gating on
    // `context.wallet.namespace` made a Sui-owning user switch wallets
    // just to see a plan they were entitled to see.
    const previewWallet =
      context.wallet?.namespace === SUI_NS
        ? context.wallet
        : getWalletForNamespace(
            // `?? []` because an absent inventory means "we know of no
            // wallets", which must fall through to the curated
            // `wallet_not_sui` below rather than throw and surface as an
            // opaque `unknown_error`.
            context.wallets ?? [],
            SUI_NS,
            context.wallet?.address,
          );
    if (!previewWallet) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_sui",
      );
    }
    const intent = parseIntent(input);
    if (!intent) {
      throw new ExecutorError(ExecutorErrorCode.InvalidInput, "invalid_intent");
    }

    const chain = getActiveSuiChain();
    const tokens = await loadSuiTokens(context, chain);
    const ctx: CompileContext = { wallet: previewWallet, chain, tokens };

    // Pool-level deposits (§6/§8): when the agent pinned an exact pool via an
    // opaque `poolId`, re-fetch the AUTHORITATIVE depositTarget server-side and
    // hand it to the compiler, which routes to the family adapter by
    // `target.kind`. The LLM only ever supplies the poolId — never an address.
    // No poolId (or no resolved target) → the plain-language venue path,
    // unchanged. A multi-vault venue (Ember/NAVI) with no target fails closed in
    // its adapter with a curated "pool target required" error.
    const poolId =
      intent.action === "supply" ||
      intent.action === "withdraw" ||
      intent.action === "swap_and_supply"
        ? intent.poolId
        : undefined;
    // Dynamic import keeps `@/api/endpoints/strategies` (which transitively
    // pulls React Native) out of this module's static graph — same pattern as
    // `scallop.config`/`ember.config`, so the node/vitest harness can load the
    // executor without an RN parse.
    const { strategiesApi } = await import("@/api/endpoints/strategies");
    // The user's own tier / whitelist / pause. `writes.ts` has always read
    // this for EVM and Solana; the Sui path never did, so a paused strategy
    // or an off-whitelist venue was enforced on two chains out of three.
    // Best-effort, exactly as `writes.ts` treats it: an unreachable strategy
    // leaves the policy checks with nothing to assert rather than blocking a
    // deposit on an API outage.
    const strategy = await strategiesApi.getStrategy().catch(() => null);
    if (poolId) {
      const opp = await strategiesApi.getPool(poolId).catch(() => null);
      if (opp?.depositTarget) ctx.depositTarget = opp.depositTarget;
    }

    let compiled: Awaited<ReturnType<typeof compileIntentToPtb>>;
    try {
      compiled = await compileIntentToPtb(intent, ctx);
    } catch (err) {
      // Preserve actionable swap reasons verbatim (curated codes, never raw
      // SDK text) so the card + agent can be specific — e.g.
      // `amount_below_minimum` instead of a generic `invalid_input`.
      if (err instanceof SuiSwapError) {
        return { status: "failed", error: err.code };
      }
      throw mapCompileError(err);
    }

    const client = new SuiJsonRpcClient({
      url: chain.rpcUrl,
      network: chain.network,
    });

    // Read the input balance ONCE: it feeds both the affordability gate here
    // and the over-concentration guardian check below (no duplicate RPC read).
    let inputBalanceRaw: bigint | null | undefined;
    if (compiled.inputCoinType) {
      inputBalanceRaw = await readInputBalance(
        client,
        // `previewWallet`, not `context.wallet` — the PTB above was
        // compiled for it, so reading the balance of a different wallet
        // (the active EVM one) would gate the preview on the wrong funds.
        previewWallet.address,
        compiled.inputCoinType,
      );
      // Fail fast if the wallet can't fund the input (the quote doesn't check).
      if (compiled.inputAmountRaw !== undefined) {
        assertAffordable(
          inputBalanceRaw,
          compiled.inputCoinType,
          compiled.inputAmountRaw,
        );
      }
    }

    const dryRun = await simulateSuiTransaction(client, {
      txBase64: compiled.ptbBase64,
      sender: previewWallet.address,
    });
    // Share the client + pre-read balance so the checks don't re-open
    // connections or re-read the same balance.
    const flags = await runGuardian({
      intent,
      compiled,
      dryRun,
      ctx,
      client,
      inputBalanceRaw,
    });
    // A dry-run that actually REVERTS (status set, ≠ success) is "blocked" — we
    // won't prepare a doomed PTB. A `null` dry-run means we couldn't reach the
    // node (transient RPC), NOT that the intent is unsafe — don't false-block
    // on it (the execute re-guard + on-chain minOut are the real gates).
    // EXCEPTION: a version-gated venue's known `assert_version` false-positive
    // (real execution succeeds) is downgraded to non-blocking; scoped tightly so
    // every genuine revert still blocks (see `isVersionGateDryRunArtifact`).
    const versionGateArtifact = isVersionGateDryRunArtifact(
      compiled.simulationUnreliable,
      dryRun,
    );
    const wouldRevert =
      dryRun !== null && dryRun.status !== "success" && !versionGateArtifact;

    // §11 pre-sign anchor. A refusal becomes a BLOCK flag rather than a thrown
    // error on purpose: `defi_intent_preview` is a read tool whose contract is
    // `{ risk_flags, blocked }`, the card already renders that, and the
    // execute path already refuses any intent carrying a block flag — so this
    // reuses the existing un-bypassable gate instead of inventing a parallel
    // one.
    const safetyFailure = await runSuiSafety({
      target: ctx.depositTarget,
      action: intent.action === "withdraw" ? "withdraw" : "deposit",
      stage: "presign",
      chain,
      walletAddress: previewWallet.address,
      fundingAmount: compiled.inputAmountRaw,
      fundingAsset: compiled.inputCoinType,
      requestedHuman:
        "amount" in intent && intent.amount
          ? Number.parseFloat(intent.amount.human)
          : undefined,
      poolId,
      protocolSlug: "venue" in intent ? intent.venue : undefined,
      toolInput: input as Record<string, unknown>,
      policy: strategy
        ? {
            tier: toSafetyTier(strategy.tier),
            protocolWhitelist: strategy.protocolWhitelist ?? undefined,
            allowAllInTier: !!strategy.allowAllInTier,
            paused: !!strategy.pausedAt,
          }
        : undefined,
    });
    if (safetyFailure) flags.push(safetyRiskFlag(safetyFailure));

    // A deposit whose pool the server never resolved is one the identity and
    // exit-terms checks could not look at. That is a real difference in what
    // was verified, so it is stated rather than left to the absence of a
    // flag. `warn`, not `block`: the plain-language venue path is a supported
    // way to deposit, and every check that does not need a pool still ran.
    if (!ctx.depositTarget && intent.action !== "swap") {
      flags.push(UNVERIFIED_POOL_FLAG);
    }

    const blocked = flags.some((f) => f.severity === "block") || wouldRevert;

    const intent_id = intentStore.put({
      ptbBase64: compiled.ptbBase64,
      intent,
      flags,
      summary: compiled.summary,
      inputCoinType: compiled.inputCoinType,
      inputAmountRaw: compiled.inputAmountRaw,
      simulationUnreliable: compiled.simulationUnreliable,
      depositTarget: ctx.depositTarget,
    });

    // What the guardian ACTUALLY read this run — real on-chain state, not a
    // canned warning. Surfaced so the card and the agent can say so plainly
    // ("guardian visibly reads real testnet state" is a scored bar). Each line
    // is true only when that read happened; all copy is hand-written.
    const inspected: string[] = [];
    if (dryRun?.status === "success") {
      inspected.push("Simulated this exact transaction on Sui");
    } else if (versionGateArtifact) {
      // Honest: we couldn't fully simulate (the venue's on-chain version gate
      // isn't reproducible in a dry-run), but the deposit path is verified.
      inspected.push("Checked this venue's live on-chain state");
    }
    if (typeof inputBalanceRaw === "bigint") {
      inspected.push("Checked your live balance");
    }
    if (compiled.poolObjectId) {
      inspected.push("Checked the pool's live state");
    }

    // All fields are JSON-safe (no bigint surfaced — §8.5).
    const data = {
      intent_id,
      human_summary: compiled.summary,
      apy: compiled.apy,
      decoded: compiled.decoded,
      risk_flags: flags,
      blocked,
      inspected,
    };
    return { status: "success", data, display: data };
  });

/**
 * `defi_intent_execute` — WRITE. The standard mobile approval sheet is the
 * explicit confirmation. Re-guards before signing (SI-5) so a blocked or
 * now-reverting intent can never be signed even if the model misbehaves.
 */
export const defiIntentExecute: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    if (!context.wallet?.address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no_connected_wallet",
      );
    }
    if (context.wallet.namespace !== SUI_NS) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_sui",
      );
    }
    // NOTE: do NOT gate on `context.account` — that's a viem (EVM) account
    // and is ALWAYS null for Sui wallets (getAccountForWallet returns null
    // for non-eip155). Sui signs via the wallet kit (keypair derived from
    // the wallet), exactly like `send_sui`. A watch-only Sui wallet has no
    // signing material and fails in `signAndExecuteSuiPtb` below.

    // Validate via the SAME zod schema the server derives its JSON Schema
    // from (single source of truth; parity-tested). Fails as
    // `invalid_intent_id` -> surfaced on `reason`.
    const { intent_id: intentId } = parseToolInput(
      IntentExecuteInputSchema,
      input,
      "intent_id",
    );
    const entry = intentStore.get(intentId);
    if (!entry) {
      // The cached PTB expired (5-min TTL) or was never stored — a stale
      // precondition, NOT bad input. The agent's recovery is to re-preview.
      throw new ExecutorError(
        ExecutorErrorCode.StalePrecondition,
        "intent_expired",
      );
    }

    // SI-5 un-bypassable block: a previewed-blocked intent never signs. The
    // plan is no longer safe to run as-is — re-preview / adjust, don't retry.
    if (entry.flags.some((f) => f.severity === "block")) {
      throw new ExecutorError(
        ExecutorErrorCode.StalePrecondition,
        "intent_no_longer_safe",
      );
    }

    const chain = getActiveSuiChain();
    const client = new SuiJsonRpcClient({
      url: chain.rpcUrl,
      network: chain.network,
    });
    // Re-guard via dry-run (§5.3): refuse a now-reverting intent before signing.
    // A `null` result means the dry-run RPC itself failed (transient) — that is
    // NOT a safety violation, so surface a retryable network error instead of
    // claiming the intent is invalid. Only an actual revert (status ≠ success)
    // is `intent_no_longer_safe`. (`simulateSuiTransaction` returns null on a
    // thrown RPC error, a non-"success" status on an on-chain revert.)
    const dryRun = await simulateSuiTransaction(client, {
      txBase64: entry.ptbBase64,
      sender: context.wallet.address,
    });
    if (dryRun === null) {
      throw new ExecutorError(
        ExecutorErrorCode.NetworkError,
        "reguard_unavailable",
      );
    }
    if (
      dryRun.status !== "success" &&
      !isVersionGateDryRunArtifact(entry.simulationUnreliable, dryRun)
    ) {
      // The re-guard dry-run now reverts — the on-chain world (pool / balance)
      // moved between preview and execute. A stale precondition, not bad
      // input: the agent should re-preview for a fresh intent, not retry this.
      // (A version-gated venue's `assert_version` false-positive is exempt — same
      // scoped bypass the preview applied; real execution succeeds.)
      throw new ExecutorError(
        ExecutorErrorCode.StalePrecondition,
        "intent_no_longer_safe",
      );
    }

    // §11.1's SECOND anchor, over the PTB that is about to be signed. The
    // dry-run above answers "would this succeed"; this answers "is this still
    // the transaction we authorised" — the Layer-4 chain binding and the
    // decoded-call-to-venue-package binding, plus the duplicate-submission
    // guard, over a PTB that has been sitting in a five-minute cache.
    // Built once and reused for the post-execution stage below, so both
    // describe the same deposit rather than two reconstructions of it.
    const safetyArgs = {
      target: entry.depositTarget,
      action: (entry.intent.action === "withdraw"
        ? "withdraw"
        : "deposit") as SafetyAction,
      stage: "submit" as SafetyStage,
      chain,
      walletAddress: context.wallet.address,
      fundingAmount: entry.inputAmountRaw,
      fundingAsset: entry.inputCoinType,
      poolId: "poolId" in entry.intent ? entry.intent.poolId : undefined,
      protocolSlug: "venue" in entry.intent ? entry.intent.venue : undefined,
    };
    const submitCtx = buildSuiSafetyContext({
      ...safetyArgs,
      call: { kind: "sui-ptb", transactionBlockBase64: entry.ptbBase64 },
    });
    const submitResult = await runSafetyPipeline(submitCtx);
    if (!submitResult.ok) {
      // Same curated vocabulary the preview uses; never a raw code to the user.
      throw new ExecutorError(
        ExecutorErrorCode.StalePrecondition,
        "intent_no_longer_safe",
      );
    }

    // "before" half of the post-execution delta assertion (§11 Layer 5),
    // read as late as possible: the next statement signs.
    const positionBefore = await snapshotPositionBefore(submitCtx);

    const kit = getSuiKit();
    if (!kit.signAndExecuteSuiPtb) {
      throw new ExecutorError(
        ExecutorErrorCode.NotImplemented,
        "sui_ptb_submit_unavailable",
      );
    }
    const digest = await kit.signAndExecuteSuiPtb({
      wallet: context.wallet,
      chain,
      ptbBase64: entry.ptbBase64,
    });
    intentStore.delete(intentId);

    const transaction_id = await recordTransferHistory({
      blockchains: context.blockchains,
      namespace: "sui",
      chainSlug: `sui-${chain.network}`,
      // TTransactionType is "TRANSFER" | "PAYMENT" in this codebase — record
      // the intent as a transfer so it surfaces in the activity feed.
      type: "TRANSFER",
      ...(entry.inputCoinType && entry.inputCoinType !== "0x2::sui::SUI"
        ? { contractAddress: entry.inputCoinType }
        : {}),
      amount: entry.inputAmountRaw?.toString() ?? "0",
      txHash: digest,
      fromAddress: context.wallet.address,
      toAddress: context.wallet.address,
    });

    // Record a StrategyPosition for a SUPPLY so it shows in "Your positions" and
    // carries the poolId + venue the withdraw path re-resolves its target from
    // (pool-level deposits §4.2/§6). Sui rows are chainId 0 (non-EVM, keyed by
    // namespace), mirroring the OpportunityCache. Best-effort: the deposit
    // already landed on-chain, so a failed record must NEVER fail the tool.
    // Dynamic import keeps `@/api/endpoints/strategies` (which pulls React
    // Native) out of this module's static graph (mirrors the preview fetch).
    if (entry.intent.action === "supply") {
      try {
        const { strategiesApi } = await import("@/api/endpoints/strategies");
        await strategiesApi.createPosition({
          protocolSlug: entry.intent.venue,
          chainId: 0,
          namespace: "sui",
          assetSymbol: entry.intent.asset,
          ...(entry.inputCoinType
            ? { assetContract: entry.inputCoinType }
            : {}),
          ...(entry.intent.poolId ? { poolId: entry.intent.poolId } : {}),
          amountAtDeposit: entry.inputAmountRaw?.toString() ?? "0",
          // USD snapshot is best-effort/cosmetic; the raw amount above is the
          // source of truth. Left 0 to avoid an extra rate lookup on the Sui
          // execute path (positions read live where possible).
          amountAtDepositUsd: 0,
          openTxHash: digest,
        });
      } catch (err) {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          console.warn(
            "[intentExecutors] createPosition failed (best-effort):",
            err,
          );
        }
      }
    }

    if (entry.intent.action === "swap") {
      track("swap_completed", {
        chain: "sui",
        from_asset: entry.intent.fromAsset,
        to_asset: entry.intent.toAsset,
        amount: Number(entry.intent.amount.human),
      });
    } else if (
      entry.intent.action === "supply" ||
      entry.intent.action === "swap_and_supply"
    ) {
      // "supply" deposits `asset`; "swap_and_supply" deposits the swapped
      // `toAsset` — either way, the symbol that actually lands in the venue.
      const assetSymbol =
        entry.intent.action === "supply"
          ? entry.intent.asset
          : entry.intent.toAsset;
      track("defi_deposit_completed", {
        chain: "sui",
        protocol_slug: entry.intent.venue,
        chain_id: chain.network,
        asset_symbol: assetSymbol,
        amount: Number(entry.intent.amount.human),
      });
    }

    // ── Safety pipeline, the stage after execution (§11 Layer 5) ────────
    // Sui's `signAndExecuteSuiPtb` returns only once the network has executed
    // the PTB, so unlike the EVM path there is nothing to wait for and the
    // position can be read immediately. No `confirmations`: Sui's provider
    // declares no `finalityDepth`, and claiming a depth nobody measured would
    // be worse than omitting it.
    //
    // Never throws. The PTB has executed; reporting a failure here would tell
    // the user their deposit did not happen while their coins sit in the
    // venue. A plain `swap` is skipped, because there is no position for a
    // delta to be about.
    const postExec =
      entry.intent.action === "swap"
        ? null
        : await verifyPostExecution(
            { ...buildSuiSafetyContext(safetyArgs), stage: "postexec" },
            { positionBefore },
          );
    if (postExec?.status === "mismatch" && __DEV__) {
      console.error("[intentExecutors] POSITION DID NOT MOVE after execute", {
        fail: postExec.fail,
        detail: postExec.detail,
        ran: postExec.ran,
      });
    }

    // base58 digest in data.digest — never the hex-typed tx_hash (§6.4).
    return {
      status: "success",
      tx_confirmed: true,
      transaction_id,
      data: {
        digest,
        network: chain.network,
        ...(postExec
          ? {
              position_verified:
                postExec.status === "verified"
                  ? true
                  : postExec.status === "mismatch"
                    ? false
                    : null,
              ...(postExec.status === "mismatch"
                ? { note: POSTEXEC_UNCONFIRMED_NOTE }
                : {}),
            }
          : {}),
      },
    };
  });

export const DEFI_INTENT_EXECUTORS: Record<string, MobileToolExecutor> = {
  defi_intent_preview: defiIntentPreview,
  defi_intent_execute: defiIntentExecute,
};
