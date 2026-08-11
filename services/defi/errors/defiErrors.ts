/**
 * DeFi error taxonomy.
 *
 * Spec: docs/defi-strategies-spec.md §16. Mirrors
 * `services/errors/paymentErrors.ts` — classification-only module that
 * NEVER returns raw error text to callers. Every branch returns a
 * curated code; the matching `<DefiError>` component owns user-facing
 * copy and gates `devMessage` behind `__DEV__`.
 *
 * The codes are stable wire identifiers: the backend uses the same
 * strings prefixed with `defi_` (e.g. `defi_tier_exceeds_user_policy`)
 * so a backend-thrown error can be classified on-mobile without ever
 * stringifying an HTTP body.
 */

export type DefiErrorCode =
  | "insufficient_funds"
  | "tier_exceeds_user_policy"
  | "protocol_not_in_whitelist"
  | "protocol_not_found"
  | "unsupported_chain"
  | "unsupported_asset"
  | "below_min_deposit"
  | "above_max_deposit"
  | "approval_required"
  | "approval_failed"
  | "deposit_failed"
  | "withdraw_failed"
  | "claim_failed"
  | "rebalance_failed"
  | "rebalance_partial_failure"
  | "apy_drift_too_high"
  | "strategy_paused"
  | "strategy_not_configured"
  | "position_not_found"
  | "cooldown_in_progress"
  | "cooldown_not_started"
  | "no_claimable_balance"
  | "no_onchain_balance"
  | "submission_unconfirmed"
  | "wallet_cannot_execute"
  // Distinct from `unsupported_chain`: the chain is fine, the user just
  // holds no key on it. Merging the two told users a network was
  // unavailable when the real fix was one import away.
  | "no_wallet_on_destination_chain"
  | "network_error"
  | "user_cancelled"
  | "unknown";

const PASSTHROUGH_CODES = new Set<DefiErrorCode>([
  "insufficient_funds",
  "tier_exceeds_user_policy",
  "protocol_not_in_whitelist",
  "protocol_not_found",
  "unsupported_chain",
  "unsupported_asset",
  "below_min_deposit",
  "above_max_deposit",
  "approval_required",
  "approval_failed",
  "deposit_failed",
  "withdraw_failed",
  "claim_failed",
  "rebalance_failed",
  "rebalance_partial_failure",
  "apy_drift_too_high",
  "strategy_paused",
  "strategy_not_configured",
  "position_not_found",
  "cooldown_in_progress",
  "cooldown_not_started",
  "no_claimable_balance",
  "no_onchain_balance",
  "submission_unconfirmed",
  "wallet_cannot_execute",
  "no_wallet_on_destination_chain",
  "network_error",
  "user_cancelled",
  "unknown",
]);

/**
 * Typed error carrying a `DefiErrorCode`. Throw inside adapters /
 * executors when the failure mode is curated; `safeExecute` /
 * `classifyDefiError` map it through cleanly.
 */
export class DefiError extends Error {
  public readonly code: DefiErrorCode;
  constructor(code: DefiErrorCode, detail?: string) {
    super(detail ?? code);
    this.code = code;
    this.name = "DefiError";
  }
}

/**
 * Classify an unknown thrown value into a `DefiErrorCode`. Order matters
 * — typed `DefiError` first, then well-known runtime errors, then
 * `defi_<code>` strings coming back from the backend, then a curated
 * substring scan, finally `unknown`.
 *
 * NEVER returns a raw error message. Every return value is a closed
 * `DefiErrorCode` literal.
 */
export function classifyDefiError(err: unknown): DefiErrorCode {
  if (err instanceof DefiError) return err.code;

  // viem cancellations / user-rejections
  const name =
    (err instanceof Error && err.name) ||
    (err as { name?: string } | null)?.name ||
    "";
  const message =
    (err instanceof Error && err.message) ||
    (err as { message?: string } | null)?.message ||
    "";

  if (
    name === "UserRejectedRequestError" ||
    /user rejected|user denied|cancelled/i.test(message)
  ) {
    return "user_cancelled";
  }
  if (
    name === "InsufficientFundsError" ||
    /insufficient funds|insufficient balance/i.test(message)
  ) {
    return "insufficient_funds";
  }
  if (
    name === "HttpRequestError" ||
    name === "TimeoutError" ||
    name === "RpcRequestError" ||
    /network|fetch|timeout|ECONN|ENOTFOUND/i.test(message)
  ) {
    return "network_error";
  }

  // Backend-thrown errors of the shape `defi_<code>` per spec §16.
  if (typeof message === "string" && message.startsWith("defi_")) {
    const candidate = message.slice("defi_".length) as DefiErrorCode;
    if (PASSTHROUGH_CODES.has(candidate)) return candidate;
  }
  // The error string itself might be the bare code (e.g. when raised
  // from an HTTP wrapper that already stripped the `defi_` prefix).
  if (
    typeof message === "string" &&
    PASSTHROUGH_CODES.has(message as DefiErrorCode)
  ) {
    return message as DefiErrorCode;
  }

  if (__DEV__ && (message || name)) {
    console.warn(
      `[classifyDefiError] no specific mapping for ${name || "unknown"}; surfacing as unknown. Detail:`,
      message || err,
    );
  }
  return "unknown";
}

