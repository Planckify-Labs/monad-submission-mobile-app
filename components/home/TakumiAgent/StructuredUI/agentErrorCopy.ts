/**
 * agentErrorCopy — the single mapping from an agent tool failure to
 * user-facing copy.
 *
 * A failed `ToolResult` carries two curated strings (see
 * `services/agent-executors/types.ts`):
 *   - `error`  — the COARSE code from the closed `ExecutorErrorCode` taxonomy
 *                (`stale_precondition`, `insufficient_funds`, …). The agent
 *                branches on this; it changes rarely.
 *   - `reason` — the OPTIONAL granular sub-reason (`intent_expired`,
 *                `quote_stale`, `amount_below_minimum`, …). Open per-tool
 *                detail, set from the thrown `ExecutorError.message`.
 *
 * Every failure card runs both through here so it can be specific WITHOUT ever
 * rendering a raw code (CLAUDE.md user-facing-errors). Lookup prefers the more
 * specific `reason`, then falls back to the coarse `error`, then a friendly
 * generic line. New protocols get sensible copy for free: their failures land
 * on an existing coarse code, and a bespoke `reason` only needs an entry here
 * if it deserves more specific wording than its code's default.
 *
 * All copy is hand-written — no raw runtime / response text reaches the user.
 */

const COPY: Record<string, string> = {
  // --- coarse ExecutorErrorCode taxonomy --------------------------------
  stale_precondition:
    "Conditions changed before this could run. Let me re-check and prepare a fresh plan.",
  insufficient_funds:
    "You don't have enough balance for this, including a little for gas.",
  network_error: "The network is busy right now. Please try again in a moment.",
  unsupported_chain: "That isn't available on this network yet.",
  wallet_type_cannot_execute: "This wallet can't sign transactions.",
  not_implemented: "That isn't supported here yet.",
  invalid_input: "I couldn't read that request. Try rephrasing what you want.",

  // --- granular reasons (more specific than their coarse code) ----------
  // stale_precondition family
  intent_expired: "That plan expired. Let me prepare a fresh one.",
  intent_no_longer_safe:
    "The on-chain situation moved since I prepared this. Let me re-check and offer a safer plan.",
  quote_stale:
    "The price moved while preparing this. Let me get a fresh quote.",
  // insufficient_funds family
  insufficient_balance:
    "You don't have enough balance for this, including a little for gas.",
  // invalid_input family
  invalid_intent: "I couldn't read that plan. Try rephrasing what you want.",
  unsupported_asset: "That asset isn't available on this network.",
  no_onchain_balance: "You don't hold that asset on this network.",
  // swap-specific reasons surfaced by the Sui Intent preview path
  amount_below_minimum:
    "That amount is below the minimum for this swap. Try a larger amount.",
  no_swap_route: "I couldn't find a swap route for that pair right now.",
  unsupported_pair: "That token pair isn't available to swap here.",
};

const FALLBACK =
  "I couldn't complete that right now. Try again in a moment, or adjust the amount.";

/**
 * Resolve `(error, reason)` to friendly copy. Prefers the granular `reason`,
 * then the coarse `error`, then a generic fallback.
 */
export function agentErrorCopy(
  error: string | undefined,
  reason?: string | undefined,
): string {
  return (reason && COPY[reason]) || (error && COPY[error]) || FALLBACK;
}
