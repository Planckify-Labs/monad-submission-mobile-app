/**
 * EVM WalletConnect capabilities — deep-link spec §4.5 / §7.3 / §7.4.
 *
 * `walletConnectNamespace` advertises every backend `eip155` chain row
 * and the methods `EvmAdapter` dispatches, **minus** `eth_sign`
 * (hard-rejected at the bridge), `eth_signTransaction` and
 * `eth_sendRawTransaction` (never offered to a remote peer: the first
 * returns a signed blob the peer broadcasts itself, the second lets it
 * inject one). The codec is the identity mapping: WalletConnect and
 * EIP-1193 share method names and result shapes.
 */

import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import type { WalletKitAdapter } from "../types";

/** Methods a WalletConnect session may call. Order is cosmetic. */
export const EVM_WC_METHODS: readonly string[] = [
  "eth_accounts",
  "eth_requestAccounts",
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_sendTransaction",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "wallet_watchAsset",
  "wallet_getCapabilities",
  "wallet_sendCalls",
  "wallet_getCallsStatus",
  "wallet_showCallsStatus",
  "wallet_getPermissions",
  "wallet_requestPermissions",
  "wallet_revokePermissions",
];

/** Never advertised to a remote peer (see module doc). */
export const EVM_WC_EXCLUDED_METHODS: readonly string[] = [
  "eth_sign",
  "eth_signTransaction",
  "eth_sendRawTransaction",
];

export const EVM_WC_EVENTS: readonly string[] = [
  "chainChanged",
  "accountsChanged",
];

export const evmWalletConnectNamespace: NonNullable<
  WalletKitAdapter["walletConnectNamespace"]
> = ({ wallets, chains }: { wallets: TWallet[]; chains: ChainConfig[] }) => {
  const evmWallets = wallets.filter((w) => w.namespace === "eip155");
  const ids = Array.from(
    new Set(
      chains
        .filter(
          (c): c is Extract<ChainConfig, { namespace: "eip155" }> =>
            c.namespace === "eip155",
        )
        .map((c) => c.chain.id),
    ),
  );
  if (evmWallets.length === 0 || ids.length === 0) return null;
  const caipChains = ids.map((id) => `eip155:${id}`);
  const accounts: string[] = [];
  for (const chain of caipChains) {
    for (const w of evmWallets) accounts.push(`${chain}:${w.address}`);
  }
  return {
    chains: caipChains,
    methods: [...EVM_WC_METHODS],
    events: [...EVM_WC_EVENTS],
    accounts,
  };
};

export const evmWalletConnectCodec: NonNullable<
  WalletKitAdapter["walletConnectCodec"]
> = {
  connectRequest() {
    return { method: "eth_requestAccounts", params: [] };
  },
  toChainRequest(method, params, chainId) {
    if (EVM_WC_EXCLUDED_METHODS.includes(method)) return null;
    if (!EVM_WC_METHODS.includes(method)) return null;
    const ref = Number(chainId.split(":")[1]);
    return {
      method,
      params,
      // The transport pins the origin's chain through `OriginChainStore`
      // before dispatch; this is the numeric hint it uses.
      chainOverride: Number.isInteger(ref) ? ref : undefined,
    };
  },
  fromChainResult(_method, value) {
    return value;
  },
};
