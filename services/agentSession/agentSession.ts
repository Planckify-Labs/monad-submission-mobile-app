/**
 * AgentSession — the lifetime-scoped object the chat screen holds while
 * an agent turn is in flight. Owns the SSE stream, the pending-
 * approvals map, the executor context, and the UI bindings injected
 * from the chat screen (tasks 13 / 14 / 15 provide the concrete
 * bindings).
 *
 * Spec: AGENT_PROTOCOL.md §8.3 / §10 "Mobile-Side Contract".
 *
 * The session is deliberately _not_ a React hook. The SSE handler runs
 * outside the component tree (we can't call hooks from an async
 * generator), so the chat screen builds the session with
 * `createAgentSession({...})` and passes in imperative callbacks for
 * the UI effects. Tests can build a session with fake bindings.
 */

import type { ExecutorContext } from "../agent-executors/types.ts";
import type { ConnectedWallet } from "../resolveUxTreatment.ts";
import { handleToolPending } from "./dispatcher.ts";
import { postRespond, rejectTool } from "./networkHelpers.ts";
import type {
  AgentEvent,
  ChatRequest,
  DonePayload,
  ErrorPayload,
  NarrativeHandoffPayload,
  StatusPayload,
  TextDeltaPayload,
  ToolExecutedPayload,
  ToolPendingPayload,
  ToolResult,
  WalletContext,
} from "./protocol.ts";
import type { SseClientHandle } from "./sseClient.ts";

// --- UI binding contract ----------------------------------------------------

/**
 * Imperative UI effects the session dispatches into. Tasks 13 / 14 /
 * 15 must satisfy this shape — do not change the surface without
 * coordinating with those tasks.
 *
 *   - `appendText(delta)` — streaming assistant text; appends to the
 *     current in-flight message bubble. Task 15 (optimistic UI).
 *   - `showStatus(message)` — transient status chip ("Checking
 *     balance…"). Cleared on the next `tool_executed` or `done`.
 *   - `showPreviewCard(payload, onConfirm, onDismiss)` — task 13.
 *     MUST call exactly one of the callbacks; the dispatcher treats
 *     `onDismiss` as a user-declined rejection.
 *   - `showApprovalSheet(payload, onApprove, onReject)` — task 14.
 *     Same contract as preview.
 *   - `showToolExecuted(payload)` — informational card for server-side
 *     tool results (e.g. a product list). Optional.
 *   - `showError(message, retryable)` — surfaces an SSE `error` event
 *     or an internal dispatcher failure. `retryable: true` maps to a
 *     "Try again" button per §8.3.
 *   - `done(usage)` — final event handler. Session has ended; the
 *     chat screen should close the in-flight message bubble.
 *   - `onSessionIdChanged(id)` — fired when the server's authoritative
 *     `session_id` is observed for the first time on an inbound SSE
 *     payload, OR whenever it differs from the previously-synced value.
 *     The chat screen mirrors this back into its own `sessionIdRef` so
 *     a §10 "Try again" tap re-POSTs on the right id (task 06).
 */
