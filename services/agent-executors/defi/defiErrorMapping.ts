/**
 * `DefiErrorCode` → `ExecutorErrorCode`: the coarse class the agent branches on.
 *
 * The write executors used to throw EVERY failure as `invalid_input`, carrying
 * the real code only in `reason`. `invalid_input` renders as "I couldn't read
 * that request. Try rephrasing what you want." and tells the agent the user's
 * PARAMETERS were bad — so on a reverted dry-run (nothing wrong with the
 * parameters at all) the agent re-sent the identical call, then invented
 * explanations for it: wrong decimals, wrong pool id, "approve it in your
 * wallet settings". None of that was true; the wallet simply held none of the
 * asset.
 *
 * `services/agent-executors/defi/intentExecutors.ts` had already learned this
 * on the Sui path. This is that mapping, shared, so the two cannot drift.
 */

import type { DefiErrorCode } from "@/services/defi/errors/defiErrors";
import { classifyDefiError } from "@/services/defi/errors/defiErrors";
import {
  ExecutorError,
  ExecutorErrorCode,
  type ExecutorErrorCodeValue,
} from "../types";

export function toExecutorErrorCode(
  code: DefiErrorCode,
): ExecutorErrorCodeValue {
  switch (code) {
    // Terminal "not enough / nothing to act on". The agent states it plainly
    // and stops — re-sending cannot help, and neither can rephrasing.
    case "insufficient_funds":
    case "no_onchain_balance":
    case "no_claimable_balance":
      return ExecutorErrorCode.InsufficientFunds;
    case "unsupported_chain":
      return ExecutorErrorCode.UnsupportedChain;
    case "wallet_cannot_execute":
      return ExecutorErrorCode.WalletCannotExecute;
    case "network_error":
      return ExecutorErrorCode.NetworkError;
    // The world moved between prepare and execute: re-quote / re-preview, do
    // not re-send. `stale_precondition` is exactly this recovery class.
    case "apy_drift_too_high":
    case "quote_expired":
    case "slippage_too_high":
    case "duplicate_submission":
      return ExecutorErrorCode.StalePrecondition;
    // A genuine build/execution failure — retryable in principle, but NOT a
    // parameter problem, so never `invalid_input`.
    case "deposit_failed":
    case "withdraw_failed":
    case "claim_failed":
    case "rebalance_failed":
    case "rebalance_partial_failure":
    case "approval_failed":
    case "submission_unconfirmed":
      return ExecutorErrorCode.Unknown;
    // Genuinely about what was asked for: an asset/protocol/amount the caller
    // named that this venue will not take.
    case "unsupported_asset":
    case "protocol_not_found":
    case "position_not_found":
    case "below_min_deposit":
    case "above_max_deposit":
      return ExecutorErrorCode.InvalidInput;
    default:
      // Policy rejections, safety-pipeline verdicts and everything else: the
      // curated `reason` carries the specifics, and `unknown_error` at least
      // does not assert something false about the user's request.
      return ExecutorErrorCode.Unknown;
  }
}

/**
 * Classify a thrown value and wrap it as the `ExecutorError` the executor
 * contract expects: coarse code + the curated `DefiErrorCode` as `reason`.
 */
export function toExecutorError(err: unknown): ExecutorError {
  if (err instanceof ExecutorError) return err;
  const code = classifyDefiError(err);
  return new ExecutorError(toExecutorErrorCode(code), code);
}
