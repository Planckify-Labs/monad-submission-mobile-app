/**
 * `lifi` — the general-purpose mobile bridge adapter.
 *
 * Spec: docs/bridge-capability-spec.md §5.2, §2.2.
 *
 * Covers EVM + Solana + Sui. Misses Stellar, which is what
 * `cctpStellarAdapter` exists for (§5.4).
 *
 * LI.FI's private chain numbering lives on the BACKEND adapter, not here:
 * the mobile side speaks CAIP-2 to `/bridge/*` and never sees an integer
 * chain id. `toProviderChainId` / `toProviderAsset` are implemented for
 * interface completeness and return `null` rather than duplicating a
 * table that would then have two places to drift.
 */

import { bridgeApi } from "@/api/endpoints/bridge";
import type {
  TBridgeBlocker,
  TBridgeQuote,
  TBridgeQuoteRequest,
  TBridgeQuoteResult,
  TBridgeStatus,
  TCaip2,
  TCaip19,
} from "@/api/types/bridge";
import { parseCaip2 } from "../caip";
import {
  checkBridgeDestinationReadiness,
  executeBridgeQuote,
} from "../execute";
import type {
  BridgeExecContext,
  BridgeReadinessRequest,
  BridgeRef,
  BridgeRouteAdapter,
  BridgeSubmission,
} from "../types";

/**
 * Namespaces LI.FI can route. Stellar is absent from LI.FI ENTIRELY
 * (§3.2), and `bip122` is reachable by LI.FI but unsignable by us (no BTC
 * wallet, §1 non-goals).
 */
const ROUTABLE_NAMESPACES = new Set(["eip155", "solana", "sui"]);

export const lifiBridgeAdapter: BridgeRouteAdapter = {
  key: "lifi",

  supports(from: TCaip2, to: TCaip2): boolean {
    if (from === to) return false;
    const fromNs = parseCaip2(from)?.namespace;
    const toNs = parseCaip2(to)?.namespace;
    if (!fromNs || !toNs) return false;
    return ROUTABLE_NAMESPACES.has(fromNs) && ROUTABLE_NAMESPACES.has(toNs);
  },

  // The provider's numbering is the backend adapter's business (§5.2).
  toProviderChainId(_c: TCaip2): string | number | null {
    return null;
  },

  toProviderAsset(_a: TCaip19): string | null {
    return null;
  },

  quote(req: TBridgeQuoteRequest): Promise<TBridgeQuoteResult> {
    return bridgeApi.getQuote(req);
  },

  execute(q: TBridgeQuote, ctx: BridgeExecContext): Promise<BridgeSubmission> {
    return executeBridgeQuote(q, ctx);
  },

  status(ref: BridgeRef): Promise<TBridgeStatus> {
    return bridgeApi.getStatus({
      fromChain: ref.fromChain,
      toChain: ref.toChain,
      txHash: ref.sourceTxHash,
      provider: ref.provider,
    });
  },

  checkDestinationReadiness(
    req: BridgeReadinessRequest,
  ): Promise<TBridgeBlocker[]> {
    return checkBridgeDestinationReadiness(req);
  },

  /**
   * Optional capability (§5.2, §7.5): a slice routed through LI.FI's
   * gas-zip bridge. It is a SECOND transaction and gets its own line in
   * the fee breakdown. It is never silent.
   */
  gasTopUp(req) {
    return bridgeApi.getGasTopUpQuote(req);
  },
};
