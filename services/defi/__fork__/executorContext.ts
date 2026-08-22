/**
 * An `ExecutorContext` bound to a fork — the seam that lets the REAL agent tool
 * executors run against anvil.
 *
 * ## Why this exists
 *
 * Two suites in this repo each cover half of a deposit and neither covers the
 * join:
 *
 *   `defi/depositSafetyContext.test.ts`  real executor, STUB chain + STUB adapter
 *   `defi/__fork__/*.fork.test.ts`       real chain + real adapter, NO executor
 *
 * So the ~1,900 lines of `agent-executors/defi/writes.ts` — the guards, the
 * two safety-pipeline anchors, the allowance/approve preamble, the
 * phantom-failure-safe submit, the position registration — have never executed
 * against real protocol state. That is precisely the span a human was covering
 * by hand, on mainnet, with their own money (runbook §12.3 requirement 9).
 *
 * ## Why no production code had to change
 *
 * `resolveChainClients` builds its viem clients from
 * `ExecutorContext.blockchains[].rpcUrl` via `utils/clients.ts`, and
 * `chainRpcUrl()` is just `rpcUrls.default.http[0]`. `rpcFetchOptions()`
 * returns `undefined` for any origin that is not a registered rpc-proxy, so a
 * `http://127.0.0.1:<port>` URL flows through untouched and unauthenticated.
 * Handing the executor a `blockchains` row that points at anvil is therefore
 * enough — nothing is stubbed, monkey-patched or branched on a test flag.
 *
 * The one thing that MUST happen is clearing `chainRouter`'s caches: they are
 * keyed on `chainId` alone, and a fork's port changes every run, so a cached
 * client from a previous fork would silently talk to a dead socket.
 */

import type { Account } from "viem";
import type { TBlockchain } from "@/api/types/blockchain";
import type { TWallet } from "@/constants/types/walletTypes";
import { clearChainRouterCaches } from "@/services/agent-executors/chainRouter";
import type { ExecutorContext } from "@/services/agent-executors/types";
import type { ForkContext } from "./harness";

/**
 * Native currency per forked chain. Only the chains with a `FORK_BLOCKS` pin
 * need an entry; `forkBlockchainRow` refuses an unknown one rather than
 * defaulting to ETH, because a wrong `decimals` here would silently corrupt
 * every native-value assertion downstream (Polygon's POL is the case that
 * makes a silent default dangerous).
 */
const NATIVE_CURRENCY: Readonly<
  Record<number, { name: string; symbol: string; decimals: number }>
> = {
  1: { name: "Ether", symbol: "ETH", decimals: 18 },
  137: { name: "POL", symbol: "POL", decimals: 18 },
  8453: { name: "Ether", symbol: "ETH", decimals: 18 },
  42161: { name: "Ether", symbol: "ETH", decimals: 18 },
};

/**
 * The `/blockchains` row the device would have received, with `rpcUrl` pointed
 * at the fork.
 *
 * Shaped like the real feed rather than minimally: `buildChainConfigFromBlockchain`
 * reads `tokens` to find the native currency, and `chainFromBlockchainRow`
 * reads it again for the viem `Chain`. A row without a native token row still
 * "works" but resolves the symbol to `"N/A"`, which is a different code path
 * from the one production takes.
 */
export function forkBlockchainRow(ctx: ForkContext): TBlockchain {
  const native = NATIVE_CURRENCY[ctx.chainId];
  if (!native) {
    throw new Error(
      `forkBlockchainRow: no native currency declared for chain ${ctx.chainId} — ` +
        "add one to NATIVE_CURRENCY rather than letting it default to ETH",
    );
  }
  return {
    id: `fork-${ctx.chainId}`,
    name: `fork-${ctx.chainId}`,
    chainId: ctx.chainId,
    rpcUrl: ctx.rpcUrl,
    blockExplorer: "",
    isEVM: true,
    isActive: true,
    isTestnet: false,
    nativeCurrency: {
      symbol: native.symbol,
      decimals: native.decimals,
      address: null,
    },
    tokens: [
      {
        name: native.name,
        symbol: native.symbol,
        decimals: native.decimals,
        isNativeCurrency: true,
      },
    ] as TBlockchain["tokens"],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Build the context the SSE dispatcher would hand an executor, bound to a fork.
 *
 * `wallets` deliberately contains the same single row as `wallet`: a DeFi write
 * must never resolve a signer from anywhere but `context.wallet`, and giving
 * the fork run a second wallet to accidentally pick would weaken the test.
 */
export function forkExecutorContext(ctx: ForkContext): ExecutorContext {
  // Ports move between runs and the router caches on chainId alone.
  clearChainRouterCaches();
  return {
    wallet: ctx.wallet,
    account: ctx.account as Account,
    blockchains: [forkBlockchainRow(ctx)],
    wallets: [ctx.wallet as TWallet],
    activeChainId: ctx.chainId,
  };
}
