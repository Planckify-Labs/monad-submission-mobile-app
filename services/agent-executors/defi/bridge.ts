/**
 * `bridge_*` mobile executors.
 *
 * Spec: docs/bridge-capability-spec.md §8.3.
 *
 * Four tools:
 *   `bridge_get_support` (read)   — the queried support matrix (§5.3)
 *   `bridge_quote`      (read)    — full disclosure payload (§6, §7)
 *   `bridge_execute`    (WRITE)   — approval card, facts-first (§8.1)
 *   `bridge_status`     (read)    — drives `BridgeProgressCard` (§7.7)
 *
 * Registered under the DeFi agent (the `bridge_` prefix is declared on
 * that agent in `agentManifests.json`), and mirrored in
 * `expectedMobileTools.ts` — `bridge_execute` additionally in
 * `MOBILE_WRITE_TOOLS`, so `authorizeToolCall` fails closed if the wire
 * ever labels it a read (`feedback_registry_parity_enforcement`).
 *
 * Error discipline: every failure is a curated code from the closed
 * `ExecutorErrorCode` taxonomy plus an optional curated `reason`. No
 * provider text, HTTP status, or `err.message` reaches the caller — those
 * strings land in LLM context on the next turn AND get rendered through
 * `agentErrorCopy` (CLAUDE.md user-facing errors).
 */

import { bridgeApi } from "@/api/endpoints/bridge";
import type {
  TBridgeBlocker,
  TBridgeQuote,
  TBridgeQuoteResult,
} from "@/api/types/bridge";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import { parseCaip2, parseCaip19 } from "@/services/bridgeRoutes/caip";
import {
  checkBridgeDestinationReadiness,
  isQuoteExpired,
  resolveSourceChain,
} from "@/services/bridgeRoutes/execute";
import { adapterForQuote } from "@/services/bridgeRoutes/registry";
import {
  type ExecutorContext,
  ExecutorError,
  ExecutorErrorCode,
  type MobileToolExecutor,
  optionalString,
  requireString,
  safeExecute,
  type ToolInput,
} from "../types";

// ── input helpers ─────────────────────────────────────────────────────

function requireCaip2(input: ToolInput, key: string): string {
  const value = requireString(input, key);
  if (!parseCaip2(value)) {
    throw new ExecutorError(
      ExecutorErrorCode.InvalidInput,
      `invalid_${key}_not_caip2`,
    );
  }
  return value;
}

function requireCaip19(input: ToolInput, key: string): string {
  const value = requireString(input, key);
  if (!parseCaip19(value)) {
    throw new ExecutorError(
      ExecutorErrorCode.InvalidInput,
      `invalid_${key}_not_caip19`,
    );
  }
  return value;
}

function requireAmountRaw(input: ToolInput, key: string): string {
  const value = requireString(input, key);
  if (!/^[0-9]{1,78}$/.test(value)) {
    throw new ExecutorError(
      ExecutorErrorCode.InvalidInput,
      `invalid_${key}_not_decimal_string`,
    );
  }
  return value;
}

/**
 * Resolve the destination address for a CAIP-2 chain from the user's own
 * wallets.
 *
 * This is the §7.4 case that makes the destination address load-bearing:
 * for Base → Solana it is a COMPLETELY DIFFERENT address, derived from
 * the same mnemonic. The user has never seen it in this context, and
 * hiding it is how funds go missing. So we resolve it explicitly and
 * return it on the payload for the card to render.
 */
function resolveDestinationAddress(
  context: ExecutorContext,
  toChain: string,
  explicit?: string,
): string {
  if (explicit) return explicit;

  const namespace = parseCaip2(toChain)?.namespace;
  if (!namespace) {
    throw new ExecutorError(
      ExecutorErrorCode.InvalidInput,
      "invalid_to_chain_not_caip2",
    );
  }

  // Same-namespace: the intent's wallet already holds the right address.
  // NEVER an `activeWallet` fallback (`feedback_dapp_bridge_isolation`).
  if (context.wallet.namespace === namespace) {
    return context.wallet.address;
  }

  throw new ExecutorError(
    ExecutorErrorCode.InvalidInput,
    "missing_to_address_for_cross_namespace",
  );
}

function chainConfigsFrom(context: ExecutorContext) {
  return context.blockchains.map(buildChainConfigFromBlockchain);
}

/**
 * Map a `routable: false` result onto a payload the card renders as a
 * plain explanatory state.
 *
 * This is a CAPABILITY BOUNDARY, not a failure (§7.6) — so it returns
 * `status: "success"` with `routable: false`, NOT a thrown error. Sending
 * it through the error path would render an error card for a question
 * that simply has a "no" answer, and would put it through
 * `agentErrorCopy` which has nothing useful to say about it.
 */
