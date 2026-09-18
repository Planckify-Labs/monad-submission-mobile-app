/**
 * `services/errors/paymentErrors.ts` — consolidated payer-facing error
 * taxonomy for the UMKM USDC-payout flow (scan → sign → submit → settle).
 *
 * Spec: `docs/umkm-usdc-payout-spec.md` §9.1 (Error-States Matrix).
 *
 * What lives here:
 *   - `PaymentErrorCode` — the exhaustive union of codes rendered by
 *     `<PaymentError>`. Task 18's M2 happy-path codes are the first
 *     block; M3+ signing / bundler / FX / intent-state codes follow.
 *   - `classifyPaymentError(err)` — single classifier consolidated out
 *     of `app/pay-merchant.tsx`. Matches by `name` / `status` / regex on
 *     `message`. NEVER reads `signature`, `nonce`, or raw typed-data.
 *   - `paymentErrorCopy` — `{ title, body, cta? }` per code. Primary
 *     `title`/`body` are plain English per the copy-audience rule: no
 *     USDC / chain / gas / signature language. Details stay in the body
 *     secondary line at most (e.g. "Rescan the merchant QR" ok;
 *     "signature invalid" not ok).
 *
 * Rules (non-negotiable):
 *   - Three-role separation — this module is classification-only. It
 *     does not fetch, mutate, or sign anything.
 *   - Chain-extension discipline — no `if (ns === "X")` anywhere. A
 *     wallet-kit that doesn't implement a capability is surfaced via
 *     the `wallet_unsupported` code, not a namespace branch.
 *   - Never leak sensitive values — `classifyPaymentError` reads only
 *     `err.name`, `err.status`, and regex-tests on `err.message`. It
 *     never returns the raw message to the caller.
 */

/**
 * Exhaustive set of payer-facing error codes across M1→M6.
 *
 * M2 happy-path codes (landed with task 18):
 *   - `insufficient_funds`, `insufficient_fee`, `user_cancelled`, `network`,
 *     `quote_expired`, `backend_not_ready`, `chain_mismatch`,
 *     `wallet_unsupported`, `unknown`.
 *
 * M3 expansion codes (reserved for when signing/bundler/FX wire in):
 *   - `signing_failed` — EIP-712 typed-data signing rejected for a
 *     non-user-cancel reason (adapter threw a typed error).
 *   - `bundler_rejected` — ERC-4337 bundler refused the UserOp
 *     (task 35 paymaster path).
 *   - `fx_unavailable` — FX quote service offline / stale.
 *   - `intent_conflict` — server-side race (e.g. intent already
 *     claimed / settled by a concurrent device).
 *   - `deposit_required` — `gasless.requiresDeposit: true` on first
 *     payment (§9.1 `REQUIRES_DEPOSIT`).
 *   - `rate_limited` — 429 from the API.
 *   - `unauthorized` — 401 from the API (session expired).
 *   - `server_error` — catch-all for 5xx that isn't `backend_not_ready`.
 */
export type PaymentErrorCode =
  | "insufficient_funds"
  | "insufficient_fee"
  | "user_cancelled"
  | "network"
  | "quote_expired"
  | "backend_not_ready"
  | "chain_mismatch"
  | "wallet_unsupported"
  | "signing_failed"
  | "bundler_rejected"
  | "fx_unavailable"
  | "intent_conflict"
  | "deposit_required"
  | "rate_limited"
  | "unauthorized"
  | "merchant_deactivated"
  | "server_error"
  | "settlement_unconfirmed"
  | "payment_not_completed"
  | "unknown";

/** Primary CTA semantic action — the component maps this to a handler prop. */
export type PaymentErrorCtaAction =
  | "retry"
  | "back"
  | "rescan"
  | "topup"
  | "invite_merchant";

export interface PaymentErrorCopy {
  title: string;
  body: string;
  cta?: { label: string; action: PaymentErrorCtaAction };
}

/**
 * What the payer was actually paying with, for the codes whose copy has
 * to name it. Nothing here is ever assumed: a Monad AUSD payment says
 * "AUSD" and "MON", a nanopay one says "USDC", and when a caller cannot
 * say (token list still loading) the copy falls back to "your balance"
 * rather than guessing a currency.
 */
