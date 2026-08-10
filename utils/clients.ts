import {
  Account,
  Chain,
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { chainRpcUrl, rpcFetchOptions } from "@/services/rpc/proxyAuth";

type TChainConfig = Chain;

// `http()` with no URL resolves to `chain.rpcUrls.default.http[0]`, which for
// backend-derived chains is the rpc-proxy. Pass it explicitly so the bearer can
// be matched to that URL — see services/rpc/proxyAuth.ts.
export const getPublicClient = (chain: TChainConfig) => {
  const url = chainRpcUrl(chain);
  const publicClient = createPublicClient({
    chain: chain,
    transport: http(url, rpcFetchOptions(url)),
  });
  return publicClient;
};

export const getWalletClient = (account: Account, chain: TChainConfig) => {
  const url = chainRpcUrl(chain);
  const walletClient = createWalletClient({
    account,
    chain: chain,
    transport: http(url, rpcFetchOptions(url)),
  });
  return walletClient;
};
