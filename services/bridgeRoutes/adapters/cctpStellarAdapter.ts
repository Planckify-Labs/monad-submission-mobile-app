/**
 * `cctp` — Circle CCTP, scoped to routes touching STELLAR ONLY.
 *
 * Spec: docs/bridge-capability-spec.md §5.4, §10.5.
 *
 * The registry earns its keep here: no single provider covers our four
 * namespaces. LI.FI routes any asset across 72 chains but has NO Stellar
 * path at all (§3.2); CCTP reaches Stellar as domain 27 but bridges USDC
 * and only USDC, because burn-and-mint requires the token ISSUER to hold
 * mint authority on the destination. "Extend CCTP to more tokens" is a
 * category error, not a roadmap item.
 *
 * Deliberately NOT a general EVM provider (§10.5): LI.FI already
 * aggregates CCTP and picks it when it is the best USDC route, so an
 * EVM-capable `cctp` adapter would add an arbitration problem without
 * adding a capability. With no overlap there is nothing to arbitrate.
 *
 * Note the absent `gasTopUp`. Stellar's precondition is a TRUSTLINE plus
 * an XLM base reserve, not gas, and a trustline is a hard opt-in the
 * recipient must perform themselves. The remedy is `ensureTrustline` on
 * the user's own wallet, surfaced through `checkDestinationReadiness`.
 * Omitting the method is the correct signal (§5.2).
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

/** Circle-issued domain for Stellar. Verified against Circle's reference. */
const STELLAR_DOMAIN = 27;

/**
 * EVM sources we can burn from, by chain id → Circle domain. Kept in step
 * with the backend adapter's table; the backend is authoritative and
 * rejects anything this list gets wrong, so a drift here degrades to a
 * capability boundary rather than a bad transaction.
 */
const EVM_DOMAINS: Record<string, number> = {
  "1": 0,
  "10": 2,
  "137": 7,
  "8453": 6,
  "42161": 3,
  "43114": 1,
};

export const cctpStellarBridgeAdapter: BridgeRouteAdapter = {
  key: "cctp",

  supports(from: TCaip2, to: TCaip2): boolean {
    // Destination must be Stellar; source must be an EVM chain we can
    // burn from. Stellar-as-source needs a Soroban burn whose argument
    // layout is not published, and guessing it is exactly the failure
    // mode §5.4.1 warns about, so it reports unsupported on purpose and
    // renders the plain no-route state (§7.6).
    const toParsed = parseCaip2(to);
    if (toParsed?.namespace !== "stellar") return false;
    const fromParsed = parseCaip2(from);
    if (fromParsed?.namespace !== "eip155") return false;
    return EVM_DOMAINS[fromParsed.reference] !== undefined;
  },

  toProviderChainId(c: TCaip2): string | number | null {
    const parsed = parseCaip2(c);
    if (!parsed) return null;
    if (parsed.namespace === "stellar") return STELLAR_DOMAIN;
    if (parsed.namespace === "eip155") {
      return EVM_DOMAINS[parsed.reference] ?? null;
    }
    return null;
  },

  toProviderAsset(_a: TCaip19): string | null {
    // CCTP identifies the asset by domain + burn token on the source
    // chain, which the backend resolves. Nothing to map here.
    return null;
  },

  quote(req: TBridgeQuoteRequest): Promise<TBridgeQuoteResult> {
    return bridgeApi.getQuote(req);
  },

  execute(q: TBridgeQuote, ctx: BridgeExecContext): Promise<BridgeSubmission> {
    // The burn happens on the EVM SOURCE chain, so this signs with the
    // EVM kit exactly like any other route. The Stellar leg is atomic and
    // non-custodial inside `CctpForwarder`, with nothing for the user's
    // Stellar wallet to sign.
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
    // Routes to the Stellar kit's trustline + base-reserve check, which
    // is the whole reason readiness is a per-namespace capability rather
    // than a gas check (§7.5, §10.4).
    return checkBridgeDestinationReadiness(req);
  },
};