export interface PaymentErrorContext {
  /** Symbol of the token the payment settles in, e.g. "AUSD", "USDC". */
  tokenSymbol?: string;
  /** Symbol of the network's own coin that pays the fee, e.g. "MON". */
  feeSymbol?: string;
  /** Network display name, e.g. "Monad Testnet". */
  networkName?: string;
  /** Formatted fee the call needs, e.g. "0.044", when known. */
  feeNeeded?: string;
  /** Formatted native balance the wallet has, e.g. "0.023", when known. */
  feeHave?: string;
}

/**
 * Copy for `code`, with the two balance codes phrased for the actual
 * payment. Everything else is the static table.
 */
export function resolvePaymentErrorCopy(
  code: PaymentErrorCode,
  ctx: PaymentErrorContext = {},
): PaymentErrorCopy {
  // Neither balance code offers a top-up: there is no in-app way to buy
  // AUSD/MON here, so a "Top up" button would be a promise nothing keeps.
  // The way out is the one the pay screen actually has — another wallet
  // (Pay from) or another token (Pay with) — which is one step back.
  if (code === "insufficient_funds") {
    const t = ctx.tokenSymbol;
    return {
      title: t ? `Not enough ${t}` : "Not enough balance",
      body: t
        ? `This wallet doesn't have enough ${t} for this payment. Choose another wallet, or pay with a different token.`
        : "This wallet doesn't have enough for this payment. Choose another wallet, or pay with a different token.",
      cta: { label: "Change wallet or token", action: "back" },
    };
  }
  if (code === "insufficient_fee") {
    const f = ctx.feeSymbol;
    const n = ctx.networkName ?? "this network";
    const hasNone = ctx.feeHave === undefined || Number(ctx.feeHave) === 0;
    const title = f
      ? hasNone
        ? `This wallet has no ${f}`
        : `Not enough ${f} for the fee`
      : "This wallet can't cover the fee";
    let body: string;
    if (f && ctx.feeNeeded && ctx.feeHave && !hasNone) {
      body = `Paying on ${n} costs about ${ctx.feeNeeded} ${f} in fees, and this wallet has ${ctx.feeHave} ${f}. Add a little ${f}, or choose a wallet that has some.`;
    } else if (f) {
      body = `Paying on ${n} costs a small fee in ${f}, and this wallet has none. Choose a wallet that has some ${f}, or pay on a different network.`;
    } else {
      body = `Paying on ${n} costs a small fee that this wallet can't cover. Choose another wallet, or pay on a different network.`;
    }
    return {
      title,
      body,
      cta: { label: "Change wallet or network", action: "back" },
    };
  }
  return paymentErrorCopy[code];
}

/**
 * Classifies an error thrown by the sign → submit pipeline (or any call
 * the pay screen makes) into the payer-facing `PaymentErrorCode`
 * taxonomy. Lifted verbatim from task 18's inline `classifyError` and
 * extended with M3+ codes.
 *
 * Matching order is intentional:
 *   1. Typed error `name` first — deterministic, locale-independent.
 *   2. HTTP status on API errors — same.
 *   3. Regex on `message` as the last resort — only for SDK-adjacent
 *      errors that don't set a typed `name` (wallet-kit rejections).
 *
 * We never return the raw message. `devMessage` is the caller's
 * responsibility to attach separately (in `__DEV__` only).
 */
