/**
 * Per-chain viem client routing for mobile agent tool executors.
 *
 * The agent protocol (§3 "Multi-Chain Targeting and Parallel Execution")
 * requires that every mobile tool call reads `chain_id` directly from
 * `input.chain_id` and routes the RPC call to a matching client —
 * NEVER to the active wallet chain. Parallel cross-chain reads rely on
 * this: the server may emit `get_wallet_balance` concurrently for
 * chain_id=1, 137, 42161 and expect mobile to fan them out.
 *
 * Source of chain metadata (in priority order):
 *   1. `ExecutorContext.blockchains` — the live list from
 *      `useBlockchainsWithStorage`. This is the canonical mobile chain
 *      registry and the one the user actually configured.
 *   2. The static fallback in `constants/configs/chainConfig.ts`
 *      (`supportedChains`) — used only if the live list is empty or
 *      doesn't yet contain the requested chain (e.g. startup race).
 *
 * We deliberately do NOT introduce a new viem client factory — reads
 * and writes go through the existing `utils/clients.ts` helpers
 * (`getPublicClient` / `getWalletClient`). Caches are keyed on
 * `chain_id` alone because the viem Chain object for a given chain_id
 * is stable for the duration of a process.
 */

import { type Account, type Chain, defineChain } from "viem";
import type { TBlockchain } from "@/api/types/blockchain";
import { findEvmChainById } from "@/constants/configs/chainConfig";
import { isChainIdSupported } from "@/services/walletKit/chainSupport";
import { getPublicClient, getWalletClient } from "@/utils/clients";
import {
  type ChainClients,
  type ExecutorContext,
  ExecutorError,
  ExecutorErrorCode,
} from "./types";

const chainDefCache = new Map<number, Chain>();
const publicClientCache = new Map<number, ReturnType<typeof getPublicClient>>();
// walletClient cache is keyed on `${chainId}:${address}` so switching the
// active wallet produces a fresh client.
const walletClientCache = new Map<string, ReturnType<typeof getWalletClient>>();

/**
 * Build a viem Chain from a `TBlockchain` row. Used when the requested
 * chain_id is not available in the static `supportedChains` table.
 */
function chainFromBlockchainRow(row: TBlockchain): Chain {
  // Prefer the flagged native token; fall back to the first token, or
  // to bare blockchain metadata when the backend hasn't populated a
  // token list for this row yet.
  const nativeToken =
    row.tokens?.find((t) => t.isNativeCurrency) ?? row.tokens?.[0];
  return defineChain({
    // Agent routes only EVM chains; a null chainId here means a
    // Solana row slipped through the filter upstream. Fall back to 0
    // so viem's types stay satisfied — any subsequent viem call will
    // throw loudly on the invalid id rather than silently succeed.
    id: row.chainId ?? 0,
    name: row.name,
    nativeCurrency: {
      name: nativeToken?.name ?? row.name,
      symbol: nativeToken?.symbol ?? "N/A",
      decimals: nativeToken?.decimals ?? 18,
    },
    rpcUrls: {
      default: { http: [row.rpcUrl] },
      public: { http: [row.rpcUrl] },
    },
    blockExplorers: row.blockExplorer
      ? {
          default: { name: row.name, url: row.blockExplorer },
        }
      : undefined,
  });
}

/**
 * Look up the viem Chain definition for a given chain_id. Caches the
 * result — a chain's RPC URL / native currency doesn't change mid-session
 * for our purposes.
 */
export function resolveChainDef(
  chainId: number,
  blockchains: TBlockchain[],
): Chain {
  // Chain lockdown: `blockchains` is already filtered by the read hooks,
  // but the static table below is not — without this, an agent tool
  // could resolve (and read from) a chain the build hides.
  if (!isChainIdSupported(chainId)) {
    throw new ExecutorError(
      ExecutorErrorCode.UnsupportedChain,
      `chain_id ${chainId} is not supported by this wallet`,
    );
  }

  const cached = chainDefCache.get(chainId);
  if (cached) return cached;

  const fromLive = blockchains.find((b) => b.chainId === chainId && b.isEVM);
  if (fromLive) {
    const def = chainFromBlockchainRow(fromLive);
    chainDefCache.set(chainId, def);
    return def;
  }

  // TODO(task-05): EVM-only lookup — move under `EvmWalletKit`.
  const fromStatic = findEvmChainById(chainId);
  if (fromStatic) {
    chainDefCache.set(chainId, fromStatic.chain);
    return fromStatic.chain;
  }

  throw new ExecutorError(
    ExecutorErrorCode.UnsupportedChain,
    `chain_id ${chainId} is not supported by this wallet`,
  );
}

/**
 * Resolve the `{ publicClient, walletClient }` pair bound to a given
 * chain_id. `walletClient` is null if the wallet has no signing account
 * (e.g. watch-only) — write executors must handle that and fail with
 * `wallet_type_cannot_execute`.
 */
export function resolveChainClients(
  chainId: number,
  context: ExecutorContext,
): ChainClients {
  const chain = resolveChainDef(chainId, context.blockchains);

  let publicClient = publicClientCache.get(chainId);
  if (!publicClient) {
    publicClient = getPublicClient(chain);
    publicClientCache.set(chainId, publicClient);
  }

  let walletClient: ChainClients["walletClient"] = null;
  if (context.account) {
    const cacheKey = `${chainId}:${context.wallet.address.toLowerCase()}`;
    const existing = walletClientCache.get(cacheKey);
    if (existing) {
      walletClient = existing;
    } else {
      const wc = getWalletClient(context.account as Account, chain);
      walletClientCache.set(cacheKey, wc);
      walletClient = wc;
    }
  }

  return { publicClient, walletClient, chainId };
}

/**
 * Obtain a signing wallet client or fail with `wallet_type_cannot_execute`.
 * Used by write executors that cannot proceed without a signer.
 */
export function requireWalletClient(
  chainId: number,
  context: ExecutorContext,
): NonNullable<ChainClients["walletClient"]> {
  const { walletClient } = resolveChainClients(chainId, context);
  if (!walletClient) {
    throw new ExecutorError(
      ExecutorErrorCode.WalletCannotExecute,
      "wallet has no signing account",
    );
  }
  return walletClient;
}

/**
 * Clear all caches. Exposed for tests and for the session teardown path
 * in task 09 — switching the active wallet or logging out should drop
 * any cached wallet clients bound to the previous account.
 */
export function clearChainRouterCaches(): void {
  chainDefCache.clear();
  publicClientCache.clear();
  walletClientCache.clear();
}
