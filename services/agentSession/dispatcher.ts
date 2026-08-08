/**
 * SSE `tool_pending` dispatcher.
 *
 * Called once per `tool_pending` event with the parsed payload and the
 * current `AgentSession`. Decides — via `authorizeToolCall` (the single
 * authorization gate, deny-layer spec §6.1) — whether the call is
 * `authorized` (run silently or behind the run-down veto), `ask` (proposal
 * card → approval sheet, no timer), or `deny` (hard reject,
 * `permission_denied`). This file is the routing layer; actual tool
 * execution goes through `executeToolWithRetry` → `EXECUTORS`.
 *
 * Strict rules (spec §10, non-negotiables for this task):
 *
 *   1. NO executor logic here. We only call `executeToolWithRetry`.
 *   2. NO UI imports. Preview / approval sheet callbacks are injected
 *      into the session via `AgentSessionUIBindings` — tasks 13 / 14
 *      wire them from the chat screen.
 *   3. Dedupe by `tool_call_id` against `session.pending_approvals`
 *      BEFORE any `await`, so a reconnect-triggered re-emit never
 *      races with the original invocation.
 *   4. Add the payload to `pending_approvals` before any `await` (same
 *      reason). Remove on the resolved path.
 */

// "@/" alias (not this file's usual relative-with-extension style) so both
// the node:test resolver hook and vitest.config.ts can stub this exact
// specifier — posthog-react-native ships RN/Flow syntax that can't load
// outside a Metro/RN transform. See services/analytics/posthog.mock.ts.
import { track } from "@/services/analytics/posthog";
import type { ToolCounterparty } from "../agent-executors/counterparty.ts";
import { confirmedCounterpartyStore } from "../confirmedCounterpartyStore.ts";
import { pendingTxStore } from "../pendingTxStore.ts";
import type { ConnectedWallet } from "../resolveUxTreatment.ts";
import type { AgentSession } from "./agentSession.ts";
import {
  type AuthorizationToken,
  authorizeToolCall,
  type ToolAuthorization,
} from "./authorizeToolCall.ts";
import { postProgress, postRespond, rejectTool } from "./networkHelpers.ts";
import type { ToolPendingPayload, ToolResult } from "./protocol.ts";

/**
 * Delay after which we ping the server with a progress hint so it can
 * emit a natural "please wait" message on the SSE. Kept short so the
 * user gets acknowledgement before they assume the app froze, but long
 * enough that fast tool calls never pay for a mini inference.
 */
const DELAY_HINT_MS = 3000;

/**
 * Entry point called by the SSE event loop. Never throws — all errors
 * are caught and surfaced via `session.ui.showError` / `rejectTool`.
 */