export interface AgentSessionUIBindings {
  appendText: (delta: string) => void;
  /**
   * Append or update a `tool` part on the current assistant message so
   * the registered StructuredUI card renders inline at the position the
   * agent emitted it (generative-ui-spec §4.3). Called by the dispatcher
   * on `tool_pending` (state: 'input-available') and again on
   * `tool_result` (state: 'output-available' | 'output-error').
   *
   * Upsert is keyed on `toolCallId`: a second call with the same id
   * updates the existing part rather than appending a duplicate.
   */
  upsertToolPart: (part: {
    toolCallId: string;
    toolName: string;
    input: unknown;
    state:
      | "input-streaming"
      | "input-available"
      | "output-available"
      | "output-error";
    output?: unknown;
    error?: string;
    /**
     * Authorization decision for this tool call (deny-layer spec §6.3).
     * Lets the inline StructuredUI write card choose its surface:
     * `authorized` → run-down veto card; `ask` → static proposal card
     * (no countdown). Absent for reads / silent calls.
     */
    decision?: "authorized" | "ask" | "deny";
  }) => void;
  showStatus: (message: string) => void;
  /**
   * Authorized-write run-down (deny-layer §4.2). MUST call exactly one
   * of the callbacks; `onConfirm` executes (also fired on countdown
   * elapse — correct only because the call is already authorized),
   * `onDismiss` rejects as `user_declined`.
   */
  showPreviewCard: (
    payload: ToolPendingPayload,
    onConfirm: () => void | Promise<void>,
    onDismiss: () => void | Promise<void>,
  ) => void;
  /**
   * The `ask` two-step proposal card (deny-layer §4.1). Step 1, inline,
   * NO timer. `onApprove` advances to the approval sheet (it does NOT
   * execute); `onReject` rejects the proposed tool as `user_declined`.
   * Optional so hosts that haven't adopted the two-step flow fall back to
   * the approval sheet directly.
   */
  showProposalCard?: (
    payload: ToolPendingPayload,
    onApprove: () => void | Promise<void>,
    onReject: () => void | Promise<void>,
  ) => void;
  showApprovalSheet: (
    payload: ToolPendingPayload,
    onApprove: () => void | Promise<void>,
    onReject: () => void | Promise<void>,
  ) => void;
  showToolExecuted?: (payload: ToolExecutedPayload) => void;
  /**
   * Narrative pass-through start (spec §6.4). Called when the server
   * emits a `narrative_handoff` frame. The chat screen sets
   * `originAgentId` on the assistant message being assembled so
   * `MessageContent.tsx` renders a "via {displayName}" badge. Default
   * no-op for hosts that don't render specialist narration.
   */
  setOriginAgent?: (originAgentId: string) => void;
  /**
   * Narrative pass-through end. Called when the server emits
   * `narrative_handoff_end`. v1: the chat screen treats this as a
   * marker that subsequent deltas belong to Core again (mobile may
   * choose to leave the badge in place on the same message — Core's
   * paraphrase typically lands in the next message).
   */
  endOriginAgent?: (originAgentId: string) => void;
  showError?: (message: string, retryable: boolean) => void;
  done?: (meta?: {
    conversation_id: string;
    conversation_title: string;
  }) => void;
  onReconnecting?: (attempt: number, delayMs: number) => void;
  /**
   * Fired on every event routed while the stream is live — signals that
   * the connection is (again) delivering data, so any UI paused during
   * a reconnect (e.g. the write-approval auto-confirm countdown) should
   * resume. Cheap/idempotent; safe to call even when never reconnecting.
   */
  onReconnected?: () => void;
  onSessionIdChanged?: (sessionId: string) => void;
}

// --- Session shape ----------------------------------------------------------

/**
 * Options accepted by `createAgentSession`.
 */
export interface CreateAgentSessionOptions {
  /** Session id chosen by the caller (usually a fresh uuid). */
  session_id: string;
  /** Wallet context sent on `POST /chat` and reused on reconnect. */
  wallet_context: WalletContext;
  /** Initial `messages` array for the first `POST /chat`. */
  messages: unknown[];
  /** Executor context forwarded to every mobile tool. */
  executorContext: ExecutorContext;
  /** ConnectedWallet used by `authorizeToolCall` / `resolveUxTreatment`. */
  connectedWallet: ConnectedWallet;
  /** UI effect bindings injected by the chat screen. */
  ui: AgentSessionUIBindings;
  /** When resuming a persisted conversation, pass its id. */
  conversation_id?: string;
  /**
   * Whether a human is present to approve tool calls. Defaults to `true`
   * (the chat screen). A headless/autonomous run passes `false` so a
   * would-be `ask` fails closed to `deny` (deny-layer spec §6.1).
   */
  interactive?: boolean;
}

/**
 * The runtime object exposed by `createAgentSession`. Long-lived for
 * the duration of one agent turn. `start()` opens the stream; `stop()`
 * tears it down; `respond` / `reject` are public escape hatches so UI
 * code can bypass the dispatcher when necessary (e.g. a manual
 * cancel).
 */
export interface AgentSession {
  session_id: string;
  pending_approvals: Map<string, ToolPendingPayload>;
  executorContext: ExecutorContext;
  connectedWallet: ConnectedWallet;
  ui: AgentSessionUIBindings;
  /** See `CreateAgentSessionOptions.interactive`. Defaults to `true`. */
  interactive: boolean;

  start: () => Promise<void>;
  stop: () => void;
  respond: (toolCallId: string, result: ToolResult) => Promise<void>;
  reject: (toolCallId: string, reason: string) => Promise<void>;
}

// --- Factory ----------------------------------------------------------------

