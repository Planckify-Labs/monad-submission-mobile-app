import { parseUnits } from "viem";
import type { PaymentErrorCode } from "../errors/paymentErrors";
import type { PaymentIntentResponse } from "./types";

/**
 * Which balance, if any, rules the payment out before it is attempted.
 * Token first (it is what the merchant gets), then the network's own coin
 * for the fee. Returns null when balances are still loading or nothing is
 * short — a false "not enough" is worse than letting the chain decide.
 *
 * `nanopayUsdcAmountMicros` is 6-decimal micros of the settlement token;
 * `tokenAmountMinor` (when the api sends it) is the same amount in the
 * token's own decimals, which is also what `tokenBalance` is parsed in.
 */
export function preflightShortfall(args: {
  paymentToken: { decimals: number; contractAddress: string | null } | null;
  tokenBalance: string;
  isLoadingTokenBalance: boolean;
  nativeBalance: bigint;
  isLoadingBalance: boolean;
  feePaidInNative: boolean;
  /**
   * The estimated fee for this exact call, when the kit could price it.
   * With it the check is real (balance < fee); without it only an empty
   * wallet is ruled out, since the fee of a call is not a fixed number.
   */
  feeNeededWei?: bigint | null;
  intent: Pick<
    PaymentIntentResponse,
    "nanopayUsdcAmountMicros" | "tokenAmountMinor"
  >;
}): Extract<
  PaymentErrorCode,
  "insufficient_funds" | "insufficient_fee"
> | null {
  const {
    paymentToken,
    tokenBalance,
    isLoadingTokenBalance,
    nativeBalance,
    isLoadingBalance,
    feePaidInNative,
    feeNeededWei,
    intent,
  } = args;

  if (paymentToken?.contractAddress && !isLoadingTokenBalance) {
    try {
      const decimals = paymentToken.decimals;
      const need = intent.tokenAmountMinor
        ? BigInt(intent.tokenAmountMinor)
        : BigInt(intent.nanopayUsdcAmountMicros) *
          10n ** BigInt(Math.max(decimals - 6, 0));
      const have = parseUnits(tokenBalance || "0", decimals);
      if (have < need) return "insufficient_funds";
    } catch {
      // Unparseable balance string: let the chain decide.
    }
  }

  if (feePaidInNative && !isLoadingBalance) {
    if (feeNeededWei != null) {
      if (nativeBalance < feeNeededWei) return "insufficient_fee";
    } else if (nativeBalance === 0n) {
      return "insufficient_fee";
    }
  }

  return null;
}
