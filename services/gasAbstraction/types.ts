/**
 * Gas-abstraction provider port — the space-docking seam that lets the
 * app pay transaction gas in a stablecoin instead of the native token.
 *
 * A `GasAbstractionProvider` encapsulates ONE way to abstract gas (the
 * 1Shot ERC-7710 relayer today; Circle Paymaster / Biconomy could be
 * registered later without touching call sites). Consumers
 * (`app/send.tsx`, agent executors) never branch on provider or chain
 * namespace — they go through `resolveGasPayment` and dispatch on the
 * resolved provider, exactly like `WalletKitAdapter` / `walletKitRegistry`.
 *
 * Rules (mirror `services/walletKit/types.ts`):
 *   - No `react` / `react-native` / `expo` imports — Node-testable.
 *   - No `viem` import in THIS module (concrete providers may use viem).
 */

import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";

/** The "pay gas in the chain's native coin" preference. */
export const NATIVE_GAS_TOKEN = "native";

/**
 * User preference for which token pays gas. Persisted in settings.
 *
 * Either {@link NATIVE_GAS_TOKEN} or the symbol the relayer tags an
 * accepted fee token with (`"USDC"`, `"USDT0"`, `"mUSD"`, …). The set of
 * offerable symbols is NOT hardcoded: it is whatever the provider's live
 * capabilities list for the chains the app surfaces (mainnet or testnet
 * alike), so a token the relayer starts accepting shows up without an app
 * change. On a chain where the chosen symbol is not accepted, gas falls
 * back to native (`resolveGasPayment`).
 *
 * `(string & {})` keeps `"native"` in autocomplete while admitting any
 * symbol string.
 */
export type GasFeeTokenPreference = typeof NATIVE_GAS_TOKEN | (string & {});

export function isNativeGasPreference(pref: GasFeeTokenPreference): boolean {
  return pref === NATIVE_GAS_TOKEN;
}

/** Case-insensitive symbol compare (`"USDC"` ⇔ `"usdc"`, `"mUSD"` ⇔ `"MUSD"`). */
export function feeTokenSymbolMatches(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/**
 * A token transfer the user wants to make, expressed independently of
 * how gas is paid. `tokenAddress` is the ERC-20 being sent; the fee token
 * is chosen separately (`GasAbstractionArgs.feeTokenSymbol`). When both
 * are the same token a single delegation covers the fee leg and the work
 * leg; otherwise the provider signs one per token (see
 * `oneShotRelayerProvider`).
 */
export interface TransferIntent {
  /** Recipient of the work transfer. */
  to: string;
  /** ERC-20 contract being sent. */
  tokenAddress: string;
  /** Raw token units (smallest denomination). */
  amount: bigint;
  decimals: number;
  /** Optional opaque correlation label echoed back in status. */
  memo?: string;
}

export interface GasAbstractionArgs {
  wallet: TWallet;
  chain: ChainConfig;
  intent: TransferIntent;
  /**
   * Symbol of the token that pays gas (the gas-settings preference, or
   * the already-resolved `quote.feeToken.symbol` when executing a plan).
   * Matched case-insensitively against the provider's accepted fee tokens
   * on `chain`; no match → the intent is not abstractable there.
   */
  feeTokenSymbol: string;
}

export interface FeeToken {
  address: string;
  symbol: string;
  decimals: number;
}

/**
 * Rough, no-signing fee quote for pre-send UI + the balance gate. The
 * authoritative fee is locked during `execute` (relayer estimate).
 */
export interface GasAbstractionQuote {
  providerId: string;
  feeToken: FeeToken;
  /** Estimated relayer fee in fee-token atoms (floored at `minFee`). */
  feeAmount: bigint;
  /** `intent.amount + feeAmount` — what the wallet must hold. */
  totalRequired: bigint;
}

export interface GasAbstractionExecuteResult {
  providerId: string;
  /** Relayer task id for async status tracking. */
  taskId: string;
  /**
   * The final, price-locked relayer fee actually charged (fee-token
   * atoms). Surfaced so the success screen can show what the user paid in
   * gas. May be absent for providers that don't expose it.
   */
  feeAmount?: bigint;
  /** The token the gas fee was charged in (e.g. USDC, USDT0). */
  feeToken?: FeeToken;
}

export interface GasAbstractionStatus {
  status: "pending" | "submitted" | "success" | "failed";
  statusCode: number;
  transactionHash?: string;
}

export interface GetGasAbstractionStatusArgs {
  chain: ChainConfig;
  taskId: string;
}

export interface GasAbstractionProvider {
  /** Stable id, e.g. `"1shot"`. */
  readonly id: string;

  /** Cheap, synchronous chain gate (constant allowlist + namespace). */
  supportsChain(chain: ChainConfig): boolean;

  /**
   * The fee tokens this provider accepts on `chain` right now, from its
   * live capabilities (never a static table). Empty when the chain is
   * not served. Drives the gas-settings option list.
   */
  listFeeTokens(chain: ChainConfig): Promise<FeeToken[]>;

  /**
   * Whether this exact transfer can be abstracted right now (e.g. the
   * token is an accepted fee token on this chain). May hit the network
   * to read live capabilities.
   */
  supportsIntent(args: GasAbstractionArgs): Promise<boolean>;

  /** Rough fee quote (no signing) for UI + the balance gate. */
  getQuote(args: GasAbstractionArgs): Promise<GasAbstractionQuote>;

  /**
   * Full price-lock loop: build + sign the delegation, estimate, re-sign
   * if the required fee changed, then submit. The CALLER is responsible
   * for biometric / PIN gating before invoking this (signing happens
   * inside). Returns a relayer `taskId`.
   */
  execute(args: GasAbstractionArgs): Promise<GasAbstractionExecuteResult>;

  /** Polls the status of a submitted task. */
  getStatus(args: GetGasAbstractionStatusArgs): Promise<GasAbstractionStatus>;
}

/** Thrown when an intent can't be abstracted (declined before signing). */
export class GasAbstractionUnavailableError extends Error {
  readonly name = "GasAbstractionUnavailableError";
  readonly reason: string;
  constructor(reason: string) {
    super(`gas abstraction unavailable: ${reason}`);
    this.reason = reason;
  }
}