/**
 * Classify a raw `@mysten/sui` transaction build/execute error into a curated
 * `DefiError` (code + reason) — the STANDARD every Sui/Move DeFi adapter runs
 * its catch-all through (Scallop, and any future Sui venue).
 *
 * A Sui `tx.build()` resolves coins and gas, so it fails with messages like
 * `"Transaction resolution failed: InsufficientCoinBalance in command 1"`,
 * `"No valid gas coins"`, or a `MoveAbort`. Collapsing all of these to a
 * generic `deposit_failed` tells the user nothing and makes the agent invent a
 * misleading "venue unavailable / parameter mismatch" story (the exact bug this
 * fixes). Mapping the balance case to `insufficient_funds` lets the DeFi agent
 * take its correct terminal branch ("you don't have enough — try a smaller
 * amount") and the failure card show "Not enough balance".
 *
 * Never surfaces raw text — the return is always a closed `DefiErrorCode` + a
 * short curated `reason` (CLAUDE.md user-facing-error rule). `fallback` is the
 * flow's terminal code (`deposit_failed` / `withdraw_failed`) used when the
 * message doesn't match a more specific class.
 */
export function classifySuiMoveError(
  err: unknown,
  fallback: DefiErrorCode,
): DefiError {
  if (err instanceof DefiError) return err;
  const message =
    (err instanceof Error && err.message) ||
    (err as { message?: string } | null)?.message ||
    "";
  const lower = message.toLowerCase();

  // Not enough of the input coin, or not enough SUI to cover gas.
  if (
    /insufficientcoinbalance|insufficientgas|no valid gas|gasbalancetoolow|insufficient (balance|coin|fund|gas)|balance.*not enough|not enough.*(balance|coin|fund|gas)/.test(
      lower,
    )
  ) {
    return new DefiError("insufficient_funds", "insufficient_balance");
  }
  // Transport / RPC — retryable.
  if (
    /network|fetch failed|failed to fetch|timeout|timed out|econn|enotfound|deadline exceeded|rate.?limit|rpc error|50[234]/.test(
      lower,
    )
  ) {
    return new DefiError("network_error", "network_error");
  }
  // A Move-level abort (paused market, cap hit, protocol precondition). We
  // can't decode the abort code generically, but flag it distinctly so the
  // agent says "the protocol rejected this" rather than "bad request".
  if (
    /moveabort|move abort|abort code|movePrimitiveRuntimeError/i.test(lower)
  ) {
    return new DefiError(fallback, "protocol_rejected");
  }
  // Safe `__DEV__` read — this module is imported by unit tests where RN's
  // `__DEV__` global isn't defined.
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(
      `[classifySuiMoveError] no specific mapping -> ${fallback}. Detail:`,
      message || err,
    );
  }
  return new DefiError(fallback, "build_failed");
}

/**
 * Friendly copy. Keep strings hand-written per CLAUDE.md user-facing
 * error rule — never echo raw error text. The optional `cta` is a
 * semantic action; the rendering component maps it to a handler.
 */
export interface DefiErrorCopy {
  title: string;
  body: string;
  cta?: "retry" | "review" | "topup" | "configure" | "wait";
}

