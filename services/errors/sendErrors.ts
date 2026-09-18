/**
 * User-facing classification for the plain send screen (`app/send.tsx`).
 *
 * Hard rule (CLAUDE.md "User-facing errors"): the UI never renders
 * `err.message`. This maps whatever the chain adapters throw onto a small
 * closed set of codes with hand-written copy, and the copy is written for
 * someone who has never heard the words gas, token, or chain (Monad
 * Metropolis strategy doc: "judge harshly on any point of friction that
 * reveals 'this is crypto'"). The raw error goes to `__DEV__` logs only.
 *
 * Chain-agnostic on purpose: the patterns cover viem (EVM), Solana, Sui
 * and Stellar wording, so this file needs no namespace branch and the
 * send screen keeps passing `pnpm check:chains`. Pure, node-testable.
 */

export type SendErrorCode =
  | "insufficient_fee"
  | "insufficient_balance"
  | "user_cancelled"
  | "network"
  | "unknown";

export type SendErrorCopy = { title: string; message: string };

function textOf(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const rec = cur as {
      name?: unknown;
      message?: unknown;
      shortMessage?: unknown;
      details?: unknown;
      cause?: unknown;
    };
    for (const v of [rec.name, rec.shortMessage, rec.message, rec.details]) {
      if (typeof v === "string") parts.push(v);
    }
    cur = rec.cause;
  }
  if (parts.length === 0 && typeof err === "string") parts.push(err);
  return parts.join(" | ");
}

export function classifySendError(err: unknown): SendErrorCode {
  const text = textOf(err);
  if (!text) return "unknown";

  if (/cancel|rejected the request|user denied|4001/i.test(text)) {
    return "user_cancelled";
  }

  // Native balance can't cover value + fee (or fee alone when sending a
  // token). viem: InsufficientFundsError / "insufficient funds for gas *
  // price + value". Solana: "insufficient lamports". Sui: InsufficientGas.
  // Stellar: tx_insufficient_fee / tx_insufficient_balance.
  if (
    /InsufficientFundsError|insufficient funds for gas|insufficient funds for transfer|insufficient lamports|InsufficientGas|tx_insufficient_fee|tx_insufficient_balance|intrinsic gas too low|gas required exceeds allowance/i.test(
      text,
    )
  ) {
    return "insufficient_fee";
  }

  // The asset being sent is short. ERC-20 reverts, Sui coin balance,
  // Stellar op_underfunded, SPL "insufficient funds" on a token account.
  if (
    /exceeds balance|transfer amount exceeds|InsufficientCoinBalance|op_underfunded|insufficient funds|insufficient balance|not enough/i.test(
      text,
    )
  ) {
    return "insufficient_balance";
  }

  if (
    /network request failed|fetch failed|timeout|timed out|ECONN|ENOTFOUND|HttpRequestError|TimeoutError|rate limit|429|503|502/i.test(
      text,
    )
  ) {
    return "network";
  }

  return "unknown";
}

/**
 * `assetSymbol` is the asset the user chose to send (they picked it, so
 * showing it back is not jargon). Everything else stays generic.
 */
export function sendErrorCopy(
  code: SendErrorCode,
  assetSymbol?: string,
): SendErrorCopy {
  switch (code) {
    case "insufficient_fee":
      return {
        title: "Can't send yet",
        message:
          "This account can't cover the small network fee for this transfer. Add a little balance to it first, then try again.",
      };
    case "insufficient_balance":
      return {
        title: "Not enough to send",
        message: assetSymbol
          ? `You don't have enough ${assetSymbol} for this amount. Lower the amount and try again.`
          : "You don't have enough for this amount. Lower the amount and try again.",
      };
    case "user_cancelled":
      return {
        title: "Transfer cancelled",
        message: "No money was sent. Try again whenever you're ready.",
      };
    case "network":
      return {
        title: "Connection problem",
        message:
          "We couldn't reach the network. Check your connection and try again.",
      };
    default:
      return {
        title: "Couldn't send",
        message:
          "Something went wrong and no money was sent. Please try again.",
      };
  }
}