export function classifyPaymentError(err: unknown): PaymentErrorCode {
  if (!err || typeof err !== "object") {
    return "unknown";
  }
  const e = err as {
    name?: string;
    message?: string;
    status?: number | null;
    response?: { status?: number };
  };

  // ── 1. Typed error names from services/nanopay and signer adapters ──

  if (e.name === "AuthorizationValidityTooShortError") {
    return "quote_expired";
  }
  if (e.name === "SourceChainMismatchError") {
    return "chain_mismatch";
  }
  if (
    e.name === "MissingNanopayPayloadError" ||
    e.name === "MissingNanopayDomainError"
  ) {
    return "unknown";
  }

  // M3: signer adapters throwing typed errors (not user-cancel).
  if (
    e.name === "SigningFailedError" ||
    e.name === "TypedDataBuildError" ||
    e.name === "InvalidSignatureError"
  ) {
    return "signing_failed";
  }

  // M3: ERC-4337 bundler rejections (task 35 paymaster path).
  if (
    e.name === "BundlerRejectedError" ||
    e.name === "UserOpSubmitError" ||
    e.name === "PaymasterUnavailableError"
  ) {
    return "bundler_rejected";
  }

  // M3: FX quote unavailable (task 26 channels + FX).
  if (e.name === "FxQuoteUnavailableError" || e.name === "FxStaleError") {
    return "fx_unavailable";
  }

  // M3: deposit-required onboarding (task 36/38 gateway deposit).
  if (e.name === "DepositRequiredError") {
    return "deposit_required";
  }

  // M3: server-side intent race (e.g. already claimed / settled).
  if (e.name === "IntentConflictError") {
    return "intent_conflict";
  }

  // ── 2. HTTP status from nanopay + ky (services/nanopay/submit.ts) ──

  const httpStatus =
    typeof e.status === "number"
      ? e.status
      : typeof e.response?.status === "number"
        ? e.response.status
        : null;

  if (e.name === "NanopaySubmitError") {
    if (httpStatus === 404) return "backend_not_ready";
    if (httpStatus === 409) return "intent_conflict";
    if (httpStatus === 410) return "quote_expired";
    if (httpStatus === 429) return "rate_limited";
    if (httpStatus === 401) return "unauthorized";
    if (httpStatus !== null && httpStatus >= 500) return "server_error";
    return "network";
  }

  // Generic API envelopes (e.g. ApiHttpError from `constants/configs/ky`).
  if (httpStatus !== null) {
    if (httpStatus === 401) return "unauthorized";
    if (httpStatus === 403) {
      if (/deactivat|MERCHANT_DEACTIVATED/i.test(e.message ?? "")) {
        return "merchant_deactivated";
      }
    }
    if (httpStatus === 404) return "backend_not_ready";
    if (httpStatus === 409) return "intent_conflict";
    if (httpStatus === 410) return "quote_expired";
    if (httpStatus === 429) return "rate_limited";
    if (httpStatus >= 500) return "server_error";
  }

  // ── 3. Message regex fallback — wallet-kit + runtime-network only ──

  const message = typeof e.message === "string" ? e.message : "";

  if (
    e.name === "UserRejectedRequestError" ||
    /reject|denied|cancel/i.test(message)
  ) {
    return "user_cancelled";
  }
  // Thrown by the settlement path before signing, with real numbers.
  if (e.name === "InsufficientFeeError") {
    return "insufficient_fee";
  }

  // The network's own coin ran out (viem: "The total cost (gas * gas fee +
  // value) of executing this transaction exceeds the balance of the
  // account", "insufficient funds for gas * price + value"). Check this
  // before the generic balance match — the ERC-20 balance may ALSO be
  // zero, but this is what actually stopped the transaction, and the
  // remedy (get some MON) is different from topping up the token.
  if (
    e.name === "InsufficientFundsError" ||
    /exceeds the balance of the account|insufficient funds for gas|gas \* (gas fee|price)/i.test(
      message,
    )
  ) {
    return "insufficient_fee";
  }
  if (/insufficient|balance/i.test(message)) {
    return "insufficient_funds";
  }
  if (/network|fetch|timeout|offline/i.test(message)) {
    return "network";
  }

  return "unknown";
}

/**
 * Per-code copy. Primary `title` + `body` are plain English for the
 * payer; `cta.action` is a semantic verb the component resolves to one
 * of the `onRetry` / `onBack` / `onRescan` / `onTopUp` props.
 *
 * Copy-audience rule enforced: no chain / gas / signature jargon in the
 * `title`; the `body` may name the actual token or fee coin where it's
 * genuinely useful context (the balance codes, via `resolvePaymentErrorCopy`).
 */
