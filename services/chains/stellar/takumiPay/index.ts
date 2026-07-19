/**
 * `takumi_pay` Soroban contract client (payer/submit surface).
 *
 * Mirrors the role of `services/chains/solana/takumiPay/` for the Stellar
 * onchain-settlement rail: pure encoders the settlement orchestrator
 * (`services/nanopay/pathOnchainSettlementStellar.ts`) composes into a
 * `process_merchant_payment` invocation. No network, no signing — those live
 * in the orchestrator + `StellarWalletKit`.
 */

import { Address, xdr } from "@stellar/stellar-base";
import { toByteArray as base64ToBytes } from "base64-js";
import { encodeMerchantQuoteScVal } from "./encoding";
import type { MerchantQuoteFields } from "./types";

export {
  buildDepositPointsArgs,
  DEPOSIT_POINTS,
  resolveStellarSacId,
} from "./depositPoints";
export { encodeMerchantQuoteScVal } from "./encoding";
export type { MerchantQuoteFields } from "./types";

/** Contract method name — the only exported function the wallet calls. */
export const PROCESS_MERCHANT_PAYMENT = "process_merchant_payment" as const;

/**
 * Build the ordered `ScVal` argument list for
 * `process_merchant_payment(payer: Address, quote: MerchantQuote, backend_signature: BytesN<64>)`.
 *
 * `backendSignatureBase64` is the 64-byte Ed25519 signature the backend
 * emitted in the intent (`quoteSignatureStellar`); `BytesN<64>` encodes as
 * `SCV_BYTES`, same as `quote.fiat_currency`'s `BytesN<3>`.
 */
export function buildProcessMerchantPaymentArgs(args: {
  payer: string;
  quote: MerchantQuoteFields;
  backendSignatureBase64: string;
}): xdr.ScVal[] {
  const payerScVal = new Address(args.payer).toScVal();
  const quoteScVal = encodeMerchantQuoteScVal(args.quote);
  const sigBytes = base64ToBytes(args.backendSignatureBase64);
  const sigScVal = xdr.ScVal.scvBytes(Buffer.from(sigBytes));
  return [payerScVal, quoteScVal, sigScVal];
}
