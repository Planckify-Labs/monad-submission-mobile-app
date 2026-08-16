/**
 * DeFi strategies API types — mirror the backend Prisma models in
 * `api/src/strategies/*` (UserStrategy, OpportunityCache,
 * StrategyPosition). See `docs/defi-strategies-spec.md` §13.
 *
 * The backend serializes Prisma `Decimal` and `BigInt` columns as
 * strings; we keep them as strings here and parse on the consumer
 * side when arithmetic is required.
 */

import type { DepositTarget } from "@/services/defi/types";

export type RiskTier = "conservative" | "balanced" | "aggressive";

export type LiquidityProfile = "instant" | "queued_short" | "queued_long";

export type StrategyStatus = "active" | "withdrawn" | "failed";

export interface TOpportunity {
  id: string;
  protocolSlug: string;
  chainId: number;
  namespace: string;
  /** Human-readable chain label, sourced from DeFiLlama's `chain` field
   * (e.g. "Ethereum", "Arbitrum", "Base", "Solana"). */
  chainName: string;
  assetSymbol: string;
  assetContract: string | null;
  poolId: string;
  /** DeFiLlama vault/market name — disambiguates sibling pools sharing
   *  (protocol, asset, chain). Free-text label, null when absent. (spec §4.2) */
  poolMeta: string | null;
  /** Server-resolved, on-chain-validated deposit destination for this exact
   *  pool (spec §4.1). `null` ⇒ unresolved → the pool is "Manual" (deep-link
   *  out), not in-app depositable. The executor re-fetches this by poolId
   *  before signing; the LLM never sees it. */
  depositTarget: DepositTarget | null;
  targetResolvedAt: string | null;
  /** Protocol's own app URL (DeFiLlama `/protocol/{slug}.url`) — the "Manual"
   *  badge opens this real site rather than the DeFiLlama page (spec §9.1).
   *  Protocol-scoped, merged onto the row server-side; null when unknown. */
  appUrl: string | null;
  apy: string;
  apy7dAvg: string;
  apyStddev30d: string;
  tvlUsd: string;
  tvl7dDelta: string;
  emissionsToFeesRatio: string | null;
  ilExposure: boolean;
  score: number;
  tier: RiskTier;
  scoredAt: string;
}

export interface TStrategyPosition {
  id: string;
  userStrategyId: string;
  walletAddress: string;
  chainId: number;
  namespace: string;
  /** Human-readable chain label, mirrors `TOpportunity.chainName`. */
  chainName: string;
  protocolSlug: string;
  assetSymbol: string;
  assetContract: string | null;
  /** DeFiLlama poolId the position was opened against — pins the exact sibling
   *  pool (spec §4.2). Null for legacy positions opened before pool-level routing. */
  poolId: string | null;
  amountAtDeposit: string;
  amountAtDepositUsd: string;
  currentAmountRaw: string | null;
  currentAmountUsd: string | null;
  status: StrategyStatus | string;
  openTxHash: string | null;
  closeTxHash: string | null;
  openedAt: string;
  closedAt: string | null;
  goal: string | null;
  targetDate: string | null;
  /** Live APY off the position's `OpportunityCache` row, joined at read
   *  time (never persisted — APY drifts). `null` when the pool has aged out
   *  of the cache or the position predates pool-level routing and has no
   *  match. */
  currentApy: number | null;
}

export type AssetPreference = "stable" | "eth_lst" | "multi";

export interface TUserStrategy {
  id: string;
  userId: string;
  walletAddress: string;
  namespace: string;
  tier: RiskTier;
  assetPreferences: AssetPreference[];
  liquidityPref: string;
  chainPref: unknown;
  allocationPct: number;
  rebalanceTrigger: unknown;
  protocolWhitelist: string[];
  allowAllInTier: boolean;
  autoCompound: boolean;
  notificationLevel: string;
  activatedAt: string | null;
  pausedAt: string | null;
  createdAt: string;
  updatedAt: string;
  positions?: TStrategyPosition[];
}

/**
 * Cross-chain (LI.FI) types — mirror `LifiQuote` in
 * `api/src/strategies/external/lifi.client.ts`. The backend wraps the
 * official `@lifi/sdk` and returns a stable, JSON-safe quote shape.
 *
 * `value`, `gasPrice`, `gasLimit` are decimal strings (the backend
 * coerces `BigIntish` to string); mobile parses them with `BigInt(...)`
 * before submitting the transaction.
 */
export interface TCrossChainQuoteRequest {
  fromChainId: number;
  toChainId: number;
  fromTokenContract: `0x${string}` | string;
  toTokenContract: `0x${string}` | string;
  amountRaw: string;
  toAddress?: `0x${string}` | string;
}

export interface TCrossChainTransactionRequest {
  to: `0x${string}` | string;
  data: `0x${string}` | string;
  value: string;
  from?: string;
  chainId?: number;
  gasPrice?: string;
  gasLimit?: string;
}

export interface TCrossChainQuote {
  transactionRequest: TCrossChainTransactionRequest;
  estimate: {
    toAmount: string;
    executionDuration: number;
    fromAmount?: string;
    fromAmountUSD?: string;
    toAmountUSD?: string;
    approvalAddress?: string;
  };
  tool: string;
  toolName?: string;
}

export interface TCrossChainStatusResponse {
  status: string;
  substatus?: string;
}

/**
 * A verified router-calldata quote (EVM expansion spec §6, §12 Q8).
 *
 * Produced by the backend proxy, which has already enforced the slippage
 * ceiling and checked `to` against the pinned router allowlist. The device
 * re-checks `to` against its own pinned copy and asserts `tokenIn`/`amountIn`
 * match what it asked for, so a compromised backend still cannot get a call
 * signed that the user did not approve (§11.1).
 */
export interface TRouterQuote {
  to: string;
  data: string;
  value: string;
  /** Protocol-reported expected output, when it reports one. */
  expectedOut: string | null;
  /** Unix seconds. Past this the quote MUST be re-fetched, never signed. */
  expiresAt: number;
  /** Echoed inputs, for the caller's decoded-intent assertion. */
  tokenIn: string;
  amountIn: string;
  chainId: number;
}