function noRoutePayload(
  result: Extract<TBridgeQuoteResult, { routable: false }>,
) {
  return {
    status: "success" as const,
    data: {
      routable: false as const,
      reason: result.reason,
    },
  };
}

// ── bridge_get_support ────────────────────────────────────────────────

/**
 * The queried support matrix (§5.3). Backed by a 1h stale-while-revalidate
 * cache on the backend, so a provider adding a chain lights up with no
 * deploy on our side.
 */
export const bridgeGetSupport: MobileToolExecutor = () =>
  safeExecute(async () => {
    try {
      const support = await bridgeApi.getSupport();
      return {
        status: "success" as const,
        data: {
          chains: support.chains,
          providers: support.providers,
          refreshed_at: support.refreshedAt,
          // A cold or failed fetch degrades to "we could not check routes
          // right now", never to a wrong "unsupported".
          degraded: support.degraded,
        },
      };
    } catch (err) {
      if (__DEV__) {
        console.warn("[bridge/getSupport] failed", err);
      }
      throw new ExecutorError(ExecutorErrorCode.NetworkError);
    }
  });

// ── bridge_quote ──────────────────────────────────────────────────────

export const bridgeQuote: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const fromChain = requireCaip2(input, "from_chain");
    const toChain = requireCaip2(input, "to_chain");
    const fromAsset = requireCaip19(input, "from_asset");
    const toAsset = requireCaip19(input, "to_asset");
    const amountRaw = requireAmountRaw(input, "amount_raw");
    const toAddress = resolveDestinationAddress(
      context,
      toChain,
      optionalString(input, "to_address"),
    );

    let result: TBridgeQuoteResult;
    try {
      result = await bridgeApi.getQuote({
        fromChain,
        toChain,
        fromAsset,
        toAsset,
        amountRaw,
        fromAddress: context.wallet.address,
        toAddress,
      });
    } catch (err) {
      if (__DEV__) {
        console.warn("[bridge/quote] request failed", err);
      }
      throw new ExecutorError(ExecutorErrorCode.NetworkError);
    }

    if (!result.routable) return noRoutePayload(result);

    const blockers = await readinessFor(result.quote, context);
    return {
      status: "success" as const,
      data: quotePayload(result.quote, blockers),
    };
  });

/**
 * Destination readiness, checked AT QUOTE TIME (§7.5).
 *
 * Bridging a full balance to a chain where the user cannot receive, or
 * cannot move funds afterwards, strands them. Checking after submission
 * would be too late by definition.
 */
async function readinessFor(
  quote: TBridgeQuote,
  context: ExecutorContext,
): Promise<TBridgeBlocker[]> {
  return checkBridgeDestinationReadiness({
    toChain: quote.to.chain,
    toAsset: quote.to.token.caip19,
    address: quote.to.address,
    chains: chainConfigsFrom(context),
  });
}

/**
 * The card's whole payload. Every number §7 requires comes from the quote
 * — never from model prose (§8.1). An LLM paraphrasing "you'll get about
 * 99.75 USDC" is not an acceptable substitute for a rendered
 * `toAmountMin`.
 */
function quotePayload(quote: TBridgeQuote, blockers: TBridgeBlocker[]) {
  return {
    routable: true as const,
    quote_id: quote.quoteId,
    provider: quote.provider,
    from: quote.from,
    to: quote.to,
    to_amount_min_raw: quote.toAmountMinRaw,
    slippage_bps: quote.slippageBps,
    fees: quote.fees,
    receives_native_asset: quote.receivesNativeAsset,
    duration_seconds: quote.durationSeconds,
    duration_range_seconds: quote.durationRangeSeconds,
    bridge: quote.bridge,
    steps: quote.steps,
    blockers,
    issued_at: quote.issuedAt,
    expires_at: quote.expiresAt,
  };
}

// ── bridge_execute (WRITE) ────────────────────────────────────────────

/**
 * Re-quotes fresh, then signs.
 *
 * The re-quote is deliberate and does two jobs at once:
 *
 *  1. §8.2 staleness. A user can read an agent message minutes later and
 *     approve a dead route. Submitting the quote the model saw would send
 *     a stale route; re-quoting at signing time means the transaction the
 *     user actually gets is priced now.
 *  2. Facts-first (§8.1). Because the tool args carry the full route
 *     rather than an opaque quote id, the approval card can render real
 *     facts (amount, asset, chains, destination address) from the ARGS
 *     instead of trusting the model's `human_summary`.
 *
 * `min_receive_raw` is the protection number travelling with the
 * approval: it is what the user was shown, and a fresh quote that cannot
 * clear it is a `stale_precondition`, not something to silently execute.
 */