export const defiErrorCopy: Record<DefiErrorCode, DefiErrorCopy> = {
  insufficient_funds: {
    title: "Not enough balance",
    body: "Your wallet doesn't have enough to complete this action.",
    cta: "topup",
  },
  tier_exceeds_user_policy: {
    title: "Outside your safety preferences",
    body: "This opportunity is riskier than your strategy allows. Update your tier in Strategies → Settings to use it.",
    cta: "configure",
  },
  protocol_not_in_whitelist: {
    title: "Protocol not allowed",
    body: "This protocol isn't on your whitelist. Add it in Strategies → Settings or pick another option.",
    cta: "configure",
  },
  protocol_not_found: {
    title: "Protocol unavailable",
    body: "We couldn't find this protocol on the selected chain. Please try a different option.",
    cta: "review",
  },
  unsupported_chain: {
    title: "Chain not supported",
    body: "This action isn't supported on the current chain. Switch chains and try again.",
    cta: "review",
  },
  unsupported_asset: {
    title: "Asset not supported",
    body: "The selected asset isn't supported by this protocol. Pick another asset.",
    cta: "review",
  },
  below_min_deposit: {
    title: "Amount too small",
    body: "This protocol requires a larger minimum deposit. Increase the amount and try again.",
    cta: "review",
  },
  above_max_deposit: {
    title: "Amount too large",
    body: "The protocol's vault is at capacity right now. Try a smaller amount.",
    cta: "review",
  },
  approval_required: {
    title: "Approval needed",
    body: "We need to approve the token before depositing. Please confirm the next prompt.",
  },
  approval_failed: {
    title: "Approval didn't go through",
    body: "We couldn't complete the token approval step. Please try again.",
    cta: "retry",
  },
  deposit_failed: {
    title: "Deposit didn't complete",
    body: "We couldn't finish the deposit. No funds were moved.",
    cta: "retry",
  },
  withdraw_failed: {
    title: "Withdrawal didn't complete",
    body: "We couldn't finish the withdrawal. Your position is unchanged.",
    cta: "retry",
  },
  claim_failed: {
    title: "Claim didn't complete",
    body: "We couldn't claim the rewards right now. Please try again.",
    cta: "retry",
  },
  rebalance_failed: {
    title: "Rebalance didn't complete",
    body: "We couldn't complete the rebalance. Your original position is unchanged.",
    cta: "retry",
  },
  rebalance_partial_failure: {
    title: "Rebalance partially completed",
    body: "The first leg succeeded but the second leg didn't. Your funds are safe in the new chain wallet — open the position to continue.",
    cta: "review",
  },
  apy_drift_too_high: {
    title: "Yield changed",
    body: "The rate moved significantly since this was suggested. We paused to let you confirm the updated numbers.",
    cta: "review",
  },
  strategy_paused: {
    title: "Strategy is paused",
    body: "Your strategy is on hold. Resume it from Strategies → Settings to keep using it.",
    cta: "configure",
  },
  strategy_not_configured: {
    title: "Strategy not set up yet",
    body: "Set up your strategy preferences first, then try again.",
    cta: "configure",
  },
  position_not_found: {
    title: "Position not found",
    body: "We couldn't find the position you asked about. Refresh and try again.",
    cta: "retry",
  },
  cooldown_in_progress: {
    title: "Cooldown in progress",
    body: "This protocol enforces a waiting period before withdrawal. We'll notify you when it's ready.",
    cta: "wait",
  },
  cooldown_not_started: {
    title: "Start cooldown first",
    body: "You need to start the cooldown period before claiming. Tap Begin Cooldown to start.",
    cta: "review",
  },
  no_claimable_balance: {
    title: "Nothing to claim yet",
    body: "There are no rewards ready to claim right now. Check back later.",
    cta: "wait",
  },
  no_onchain_balance: {
    title: "Nothing to move",
    body: "This position has no on-chain balance to withdraw right now. Refresh your positions and try again.",
    cta: "retry",
  },
  submission_unconfirmed: {
    title: "Couldn't confirm",
    body: "We sent the transaction but couldn't confirm it in time. Check your activity feed before trying again — it may have gone through.",
    cta: "review",
  },
  wallet_cannot_execute: {
    title: "Wallet can't sign",
    body: "This wallet can't sign transactions. Switch to a wallet with signing enabled.",
    cta: "review",
  },
  no_wallet_on_destination_chain: {
    title: "No wallet on that chain",
    body: "You don't have a wallet on the destination chain yet. Add one, then try again.",
    cta: "review",
  },
  network_error: {
    title: "Network issue",
    body: "We couldn't reach the network. Check your connection and try again.",
    cta: "retry",
  },
  user_cancelled: {
    title: "Cancelled",
    body: "You cancelled this action. No funds were moved.",
  },
  unknown: {
    title: "Something went wrong",
    body: "We hit an unexpected issue. Please try again, or contact support if it keeps happening.",
    cta: "retry",
  },
};