export function createAgentSession(
  options: CreateAgentSessionOptions,
): AgentSession {
  const pending_approvals = new Map<string, ToolPendingPayload>();
  let stream: SseClientHandle | null = null;
  let stopped = false;

  const session: AgentSession = {
    session_id: options.session_id,
    pending_approvals,
    executorContext: options.executorContext,
    connectedWallet: options.connectedWallet,
    ui: options.ui,
    interactive: options.interactive ?? true,

    start: async () => {
      if (stream || stopped) return;
      // The request object is mutated in place when the server
      // assigns a real session id — see `syncServerSessionId`. This
      // keeps the reconnect body (built by `openSseStream` from
      // `opts.request.session_id`) pointed at the server's id.
      const request: ChatRequest = {
        session_id: options.session_id,
        messages: options.messages,
        wallet_context: options.wallet_context,
        ...(options.conversation_id !== undefined
          ? { conversation_id: options.conversation_id }
          : {}),
      };

      // Dynamic import keeps `sseClient.ts` (which pulls in
      // `expo/fetch`) out of the module graph until we actually need
      // the transport. Critical for unit tests running under plain
      // Node, where `expo/fetch` cannot be resolved.
      const { openSseStream } = await import("./sseClient.ts");
      stream = openSseStream({
        request,
        hasPendingApprovals: () => pending_approvals.size > 0,
        onReconnectAttempt: (attempt, delayMs) => {
          options.ui.onReconnecting?.(attempt, delayMs);
        },
        onClosed: () => {
          // Stream closed while idle — session is over.
        },
      });

      try {
        for await (const event of stream.events) {
          if (stopped) break;
          // Sync the server-assigned session id onto `request` too so
          // the reconnect path posts with the id the server knows.
          const maybeId = (event.data as { session_id?: unknown } | null)
            ?.session_id;
          if (typeof maybeId === "string" && maybeId) {
            request.session_id = maybeId;
          }
          await routeEvent(event, session);
        }
      } catch (err) {
        if (stopped) return;
        // conversation_not_found means the caller passed a stale
        // conversation_id. Re-throw so the caller can clear it and retry
        // without surfacing an error to the user.
        if (String(err).includes("conversation_not_found")) {
          throw err;
        }
        options.ui.showError?.(
          `[agentSession] SSE stream failed: ${String(err)}`,
          true,
        );
      }
    },

    stop: () => {
      stopped = true;
      stream?.close();
      stream = null;
    },

    respond: async (toolCallId, result) => {
      // Always read from `session.session_id`, not `options.session_id`,
      // so we pick up the server-assigned id synced by `syncServerSessionId`.
      await postRespond(session.session_id, toolCallId, result);
      pending_approvals.delete(toolCallId);
    },

    reject: async (toolCallId, reason) => {
      const payload = pending_approvals.get(toolCallId);
      if (!payload) return;
      await rejectTool(payload, { session_id: session.session_id }, reason);
      pending_approvals.delete(toolCallId);
    },
  };

  return session;
}

/**
 * Test-only entry point to route a single event into a session. Not
 * exported from the barrel — tests import it via the file path. The
 * production code path is `createAgentSession().start()`.
 */
export const __testing = {
  routeEvent: (event: AgentEvent, session: AgentSession) =>
    routeEvent(event, session),
};

// --- Event routing ----------------------------------------------------------

/**
 * Exhaustively routes a single `AgentEvent` into the session's UI
 * bindings and dispatcher. Unknown event types emit a console warning
 * and continue — per the task spec, unknown events must NOT crash the
 * session. The `never` default asserts exhaustiveness at compile time.
 */
async function routeEvent(
  event: AgentEvent,
  session: AgentSession,
): Promise<void> {
  // The server assigns its own `session_id` via `randomUUID()` on the
  // first `POST /chat` and ignores whatever id the mobile sent. The
  // real id first surfaces on `tool_pending` / `done` payloads — sync
  // it onto the session eagerly so any `POST /chat/respond` the
  // dispatcher fires uses the id the server actually recognises.
  syncServerSessionId(event, session);

  // Any routed event means the stream is currently delivering data —
  // clear any "reconnecting" UI state a prior drop may have set, even
  // if we were never actually mid-reconnect (idempotent no-op then).
  try {
    session.ui.onReconnected?.();
  } catch (err) {
    console.warn(`[agentSession] onReconnected threw: ${String(err)}`);
  }

  switch (event.event) {
    case "text_delta":
      handleTextDelta(event.data, session);
      return;

    case "status":
      handleStatus(event.data, session);
      return;

    case "tool_pending":
      // Fire-and-forget — the dispatcher manages its own awaits and
      // the SSE loop should keep draining in the meantime.
      void handleToolPending(event.data, session);
      return;

    case "tool_executed":
      handleToolExecuted(event.data, session);
      return;

    case "narrative_handoff":
      handleNarrativeHandoff(event.data, session);
      return;

    case "narrative_handoff_end":
      handleNarrativeHandoffEnd(event.data, session);
      return;

    case "done":
      handleDone(event.data, session);
      return;

    case "error":
      handleError(event.data, session);
      return;

    default: {
      // Compile-time exhaustiveness check. If the `AgentEvent` union
      // grows and this stops compiling, add a case above. Runtime
      // behaviour: warn + continue, never crash.
      const _exhaustive: never = event;
      console.warn(
        `[agentSession] unknown SSE event type, ignoring: ${JSON.stringify(_exhaustive)}`,
      );
      return;
    }
  }
}

