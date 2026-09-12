/**
 * Stellar WalletConnect capabilities — deep-link spec §4.5 / §7.4.
 * CAIP-2 `stellar:pubnet|testnet`, CAIP-10 `stellar:pubnet:G…` (G-StrKey
 * only). Method table:
 *
 *   stellar_signXDR {xdr, chain?, account?}   → SUBMIT_TRANSACTION (sign-only)   → { signedXDR, signerAddress }
 *   stellar_signAndSubmitXDR {xdr, …}         → SUBMIT_TRANSACTION (submit)      → { tx_hash, signedXDR, successful }
 *   stellar_signMessage {message, account?}   → SUBMIT_BLOB                      → { signedMessage, signerAddress }
 *   stellar_signAuthEntry {authEntryXdr, …}   → SUBMIT_AUTH_ENTRY                → { signedAuthEntry, signerAddress }
 *
 * "Wallet MUST reject signing if the encoded network_id inside the tx
 * does not match this chain": the adapter signs with the passphrase the
 * request's CAIP-2 chain resolves to, so a mismatched envelope fails
 * signature verification on submit rather than being signed for the
 * wrong network.
 */

import { Networks } from "@stellar/stellar-base";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import {
  caipReferenceToStellarNetwork,
  stellarNetworkToCaipReference,
} from "@/services/walletconnect/caipMapping";
import type { WalletKitAdapter } from "../types";

export const STELLAR_WC_METHODS: readonly string[] = [
  "stellar_signXDR",
  "stellar_signAndSubmitXDR",
  "stellar_signMessage",
  "stellar_signAuthEntry",
];
export const STELLAR_WC_EVENTS: readonly string[] = ["accountsChanged"];

type P = Record<string, unknown>;
const obj = (p: unknown): P => (p && typeof p === "object" ? (p as P) : {});

function passphraseFor(caip2: string): string | null {
  const [ns, ref] = caip2.split(":");
  if (ns !== "stellar" || !ref) return null;
  const network = caipReferenceToStellarNetwork(ref);
  if (!network) return null;
  return network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

export const stellarWalletConnectNamespace: NonNullable<
  WalletKitAdapter["walletConnectNamespace"]
> = ({ wallets, chains }: { wallets: TWallet[]; chains: ChainConfig[] }) => {
  const xlmWallets = wallets.filter((w) => w.namespace === "stellar");
  const refs = Array.from(
    new Set(
      chains
        .filter(
          (c): c is Extract<ChainConfig, { namespace: "stellar" }> =>
            c.namespace === "stellar",
        )
        .map((c) => stellarNetworkToCaipReference(c.network)),
    ),
  );
  if (xlmWallets.length === 0 || refs.length === 0) return null;
  const caipChains = refs.map((r) => `stellar:${r}`);
  const accounts: string[] = [];
  for (const chain of caipChains)
    for (const w of xlmWallets) accounts.push(`${chain}:${w.address}`);
  return {
    chains: caipChains,
    methods: [...STELLAR_WC_METHODS],
    events: [...STELLAR_WC_EVENTS],
    accounts,
  };
};

export const stellarWalletConnectCodec: NonNullable<
  WalletKitAdapter["walletConnectCodec"]
> = {
  connectRequest() {
    return { method: "REQUEST_ACCESS", params: {} };
  },
  toChainRequest(method, params, chainId) {
    const networkPassphrase = passphraseFor(chainId);
    if (!networkPassphrase) return null;
    const p = obj(params);
    const accountToSign = typeof p.account === "string" ? p.account : undefined;
    switch (method) {
      case "stellar_signXDR":
        if (typeof p.xdr !== "string") return null;
        return {
          method: "SUBMIT_TRANSACTION",
          params: { transactionXdr: p.xdr, networkPassphrase, accountToSign },
        };
      case "stellar_signAndSubmitXDR":
        if (typeof p.xdr !== "string") return null;
        return {
          method: "SUBMIT_TRANSACTION",
          params: {
            transactionXdr: p.xdr,
            networkPassphrase,
            accountToSign,
            submit: true,
          },
        };
      case "stellar_signMessage":
        if (typeof p.message !== "string") return null;
        return {
          method: "SUBMIT_BLOB",
          params: { blob: p.message, networkPassphrase, accountToSign },
        };
      case "stellar_signAuthEntry": {
        const entry =
          typeof p.authEntryXdr === "string"
            ? p.authEntryXdr
            : typeof p.xdr === "string"
              ? p.xdr
              : null;
        if (!entry) return null;
        return {
          method: "SUBMIT_AUTH_ENTRY",
          params: { authEntryXdr: entry, networkPassphrase, accountToSign },
        };
      }
      default:
        return null;
    }
  },
  fromChainResult(method, value) {
    const v = obj(value);
    switch (method) {
      case "stellar_signXDR":
        return {
          signedXDR: v.signedTransaction,
          signerAddress: v.signerAddress,
        };
      case "stellar_signAndSubmitXDR":
        return {
          tx_hash: v.hash,
          signedXDR: v.signedTransaction,
          successful: typeof v.hash === "string" && v.hash.length > 0,
        };
      case "stellar_signMessage":
        return {
          signedMessage: v.signedMessage,
          signerAddress: v.signerAddress,
        };
      case "stellar_signAuthEntry":
        return {
          signedAuthEntry: v.signedAuthEntry,
          signerAddress: v.signerAddress,
        };
      default:
        return value;
    }
  },
};
