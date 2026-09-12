/**
 * Sui WalletConnect capabilities — deep-link spec §4.5 / §7.4. The Sui
 * RPC standard "is still under review" per the WalletConnect docs; the
 * shapes below follow the published page (2026-09-11):
 *
 *   sui_signTransaction {transaction, address?}           → sui:signTransaction           → { signature, transactionBytes }
 *   sui_signAndExecuteTransaction {transaction, address?} → sui:signAndExecuteTransaction → { digest }
 *   sui_signPersonalMessage {message, address}            → sui:signPersonalMessage       → { signature }
 *   sui_getAccounts                                       → transport                     → [{ pubkey, address }]
 */

import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import { chainToNetwork } from "@/services/chains/sui/payloads";
import type { WalletKitAdapter } from "../types";

export const SUI_WC_METHODS: readonly string[] = [
  "sui_signTransaction",
  "sui_signAndExecuteTransaction",
  "sui_signPersonalMessage",
  "sui_getAccounts",
];
export const SUI_WC_EVENTS: readonly string[] = [
  "chainChanged",
  "accountsChanged",
];

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function toBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return typeof btoa === "function"
    ? btoa(bin)
    : Buffer.from(bytes).toString("base64");
}

type P = Record<string, unknown>;
const obj = (p: unknown): P => (p && typeof p === "object" ? (p as P) : {});

export const suiWalletConnectNamespace: NonNullable<
  WalletKitAdapter["walletConnectNamespace"]
> = ({ wallets, chains }: { wallets: TWallet[]; chains: ChainConfig[] }) => {
  const suiWallets = wallets.filter((w) => w.namespace === "sui");
  const networks = Array.from(
    new Set(
      chains
        .filter(
          (c): c is Extract<ChainConfig, { namespace: "sui" }> =>
            c.namespace === "sui",
        )
        .map((c) => c.network),
    ),
  );
  if (suiWallets.length === 0 || networks.length === 0) return null;
  const caipChains = networks.map((n) => `sui:${n}`);
  const accounts: string[] = [];
  for (const chain of caipChains)
    for (const w of suiWallets) accounts.push(`${chain}:${w.address}`);
  return {
    chains: caipChains,
    methods: [...SUI_WC_METHODS],
    events: [...SUI_WC_EVENTS],
    accounts,
  };
};

/** `sui_getAccounts` needs the ed25519 pubkey next to the address. */
export function suiAccountsForSession(
  accounts: string[],
  wallets: TWallet[],
): Array<{ pubkey: string; address: string }> {
  const out: Array<{ pubkey: string; address: string }> = [];
  const seen = new Set<string>();
  for (const a of accounts) {
    if (!a.startsWith("sui:")) continue;
    const address = a.split(":")[2];
    if (!address || seen.has(address)) continue;
    seen.add(address);
    const w = wallets.find(
      (x) =>
        x.namespace === "sui" &&
        x.address.toLowerCase() === address.toLowerCase(),
    );
    out.push({ pubkey: w?.sui?.pubkeyHex ?? "", address });
  }
  return out;
}

export const suiWalletConnectCodec: NonNullable<
  WalletKitAdapter["walletConnectCodec"]
> = {
  connectRequest(chainId) {
    return {
      method: "standard:connect",
      params: [{ silent: false, chain: chainId }],
    };
  },
  toChainRequest(method, params, chainId, ctx) {
    const network = chainToNetwork(chainId);
    if (!network) return null;
    const p = obj(params);
    switch (method) {
      case "sui_getAccounts":
        return {
          transportResult: {
            accounts: ctx.accounts.filter((a) => a.startsWith("sui:")),
          },
        };
      case "sui_signTransaction":
        if (typeof p.transaction !== "string") return null;
        return {
          method: "sui:signTransaction",
          params: [
            { transaction: p.transaction, address: p.address, chain: chainId },
          ],
        };
      case "sui_signAndExecuteTransaction":
        if (typeof p.transaction !== "string") return null;
        return {
          method: "sui:signAndExecuteTransaction",
          params: [
            { transaction: p.transaction, address: p.address, chain: chainId },
          ],
        };
      case "sui_signPersonalMessage": {
        if (typeof p.message !== "string") return null;
        const message =
          BASE64_RE.test(p.message) && p.message.length % 4 === 0
            ? p.message
            : toBase64Utf8(p.message);
        return {
          method: "sui:signPersonalMessage",
          params: [{ message, address: p.address }],
        };
      }
      default:
        return null;
    }
  },
  fromChainResult(method, value) {
    const v = obj(value);
    switch (method) {
      case "sui_signTransaction":
        return { signature: v.signature, transactionBytes: v.bytes };
      case "sui_signAndExecuteTransaction":
        return { digest: v.digest };
      case "sui_signPersonalMessage":
        return { signature: v.signature };
      default:
        return value;
    }
  },
};