export async function handleToolPending(
  payload: ToolPendingPayload,
  session: AgentSession,
): Promise<void> {
  const toolCallId = payload.tool_call_id;

  // --- Dedupe: reconnect re-emit guard -----------------------------
  // The SSE client already dedupes, but a second layer here protects
  // against any future transport swap (e.g. a real EventSource on
  // web) that doesn't.
  if (session.pending_approvals.has(toolCallId)) {
    return;
  }

  // Reserve the slot BEFORE any async work.
  session.pending_approvals.set(toolCallId, payload);

  const wallet = getConnectedWallet(session);
  if (!wallet) {
    // No wallet bound — we can't reason about policy. Reject the
    // tool so the agent sees a typed failure rather than a hang.
    session.pending_approvals.delete(toolCallId);
    await safeReject(payload, session, "wallet_type_cannot_execute");
    return;
  }

  // --- The single authorization decision (deny-layer spec §6.1) ----
  // Computed BEFORE painting any card so the inline StructuredUI card is
  // never a decision-blind auto-confirm surface (fixes D2). This is the
  // ONLY place the gate is consulted; the dispatcher switches purely on
  // the `decision` it returns.
  let auth: ToolAuthorization;
  try {
    auth = authorizeToolCall({
      capability: payload.meta.capability,
      toolName: payload.name,
      wallet,
      sessionId: session.session_id,
      // Headless runs (no human to approve) fail an `ask` closed — see
      // authorizeToolCall. The chat screen is always interactive.
      interactive: session.interactive ?? true,
      // Known-destination envelope: the gate reads the tool's own args to
      // find the counterparty, and asks the store whether the user has
      // ever confirmed it. Injected (not imported there) so the gate stays
      // a pure, synchronous decision function.
      input: payload.input,
      // Optional-chained: a host may bind a session before its executor
      // context is fully populated, and a missing namespace must degrade
      // to "no envelope" rather than throw inside the gate.
      walletNamespace: session.executorContext?.wallet?.namespace,
      // Being one of the user's OWN wallets is deliberately NOT enough.
      // The device derives an address on every namespace from one seed, so
      // "own wallet" includes a dozen the user has never chosen — trusting
      // those is the same silent auto-pick the envelope exists to catch.
      // What counts is that value has actually gone there before.
      isCounterpartyConfirmed: (counterparty) =>
        confirmedCounterpartyStore.isConfirmed(
          wallet.address,
          counterparty.namespace,
          counterparty.address,
        ),
    });
  } catch (err) {
    session.pending_approvals.delete(toolCallId);
    session.ui.showError?.(
      `[agentSession] authorizeToolCall failed: ${String(err)}`,
      false,
    );
    await safeReject(payload, session, "network_error");
    return;
  }

  const { decision, token } = auth;

  // Shared user-decline path used by the run-down cancel and the ask
  // proposal/sheet reject.
  const rejectDeclined = async () => {
    session.pending_approvals.delete(toolCallId);
    try {
      session.ui.upsertToolPart?.({
        toolCallId,
        toolName: payload.name,
        input: payload.input,
        state: "output-error",
        error: "user_declined",
      });
    } catch {}
    await safeReject(payload, session, "user_declined");
  };

  // --- DENY — hard reject, no card (fail closed) -------------------
  if (decision === "deny") {
    // The specific reason (watch_only / approval_unavailable /
    // policy_denied) stays in logs only; the agent sees the single fixed
    // `permission_denied` token (user-facing-error rule, §6.6).
    console.warn(
      `[agentSession] ${payload.name} denied (${auth.reason ?? "policy_denied"})`,
    );
    try {
      session.ui.upsertToolPart?.({
        toolCallId,
        toolName: payload.name,
        input: payload.input,
        state: "output-error",
        error: "permission_denied",
      });
    } catch {}
    session.pending_approvals.delete(toolCallId);
    await safeReject(payload, session, "permission_denied");
    return;
  }

  // Paint the inline card now that the decision is known. The card reads
  // `decision` to choose its surface — INV-1: only `authorized` ever
  // wires the auto-execute run-down.
  try {
    session.ui.upsertToolPart?.({
      toolCallId,
      toolName: payload.name,
      input: payload.input,
      state: "input-available",
      decision,
    });
  } catch (err) {
    console.warn(
      `[agentSession] upsertToolPart(pending) threw: ${String(err)}`,
    );
  }

  // --- AUTHORIZED --------------------------------------------------
  if (decision === "authorized") {
    if (auth.treatment === "silent") {
      // Reads (and deliberately-silent overrides like x402) run with no
      // card interaction.
      await runNonInteractive(payload, session, token);
      return;
    }
    // Authorized WRITE → the 6 s run-down veto card. Inaction at 0
    // executes (the card fires onConfirm) — correct ONLY because the
    // call is already authorized (§D-1 / INV-1).
    const onConfirm = async () => {
      await runNonInteractive(payload, session, token);
    };
    try {
      session.ui.showPreviewCard(payload, onConfirm, rejectDeclined);
    } catch (err) {
      session.pending_approvals.delete(toolCallId);
      session.ui.showError?.(
        `[agentSession] showPreviewCard threw: ${String(err)}`,
        false,
      );
      await safeReject(payload, session, "network_error");
    }
    return;
  }

  // --- ASK — two-step, no timer (§4.1) -----------------------------
  // Step 1: the inline proposal card (Reject / Approve). Reject rejects
  // outright; Approve opens the approval sheet (step 2). NOTHING
  // auto-resolves on this path.
  const openApprovalSheet = () => {
    try {
      session.ui.showApprovalSheet(
        payload,
        // Step 2 Confirm: execute (and the sheet may install a grant so
        // the next call resolves `authorized`).
        async () => {
          await runNonInteractive(payload, session, token, auth.counterparty);
        },
        rejectDeclined,
      );
    } catch (err) {
      session.pending_approvals.delete(toolCallId);
      session.ui.showError?.(
        `[agentSession] showApprovalSheet threw: ${String(err)}`,
        false,
      );
      void safeReject(payload, session, "network_error");
    }
  };

  // The inline proposal card (step 1) is only rendered by WRITE cards —
  // read cards have no approval surface. So an `ask` read (e.g. the user
  // turned off "Auto-approve read actions") goes straight to the approval
  // sheet, which always renders. Writes get the two-step proposal flow
  // when the host supports it.
  const isWrite = payload.meta.capability === "write";
  try {
    if (session.ui.showProposalCard && isWrite) {
      session.ui.showProposalCard(payload, openApprovalSheet, rejectDeclined);
    } else {
      // Read ask, or a host without the two-step proposal card: go
      // straight to the approval sheet (still no timer, still explicit).
      openApprovalSheet();
    }
  } catch (err) {
    session.pending_approvals.delete(toolCallId);
    session.ui.showError?.(
      `[agentSession] showProposalCard threw: ${String(err)}`,
      false,
    );
    await safeReject(payload, session, "network_error");
  }
}

