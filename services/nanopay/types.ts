/**
 * `services/nanopay/types.ts` — mobile-side mirrors of the backend contract
 * for Circle Nanopayments Path B (spec §6.2, milestone M2).
 *
 * These are the ONLY shapes this module accepts or emits. The rule (memory
 * `feedback_role_separation.md`) is load-bearing: the server pre-shapes
 * every field the wallet signs — this module reshapes what the server
 * sent and nothing else. It never *invents* authorization fields.
 *
 * Namespace discipline (memory `feedback_chain_extension_discipline.md`):
 * M2 ships EVM-only via the `evm_eip3009` discriminator. A future Solana
 * variant (M6 task 42) gets its own `services/nanopay/svm/*` and a switch
 * at the call site (task 18) — not an `if (namespace === "X")` branch in
 * this module.
 */

import type { SignTransferWithAuthorizationArgs } from "../walletKit/types.ts";

/** Minor-unit fiat amount (e.g. IDR 15,000 → 1_500_000 since IDR is 2dp). */
export type Currency = "IDR" | "PHP" | "THB" | "MYR" | "VND";

export type PaymentIntentStatus =
  | "pending"
  | "submitting"
  | "settling"
  | "paid"
  | "paid_out"
  | "failed"
  | "expired";

/** Polling stops once status hits one of these — the intent is terminal. */
export const TERMINAL_INTENT_STATUSES: ReadonlyArray<PaymentIntentStatus> = [
  "paid",
  "paid_out",
  "failed",
  "expired",
];

export function isTerminalIntentStatus(
  status: PaymentIntentStatus | undefined,
): boolean {
  return !!status && TERMINAL_INTENT_STATUSES.includes(status);
}

/**
 * Input to `POST /v1/pay/intents`.
 *
 * `merchantId` is set when the QR scan resolved client-side (our own
 * TakumiPay JWS); `scannedPayload` carries the raw EMVCo/QRIS bytes so
 * the backend can parse + resolve the merchant itself when we didn't.
 * At least one MUST be provided — enforced server-side.
 */
export interface CreateIntentRequest {
  merchantId?: string;
  scannedPayload?: string;
  /** Amount in minor units (null for open-amount QRs — user types it in `/pay-merchant`). */
  fiatAmountMinor?: number;
  currency: Currency;
  /** Source token the payer wants to pay with (onchain settlement rail). */
  sourceTokenId?: string;
  /**
   * Payer's preferred settlement namespace. `"evm"` (default) → Arc + Nanopayments;
   * `"solana"` → Path B-SVM. Omitting is equivalent to `"evm"`.
   * Derived from the active wallet namespace at intent-creation time.
   */
  preferredChain?: "evm" | "solana";
}

/**
 * EIP-712 message fields the wallet signs. Mirrors the shape
 * `WalletKitAdapter.signTransferWithAuthorization` consumes — the server
 * generates every field (including the 32-byte random `nonce` and the
 * Gateway `domain`), the wallet just signs.
 */
export interface NanopayPayload {
  /** USDC asset address embedded in the EIP-712 `TransferWithAuthorization` struct. */
  usdc: `0x${string}`;
  /** Source chain carrying the USDC balance the payer will debit. */
  sourceChainId: number;
  /**
   * EIP-712 domain. `verifyingContract` is Circle's `GatewayWallet`
   * contract (NOT the USDC contract — signing against USDC's domain
   * passes verify but fails settle). Pulled by the backend from
   * `GET /gateway/v1/x402/supported` at boot.
   */
  domain: {
    name: string;
    version: string;
    verifyingContract: `0x${string}`;
  };
  from: `0x${string}`;
  /** `= PLATFORM_TREASURY_ADDRESS_EVM`. Merchants are resolved off-chain. */
  to: `0x${string}`;
  /** 6-decimal USDC units, encoded as a decimal string to preserve bigint precision over JSON. */
  value: string;
  validAfter: number;
  /**
   * Unix seconds. Circle requires `≥ now + 3 days` — shorter windows
   * fail settle with `authorization_validity_too_short`. The build step
   * enforces this guard before the wallet is touched.
   */
  validBefore: number;
  /** 32-byte random, server-generated per intent. */
  nonce: `0x${string}`;
}

/**
 * Response shape of both `POST /v1/pay/intents` and
 * `GET /v1/pay/intents/:id`. Polling uses the same shape — `status`
 * drives UI state, `nanopay` is `null` once the payload has been
 * consumed (post-settle).
 */
