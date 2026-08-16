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
import { runGuardian } from "@/services/chains/sui/intent/guardian/riskCheckRegistry";
import {
  IntentExecuteInputSchema,
  parseIntent,
} from "@/services/chains/sui/intent/intentSchema";
import { intentStore } from "@/services/chains/sui/intent/intentStore";
import type { CompileContext } from "@/services/chains/sui/intent/intentTypes";
import { simulateSuiTransaction } from "@/services/chains/sui/simulation";
import { DefiError } from "@/services/defi/errors/defiErrors";
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
    if (poolId) {
      // Dynamic import keeps `@/api/endpoints/strategies` (which transitively
      // pulls React Native) out of this module's static graph — same pattern as
      // `scallop.config`/`ember.config`, so the node/vitest harness can load the
      // executor without an RN parse.
      const { strategiesApi } = await import("@/api/endpoints/strategies");
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
    const blocked = flags.some((f) => f.severity === "block") || wouldRevert;

    const intent_id = intentStore.put({
      ptbBase64: compiled.ptbBase64,
      intent,
      flags,
      summary: compiled.summary,
      inputCoinType: compiled.inputCoinType,
      inputAmountRaw: compiled.inputAmountRaw,
      simulationUnreliable: compiled.simulationUnreliable,
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

    // base58 digest in data.digest — never the hex-typed tx_hash (§6.4).
    return {
      status: "success",
      tx_confirmed: true,
      transaction_id,
      data: { digest, network: chain.network },
    };
  });

export const DEFI_INTENT_EXECUTORS: Record<string, MobileToolExecutor> = {
  defi_intent_preview: defiIntentPreview,
  defi_intent_execute: defiIntentExecute,
};
