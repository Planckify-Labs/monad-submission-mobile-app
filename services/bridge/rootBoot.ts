/**
 * Root bridge boot — deep-link spec §4.6 (F3).
 *
 * The approval spine (`bootBridge` + `<ApprovalHost/>`) used to exist
 * only while `app/dapps-browser.tsx` was mounted, so a WalletConnect
 * request, a SEP-0007 `tx` or an MWA association arriving on the home
 * screen had nowhere to render. This boots the bridge from
 * `app/_layout.tsx` right after `bootWalletKits()`; the browser screen's
 * own `bootBridge()` call becomes a rebind (its `booted` guard) that
 * re-attaches the WebView getter and the browser's chain resolvers.
 *
 * `getContext()` at the root returns `activeWallet: null` on purpose:
 * external transports bind their own wallet (§4.7) and the bridge stamps
 * it per request; nothing on that path may read the home-screen wallet
 * (invariant S-4, `feedback_dapp_bridge_isolation`).
 */

import { mainnet } from "viem/chains";
import type { TBlockchain } from "@/api/types/blockchain";
import type { TWallet } from "@/constants/types/walletTypes";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import { readActiveBlockchainRows } from "@/services/blockchains/cache";
import { getAccountForWallet } from "@/services/walletService";
import { bootBridge } from "./boot";

/** Wallet list the root context reads. `AppShell` keeps it current. */
const holder: { wallets: TWallet[] } = { wallets: [] };

export function setRootBridgeWallets(wallets: TWallet[]): void {
  holder.wallets = wallets;
}

/** Current wallet list as the root context sees it (never the active wallet). */
export function getRootBridgeWallets(): TWallet[] {
  return holder.wallets;
}

function evmRow(
  rows: TBlockchain[] | null,
  chainId: number,
): TBlockchain | null {
  return (
    rows?.find((b) => b.isEVM && b.chainId === chainId && Boolean(b.rpcUrl)) ??
    null
  );
}

/** The EVM adapter's own chain shape: a viem chain plus the RPC to serve it on. */
type EvmAdapterChain = { chain: import("viem").Chain; rpcUrl: string };

function evmConfigFromRow(row: TBlockchain | null): EvmAdapterChain | null {
  if (!row) return null;
  const cfg = buildChainConfigFromBlockchain(row);
  // `rpcUrl` from the feed is the project's RPC proxy for that chain —
  // the same value the dApps browser serves (`browserRpcForRow`).
  return cfg.namespace === "eip155"
    ? { chain: cfg.chain, rpcUrl: row.rpcUrl }
    : null;
}

function resolveSupportedEvmChain(chainId: number): EvmAdapterChain | null {
  return evmConfigFromRow(evmRow(readActiveBlockchainRows(), chainId));
}

function resolveDefaultEvmChain(): EvmAdapterChain | null {
  const rows = readActiveBlockchainRows();
  const byMainnet = evmConfigFromRow(evmRow(rows, mainnet.id));
  if (byMainnet) return byMainnet;
  const first =
    rows?.find(
      (b) => b.isEVM && typeof b.chainId === "number" && Boolean(b.rpcUrl),
    ) ?? null;
  return evmConfigFromRow(first);
}

let rootBooted = false;

/**
 * Idempotent. Call once from the root layout after `bootWalletKits()`.
 */
export function bootBridgeAtRoot(): void {
  if (rootBooted) return;
  rootBooted = true;
  bootBridge({
    getContext: () => ({
      activeWallet: null,
      wallets: holder.wallets,
      getAccount: getAccountForWallet,
      chainOverride: undefined,
    }),
    getWebView: () => null,
    // Feed-backed defaults. The dApps browser rebinds these with its own
    // active-chain-aware resolvers when it mounts (`bootBridge` keeps a
    // live holder), so browser behaviour is unchanged.
    resolveEvmChain: () => resolveDefaultEvmChain(),
    resolveSupportedEvmChain,
    resolveDefaultEvmChain,
  });
}
