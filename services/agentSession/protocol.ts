/**
 * Protocol types shared between the Takumi Agent API server and this
 * mobile app.
 *
 * SOURCE OF TRUTH: `takumi-agent-api/src/session/types.ts` — do NOT cross-
 * import from the sibling package. These types are mirrored here verbatim
 * so the mobile build is self-contained. If the server type file changes,
 * update this file to match and bump any call sites.
 *
 * Cross-reference:
 *   AGENT_PROTOCOL.md §4 "Transport"
 *   AGENT_PROTOCOL.md §8 "The Message Protocol"
 *   AGENT_PROTOCOL.md §9 "Server-Side Agent Loop"
 *   AGENT_PROTOCOL.md §10 "Mobile-Side Contract"
 */

// --- Wallet context (sent by mobile on POST /chat) --------------------------

/**
 * Public wallet information injected into every `POST /chat` request.
 * Mirrors `WalletContext` in the server types file.
 *
 * The agent only ever sees the public address — the private key and seed
 * phrase must never leave the device.
 *
 * Address format: EVM wallets send a `0x`-prefixed hex address; Solana
 * wallets send a base58 public key. The server accepts either — see
 * `chat.schemas.ts` on the agent API. The `namespace` field is the
 * authoritative discriminator.
 */
export interface WalletContext {
  address: string;
  /**
   * Chain namespace the wallet is active on. Omitted for legacy EVM
   * clients; the server defaults to `"eip155"` when absent. The server
   * treats unknown wallet_context keys as opaque metadata, so emitting
   * a namespace value the server doesn't yet recognise (e.g. `"sui"`
   * before the server protocol bumps) is type-safe — the field is
   * forward-compatible per AGENT_PROTOCOL §13.
   */
  namespace?: "eip155" | "solana" | "sui" | "stellar";
  /**
   * Numeric chain id for EVM chains. For non-EVM chains this is `0` —
   * the server only reads it to surface in the system prompt and to
   * stamp conversation rows, so a sentinel is fine.
   */
  chain_id: number;
  chain_name: string;
  chain_symbol: string;
  label?: string;
  /**
   * Whether the mobile has a stored access token for the points /
   * redemption API keyed to this wallet address. Computed locally by
   * `checkPointsAuth()` before every `POST /chat` — the server never
   * mints or validates this flag, it's purely a hint that lets the
   * agent skip `request_authentication` when the user is already
   * signed in. Added in protocol v1.1 §13.
   */
  points_authenticated?: boolean;
  /**
   * Every namespace the device actually holds a wallet on.
   *
   * `namespace` above describes only the ACTIVE wallet, which told the
   * server nothing about what else the user can reach. A seed phrase
   * derives all four, but a private-key import covers exactly one — so
   * the model was proposing Sui deposits and Solana bridges to users who
   * had no key on those chains, and only found out when the executor
   * refused. The server's DeFi prompt even asserted the opposite ("the
   * device already holds every wallet they own"), which is true for seed
   * users and false for imports.
   *
   * Sending the inventory lets the model avoid the dead end instead of
   * walking into it. Omitted by older clients; the server treats absence
   * as "unknown" and says nothing about ownership rather than guessing.
   */
  owned_namespaces?: Array<"eip155" | "solana" | "sui" | "stellar">;
}

// --- Tool classification ----------------------------------------------------

/**
 * Factual classification of what a tool does. The mobile maps capability
 * to a UX treatment via `resolveUxTreatment` — the server never dictates
 * friction level, it only declares the action type.
 */
export type ToolCapability = "read" | "write";

/**
 * Logical grouping for policy rules. Kept as a widened string to match
 * the server type — the server upstream may extend the enum without
 * coordinating a mobile release, and the mobile should treat unknown
 * categories as opaque metadata.
 */
export type ToolCategory = string;

// --- SSE event payloads (server → mobile) ----------------------------------

/** `text_delta` — a streaming chunk of assistant text. */
export interface TextDeltaPayload {
  content: string;
}

/** `status` — a lightweight progress indicator label ("Checking balance…"). */
export interface StatusPayload {
  message: string;
}

/**
 * `tool_pending` — emitted for every tool with `executor: "mobile"`. The
 * mobile MUST execute and reply via `POST /chat/respond` (or reject).
 *
 * Mirrors `ToolPendingPayload` in the server types file.
 */
export interface ToolPendingPayload {
  session_id: string;
  tool_call_id: string;
  name: string;
  input: Record<string, unknown>;
  meta: {
    executor: "mobile";
    capability: ToolCapability;
    category: ToolCategory;
    human_summary: string;
    amount_usd?: number;
  };
  /**
   * Optional id of the agent that emitted this tool call (e.g. "wallet",
   * "defi"). Mobile renders a "via X specialist" badge when set and not
   * equal to "core"/"wallet" (Task 17). Old clients that ignore this
   * field keep working — backwards-compat verified by the Task 20 e2e.
   *
   * Mirrors the server-side `ToolPendingPayload.origin_agent_id` added
   * in `agent-api/src/session/types.ts`.
   */
  origin_agent_id?: string;
}

