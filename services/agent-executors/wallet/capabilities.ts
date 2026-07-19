/**
 * Chain-agnostic (capability-based) wallet executors.
 *
 * A Facade over the per-namespace balance / asset executors: the agent
 * calls ONE intent tool (`get_native_balance`, `get_wallet_assets`) and this
 * router dispatches to the correct namespace implementation via a
 * namespace → executor lookup (the Strategy). The per-namespace executors
 * already route through the `walletKitRegistry` adapter, so this keeps the
 * shared code chain-agnostic per the space-docking rule — the agent no
 * longer has to know whether the wallet is EVM / Solana / Sui / Stellar.
 *
 * The delegate functions stay individually registered (history replay +
 * registry parity unchanged); the server simply hides those per-namespace
 * tool NAMES from the model (see agent-api `namespaceScope.ts`
 * `SUPERSEDED_BY_CAPABILITY`) so only these two capability tools are offered.
 */

import { parseEther } from "viem";
import type { WalletBalancesPayload } from "../balancePayload";
import {
  ExecutorError,
  ExecutorErrorCode,
  type MobileToolExecutor,
  requireString,
  safeExecute,
  type ToolInput,
  type ToolResult,
} from "../types";
import { getWalletBalance, getWalletTokens } from "./reads";
import {
  getSolanaWalletTokens,
  getWalletSolBalance,
  sendSol,
  sendSplToken,
} from "./solana";
import {
  getWalletStellarAssets,
  getWalletXlmBalance,
  sendStellarAsset,
  sendXlm,
} from "./stellar";
import {
  getSuiWalletTokens,
  getWalletSuiBalance,
  sendSui,
  sendSuiCoin,
} from "./sui";
import { sendNativeToken, transferErc20 } from "./writes";

/**
 * Native-balance route per wallet namespace. Keyed on `wallet.namespace`
 * (the CAIP namespace: `eip155` | `solana` | `sui` | `stellar`).
 */
const NATIVE_BALANCE_ROUTES: Record<string, MobileToolExecutor> = {
  eip155: getWalletBalance,
  solana: getWalletSolBalance,
  sui: getWalletSuiBalance,
  stellar: getWalletXlmBalance,
};

/** Asset-list route per wallet namespace. */
const ASSET_LIST_ROUTES: Record<string, MobileToolExecutor> = {
  eip155: getWalletTokens,
  solana: getSolanaWalletTokens,
  sui: getSuiWalletTokens,
  stellar: getWalletStellarAssets,
};

/**
 * Build a router executor that dispatches to the per-namespace delegate for
 * the connected wallet's namespace. Fails with `unsupported_chain` (never a
 * raw error) when no route exists — the same coarse code the delegates use.
 */
function routeByWalletNamespace(
  routes: Record<string, MobileToolExecutor>,
): MobileToolExecutor {
  return (input, context) => {
    const namespace = context.wallet?.namespace;
    const delegate = namespace ? routes[namespace] : undefined;
    if (!delegate) {
      return safeExecute(async () => {
        throw new ExecutorError(
          ExecutorErrorCode.UnsupportedChain,
          `no route for namespace ${namespace ?? "unknown"}`,
        );
      });
    }
    return delegate(input, context);
  };
}

/** `get_native_balance` — connected wallet's native coin balance, any chain. */
export const getNativeBalance: MobileToolExecutor =
  routeByWalletNamespace(NATIVE_BALANCE_ROUTES);

/** `get_wallet_assets` — connected wallet's token/asset list, any chain. */
export const getWalletAssets: MobileToolExecutor =
  routeByWalletNamespace(ASSET_LIST_ROUTES);

// ─── Writes ─────────────────────────────────────────────────────────────────
// `send_native` / `send_token` take chain-agnostic inputs ({ to, amount } /
// { to, symbol, amount }) and ADAPT them to each namespace's existing,
// already-tested send executor — which keeps the proven signing path,
// gas handling, and `recordTransferHistory` untouched (the money path is not
// rewritten). Only the input field names + EVM's human→wei conversion differ,
// so each namespace supplies a tiny `build` adapter alongside its `exec`.

type NativeSendArgs = { to: string; amount: string };
type TokenSendArgs = { to: string; amount: string; address: string; decimals: number };

interface NativeSendRoute {
  build: (a: NativeSendArgs) => ToolInput;
  exec: MobileToolExecutor;
}
interface TokenSendRoute {
  build: (a: TokenSendArgs) => ToolInput;
  exec: MobileToolExecutor;
}

