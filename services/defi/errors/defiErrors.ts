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
  /** Withdraw-only: requested amount exceeds the position's live on-chain
   *  balance. Distinct from `no_onchain_balance` (zero) — this is a
   *  too-large PARTIAL withdraw, caught pre-signing instead of reverting
   *  on-chain and burning gas. */
  | "withdraw_exceeds_balance"
  | "submission_unconfirmed"
  | "wallet_cannot_execute"
  // Distinct from `unsupported_chain`: the chain is fine, the user just
  // holds no key on it. Merging the two told users a network was
  // unavailable when the real fix was one import away.
  | "no_wallet_on_destination_chain"
  | "network_error"
  | "user_cancelled"
  // ── EVM protocol expansion (docs/defi-evm-protocol-expansion-spec.md §11.2)
  // Each maps to one safety layer, so a blocked deposit can be explained
  // without ever showing the user the machine reason.
  /** L1: the resolved destination is an EOA or undeployed. */
  | "target_not_a_contract"
  /** L1: the destination is not in the pinned address-book / router allowlist. */
  | "target_not_allowlisted"
  /** L1: keccak256(abi.encode(params)) != marketId (Morpho Blue). */
  | "market_id_mismatch"
  /** L1: the market's oracle/IRM is not on the reviewed allowlist. */
  | "oracle_not_allowlisted"
  /** L2: the vault/market cannot accept this much right now. */
  | "deposit_cap_exceeded"
  /** L2/L4: the slippage budget was exceeded or a minimum could not be set. */
  | "slippage_too_high"
  /** L4: the router quote aged out before signing. */
  | "quote_expired"
  /** L5: the protocol's own emergency state is engaged. */
  | "protocol_paused"
  /** L4: the decoded call does not match what the user approved. */
  | "decoded_intent_mismatch"
  /** L3: this would put too much of the user's funds in one protocol. */
  | "exposure_cap_exceeded"
  /** L3: ops disabled the family (rollout flag or kill-switch). */
  | "family_disabled"
  /** L2/L4: the amount was scaled with the wrong decimals. */
  | "decimals_mismatch"
  /** L3: the counterparty is on a sanctions/deny list. */
  | "counterparty_blocked"
  /** L5: mined, but not yet past the chain's finality depth. Pending, not failed. */
  | "awaiting_finality"
  /** L4: an identical intent is already in flight. */
  | "duplicate_submission"
  /** L3: too many deposits in the rolling window. */
  | "velocity_exceeded"
  /** L1/L3: the pool's APY/TVL is statistically implausible. */
  | "pool_anomaly_flagged"
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
  "withdraw_exceeds_balance",
  "submission_unconfirmed",
  "wallet_cannot_execute",
  "no_wallet_on_destination_chain",
  "network_error",
  "user_cancelled",
  "target_not_a_contract",
  "target_not_allowlisted",
  "market_id_mismatch",
  "oracle_not_allowlisted",
  "deposit_cap_exceeded",
  "slippage_too_high",
  "quote_expired",
  "protocol_paused",
  "decoded_intent_mismatch",
  "exposure_cap_exceeded",
  "family_disabled",
  "decimals_mismatch",
  "counterparty_blocked",
  "awaiting_finality",
  "duplicate_submission",
  "velocity_exceeded",
  "pool_anomaly_flagged",
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
  withdraw_exceeds_balance: {
    title: "Amount too large",
    body: "You're trying to withdraw more than this position currently holds. Lower the amount and try again.",
    cta: "review",
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
  // ── EVM protocol expansion (§11.2) ──────────────────────────────────────
  // Copy stays hand-written and layer-agnostic: the user needs to know what to
  // do, not which check fired. The machine reason goes to __DEV__ logs only.
  target_not_a_contract: {
    title: "Couldn't verify this pool",
    body: "We couldn't confirm this pool's contract on-chain, so we stopped before moving any funds. Try another option.",
    cta: "review",
  },
  target_not_allowlisted: {
    title: "Pool not approved",
    body: "This pool isn't on our reviewed list yet, so we can't deposit into it in-app. You can still open it on the protocol's own site.",
    cta: "review",
  },
  market_id_mismatch: {
    title: "Couldn't verify this market",
    body: "This market's details didn't line up when we checked them on-chain. We stopped before moving any funds.",
    cta: "review",
  },
  oracle_not_allowlisted: {
    title: "Market not approved",
    body: "This market uses a price feed we haven't reviewed, so we don't route deposits into it. Please pick another option.",
    cta: "review",
  },
  deposit_cap_exceeded: {
    title: "Pool is at capacity",
    body: "This pool can't take the full amount right now. Try a smaller amount, or pick another option.",
    cta: "review",
  },
  slippage_too_high: {
    title: "Price moved too much",
    body: "The rate moved more than we allow while preparing this deposit. Nothing was sent. Please try again.",
    cta: "retry",
  },
  quote_expired: {
    title: "Quote expired",
    body: "The price we prepared is no longer current. Please try again to get a fresh one.",
    cta: "retry",
  },
  protocol_paused: {
    title: "Protocol is paused",
    body: "This protocol has paused deposits on its side. Please try again later or choose another option.",
    cta: "wait",
  },
  decoded_intent_mismatch: {
    title: "Something didn't match",
    body: "The transaction didn't match what you approved, so we cancelled it. No funds were moved.",
    cta: "review",
  },
  exposure_cap_exceeded: {
    title: "Too much in one protocol",
    body: "This would put more of your funds in a single protocol than your settings allow. Spread it out, or raise the limit in Strategies, Settings.",
    cta: "configure",
  },
  family_disabled: {
    title: "Temporarily unavailable",
    body: "Deposits into this type of pool are turned off right now. Please try another option.",
    cta: "review",
  },
  decimals_mismatch: {
    title: "Amount didn't check out",
    body: "We couldn't confirm the amount matched the token's units, so we stopped. No funds were moved.",
    cta: "retry",
  },
  counterparty_blocked: {
    title: "Can't continue",
    body: "We're not able to process this one. Please choose another option or contact support.",
    cta: "review",
  },
  awaiting_finality: {
    title: "Confirming",
    body: "Your transaction is on-chain and we're waiting for it to settle. We'll update your position shortly.",
    cta: "wait",
  },
  duplicate_submission: {
    title: "Already in progress",
    body: "This deposit is already being processed. Check your activity feed before trying again.",
    cta: "review",
  },
  velocity_exceeded: {
    title: "Too many deposits",
    body: "You've hit the limit for how many deposits can be made in a short window. Please try again later.",
    cta: "wait",
  },
  pool_anomaly_flagged: {
    title: "Pool under review",
    body: "This pool's numbers look unusual, so we've paused in-app deposits into it while we check. Please pick another option.",
    cta: "review",
  },
  unknown: {
    title: "Something went wrong",
    body: "We hit an unexpected issue. Please try again, or contact support if it keeps happening.",
    cta: "retry",
  },
};
