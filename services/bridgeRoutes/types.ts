/**
 * `BridgeRouteAdapter` — the mobile docking port.
 *
 * Spec: docs/bridge-capability-spec.md §5.2.
 *
 * Mirrors `services/defi/registry.ts`'s shape exactly. `supports()` is
 * the whole seam: adding Bitcoin, or a non-LI.FI provider later, is
 * REGISTERING AN ADAPTER. No enum edit, no branch in shared code, and
 * `pnpm check:chains` stays green because nothing under `components/`,
 * `hooks/`, or `app/` learns a namespace string.
 *
 * Division of labour with the backend: quoting, provider arbitration, and
 * the cached support matrix live server-side (one place for integrator
 * config and API keys). What can only happen on the device is here —
 * SIGNING (`execute`) and DESTINATION READINESS, which needs the user's
 * own wallet and live chain reads.
 */

import type {
  TBridgeBlocker,
  TBridgeQuote,
  TBridgeQuoteRequest,
  TBridgeQuoteResult,
  TBridgeStatus,
  TCaip2,
  TCaip19,
} from "@/api/types/bridge";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";

export interface BridgeExecContext {
  /**
   * The wallet bound to THIS bridge intent.
   *
   * Never a home-screen `activeWallet` fallback — the wallet being
   * bridged from and the wallet on the home screen can differ, and mixing
   * them is the exact bug class fixed in `4828e91`
   * (`feedback_dapp_bridge_isolation`).
   */
  wallet: TWallet;
  /** The source `ChainConfig`, resolved from `quote.from.chain`. */
  chain: ChainConfig;
}

export interface BridgeSubmission {
  /** Source-chain hash / signature / digest. */
  sourceTxHash: string;
  provider: string;
  fromChain: TCaip2;
  toChain: TCaip2;
}

export interface BridgeRef {
  provider: string;
  fromChain: TCaip2;
  toChain: TCaip2;
  sourceTxHash: string;
}

export interface BridgeReadinessRequest {
  toChain: TCaip2;
  toAsset: TCaip19;
  address: string;
  /** Candidate `ChainConfig`s to resolve `toChain` against. */
  chains: ChainConfig[];
}

export interface BridgeRouteAdapter {
  /** Stable registry key, e.g. `"lifi"`, `"cctp"`. */
  key: string;

  /** Can this adapter move value from `from` to `to`? */
  supports(from: TCaip2, to: TCaip2): boolean;

  /** Provider's private chain id. `null` when unknown to it. */
  toProviderChainId(c: TCaip2): string | number | null;

  /** Provider's private asset identifier. `null` when inexpressible. */
  toProviderAsset(a: TCaip19): string | null;

  quote(req: TBridgeQuoteRequest): Promise<TBridgeQuoteResult>;

  execute(q: TBridgeQuote, ctx: BridgeExecContext): Promise<BridgeSubmission>;

  status(ref: BridgeRef): Promise<TBridgeStatus>;

  /**
   * Per-namespace preconditions on the destination (§7.5).
   *
   * Delegates to `WalletKitAdapter.checkBridgeDestinationReadiness`, so
   * adding a namespace means implementing THAT one method and never
   * touching the card. Bridging a full balance to a chain where the user
   * cannot receive, or cannot move funds afterwards, STRANDS them, so
   * this runs at quote time.
   */
  checkDestinationReadiness(
    req: BridgeReadinessRequest,
  ): Promise<TBridgeBlocker[]>;

  // ── optional capabilities, presence-checked (space docking) ─────────
  /**
   * Route a small slice into the destination's gas token (§7.5).
   *
   * An adapter omits this when it cannot top up gas, AND when its routes
   * carry no strand risk because the provider pays the destination leg
   * (Circle's Forwarding Service, §7.5.1). The absence is the correct
   * signal, not an omission to work around.
   */
  gasTopUp?(req: {
    chain: TCaip2;
    toAddress: string;
    fromChain: TCaip2;
    fromAsset: TCaip19;
    fromAddress: string;
    amountUsd: number;
  }): Promise<TBridgeQuote>;
}
