/**
 * Bridge wire types — the mobile mirror of `api/src/bridge/types.ts`.
 *
 * Spec: docs/bridge-capability-spec.md §5.1, §6, §7.
 *
 * KEEP IN SYNC with the backend module. Two invariants carry across:
 *
 *  1. Chain identity is CAIP-2 and asset identity CAIP-19, never a
 *     provider's private chain number. That mapping stays inside each
 *     adapter (§5.2).
 *  2. `decimals` travels with every token and is never a shared constant.
 *     Stellar USDC is 7 decimals; USDC everywhere else is 6 (§5.4.1, §6).
 */

/** CAIP-2 chain id, e.g. `eip155:8453`, `sui:mainnet`, `stellar:pubnet`. */
export type TCaip2 = string;

/** CAIP-19 asset id, e.g. `eip155:8453/erc20:0x8335…`, `eip155:1/slip44:60`. */
export type TCaip19 = string;

export interface TBridgeToken {
  caip19: TCaip19;
  chain: TCaip2;
  address: string;
  symbol: string;
  name?: string;
  /** Required. Formatting by guesswork is the §6 bug this removes. */
  decimals: number;
  priceUsd?: string;
  logoUri?: string;
  isNative: boolean;
  verification: "verified" | "unverified" | "unknown";
}

export type TBridgeFeeKey =
  | "bridge"
  | "integrator"
  | "gas_source"
  | "gas_destination"
  | "forwarding"
  | "gas_top_up"
  | "other";

export interface TBridgeFee {
  key: TBridgeFeeKey;
  label: string;
  amountRaw: string;
  token: TBridgeToken;
  amountUsd?: string;
  /** `true` = already deducted from output; `false` = charged on top. */
  included: boolean;
}

/**
 * Trust model of the mechanism moving the funds. Burn-and-mint, liquidity
 * pool, and intent/filler are different trust models and users are
 * entitled to know which one they are in (§7.3).
 */
export type TBridgeMechanism =
  | "burn_mint"
  | "liquidity_pool"
  | "intent_filler"
  | "unknown";

export interface TBridgeProviderInfo {
  key: string;
  name: string;
  logoUri?: string;
  mechanism: TBridgeMechanism;
}

export type TBridgeStepKind =
  | "approve"
  | "swap"
  | "burn"
  | "attestation"
  | "mint"
  | "protocol";

export interface TBridgeRouteStep {
  key: string;
  kind: TBridgeStepKind;
  label: string;
  fromChain?: TCaip2;
  toChain?: TCaip2;
  fromToken?: TBridgeToken;
  toToken?: TBridgeToken;
  fromAmountRaw?: string;
  toAmountRaw?: string;
  provider?: TBridgeProviderInfo;
}

/**
 * A destination precondition that is not satisfied yet (§7.5).
 *
 * Gas is only the EVM case. Solana needs an associated token account plus
 * rent; Stellar needs a USDC TRUSTLINE plus the XLM base reserve, which is
 * a hard opt-in no amount of sender-side signing can substitute for.
 */
export type TBridgeBlockerCode =
  | "no_destination_gas"
  | "missing_trustline"
  | "account_not_funded"
  | "missing_token_account";

export type TBridgeRemedy =
  | { kind: "gas_top_up"; suggestedUsd: number }
  | { kind: "establish_trustline"; asset: string }
  // `symbol` rather than a full token: the readiness check knows the
  // chain's native asset by name but has no price/logo metadata, and
  // inventing it would be worse than omitting it.
  | { kind: "fund_account"; minimumRaw: string; symbol: string }
  | { kind: "none" };

export interface TBridgeBlocker {
  code: TBridgeBlockerCode;
  /** Hand-written copy, ready to render. Never raw error text. */
  message: string;
  severity: "warning" | "blocking";
  remedy: TBridgeRemedy;
}