/**
 * Quote commitment for the onchain settlement rail. The backend signs
 * this struct and the wallet calls `processMerchantPayment(quote, sig)`
 * on the TakumiPay contract. Every field matches the Solidity
 * `QuoteCommitment` struct layout exactly.
 */
export interface QuoteCommitment {
  refId: string;
  merchantId: string;
  tokenAddress: `0x${string}`;
  amount: string;
  platformFeeAmount: string;
  fiatAmountMinor: number;
  fiatCurrency: string;
  exchangeRateId: number;
  expiresAt: number;
}

/**
 * Solana quote commitment for the onchain settlement rail. The backend
 * signs this struct with Ed25519 and the wallet calls
 * `processMerchantPaymentSol/Token` on the TakumiPay Anchor program.
 * Solana counterpart to `QuoteCommitment` (EVM/ECDSA).
 */
export interface QuoteCommitmentSvm {
  refId: string;
  merchantId: string;
  tokenMint: string;
  amount: string;
  platformFeeAmount: string;
  fiatAmountMinor: string;
  fiatCurrency: string;
  exchangeRateId: string;
  expiresAt: string;
}

/**
 * Stellar counterpart of {@link QuoteCommitmentSvm} — the backend-signed
 * `takumi_pay` `MerchantQuote` fields the wallet re-encodes byte-exact and
 * submits to `process_merchant_payment`. Numeric fields are decimal strings
 * (bigint over JSON). `token` is the token's SAC contract id (`C…`), not the
 * classic `"{CODE}:{ISSUER}"` compound.
 */
export interface QuoteCommitmentStellar {
  refId: string;
  merchantId: string;
  token: string;
  amount: string;
  platformFeeAmount: string;
  fiatAmountMinor: string;
  fiatCurrency: string;
  exchangeRateId: string;
  expiresAt: string;
}

export interface PaymentIntentResponse {
  id: string;
  status: PaymentIntentStatus;
  /** 6-decimal USDC atomic units, decimal string to keep bigint semantics over JSON. */
  nanopayUsdcAmountMicros: string;
  /** Source chain the payer debits from. */
  nanopayUsdcSourceChainId: number;
  /** Gateway batched-wallet contract address on `nanopayUsdcSourceChainId`. */
  nanopayUsdcTreasuryAddress: `0x${string}`;
  /** Wire payload the wallet must sign. `null` once consumed. */
  nanopay: NanopayPayload | null;
  /** Unix ms — quote freeze (60s typically). */
  expiresAt: number;
  /**
   * Server-selected settlement path. `"nanopay"` = Path B (Circle),
   * `"x402"` = Path C, `"takumipay"` = TakumiPay onchain settlement.
   */
  path?: "nanopay" | "x402" | "takumipay";
  /**
   * Token amount in minor units (e.g. 6-decimal for USDC). Renamed from
   * `nanopayUsdcAmountMicros` on backend for token-agnostic settlement.
   */
  tokenAmountMinor?: string;
  /** Source token identifier for multi-token settlement. */
  sourceTokenId?: string;
  /** Signed quote commitment for the onchain settlement rail. */
  quoteCommitment?: QuoteCommitment;
  /** Backend ECDSA signature over the `quoteCommitment` struct. */
  quoteSignature?: `0x${string}`;
  /** TakumiPay contract address for onchain settlement. */
  contractAddress?: `0x${string}`;
  quoteCommitmentSvm?: QuoteCommitmentSvm;
  quoteSignatureSvm?: string;
  programId?: string;
  backendSignerPubkey?: string;
  /** Stellar `takumi_pay` settlement — mirrors the SVM quote fields above. */
  quoteCommitmentStellar?: QuoteCommitmentStellar;
  /** Base64 Ed25519 signature (64 bytes) over the `QuoteMessage`. */
  quoteSignatureStellar?: string;
  /** Hex raw Ed25519 pubkey of the backend Stellar quote signer. */
  backendSignerPubkeyStellar?: string;
  /** `takumi_pay` Soroban contract id (`C…`) for this chain. */
  takumiPayContractId?: string;
  /** Source token's blockchain ULID — used to fetch the payment contract. */
  blockchainId?: string;
}

/** Body of `POST /v1/pay/intents/:id/nanopay`. */
export interface SubmitNanopayRequest {
  signature: `0x${string}`;
  /** Split-signature fields — optional; server derives these from `signature` when omitted. */
  v?: number;
  r?: `0x${string}`;
  s?: `0x${string}`;
}

export interface SubmitNanopayResponse {
  id: string;
  status: PaymentIntentStatus;
}

/** Exactly the shape `signTransferWithAuthorization` (task 15) consumes. */
export type NanopaySignArgs = SignTransferWithAuthorizationArgs;
