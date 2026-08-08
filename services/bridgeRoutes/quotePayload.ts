/**
 * `TBridgeQuote` (wire shape) → the payload `BridgeQuoteCard` renders.
 *
 * Spec: docs/bridge-capability-spec.md §7, §8.1.
 *
 * Lives here rather than inside the executor because BOTH sides of the
 * bridge UI now produce this shape:
 *
 *   - `bridge_quote` (services/agent-executors/defi/bridge.ts), the normal
 *     agent-driven path, and
 *   - `BridgeQuoteCard` itself, which re-quotes DIRECTLY against
 *     `bridgeApi` when the user changes the destination wallet, so the
 *     card updates immediately instead of waiting on a model round trip.
 *
 * One mapper means the card cannot drift between "the agent priced this"
 * and "I priced this" — a re-quote that silently rendered a different
 * subset of §7's required disclosures (minimum received, itemised fees,
 * slippage) would be exactly the kind of gap §8.1 exists to prevent.
 */

import type { TBridgeBlocker, TBridgeQuote } from "@/api/types/bridge";

export function buildBridgeQuotePayload(
  quote: TBridgeQuote,
  blockers: TBridgeBlocker[],
) {
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

export type TBridgeQuotePayload = ReturnType<typeof buildBridgeQuotePayload>;