// --- Internals --------------------------------------------------------------

/**
 * Non-interactive path used by `silent` and by the `preview` /
 * `confirm` callbacks after the user has acknowledged the action.
 * Runs the executor through `executeToolWithRetry`, posts the result,
 * then removes the pending slot.
 */
async function runNonInteractive(
  payload: ToolPendingPayload,
  session: AgentSession,
  token: AuthorizationToken,
  /**
   * Recorded as an established destination once this call SUCCEEDS. Only
   * passed on the paths a human actually cleared.
   */
  counterparty?: ToolCounterparty,
): Promise<void> {
  // Start the delay-hint timer BEFORE kicking off the executor. If the
  // executor resolves (success or failure) within DELAY_HINT_MS we
  // cancel the timer and no hint is sent; otherwise the timer fires
  // once, the server streams a "please wait" message on the SSE, and
  // the executor keeps running in parallel. Fire-and-forget — we never
  // await the hint POST.
  const hintTimer = setTimeout(() => {
    void postProgress(session.session_id, payload.tool_call_id);
  }, DELAY_HINT_MS);

  let result: ToolResult;
  try {
    // Dynamic import keeps `../agent-executors/retry.ts` — which
    // transitively pulls in viem and `@/utils/clients` — out of the
    // module graph until an actual tool call needs to run. Tests
    // exercising the `blocked` / rejection paths never hit this code
    // path, so they can load `dispatcher.ts` under plain Node
    // without the RN runtime.
    const { executeToolWithRetry } = await import(
      "../agent-executors/retry.ts"
    );
    // Idempotent reads (catalog, balances, history) retry a wider set of
    // transient backend failures — a one-shot 5xx/503/429 on the public
    // catalog is the "Couldn't load catalog" flakiness; a re-read can't
    // double-spend so the wider net is safe. Writes keep the strict
    // (write-safe) default predicate to preserve the anti-double-submit rule.
    const { isTransientReadError } = await import(
      "../agent-executors/types.ts"
    );
    result = await executeToolWithRetry(
      payload.name,
      payload.input,
      session.executorContext,
      // Structural single-source-of-truth (INV-3): execution requires the
      // token minted by `authorizeToolCall`.
      token,
      payload.meta.capability === "read"
        ? { isRetryable: isTransientReadError }
        : {},
    );
  } catch (err) {
    // `executeToolWithRetry` is documented as never-throw, but treat
    // any escaped exception as a failed tool result so the agent
    // still sees a typed response rather than timing out. NEVER put the
    // raw `String(err)` on `error` — it would flow into LLM context AND
    // onto the failure card (CLAUDE.md user-facing-errors). Curated code
    // only; the raw detail goes to a dev log.
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(`[agentSession] executor threw for ${payload.name}:`, err);
    }
    result = {
      status: "failed",
      error: "unknown_error",
    };
  } finally {
    clearTimeout(hintTimer);
  }

  // --- Task 15: optimistic pending-tx UI hook ----------------------
  // The ONLY call site that adds records to `pendingTxStore` from the
  // dispatcher. For write tools we drop a "submitted" card the moment
  // a hash comes back, and a "failed" card if the executor returned a
  // failure WITH a hash (reverted-but-submitted) so the UI can still
  // surface the explorer link.
  //
  // After a successful submission we also kick off a background receipt
  // poller so the card auto-transitions to confirmed/failed without
  // requiring the agent to call `get_transaction` explicitly.
  // --- Establish the destination (deny-layer §4.0 extension) --------
  // Recorded on SUCCESS, not on approval: the rule is that value has
  // actually gone there. An approval the executor then failed to carry
  // out proves the user's intent but not the destination's usability, and
  // the whole point of this record is to become a standing default —
  // defaulting to somewhere a transfer has never actually landed is the
  // guess we are trying to eliminate.
  const payingWallet = session.connectedWallet?.address;
  if (counterparty && payingWallet && result.status === "success") {
    try {
      confirmedCounterpartyStore.confirm(payingWallet, {
        address: counterparty.address,
        namespace: counterparty.namespace,
        tool_name: payload.name,
      });
    } catch (err) {
      // Bookkeeping must never fail a completed transfer — worst case the
      // user is asked once more next time.
      console.warn(
        `[agentSession] failed to record destination: ${String(err)}`,
      );
    }
  }

  if (payload.meta.capability === "write" && result.tx_hash) {
    // Agent may omit `chain_id` from the tool input (common for points
    // tools that infer it from wallet context), so fall back to the
    // executor context's active chain — otherwise the card is stuck
    // on "submitting" forever because pollReceipt early-exits on
    // chain_id 0.
    const chainIdRaw = payload.input.chain_id;
    const chainId =
      typeof chainIdRaw === "number" && chainIdRaw > 0
        ? chainIdRaw
        : (session.executorContext.activeChainId ?? 0);

    // Some executors (e.g. `deposit_points`) wait for the receipt
    // themselves before returning. Respect their `tx_confirmed` flag
    // so the card goes straight to the terminal state — no need to
    // re-poll what the executor already verified.
    const confirmedByExecutor =
      result.status === "success" && result.tx_confirmed === true;

    pendingTxStore.add({
      tx_hash: result.tx_hash,
      chain_id: chainId,
      description: payload.meta.human_summary,
      state:
        result.status === "failed"
          ? "failed"
          : confirmedByExecutor
            ? "confirmed"
            : "submitted",
      error: result.status === "failed" ? result.error : undefined,
      transactionId: result.transaction_id,
      confirmed_at: confirmedByExecutor ? Date.now() : undefined,
    });

    if (result.status === "success" && !confirmedByExecutor) {
      const txHash = result.tx_hash;
      // Fire-and-forget — we do NOT await this. The poller updates the
      // store via `markConfirmed` / `markFailed` as a side-effect;
      // errors inside `pollReceipt` are swallowed there.
      import("./receiptPoller.ts")
        .then(({ pollReceipt }) => {
          pollReceipt(txHash, chainId, session.executorContext).catch(() => {});
        })
        .catch(() => {});
    }
  }

  // Agent actually DOING something (a write tool) is the value signal —
  // reads (balance checks, activity lookups) are deliberately not tracked.
  // Both outcomes fire so failure rate is visible, not just successes.
  if (payload.meta.capability === "write") {
    track("agent_tool_completed", {
      tool_name: payload.name,
      state: result.status,
    });
  }

  // Mirror the tool result into the message parts so MessageContent
  // re-renders the inline card with `state: output-available` (or
  // `output-error`). The registered component then transitions from
  // the preview/pending UI to the terminal receipt.
  try {
    session.ui.upsertToolPart?.({
      toolCallId: payload.tool_call_id,
      toolName: payload.name,
      input: payload.input,
      state: result.status === "failed" ? "output-error" : "output-available",
      output: result,
      error: result.status === "failed" ? result.error : undefined,
    });
  } catch (err) {
    console.warn(`[agentSession] upsertToolPart(result) threw: ${String(err)}`);
  }

  try {
    await postRespondWithPolicy(session, payload, result);
  } catch (err) {
    session.ui.showError?.(
      `[agentSession] failed to POST tool result: ${String(err)}`,
      true,
    );
    // Leave the slot in pending_approvals — a reconnect will re-emit
    // the tool_pending and we'll retry from the top of the loop.
    return;
  }

  session.pending_approvals.delete(payload.tool_call_id);
}