export const paymentErrorCopy: Record<PaymentErrorCode, PaymentErrorCopy> = {
  // The two balance codes are phrased per payment by
  // `resolvePaymentErrorCopy`; these entries are the no-context fallback.
  insufficient_funds: {
    title: "Not enough balance",
    body: "This wallet doesn't have enough for this payment. Choose another wallet, or pay with a different token.",
    cta: { label: "Change wallet or token", action: "back" },
  },
  insufficient_fee: {
    title: "This wallet can't cover the fee",
    body: "Paying on this network costs a small fee that this wallet can't cover. Choose another wallet, or pay on a different network.",
    cta: { label: "Change wallet or network", action: "back" },
  },
  user_cancelled: {
    title: "Payment cancelled",
    body: "You cancelled the confirmation. Try again when you're ready.",
    cta: { label: "Try again", action: "retry" },
  },
  network: {
    title: "Couldn't reach the payment server",
    body: "Check your connection and try again.",
    cta: { label: "Retry", action: "retry" },
  },
  quote_expired: {
    title: "Quote expired",
    body: "Rescan the merchant QR to get a fresh quote.",
    cta: { label: "Rescan", action: "rescan" },
  },
  backend_not_ready: {
    title: "Merchant not on TakumiPay yet",
    body: "This merchant isn't on TakumiPay yet. Be the first to invite them!",
    cta: { label: "Invite them", action: "invite_merchant" },
  },
  chain_mismatch: {
    title: "Wrong network",
    body: "Switch to the payment network and try again.",
    cta: { label: "Switch network", action: "retry" },
  },
  wallet_unsupported: {
    title: "Wallet not supported",
    body: "Your current wallet doesn't support this payment method. Try switching wallets.",
    cta: { label: "Switch wallet", action: "back" },
  },
  // ── M3 expansion rows ─────────────────────────────────────────────
  signing_failed: {
    title: "Couldn't confirm this payment",
    body: "Something went wrong on the confirmation step. Let's try again.",
    cta: { label: "Try again", action: "retry" },
  },
  bundler_rejected: {
    title: "Payment didn't go through",
    body: "The payment couldn't be submitted right now. Please try again in a moment.",
    cta: { label: "Retry", action: "retry" },
  },
  fx_unavailable: {
    title: "Rates unavailable",
    body: "We can't get a fresh exchange rate right now. Try again shortly.",
    cta: { label: "Retry", action: "retry" },
  },
  intent_conflict: {
    title: "This payment is already in progress",
    body: "Looks like this payment was already started on another device. Please check your recent activity.",
    cta: { label: "OK", action: "back" },
  },
  deposit_required: {
    title: "One-time setup needed",
    body: "Deposit USDC once so your future payments are instant and free.",
    cta: { label: "Deposit now", action: "topup" },
  },
  rate_limited: {
    title: "Too many attempts",
    body: "Please wait a moment and try again.",
    cta: { label: "Retry", action: "retry" },
  },
  unauthorized: {
    title: "Sign in to continue",
    body: "Your session has expired. Please sign in again to pay.",
    cta: { label: "OK", action: "back" },
  },
  merchant_deactivated: {
    title: "This merchant is no longer accepting payments",
    body: "The merchant you scanned has been deactivated. Please contact the merchant directly.",
    cta: { label: "OK", action: "back" },
  },
  server_error: {
    title: "Something went wrong on our end",
    body: "We're looking into it. Please try again in a moment.",
    cta: { label: "Retry", action: "retry" },
  },
  // The on-chain payment is already out (mined or at least broadcast) but
  // the server hasn't confirmed it yet. Retry re-checks with the same
  // transaction; it never signs a second payment.
  settlement_unconfirmed: {
    title: "Payment sent, still confirming",
    body: "Your payment went through on the network but we couldn't confirm it yet. Tap Check again. You won't be charged twice.",
    cta: { label: "Check again", action: "retry" },
  },
  // The chain itself rejected the payment transaction (reverted), so no
  // money moved. The quote is spent; a fresh scan is the way back in.
  payment_not_completed: {
    title: "Payment didn't go through",
    body: "The network didn't accept this payment, so you weren't charged. Scan the code again to retry.",
    cta: { label: "Scan again", action: "rescan" },
  },
  unknown: {
    title: "Something went wrong",
    body: "Please try again. If the problem keeps happening, contact support.",
    cta: { label: "Try again", action: "retry" },
  },
};