export type TBridgeExecutionPayload =
  | {
      kind: "evm_transaction";
      chain: TCaip2;
      to: string;
      data: string;
      value: string;
      gasPrice?: string;
      gasLimit?: string;
      approval?: { token: string; spender: string; amountRaw: string };
    }
  | {
      kind: "serialized_transaction";
      chain: TCaip2;
      encoding: "base64" | "hex";
      payload: string;
    }
  | {
      kind: "soroban_invoke";
      chain: TCaip2;
      contractId: string;
      method: string;
      argsXdrBase64: string[];
    };

/**
 * Terminal outcome. FOUR values, never a boolean (§7.7.1).
 *
 * `DONE` from LI.FI has three outcomes and two of them are not what the
 * user asked for: `partial` (full value, DIFFERENT token) and `refunded`
 * (funds back on the source chain). Both are OUTCOMES, not errors — they
 * must not go through `agentErrorCopy`.
 */
export type TBridgeOutcome = "completed" | "partial" | "refunded" | "failed";

export type TBridgePhase =
  | "pending_source"
  | "pending_attestation"
  | "pending_destination"
  | "settled";

export interface TBridgeStatus {
  outcome: TBridgeOutcome | null;
  phase: TBridgePhase;
  currentStepKey?: string;
  sourceTxHash?: string;
  destinationTxHash?: string;
  /** Populated on `partial` — the token actually received. */
  receivedToken?: TBridgeToken;
  receivedAmountRaw?: string;
  /** Populated on `refunded` — where the money went back to. */
  refundChain?: TCaip2;
  explorerUrl?: string;
}

export interface TBridgeQuote {
  quoteId: string;
  provider: string;
  from: {
    chain: TCaip2;
    /** Resolved display name, so the card never derives one. */
    chainName?: string;
    token: TBridgeToken;
    address: string;
    amountRaw: string;
    amountUsd?: string;
  };
  to: {
    chain: TCaip2;
    /** Resolved display name, so the card never derives one. */
    chainName?: string;
    token: TBridgeToken;
    /** Shown explicitly on the card. Cross-namespace this differs (§7.4). */
    address: string;
    amountRaw: string;
    amountUsd?: string;
  };
  /** Worst-case guarantee. The protection number on screen (§7.2). */
  toAmountMinRaw: string;
  slippageBps: number;
  fees: TBridgeFee[];
  receivesNativeAsset: boolean;
  durationSeconds: number;
  durationRangeSeconds?: [number, number];
  bridge: TBridgeProviderInfo;
  steps: TBridgeRouteStep[];
  execution: TBridgeExecutionPayload;
  issuedAt: string;
  expiresAt: string;
}

/**
 * Why a route is unavailable. Every value is a CAPABILITY BOUNDARY, not a
 * failure — the card renders a plain explanatory state, not an error card,
 * and never raw provider text (§7.6).
 */
export type TBridgeNoRouteReason =
  | "same_chain"
  | "chain_not_supported"
  | "asset_not_supported"
  | "asset_chain_mismatch"
  | "no_route_found"
  | "check_unavailable";

export type TBridgeQuoteResult =
  | { routable: true; quote: TBridgeQuote }
  | { routable: false; reason: TBridgeNoRouteReason };

export interface TBridgeSupportedChain {
  chain: TCaip2;
  name: string;
  providers: string[];
  logoUri?: string;
  nativeSymbol?: string;
}

export interface TBridgeSupport {
  chains: TBridgeSupportedChain[];
  providers: Array<{ key: string; tools: string[] }>;
  refreshedAt: string;
  /**
   * `true` when the matrix came from a stale cache. Callers degrade to
   * "we could not check routes right now" — NEVER to a wrong
   * "unsupported" (§5.3).
   */
  degraded: boolean;
}

export interface TBridgeQuoteRequest {
  fromChain: TCaip2;
  toChain: TCaip2;
  fromAsset: TCaip19;
  toAsset: TCaip19;
  amountRaw: string;
  fromAddress: string;
  toAddress: string;
}

export interface TBridgeStatusRequest {
  fromChain: TCaip2;
  toChain: TCaip2;
  txHash: string;
  provider?: string;
}

export interface TBridgeGasTopUpRequest {
  chain: TCaip2;
  toAddress: string;
  fromChain: TCaip2;
  fromAsset: TCaip19;
  fromAddress: string;
  amountUsd: number;
}