export const bridgeExecute: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const fromChain = requireCaip2(input, "from_chain");
    const toChain = requireCaip2(input, "to_chain");
    const fromAsset = requireCaip19(input, "from_asset");
    const toAsset = requireCaip19(input, "to_asset");
    const amountRaw = requireAmountRaw(input, "amount_raw");
    const toAddress = resolveDestinationAddress(
      context,
      toChain,
      optionalString(input, "to_address"),
    );
    const minReceiveRaw = optionalString(input, "min_receive_raw");

    if (!context.account && context.wallet.namespace === "eip155") {
      throw new ExecutorError(ExecutorErrorCode.WalletCannotExecute);
    }

    let result: TBridgeQuoteResult;
    try {
      result = await bridgeApi.getQuote({
        fromChain,
        toChain,
        fromAsset,
        toAsset,
        amountRaw,
        fromAddress: context.wallet.address,
        toAddress,
      });
    } catch (err) {
      if (__DEV__) {
        console.warn("[bridge/execute] re-quote failed", err);
      }
      throw new ExecutorError(ExecutorErrorCode.NetworkError);
    }

    if (!result.routable) {
      // The route existed when quoted and does not now. That is the
      // world moving between prepare and execute, which is exactly the
      // `stale_precondition` recovery class: re-quote, do not retry.
      throw new ExecutorError(
        ExecutorErrorCode.StalePrecondition,
        "quote_stale",
      );
    }

    const quote = result.quote;

    if (isQuoteExpired(quote)) {
      throw new ExecutorError(
        ExecutorErrorCode.StalePrecondition,
        "quote_stale",
      );
    }

    // Honour the protection number the user approved against.
    if (minReceiveRaw) {
      try {
        if (BigInt(quote.toAmountMinRaw) < BigInt(minReceiveRaw)) {
          throw new ExecutorError(
            ExecutorErrorCode.StalePrecondition,
            "quote_stale",
          );
        }
      } catch (err) {
        if (err instanceof ExecutorError) throw err;
        throw new ExecutorError(
          ExecutorErrorCode.InvalidInput,
          "invalid_min_receive_raw",
        );
      }
    }

    // A blocking readiness failure means the funds cannot arrive, or
    // cannot be moved once they do. Refuse rather than strand (§7.5).
    const blockers = await readinessFor(quote, context);
    const blocking = blockers.find((b) => b.severity === "blocking");
    if (blocking) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        blocking.code === "missing_trustline"
          ? "destination_missing_trustline"
          : "destination_not_ready",
      );
    }

    const chains = chainConfigsFrom(context);
    const sourceChain = resolveSourceChain(quote, chains);
    if (!sourceChain) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "source_chain_not_configured",
      );
    }

    const adapter = adapterForQuote(
      quote.provider,
      quote.from.chain,
      quote.to.chain,
    );
    if (!adapter) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "no_bridge_adapter",
      );
    }

    // §7.5 — optional gas top up, opted into explicitly by the user via
    // the card's inline "Add gas" action. It is a SECOND TRANSACTION and
    // is reported as its own line, never folded into the main transfer
    // and never silent. Presence-checked on the adapter (space docking):
    // a provider whose routes carry no strand risk simply has no
    // `gasTopUp`, and the absence is the correct signal.
    const gasTopUpUsd = optionalNumber(input, "gas_top_up_usd");
    let gasTopUp: { tx_hash: string; amount_usd: number } | null = null;
    if (gasTopUpUsd && gasTopUpUsd > 0 && adapter.gasTopUp) {
      gasTopUp = await runGasTopUp({
        adapter,
        quote,
        amountUsd: gasTopUpUsd,
        wallet: context.wallet,
        sourceChain,
      });
    }

    let submission: Awaited<ReturnType<typeof adapter.execute>>;
    try {
      submission = await adapter.execute(quote, {
        // The wallet bound to THIS intent. No home-screen fallback
        // anywhere in this path (`feedback_dapp_bridge_isolation`).
        wallet: context.wallet,
        chain: sourceChain,
      });
    } catch (err) {
      if (__DEV__) {
        console.warn("[bridge/execute] submission failed", err);
      }
      const code = (err as { code?: string } | null)?.code;
      if (code === "quote_stale") {
        throw new ExecutorError(
          ExecutorErrorCode.StalePrecondition,
          "quote_stale",
        );
      }
      if (code === "unsupported_chain") {
        throw new ExecutorError(ExecutorErrorCode.UnsupportedChain);
      }
      if (code === "wallet_cannot_execute") {
        throw new ExecutorError(ExecutorErrorCode.WalletCannotExecute);
      }
      throw new ExecutorError(ExecutorErrorCode.NetworkError);
    }

    return {
      status: "success" as const,
      // A bridge is NOT done when the source tx confirms (§7.7), so the
      // receipt is explicitly unconfirmed and the progress card takes over.
      tx_confirmed: false,
      data: {
        ...quotePayload(quote, blockers),
        source_tx_hash: submission.sourceTxHash,
        // Terminal state is a four-value outcome, never a boolean, and it
        // is not known yet (§7.7.1).
        outcome: null,
        phase: "pending_source" as const,
        ...(gasTopUp ? { gas_top_up: gasTopUp } : {}),
      },
    };
  });

