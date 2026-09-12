/**
 * Phantom-compatible method table — deep-link spec §9. Wire shapes
 * verified against `docs.phantom.com/phantom-deeplinks/provider-methods/*`
 * (2026-09-11):
 *
 *   signMessage            { message: base58, session, display? } → { signature: base58 }
 *   signTransaction        { transaction: base58, session }         → { transaction: base58 }
 *   signAllTransactions    { transactions: base58[], session }      → { transactions: base58[] }
 *   signAndSendTransaction { transaction: base58, session, sendOptions? } → { signature: base58 }  (deprecated by Phantom, accepted for compatibility)
 *   disconnect             { session }                              → (no data)
 *
 * One table per namespace: this file is Solana's. A future EVM / Sui /
 * Stellar variant is a second table keyed by the session's `chain`, not
 * a change to the transport.
 */

import bs58 from "bs58";
import { base64ToBytes, bytesToBase64 } from "@/services/chains/solana/codec";
import type { Namespace } from "@/services/chains/types";
import type { EncryptedLinkMethod } from "@/services/deeplinks/types";

/** Phantom error codes, verbatim (`docs.phantom.com/solana/errors`). */
export const UL_ERRORS = {
  userRejected: { errorCode: 4001, errorMessage: "User rejected the request." },
  unauthorized: {
    errorCode: 4100,
    errorMessage:
      "The requested method and/or account has not been authorized by the user.",
  },
  invalidInput: {
    errorCode: -32000,
    errorMessage: "Missing or invalid parameters.",
  },
  resourceUnavailable: {
    errorCode: -32002,
    errorMessage: "Requested resource not available.",
  },
  transactionRejected: {
    errorCode: -32003,
    errorMessage: "Transaction creation failed.",
  },
  methodNotFound: {
    errorCode: -32601,
    errorMessage: "The method does not exist / is not available.",
  },
  internal: {
    errorCode: -32603,
    errorMessage: "Something went wrong within the wallet.",
  },
} as const;

export type UlError = (typeof UL_ERRORS)[keyof typeof UL_ERRORS];

export function ulErrorForRpc(code: number): UlError {
  switch (code) {
    case 4001:
      return UL_ERRORS.userRejected;
    case 4100:
    case 4900:
    case 4901:
      return UL_ERRORS.unauthorized;
    case -32602:
    case -32000:
      return UL_ERRORS.invalidInput;
    case -32002:
      return UL_ERRORS.resourceUnavailable;
    case -32003:
      return UL_ERRORS.transactionRejected;
    case -32601:
      return UL_ERRORS.methodNotFound;
    default:
      return UL_ERRORS.internal;
  }
}

export interface MethodTable {
  namespace: Namespace;
  chainName: string;
  /** Session `chain` value this table serves. */
  sessionChain: string;
  defaultCluster: string;
  clusterToChain(cluster: string): string;
  /** Translate a decrypted payload into the adapter request; `null` = invalid input. */
  toChainRequest(
    method: Exclude<EncryptedLinkMethod, "connect" | "disconnect">,
    payload: Record<string, unknown>,
    session: { public_key: string; cluster: string },
  ): { method: string; params: unknown } | null;
  fromChainResult(
    method: Exclude<EncryptedLinkMethod, "connect" | "disconnect">,
    value: unknown,
  ): Record<string, unknown>;
}

function b58(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || s === "") return null;
  try {
    return bs58.decode(s);
  } catch {
    return null;
  }
}

export const SOLANA_METHOD_TABLE: MethodTable = {
  namespace: "solana",
  chainName: "Solana",
  sessionChain: "solana",
  defaultCluster: "mainnet-beta",
  clusterToChain(cluster) {
    return cluster === "mainnet-beta" ? "solana:mainnet" : `solana:${cluster}`;
  },
  toChainRequest(method, p, session) {
    const chain = this.clusterToChain(session.cluster);
    switch (method) {
      case "signMessage": {
        const bytes = b58(p.message);
        if (!bytes) return null;
        return {
          method: "solana:signMessage",
          params: [
            { address: session.public_key, message: bytesToBase64(bytes) },
          ],
        };
      }
      case "signTransaction": {
        const bytes = b58(p.transaction);
        if (!bytes) return null;
        return {
          method: "solana:signTransaction",
          params: [{ transaction: bytesToBase64(bytes), chain }],
        };
      }
      case "signAllTransactions": {
        if (!Array.isArray(p.transactions) || p.transactions.length === 0)
          return null;
        const inputs: Array<{ transaction: string; chain: string }> = [];
        for (const t of p.transactions) {
          const bytes = b58(t);
          if (!bytes) return null;
          inputs.push({ transaction: bytesToBase64(bytes), chain });
        }
        return { method: "solana:signTransaction", params: inputs };
      }
      case "signAndSendTransaction": {
        const bytes = b58(p.transaction);
        if (!bytes) return null;
        return {
          method: "solana:signAndSendTransaction",
          params: [
            {
              transaction: bytesToBase64(bytes),
              chain,
              options: p.sendOptions,
            },
          ],
        };
      }
      default:
        return null;
    }
  },
  fromChainResult(method, value) {
    switch (method) {
      case "signMessage": {
        const sig = (value as { signature?: string })?.signature ?? "";
        return { signature: bs58.encode(base64ToBytes(sig)) };
      }
      case "signTransaction": {
        const first = Array.isArray(value)
          ? (value[0] as { signedTransaction?: string })
          : undefined;
        return {
          transaction: bs58.encode(
            base64ToBytes(first?.signedTransaction ?? ""),
          ),
        };
      }
      case "signAllTransactions": {
        const list = Array.isArray(value)
          ? (value as Array<{ signedTransaction?: string }>)
          : [];
        return {
          transactions: list.map((v) =>
            bs58.encode(base64ToBytes(v.signedTransaction ?? "")),
          ),
        };
      }
      case "signAndSendTransaction": {
        const first = Array.isArray(value)
          ? (value[0] as { signature?: string })
          : undefined;
        return { signature: first?.signature ?? "" };
      }
      default:
        return {};
    }
  },
};

/** Registry keyed by the session's `chain` value. */
export const METHOD_TABLES: Record<string, MethodTable> = {
  solana: SOLANA_METHOD_TABLE,
};
