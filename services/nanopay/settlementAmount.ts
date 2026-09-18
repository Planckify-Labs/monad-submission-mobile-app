import { formatUnits } from "viem";
import type { PaymentIntentResponse } from "./types";

const USDC_DECIMALS = 6;

/**
 * "~2.97 AUSD" / "~2.97 USDC": the amount leaving the payer's balance, in
 * the token it actually leaves in.
 *
 * Nanopay is USDC by construction. The on-chain rail settles in whatever
 * `sourceToken` the intent names; if the api hasn't named it (older
 * responses) the caller may pass a `fallbackToken` it resolved itself.
 * When neither is known on the on-chain rail, the symbol is left off
 * rather than guessed — a Monad AUSD quote labelled "USDC" is worse than
 * one labelled nothing.
 */
export function settlementAmountLabel(
  intent: Pick<
    PaymentIntentResponse,
    "path" | "nanopayUsdcAmountMicros" | "tokenAmountMinor" | "sourceToken"
  >,
  fallbackToken?: { symbol: string; decimals: number } | null,
): string {
  const onchain = intent.path === "takumipay" || !!intent.sourceToken;
  if (!onchain) {
    return formatMinor(intent.nanopayUsdcAmountMicros, USDC_DECIMALS, "USDC");
  }
  const token = intent.sourceToken ?? fallbackToken ?? null;
  if (intent.tokenAmountMinor && intent.sourceToken) {
    return formatMinor(
      intent.tokenAmountMinor,
      intent.sourceToken.decimals,
      intent.sourceToken.symbol,
    );
  }
  // `nanopayUsdcAmountMicros` is always 6-decimal micros of the settlement
  // token, whatever its symbol.
  return formatMinor(
    intent.nanopayUsdcAmountMicros,
    USDC_DECIMALS,
    token?.symbol ?? "",
  );
}

function formatMinor(minor: string, decimals: number, symbol: string): string {
  const suffix = symbol ? ` ${symbol}` : "";
  try {
    const whole = formatUnits(BigInt(minor), decimals);
    const n = Number.parseFloat(whole);
    if (!Number.isFinite(n)) return `${whole}${suffix}`;
    return `${n.toFixed(n < 1 ? 4 : 2)}${suffix}`;
  } catch {
    return `${minor}${suffix}`;
  }
}