/**
 * Update `session.session_id` in place when an incoming SSE payload
 * carries a server-assigned id. Noop for events that don't have one.
 *
 * The server's `SessionService.create()` always mints its own id via
 * `randomUUID()` (see `agent-api/src/session/session.service.ts`), so
 * the mobile's locally-generated id is effectively throwaway after the
 * first event arrives. Keeping the id in sync here means downstream
 * `postRespond` / `rejectTool` calls hit the right session.
 */
function syncServerSessionId(event: AgentEvent, session: AgentSession): void {
  const maybeId = (event.data as { session_id?: unknown } | null)?.session_id;
  if (
    typeof maybeId === "string" &&
    maybeId &&
    session.session_id !== maybeId
  ) {
    session.session_id = maybeId;
    // Bubble the new id up to the chat screen so its `sessionIdRef`
    // (used by §10 "Try again" — task 06) follows the server's view.
    try {
      session.ui.onSessionIdChanged?.(maybeId);
    } catch (err) {
      console.warn(`[agentSession] onSessionIdChanged threw: ${String(err)}`);
    }
  }
}

// --- Per-event handlers (kept small so routeEvent stays readable) ---------

function handleTextDelta(data: TextDeltaPayload, session: AgentSession): void {
  try {
    session.ui.appendText(data.content);
  } catch (err) {
    console.warn(`[agentSession] appendText threw: ${String(err)}`);
  }
}

function handleStatus(data: StatusPayload, session: AgentSession): void {
  try {
    session.ui.showStatus(data.message);
  } catch (err) {
    console.warn(`[agentSession] showStatus threw: ${String(err)}`);
  }
}

function handleToolExecuted(
  data: ToolExecutedPayload,
  session: AgentSession,
): void {
  try {
    session.ui.showToolExecuted?.(data);
  } catch (err) {
    console.warn(`[agentSession] showToolExecuted threw: ${String(err)}`);
  }
}

function handleNarrativeHandoff(
  data: NarrativeHandoffPayload,
  session: AgentSession,
): void {
  // Spec §6.4 — subsequent text deltas belong to the named specialist
  // until `narrative_handoff_end` arrives. The chat screen sets the
  // origin on the in-flight message; absence of the binding is a
  // forward-compat no-op (CLAUDE.md user-facing-error rule).
  try {
    session.ui.setOriginAgent?.(data.origin_agent_id);
  } catch (err) {
    console.warn(`[agentSession] setOriginAgent threw: ${String(err)}`);
  }
}

function handleNarrativeHandoffEnd(
  data: NarrativeHandoffPayload,
  session: AgentSession,
): void {
  try {
    session.ui.endOriginAgent?.(data.origin_agent_id);
  } catch (err) {
    console.warn(`[agentSession] endOriginAgent threw: ${String(err)}`);
  }
}

function handleDone(data: DonePayload, session: AgentSession): void {
  try {
    const meta =
      data.conversation_id && data.conversation_title
        ? {
            conversation_id: data.conversation_id,
            conversation_title: data.conversation_title,
          }
        : undefined;
    session.ui.done?.(meta);
  } catch (err) {
    console.warn(`[agentSession] done handler threw: ${String(err)}`);
  }
  // Per §10: done closes the SSE and empties pending_approvals.
  session.pending_approvals.clear();
  session.stop();
}

function handleError(data: ErrorPayload, session: AgentSession): void {
  try {
    session.ui.showError?.(data.message, data.retryable);
  } catch (err) {
    console.warn(`[agentSession] showError threw: ${String(err)}`);
  }
  // Non-retryable errors terminate the session — see §8.3.
  if (!data.retryable) {
    session.pending_approvals.clear();
    session.stop();
  }
}
