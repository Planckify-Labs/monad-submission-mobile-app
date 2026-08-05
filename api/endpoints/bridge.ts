import { api } from "@/constants/configs/ky";
import type {
  TBridgeGasTopUpRequest,
  TBridgeQuote,
  TBridgeQuoteRequest,
  TBridgeQuoteResult,
  TBridgeStatus,
  TBridgeStatusRequest,
  TBridgeSupport,
} from "../types/bridge";

/**
 * `/bridge/*` client.
 *
 * Spec: docs/bridge-capability-spec.md §5.3, §7.6, §8.3.
 *
 * The mobile side never talks to LI.FI or Circle directly — it proxies
 * through the backend so integrator config, provider arbitration, and the
 * cached support matrix live in one place.
 *
 * Errors: `ky` throws `HTTPError` on non-2xx and the shared `api` instance
 * already keeps response bodies out of `Error.message`. Callers map to a
 * curated code; nothing from here is rendered verbatim (CLAUDE.md
 * user-facing errors).
 */
export const bridgeApi = {
  /**
   * Queried support matrix. Never hardcoded, so a provider adding a chain
   * lights up with no deploy on our side (§5.3).
   */
  getSupport: async () => {
    return api.get("bridge/support").json<TBridgeSupport>();
  },

  /**
   * Returns a discriminated result, not a thrown error, when a pair is
   * unroutable: "no route" is a first-class STATE (§7.6).
   */
  getQuote: async (payload: TBridgeQuoteRequest) => {
    return api
      .post("bridge/quote", { json: payload })
      .json<TBridgeQuoteResult>();
  },

  getStatus: async (params: TBridgeStatusRequest) => {
    const search = new URLSearchParams({
      fromChain: params.fromChain,
      toChain: params.toChain,
      txHash: params.txHash,
      ...(params.provider ? { provider: params.provider } : {}),
    }).toString();
    return api.get(`bridge/status?${search}`).json<TBridgeStatus>();
  },

  /**
   * Quote a small slice of the source asset into the destination's gas
   * token (§7.5). This is a SECOND transaction and appears as its own line
   * in the fee breakdown. It is never silent.
   */
  getGasTopUpQuote: async (payload: TBridgeGasTopUpRequest) => {
    return api
      .post("bridge/gas-top-up", { json: payload })
      .json<TBridgeQuote>();
  },
};
