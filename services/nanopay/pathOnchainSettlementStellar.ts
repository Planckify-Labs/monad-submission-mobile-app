/**
 * `services/nanopay/pathOnchainSettlementStellar.ts` — Stellar counterpart of
 * `pathOnchainSettlement.ts` (EVM) / `pathOnchainSettlementSvm.ts` (Solana)
 * for the `"takumipay"` onchain-settlement rail. Calls
 * `process_merchant_payment` on the `takumi_pay` Soroban contract.
 *
 * Space-docking: self-contained Stellar module. It reads ONLY its own intent
 * fields (`quoteCommitmentStellar` / `quoteSignatureStellar` /
 * `takumiPayContractId`), asserts its own namespace at entry, and reaches the
 * chain via the presence-checked `walletKit.sendSorobanTransaction` — no
 * shared code branches on namespace to pick this module (see
 * `docs/solana-contract-integration-spec.md` §4.2).
 */

import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import {
  buildProcessMerchantPaymentArgs,
  type MerchantQuoteFields,
  PROCESS_MERCHANT_PAYMENT,
} from "@/services/chains/stellar/takumiPay";
import type { WalletKitAdapter } from "@/services/walletKit/types";
import type { PaymentIntentResponse, QuoteCommitmentStellar } from "./types";

export class OnchainSettlementStellarError extends Error {
  readonly name = "OnchainSettlementStellarError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ExecuteOnchainSettlementStellarArgs {
  intent: PaymentIntentResponse;
  wallet: TWallet;
  walletKit: WalletKitAdapter;
  chain: ChainConfig;
  /** `takumi_pay` contract id (`C…`) — resolved from the intent / SmartContract row. */
  contractId: string;
}

export interface ExecuteOnchainSettlementStellarResult {
  txHash: string;
}

/** Parse the wire commitment (decimal strings) into the encoder's typed form. */
function toMerchantQuoteFields(
  commitment: QuoteCommitmentStellar,
): MerchantQuoteFields {
  return {
    refId: commitment.refId,
    merchantId: commitment.merchantId,
    token: commitment.token,
    amount: BigInt(commitment.amount),
    platformFeeAmount: BigInt(commitment.platformFeeAmount),
    fiatAmountMinor: BigInt(commitment.fiatAmountMinor),
    fiatCurrency: commitment.fiatCurrency,
    exchangeRateId: BigInt(commitment.exchangeRateId),
    expiresAt: BigInt(commitment.expiresAt),
  };
}

export async function executeOnchainSettlementStellar(
  args: ExecuteOnchainSettlementStellarArgs,
): Promise<ExecuteOnchainSettlementStellarResult> {
  const { intent, wallet, walletKit, chain, contractId } = args;

  if (chain.namespace !== "stellar") {
    throw new OnchainSettlementStellarError(
      "WRONG_CHAIN_NAMESPACE",
      "Expected Stellar chain",
    );
  }

  if (!intent.quoteCommitmentStellar || !intent.quoteSignatureStellar) {
    throw new OnchainSettlementStellarError(
      "MISSING_QUOTE",
      "Intent missing quoteCommitmentStellar or quoteSignatureStellar",
    );
  }

  if (typeof walletKit.sendSorobanTransaction !== "function") {
    throw new OnchainSettlementStellarError(
      "WALLET_UNSUPPORTED",
      "Wallet does not support sendSorobanTransaction",
    );
  }

  const quote = toMerchantQuoteFields(intent.quoteCommitmentStellar);
  const callArgs = buildProcessMerchantPaymentArgs({
    payer: wallet.address,
    quote,
    backendSignatureBase64: intent.quoteSignatureStellar,
  });

  const txHash = await walletKit.sendSorobanTransaction({
    wallet,
    chain,
    contractId,
    method: PROCESS_MERCHANT_PAYMENT,
    args: callArgs,
  });

  return { txHash };
}