function optionalNumber(input: ToolInput, key: string): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new ExecutorError(ExecutorErrorCode.InvalidInput, `invalid_${key}`);
  }
  return n;
}

/**
 * Buy a little destination gas as a separate, explicit transaction.
 *
 * A failure here must NOT abort the main bridge: the user asked to move
 * funds, and refusing that because a $2 convenience leg did not route
 * would be the worse outcome. We log and continue, and the readiness
 * warning stays on the progress card so the user still knows.
 */
async function runGasTopUp(args: {
  adapter: NonNullable<ReturnType<typeof adapterForQuote>>;
  quote: TBridgeQuote;
  amountUsd: number;
  wallet: ExecutorContext["wallet"];
  sourceChain: Parameters<
    NonNullable<ReturnType<typeof adapterForQuote>>["execute"]
  >[1]["chain"];
}): Promise<{ tx_hash: string; amount_usd: number } | null> {
  const { adapter, quote, amountUsd, wallet, sourceChain } = args;
  if (!adapter.gasTopUp) return null;
  try {
    const topUpQuote = await adapter.gasTopUp({
      chain: quote.to.chain,
      toAddress: quote.to.address,
      fromChain: quote.from.chain,
      fromAsset: quote.from.token.caip19,
      fromAddress: quote.from.address,
      amountUsd,
    });
    const submission = await adapter.execute(topUpQuote, {
      wallet,
      chain: sourceChain,
    });
    return { tx_hash: submission.sourceTxHash, amount_usd: amountUsd };
  } catch (err) {
    if (__DEV__) {
      console.warn("[bridge/execute] gas top up failed, continuing", err);
    }
    return null;
  }
}

// ── bridge_status ─────────────────────────────────────────────────────

/**
 * Drives `BridgeProgressCard`.
 *
 * `DONE` does NOT mean success (§7.7.1): it carries `completed`,
 * `partial` (full value in a DIFFERENT token), and `refunded` (funds back
 * on the source chain). All three come back as outcomes here, and
 * `partial` / `refunded` must not be rendered as errors.
 */
export const bridgeStatus: MobileToolExecutor = (input) =>
  safeExecute(async () => {
    const fromChain = requireCaip2(input, "from_chain");
    const toChain = requireCaip2(input, "to_chain");
    const txHash = requireString(input, "source_tx_hash");
    const provider = optionalString(input, "provider");

    try {
      const status = await bridgeApi.getStatus({
        fromChain,
        toChain,
        txHash,
        provider,
      });
      return {
        status: "success" as const,
        data: {
          outcome: status.outcome,
          phase: status.phase,
          current_step_key: status.currentStepKey,
          source_tx_hash: status.sourceTxHash ?? txHash,
          destination_tx_hash: status.destinationTxHash,
          received_token: status.receivedToken,
          received_amount_raw: status.receivedAmountRaw,
          refund_chain: status.refundChain,
          explorer_url: status.explorerUrl,
          from_chain: fromChain,
          to_chain: toChain,
          from_chain_name: optionalString(input, "from_chain_name"),
          to_chain_name: optionalString(input, "to_chain_name"),
        },
      };
    } catch (err) {
      if (__DEV__) {
        console.warn("[bridge/status] failed", err);
      }
      throw new ExecutorError(ExecutorErrorCode.NetworkError);
    }
  });

export const BRIDGE_EXECUTORS: Record<string, MobileToolExecutor> = {
  bridge_get_support: bridgeGetSupport,
  bridge_quote: bridgeQuote,
  bridge_execute: bridgeExecute,
  bridge_status: bridgeStatus,
};
