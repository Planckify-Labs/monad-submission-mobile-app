/**
 * Solana WalletConnect capabilities — deep-link spec §4.5 / §7.3 / §7.4.
 *
 * Chains are advertised in the CAIP-2 form AppKit sends (genesis-hash
 * references, `services/walletconnect/caipMapping.ts`); requests come
 * back in that form and are translated to the adapter's short
 * `solana:mainnet|devnet|testnet` aliases. Method table:
 *
 *   solana_signMessage {message: base58, pubkey}   → solana:signMessage       → { signature: base58 }
 *   solana_signTransaction {transaction: base64}   → solana:signTransaction   → { signature, transaction }
 *   solana_signAllTransactions {transactions[]}    → solana:signTransaction×N → { transactions: base64[] }
 *   solana_signAndSendTransaction {transaction}    → solana:signAndSend…      → { signature: base58 }
 *   solana_getAccounts / solana_requestAccounts    → answered by the transport → [{ pubkey }]
 *
 * The deprecated `feePayer`/`instructions`/`recentBlockhash` param shape
 * of `solana_signTransaction` is not accepted (`-32602`).
 */

import bs58 from "bs58";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import { base64ToBytes, bytesToBase64 } from "@/services/chains/solana/codec";
import {
  solanaClusterToWcCaip2,
  wcCaip2ToSolanaCluster,
} from "@/services/walletconnect/caipMapping";
import type { WalletKitAdapter } from "../types";

export const SOLANA_WC_METHODS: readonly string[] = [
  "solana_signMessage",
  "solana_signTransaction",
  "solana_signAllTransactions",
  "solana_signAndSendTransaction",
  "solana_getAccounts",
  "solana_requestAccounts",
];

export const SOLANA_WC_EVENTS: readonly string[] = [
  "chainChanged",
  "accountsChanged",
];

function shortChain(caip2: string): string | null {
  const cluster = wcCaip2ToSolanaCluster(caip2);
  if (!cluster) return null;
  return cluster === "mainnet-beta" ? "solana:mainnet" : `solana:${cluster}`;
}

/** First signature of a base64 wire transaction (compact-u16 count + 64-byte sigs). */
export function firstSignatureBase58(wireBase64: string): string {
  const bytes = base64ToBytes(wireBase64);
  // Compact-u16: one byte for counts < 0x80, which every real tx is.
  const count = bytes[0] & 0x7f;
  const offset = bytes[0] & 0x80 ? 2 : 1;
  if (count === 0 || bytes.length < offset + 64) return "";
  return bs58.encode(bytes.slice(offset, offset + 64));
}

export const solanaWalletConnectNamespace: NonNullable<
  WalletKitAdapter["walletConnectNamespace"]
> = ({ wallets, chains }: { wallets: TWallet[]; chains: ChainConfig[] }) => {
  const solWallets = wallets.filter((w) => w.namespace === "solana");
  const clusters = Array.from(
    new Set(
      chains
        .filter(
          (c): c is Extract<ChainConfig, { namespace: "solana" }> =>
            c.namespace === "solana",
        )
        .map((c) => c.cluster),
    ),
  );
  if (solWallets.length === 0 || clusters.length === 0) return null;
  const caipChains = clusters.map((c) => solanaClusterToWcCaip2(c));
  const accounts: string[] = [];
  for (const chain of caipChains)
    for (const w of solWallets) accounts.push(`${chain}:${w.address}`);
  return {
    chains: caipChains,
    methods: [...SOLANA_WC_METHODS],
    events: [...SOLANA_WC_EVENTS],
    accounts,
  };
};

type P = Record<string, unknown>;
const obj = (p: unknown): P => (p && typeof p === "object" ? (p as P) : {});

export const solanaWalletConnectCodec: NonNullable<
  WalletKitAdapter["walletConnectCodec"]
> = {
  connectRequest() {
    return { method: "standard:connect", params: [{ silent: false }] };
  },
  toChainRequest(method, params, chainId, ctx) {
    const chain = shortChain(chainId);
    if (!chain) return null;
    const p = obj(params);
    switch (method) {
      case "solana_getAccounts":
      case "solana_requestAccounts":
        return {
          transportResult: ctx.accounts
            .filter((a) => a.startsWith("solana:"))
            .map((a) => ({ pubkey: a.split(":")[2] })),
        };
      case "solana_signMessage": {
        if (typeof p.message !== "string") return null;
        let bytes: Uint8Array;
        try {
          bytes = bs58.decode(p.message);
        } catch {
          return null;
        }
        return {
          method: "solana:signMessage",
          params: [
            {
              address: typeof p.pubkey === "string" ? p.pubkey : undefined,
              message: bytesToBase64(bytes),
            },
          ],
        };
      }
      case "solana_signTransaction": {
        if (typeof p.transaction !== "string") return null; // deprecated shape refused
        return {
          method: "solana:signTransaction",
          params: [{ transaction: p.transaction, chain }],
        };
      }
      case "solana_signAllTransactions": {
        if (
          !Array.isArray(p.transactions) ||
          p.transactions.some((t) => typeof t !== "string")
        )
          return null;
        return {
          method: "solana:signTransaction",
          params: (p.transactions as string[]).map((transaction) => ({
            transaction,
            chain,
          })),
        };
      }
      case "solana_signAndSendTransaction": {
        if (typeof p.transaction !== "string") return null;
        return {
          method: "solana:signAndSendTransaction",
          params: [
            { transaction: p.transaction, chain, options: p.sendOptions },
          ],
        };
      }
      default:
        return null;
    }
  },
  fromChainResult(method, value) {
    switch (method) {
      case "solana_signMessage": {
        const sig = (value as { signature?: string })?.signature ?? "";
        return { signature: bs58.encode(base64ToBytes(sig)) };
      }
      case "solana_signTransaction": {
        const first = Array.isArray(value)
          ? (value[0] as { signedTransaction?: string })
          : undefined;
        const signed = first?.signedTransaction ?? "";
        return { signature: firstSignatureBase58(signed), transaction: signed };
      }
      case "solana_signAllTransactions": {
        const list = Array.isArray(value)
          ? (value as Array<{ signedTransaction?: string }>)
          : [];
        return { transactions: list.map((v) => v.signedTransaction ?? "") };
      }
      case "solana_signAndSendTransaction": {
        const first = Array.isArray(value)
          ? (value[0] as { signature?: string })
          : undefined;
        return { signature: first?.signature ?? "" };
      }
      default:
        return value;
    }
  },
};
