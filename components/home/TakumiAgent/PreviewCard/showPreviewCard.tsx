/**
 * `showPreviewCard` — the integration seam task 09 will use.
 *
 * The SSE dispatcher (task 09) receives a `tool_pending` event whose
 * effective UX treatment resolves to `"preview"`, then needs to render
 * an inline card in the chat timeline. That wiring isn't done yet: this
 * file exposes a pure factory that returns the JSX element, plus the
 * bookkeeping hooks that task 09 will fill in.
 *
 * DO NOT import this at runtime from the dispatcher until task 09
 * wires it in — it is exported here so the component + its contract
 * are colocated and ready to drop in.
 */

import type React from "react";

import { approvalSummaryFromToolInput } from "../StructuredUI/approvalSummary";
import PreviewCard from "./PreviewCard";
import type {
  AgentSessionLike,
  PreviewCardDispatcherCallbacks,
  ToolPendingPayload,
} from "./types";

export interface ShowPreviewCardOptions {
  /** Override the default 6000ms run-down veto window (deny-layer §D-2). */
  autoConfirmMs?: number;
  /**
   * Live reconnect flag from the SSE dispatcher. Pass `true` while the
   * stream is reconnecting to pause the countdown. Defaults to `false`.
   */
  isReconnecting?: boolean;
}

/**
 * Build a `PreviewCard` JSX element wired to the dispatcher callbacks.
 *
 * Task 09 will call this from its `handleToolPending` handler after
 * `resolveUXTreatment` (task 12) returns `"preview"`. Both callbacks
 * are expected to clear the entry from `session.pending_approvals` —
 * this factory does not do the bookkeeping itself so the dispatcher
 * stays the single source of truth for session state.
 *
 * TODO(task 09): the dispatcher will call this factory. For now it
 * returns a JSX element that the chat timeline can render; the
 * `executeTool` / `rejectTool` callbacks have not yet been implemented
 * upstream.
 */
export function showPreviewCard(
  payload: ToolPendingPayload,
  session: AgentSessionLike,
  callbacks: PreviewCardDispatcherCallbacks,
  options: ShowPreviewCardOptions = {},
): React.ReactElement {
  const { autoConfirmMs = 6000, isReconnecting = false } = options;

  // Ensure the payload is tracked in session state. Task 09 may move
  // this up into the dispatcher so the check is idempotent across
  // reconnect redeliveries.
  session.pending_approvals.set(payload.tool_call_id, payload);

  return (
    <PreviewCard
      key={payload.tool_call_id}
      summary={approvalSummaryFromToolInput(
        payload.input,
        payload.meta.human_summary,
      )}
      autoConfirmMs={autoConfirmMs}
      isReconnecting={isReconnecting}
      onConfirm={() => {
        // TODO(task 09): executeTool will POST /chat/respond with the
        // tool result and remove the entry from pending_approvals.
        void callbacks.executeTool(payload, session);
      }}
      onDismiss={() => {
        // TODO(task 09): rejectTool will POST /chat/respond with a
        // user_declined error and remove the entry from pending_approvals.
        void callbacks.rejectTool(payload, session, "user_declined");
      }}
    />
  );
}
