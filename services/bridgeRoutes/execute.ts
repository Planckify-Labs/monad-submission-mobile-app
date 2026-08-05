/**
 * Bridge execution + destination readiness — the walletKit dispatch.
 *
 * Spec: docs/bridge-capability-spec.md §5.2, §7.5.
 *
 * Both adapters share this because signing and readiness are properties
 * of the CHAIN, not of the provider that priced the route. The dispatch
 * goes through `WalletKitAdapter`'s optional, presence-checked
 * `submitBridgeExecution` / `checkBridgeDestinationReadiness` methods, so
 * no code here branches on a namespace string.
 */

import type {
  TBridgeBlocker,
  TBridgeQuote,
  TBridgeStatus,
} from "@/api/types/bridge";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { walletKitRegistry } from "@/services/walletKit/registry";
import type { BridgeExecutionPayload } from "@/services/walletKit/types";
import { assetContractFromCaip19, findChainByCaip2 } from "./caip";
import type {
  BridgeExecContext,
  BridgeReadinessRequest,
  BridgeSubmission,
} from "./types";

/**
 * Curated failure codes. Never a raw provider / RPC string — these are
 * fed back into LLM context on the next turn AND rendered through
 * `agentErrorCopy` (CLAUDE.md user-facing errors).
 */
export class BridgeExecutionError extends Error {
  readonly name = "BridgeExecutionError";
  readonly code:
    | "quote_stale"
    | "unsupported_chain"
    | "wallet_cannot_execute"
    | "submission_failed";
  constructor(code: BridgeExecutionError["code"]) {
    super(code);
    this.code = code;
  }
}

/**
 * A quote past its TTL must never be submitted (§8.2).
 *
 * A user can read an agent message minutes later and approve a dead
 * route. That is the `stale_precondition` recovery class: the fix is to
 * RE-QUOTE, not to retry the same call, so it gets its own code.
 */
export function isQuoteExpired(
  quote: TBridgeQuote,
  now: number = Date.now(),
): boolean {
  const expiry = new Date(quote.expiresAt).getTime();
  return Number.isFinite(expiry) && expiry <= now;
}

/**
 * Sign and submit a quote's execution payload.
 *
 * Renders and signs from `ctx.wallet` only. There is deliberately no
 * `activeWallet` fallback anywhere in this path
 * (`feedback_dapp_bridge_isolation`).
 */
export async function executeBridgeQuote(
  quote: TBridgeQuote,
  ctx: BridgeExecContext,
): Promise<BridgeSubmission> {
  if (isQuoteExpired(quote)) {
    throw new BridgeExecutionError("quote_stale");
  }

  const kit = walletKitRegistry.has(ctx.chain.namespace)
    ? walletKitRegistry.get(ctx.chain.namespace)
    : null;

  // Presence check, not a namespace branch: a chain whose kit has not
  // docked the capability simply cannot bridge yet.
  if (!kit?.submitBridgeExecution) {
    throw new BridgeExecutionError("unsupported_chain");
  }

  let sourceTxHash: string;
  try {
    sourceTxHash = await kit.submitBridgeExecution({
      wallet: ctx.wallet,
      chain: ctx.chain,
      payload: quote.execution as BridgeExecutionPayload,
    });
  } catch (err) {
    if (__DEV__) {
      console.warn("[bridgeRoutes/execute] submission failed", err);
    }
    const name = (err as { name?: string } | null)?.name;
    if (name === "BridgePayloadUnsupportedError") {
      throw new BridgeExecutionError("unsupported_chain");
    }
    throw new BridgeExecutionError("submission_failed");
  }

  return {
    sourceTxHash,
    provider: quote.provider,
    fromChain: quote.from.chain,
    toChain: quote.to.chain,
  };
}

/**
 * Per-namespace destination preconditions (§7.5).
 *
 * Returns `[]` when the destination chain is not one this app knows, or
 * when its kit has not docked the capability. An unknown answer must
 * never be rendered as a confident blocker: a false warning on a healthy
 * account trains users to dismiss the one that matters.
 */
export async function checkBridgeDestinationReadiness(
  req: BridgeReadinessRequest,
): Promise<TBridgeBlocker[]> {
  const chain = findChainByCaip2(req.chains, req.toChain);
  if (!chain) return [];

  const kit = walletKitRegistry.has(chain.namespace)
    ? walletKitRegistry.get(chain.namespace)
    : null;
  if (!kit?.checkBridgeDestinationReadiness) return [];

  try {
    // The kit's blocker shape IS the wire shape — deliberately, so a new
    // namespace's blockers reach the card without a translation layer
    // that could quietly drop a remedy.
    return await kit.checkBridgeDestinationReadiness({
      chain,
      address: req.address,
      contractAddress: assetContractFromCaip19(req.toAsset),
      assetCaip19: req.toAsset,
    });
  } catch (err) {
    if (__DEV__) {
      console.warn("[bridgeRoutes/readiness] check failed", err);
    }
    return [];
  }
}

/** Resolve the source `ChainConfig` a quote must be signed on. */
export function resolveSourceChain(
  quote: TBridgeQuote,
  chains: ChainConfig[],
): ChainConfig | null {
  return findChainByCaip2(chains, quote.from.chain);
}

/**
 * `partial` and `refunded` are OUTCOMES, not errors (§7.7.1). Callers use
 * this to keep them out of `agentErrorCopy`, which would otherwise render
 * "something went wrong" over a transfer that actually delivered value.
 */
export function isTerminalFailure(status: TBridgeStatus): boolean {
  return status.outcome === "failed";
}