// --- postRespond delivery policy --------------------------------------------

/**
 * Maximum extra delivery attempts after the first. Mirrors the default
 * in `services/agent-executors/retry.ts` so the read-tool delivery loop
 * has the same shape (3 total attempts) the executor itself uses.
 */
const POST_RESPOND_MAX_RETRIES = 2;
const POST_RESPOND_BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Deliver a `ToolResult` back to the server with capability-aware retry.
 *
 * Mirrors the §10 retry rules used by `executeToolWithRetry`:
 *   - Read tools retry transient delivery failures with linear backoff
 *     (`baseDelayMs * (attempt + 1)`), then fall through to a
 *     `tool_rejected{reason: "network_error"}` so the server pairs the
 *     assistant tool_call with a typed result instead of timing out.
 *   - Write tools never auto-retry — anything that moved (or
 *     could have moved) value gets a single delivery attempt. If that
 *     fails the slot is left in `pending_approvals` and a reconnect /
 *     manual recovery is required. This matches the anti-double-spend
 *     invariant in `retry.ts` rule 2 (any `tx_hash` is final).
 *
 * Throws on permanent failure for non-read capabilities so the caller's
 * existing error path (showError + leave slot) keeps working.
 */
async function postRespondWithPolicy(
  session: AgentSession,
  payload: ToolPendingPayload,
  result: ToolResult,
): Promise<void> {
  const capability = payload.meta.capability;

  if (capability !== "read") {
    // Write: single attempt, no retry. Per the design,
    // anything that touched chain state must not double-deliver.
    await postRespond(session.session_id, payload.tool_call_id, result);
    return;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= POST_RESPOND_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(POST_RESPOND_BASE_DELAY_MS * attempt);
    }
    try {
      await postRespond(session.session_id, payload.tool_call_id, result);
      return;
    } catch (err) {
      lastError = err;
    }
  }

  // Read-tool delivery exhausted all retries. Pair the server-side
  // tool_call with a typed rejection so the agent loop doesn't sit on
  // an orphan until the 5-minute timeout. Falling back to rejectTool
  // (instead of fabricating a server-side marker) keeps the
  // `mobile→execute, mobile→respond` invariant intact.
  console.warn(
    `[agentSession] postRespond exhausted retries for ${payload.tool_call_id} (${payload.name}): ${String(lastError)}`,
  );
  await rejectTool(payload, session, "network_error");
}

/**
 * Wrapper around `rejectTool` that never throws. We don't want a
 * network blip on the rejection path to corrupt the session — log it
 * and carry on.
 */
async function safeReject(
  payload: ToolPendingPayload,
  session: AgentSession,
  reason: string,
): Promise<void> {
  try {
    await rejectTool(payload, session, reason);
  } catch (err) {
    console.warn(
      `[agentSession] rejectTool failed for ${payload.tool_call_id}: ${String(err)}`,
    );
  }
}

/**
 * Extract the `ConnectedWallet` (the shape `resolveUxTreatment`
 * expects) from the session. The agent session owns the source of
 * truth — we don't re-read wallet state from hooks because the
 * dispatcher runs outside the React component tree.
 *
 * Returns `null` when the session has no wallet bound (shouldn't
 * happen in practice — the chat screen won't start a session without
 * one — but defensive handling keeps us safe against init races).
 */
function getConnectedWallet(session: AgentSession): ConnectedWallet | null {
  return session.connectedWallet ?? null;
}