/**
 * Narrative pass-through markers (spec §6.4). The server emits
 * `narrative_handoff` immediately before the specialist's first text
 * delta and `narrative_handoff_end` after the last. Mobile sets
 * `originAgentId` on the assistant message being assembled so
 * `MessageContent.tsx` renders a "via X specialist" badge.
 */
export interface NarrativeHandoffPayload {
  origin_agent_id: string;
}

/**
 * `tool_executed` — informational event emitted after a server-side
 * (non-onchain) tool completes. Mobile uses it to render intermediate
 * state (e.g. a product list, a booking preview). No response required.
 */
export interface ToolExecutedPayload {
  tool_call_id: string;
  name: string;
  display_result: unknown;
}

/** `done` — the agent has finished reasoning; mobile closes the SSE. */
export interface DonePayload {
  session_id: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  };
  /** Set when the turn was tied to a persisted conversation. */
  conversation_id?: string;
  /** Title of the active conversation. */
  conversation_title?: string;
}

/** `error` — terminal or transient failure surfaced from the agent loop. */
export interface ErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * Discriminated union of every SSE event the server can emit.
 *
 * The mobile dispatcher MUST exhaust this union — unknown events are
 * logged but must not crash the session (see `agentSession.ts`).
 */
export type AgentEvent =
  | { event: "text_delta"; data: TextDeltaPayload }
  | { event: "status"; data: StatusPayload }
  | { event: "tool_pending"; data: ToolPendingPayload }
  | { event: "tool_executed"; data: ToolExecutedPayload }
  | { event: "narrative_handoff"; data: NarrativeHandoffPayload }
  | { event: "narrative_handoff_end"; data: NarrativeHandoffPayload }
  | { event: "done"; data: DonePayload }
  | { event: "error"; data: ErrorPayload };

// --- Mobile → server response (POST /chat/respond) --------------------------

/**
 * The `ToolResult` body returned on success. Identical shape to
 * `services/agent-executors/types.ts` — kept as a structural type here
 * so this file doesn't import from the executor package (which pulls in
 * viem + native modules).
 *
 * Mirrors `ToolResult` in the server types file.
 */
export interface ToolResult {
  status: "success" | "failed";
  tx_hash?: `0x${string}`;
  tx_confirmed?: boolean;
  /**
   * Agent-facing payload. Should stay compact — ids, counts, filters —
   * because the whole thing lands in the LLM context window on every
   * subsequent turn. Rich, UI-specific data belongs in `display`.
   */
  data?: unknown;
  /**
   * UI-facing payload. The mobile executor puts the full rich object
   * here (product grids, balance rows, swap quotes, …). The server
   * strips this slice before feeding tool results to `streamText`, so
   * it never enters LLM context — but it IS persisted in `contentJson`
   * so historical replay renders the same card on reload.
   *
   * Cards read `output.display ?? output.data ?? output` so absence is
   * a no-op.
   */
  display?: unknown;
  error?: string;
  /** Backend transaction record id, set when the executor recorded history. */
  transaction_id?: string;
}

/**
 * Mobile response body posted back to `POST /chat/respond`. Either a
 * successful tool result or a rejection with a reason string.
 *
 * Mirrors `MobileResponse` in the server types file.
 */
export type MobileResponse =
  | {
      type: "tool_result";
      session_id: string;
      tool_call_id: string;
      result: ToolResult;
    }
  | {
      type: "tool_rejected";
      session_id: string;
      tool_call_id: string;
      /**
       * Short fixed token, never raw error text (user-facing-error rule).
       * `permission_denied` (deny-layer spec §6.6) means the capability is
       * not authorised at all — semantically distinct from `user_declined`
       * ("the user said no to this specific action"). The agent-api system
       * prompts must handle the two differently (§4.2). The union stays
       * open (`| string`) for forward-compatible reasons.
       */
      reason:
        | "user_declined"
        | "permission_denied"
        | "insufficient_funds"
        | "network_error"
        | "wallet_type_cannot_execute"
        | string;
    };

// --- POST /chat request body ------------------------------------------------

/**
 * Body of `POST /chat/progress` — sent by the mobile when a tool call
 * has been pending on the device for longer than the client-side delay
 * threshold (~3s). The server answers with a short natural-voice "please
 * wait" streamed as `text_delta` events on the already-open SSE.
 * See AGENT_PROTOCOL.md §8.5.
 */
export interface ProgressRequest {
  session_id: string;
  tool_call_id: string;
  /** Optional hint; free-form string for forward compatibility. */
  reason?: string;
}

/**
 * Body of the initial `POST /chat` request that opens the SSE stream.
 * `messages` is a loose `unknown[]` because mobile-side message shapes
 * come from the `ai` SDK and vary by user input; the server validates.
 *
 * On reconnect (see §4 "SSE Reconnect Mid-Turn") the mobile re-sends this
 * with the existing `session_id` and an empty `messages` array.
 */
export interface ChatRequest {
  session_id?: string;
  messages: unknown[];
  wallet_context: WalletContext;
  /** When resuming a persisted conversation, pass its id so the server loads prior context. */
  conversation_id?: string;
}