const NATIVE_SEND_ROUTES: Record<string, NativeSendRoute> = {
  // EVM native is 18-decimal — the delegate wants raw wei, so convert here.
  // chain_id is omitted: the delegate falls back to context.activeChainId.
  eip155: {
    build: (a) => ({ to: a.to, value_wei: parseEther(a.amount).toString() }),
    exec: sendNativeToken,
  },
  solana: { build: (a) => ({ to: a.to, amount_sol: a.amount }), exec: sendSol },
  sui: { build: (a) => ({ to: a.to, amount_sui: a.amount }), exec: sendSui },
  stellar: { build: (a) => ({ to: a.to, amount_xlm: a.amount }), exec: sendXlm },
};

const TOKEN_SEND_ROUTES: Record<string, TokenSendRoute> = {
  eip155: {
    build: (a) => ({
      contract_address: a.address,
      to: a.to,
      token_amount: a.amount,
      token_decimals: a.decimals,
    }),
    exec: transferErc20,
  },
  solana: {
    build: (a) => ({
      mint_address: a.address,
      to: a.to,
      token_amount: a.amount,
      token_decimals: a.decimals,
    }),
    exec: sendSplToken,
  },
  sui: {
    build: (a) => ({
      coin_type: a.address,
      to: a.to,
      token_amount: a.amount,
      token_decimals: a.decimals,
    }),
    exec: sendSuiCoin,
  },
  stellar: {
    // The Stellar asset identifier is the compound `CODE:ISSUER` from
    // get_wallet_assets — split it back into the delegate's two fields.
    build: (a) => {
      const [code, issuer] = a.address.split(":");
      return { to: a.to, code, issuer, amount: a.amount };
    },
    exec: sendStellarAsset,
  },
};

/**
 * Stamp the wallet namespace onto a delegate's result so the unified receipt
 * card (`UnifiedPendingTxCard`) can pick the right per-namespace renderer
 * deterministically instead of sniffing the result shape. Only touches
 * object-shaped `data`; a rejected / bare result passes through untouched.
 */
function stampNamespace(result: ToolResult, namespace: string): ToolResult {
  if (result.data && typeof result.data === "object") {
    return {
      ...result,
      data: { ...(result.data as Record<string, unknown>), namespace },
    };
  }
  return result;
}

/** `send_native` — transfer the native coin, whatever the active namespace. */
export const sendNative: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const namespace = context.wallet?.namespace ?? "";
    const route = NATIVE_SEND_ROUTES[namespace];
    if (!route) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        `no native send route for namespace ${namespace || "unknown"}`,
      );
    }
    const to = requireString(input, "to");
    const amount = requireString(input, "amount");
    return stampNamespace(await route.exec(route.build({ to, amount }), context), namespace);
  });

/**
 * `send_token` — transfer a non-native asset. Resolves the user-facing
 * `symbol` to the active namespace's on-chain identifier + decimals via the
 * SAME asset-list path the model reads from (no separate loader), then hands
 * off to the per-namespace send executor.
 */
export const sendToken: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const namespace = context.wallet?.namespace ?? "";
    const route = TOKEN_SEND_ROUTES[namespace];
    const assetLister = ASSET_LIST_ROUTES[namespace];
    if (!route || !assetLister) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        `no token send route for namespace ${namespace || "unknown"}`,
      );
    }
    const to = requireString(input, "to");
    const symbol = requireString(input, "symbol");
    const amount = requireString(input, "amount");

    // Resolve symbol → { address, decimals } using the asset-list delegate.
    const listed = (await assetLister(
      { symbol, is_native_currency: false, include_balance: false },
      context,
    )) as ToolResult & { display?: WalletBalancesPayload };
    if (listed.status !== "success" || !listed.display) {
      throw new ExecutorError(
        ExecutorErrorCode.NetworkError,
        "asset_lookup_failed",
      );
    }
    const rows = listed.display.groups?.[0]?.tokens ?? [];
    const want = symbol.toLowerCase();
    const match =
      rows.find((r) => !r.is_native && r.symbol.toLowerCase() === want) ??
      rows.find((r) => !r.is_native && r.symbol.toLowerCase().startsWith(want));
    if (!match || !match.address) {
      throw new ExecutorError(ExecutorErrorCode.InvalidInput, "token_not_found");
    }

    return stampNamespace(
      await route.exec(
        route.build({
          to,
          amount,
          address: match.address,
          decimals: match.decimals,
        }),
        context,
      ),
      namespace,
    );
  });

export const CAPABILITY_EXECUTORS: Record<string, MobileToolExecutor> = {
  get_native_balance: getNativeBalance,
  get_wallet_assets: getWalletAssets,
  send_native: sendNative,
  send_token: sendToken,
};
