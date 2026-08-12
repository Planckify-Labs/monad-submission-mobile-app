/**
 * Minimal Soroban RPC (JSON-RPC 2.0) client — plain `fetch()` against the
 * documented Soroban RPC methods, no `@stellar/stellar-sdk` dependency (same
 * posture as `horizonClient.ts`: `fetch` is a Hermes/RN global; the SDK's
 * `rpc.Server` would drag in ESM/transitive surface this app deliberately
 * avoids). Covers only what the onchain-settlement rail needs:
 * `simulateTransaction` → `sendTransaction` → poll `getTransaction`.
 *
 * The endpoint comes from `chain.rpcUrl` — the Soroban RPC URL the backend now
 * serves for Stellar rows (see `hooks/useWallet.helpers.ts`). It is `undefined`
 * on networks with no Soroban deployment (mainnet today); the factory throws a
 * clear error there rather than silently pointing at Horizon.
 */

import { Networks } from "@stellar/stellar-base";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { assertStellarChain } from "@/constants/configs/chainConfig";
import { proxyAuthHeaders } from "@/services/rpc/proxyAuth";

/** Structured Soroban RPC failure — mirrors `HorizonRequestError`'s shape. */
export class SorobanRpcError extends Error {
  override readonly name = "SorobanRpcError";
  readonly code?: number;
  /** Diagnostic-only (never shown to users): the raw JSON-RPC error / result. */
  readonly body?: unknown;
  constructor(message: string, code?: number, body?: unknown) {
    super(message);
    this.code = code;
    this.body = body;
  }
}

/** `simulateTransaction` result subset the assembler consumes. */
export interface SimulateResult {
  /** base64 `SorobanTransactionData` (footprint + resource fees). */
  transactionData: string;
  /** Extra resource fee (stroops, decimal string) to add to the base fee. */
  minResourceFee: string;
  /** base64 `SorobanAuthorizationEntry[]` the invocation requires. */
  auth: string[];
  latestLedger: number;
  /**
   * Present when the invocation touches ledger entries that have been
   * archived. Soroban entries have a TTL, and once archived an
   * invocation reading them fails at consensus with nothing useful to
   * show the user.
   *
   * The preamble describes a `RestoreFootprint` operation that must be
   * submitted and confirmed FIRST. The original invocation then has to
   * be re-simulated, because this footprint and resource fee were
   * computed against pre-restore ledger state.
   */
  restorePreamble?: {
    transactionData: string;
    minResourceFee: string;
  };
}

export type GetTransactionStatus = "NOT_FOUND" | "SUCCESS" | "FAILED";

export interface GetTransactionResult {
  status: GetTransactionStatus;
  latestLedger: number;
  /** base64 `TransactionResult` XDR — present once the tx is in a ledger. */
  resultXdr?: string;
}

export interface SendTransactionResult {
  status: "PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR";
  hash: string;
  latestLedger: number;
  /** base64 `TransactionResult` XDR — present when status is ERROR. */
  errorResultXdr?: string;
}

export interface SorobanRpcClient {
  rpcUrl: string;
  networkPassphrase: string;
  simulateTransaction(txXdrBase64: string): Promise<SimulateResult>;
  sendTransaction(txXdrBase64: string): Promise<SendTransactionResult>;
  getTransaction(hash: string): Promise<GetTransactionResult>;
}

interface JsonRpcEnvelope<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  // The wallet's Soroban endpoint is the same authenticated rpc-proxy the
  // EVM chains use, and a plain `fetch` sent it no bearer — every read
  // came back 401. `proxyAuthHeaders` is origin-gated on what the
  // backend feed registered, so a public Soroban endpoint still gets no
  // header and our key never leaves our own infrastructure.
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...proxyAuthHeaders(rpcUrl),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // Non-JSON error body — leave undefined.
    }
    throw new SorobanRpcError(
      `Soroban RPC ${method} failed with status ${res.status}`,
      res.status,
      body,
    );
  }
  const json = (await res.json()) as JsonRpcEnvelope<T>;
  if (json.error) {
    throw new SorobanRpcError(
      `Soroban RPC ${method} error: ${json.error.message}`,
      json.error.code,
      json.error,
    );
  }
  if (json.result === undefined) {
    throw new SorobanRpcError(`Soroban RPC ${method} returned no result`);
  }
  return json.result;
}

/**
 * Build a Soroban RPC client bound to `chain`'s `rpcUrl`. Network passphrase
 * is read from `Networks` constants (not the config) so a mismatch can't
 * silently sign for the wrong network — same guard as `getHorizonClient`.
 */
export function getSorobanRpcClient(
  chainConfig: ChainConfig,
): SorobanRpcClient {
  const chain = assertStellarChain(chainConfig);
  const rpcUrl = chain.rpcUrl;
  if (!rpcUrl) {
    throw new SorobanRpcError(
      `Soroban RPC unavailable for Stellar ${chain.network} (no rpcUrl configured)`,
    );
  }
  const networkPassphrase =
    chain.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

  return {
    rpcUrl,
    networkPassphrase,
    async simulateTransaction(txXdrBase64: string): Promise<SimulateResult> {
      const raw = await rpcCall<{
        transactionData?: string;
        minResourceFee?: string;
        results?: { auth?: string[]; xdr?: string }[];
        restorePreamble?: {
          transactionData?: string;
          minResourceFee?: string;
        };
        latestLedger: number;
        error?: string;
      }>(rpcUrl, "simulateTransaction", { transaction: txXdrBase64 });
      if (raw.error) {
        throw new SorobanRpcError(
          `simulateTransaction: ${raw.error}`,
          undefined,
          raw,
        );
      }
      if (!raw.transactionData || raw.minResourceFee === undefined) {
        throw new SorobanRpcError(
          "simulateTransaction: missing transactionData/minResourceFee",
          undefined,
          raw,
        );
      }
      // An empty `transactionData` on the preamble means "nothing to
      // restore" — treat only a fully-populated preamble as real, so a
      // partial response cannot trigger a pointless restore transaction.
      const preamble =
        raw.restorePreamble?.transactionData &&
        raw.restorePreamble.minResourceFee !== undefined
          ? {
              transactionData: raw.restorePreamble.transactionData,
              minResourceFee: raw.restorePreamble.minResourceFee,
            }
          : undefined;
      return {
        transactionData: raw.transactionData,
        minResourceFee: raw.minResourceFee,
        auth: raw.results?.[0]?.auth ?? [],
        latestLedger: raw.latestLedger,
        restorePreamble: preamble,
      };
    },
    async sendTransaction(txXdrBase64: string): Promise<SendTransactionResult> {
      return rpcCall<SendTransactionResult>(rpcUrl, "sendTransaction", {
        transaction: txXdrBase64,
      });
    },
    async getTransaction(hash: string): Promise<GetTransactionResult> {
      return rpcCall<GetTransactionResult>(rpcUrl, "getTransaction", { hash });
    },
  };
}
