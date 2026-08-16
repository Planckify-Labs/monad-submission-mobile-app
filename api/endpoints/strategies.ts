import { api } from "@/constants/configs/ky";
import type {
  LiquidityProfile,
  RiskTier,
  TCrossChainQuote,
  TCrossChainQuoteRequest,
  TCrossChainStatusResponse,
  TOpportunity,
  TRouterQuote,
  TStrategyPosition,
  TUserStrategy,
} from "../types/strategy";
import { buildSearchParams } from "../utils/api-helpers";

export interface TOpportunitySearchParams {
  tier?: string;
  asset_symbol?: string;
  chain_id?: number;
  /** Chain namespace filter ("eip155" | "solana" | "sui") — lets the agent
   *  ask for non-EVM yield (Sui rows are chainId 0, keyed by namespace). */
  namespace?: string;
  liquidity_profile?: string;
  amount_usd?: number;
}

export interface TProtocolOption {
  protocolSlug: string;
  namespace: string;
  chainId: number;
  /** Backend-resolved display name (joins Blockchain registry → curated set). */
  chainName: string;
  tier: RiskTier;
  assetSymbol: string;
}

export interface TCreateStrategyPayload {
  namespace: "eip155" | "solana" | "sui";
  tier: RiskTier;
  assetPreferences: Array<"stable" | "eth_lst" | "multi">;
  liquidityPref: LiquidityProfile | "7d" | "30d" | "instant";
  chainPref: Array<number | "any">;
  allocationPct: number;
  rebalanceTrigger:
    | { kind: "interval"; value: "weekly" | "monthly" }
    | {
        kind: "yield_drop";
        thresholdPct: number;
      };
  protocolWhitelist?: string[];
  allowAllInTier?: boolean;
  autoCompound?: boolean;
  notificationLevel: "every" | "daily" | "alerts";
}

export const strategiesApi = {
  getStrategy: async () => {
    return api.get("strategies").json<TUserStrategy>();
  },

  createStrategy: async (payload: TCreateStrategyPayload) => {
    return api.post("strategies", { json: payload }).json<TUserStrategy>();
  },

  updateStrategy: async (payload: Partial<TCreateStrategyPayload>) => {
    return api.patch("strategies", { json: payload }).json<TUserStrategy>();
  },

  getOpportunities: async (params: TOpportunitySearchParams = {}) => {
    const searchParams = buildSearchParams(params);
    const qs = searchParams.toString();
    const url = qs
      ? `strategies/opportunities?${qs}`
      : "strategies/opportunities";
    return api.get(url).json<TOpportunity[]>();
  },

  getOpportunity: async (slug: string) => {
    return api
      .get(`strategies/opportunities/${encodeURIComponent(slug)}`)
      .json<TOpportunity>();
  },

  /**
   * Fetch a single opportunity by DeFiLlama poolId — the authoritative
   * `depositTarget` source the deposit executor re-fetches before signing
   * (pool-level deposits spec §6). Keyed by poolId so it pins the exact
   * sibling pool, unlike `getOpportunity(slug)` which keys by protocolSlug.
   */
  getPool: async (poolId: string) => {
    return api
      .get(`strategies/pools/${encodeURIComponent(poolId)}`)
      .json<TOpportunity>();
  },

  getProtocols: async (tier?: RiskTier) => {
    const qs = tier ? `?tier=${encodeURIComponent(tier)}` : "";
    return api.get(`strategies/protocols${qs}`).json<TProtocolOption[]>();
  },

  getPositions: async () => {
    return api.get("strategies/positions").json<TStrategyPosition[]>();
  },

  /**
   * Batch USD spot-price lookup, proxied through the backend to Alchemy's
   * Prices API (`POST /strategies/asset-prices`) — the only place that
   * vendor is called from; this client never holds the Alchemy key.
   * A price Alchemy can't resolve (or a chain with no Alchemy mapping)
   * comes back `usd: null`, never thrown.
   */
  getAssetPrices: async (
    queries: {
      chainId: number;
      assetSymbol: string;
      assetContract?: string;
    }[],
  ) => {
    return api
      .post("strategies/asset-prices", {
        json: {
          queries: queries.map((q) => ({
            chain_id: q.chainId,
            asset_symbol: q.assetSymbol,
            asset_contract: q.assetContract,
          })),
        },
      })
      .json<
        {
          chain_id: number;
          asset_symbol: string;
          asset_contract: string | null;
          usd: number | null;
        }[]
      >();
  },

  createPosition: async (payload: {
    protocolSlug: string;
    chainId: number;
    namespace: string;
    assetSymbol: string;
    assetContract?: string;
    /** DeFiLlama poolId the deposit targeted — pins the exact pool (spec §4.2). */
    poolId?: string;
    amountAtDeposit: string;
    amountAtDepositUsd: number;
    openTxHash?: string;
    goal?: string;
    targetDate?: string;
  }) => {
    return api
      .post("strategies/positions", { json: payload })
      .json<TStrategyPosition>();
  },

  getPosition: async (id: string) => {
    return api
      .get(`strategies/positions/${encodeURIComponent(id)}`)
      .json<TStrategyPosition>();
  },

  /**
   * Report a freshly-observed on-chain value back to the backend so
   * consumers that don't do a live read (auto-compound watcher, push
   * notifications) aren't stuck on a permanently-null snapshot. Mobile is
   * the trust anchor for the on-chain read — this just persists it.
   */
  refreshPosition: async (
    id: string,
    observed?: { currentAmountRaw?: string; currentAmountUsd?: number },
  ) => {
    return api
      .post(`strategies/positions/${encodeURIComponent(id)}/refresh`, {
        json: observed
          ? {
              current_amount_raw: observed.currentAmountRaw,
              current_amount_usd: observed.currentAmountUsd,
            }
          : {},
      })
      .json<TStrategyPosition>();
  },

  /**
   * Router-calldata quote proxy (EVM expansion spec §6). Pendle/Uniswap LP have
   * no on-chain deposit ABI we encode, so the backend fetches the protocol's
   * calldata, enforces the slippage ceiling and verifies the returned `to`
   * against the pinned router allowlist before answering. The device never
   * calls the protocol's API itself, and it re-checks the same allowlist
   * against its OWN pinned copy (§11.1 — two independent trust anchors).
   *
   * The receiver is taken from the JWT server-side; there is deliberately no
   * way to ask for a quote made out to someone else.
   */
  getRouterQuote: async (payload: {
    poolId: string;
    amountRaw: string;
    slippageBps: number;
    action?: "deposit" | "withdraw";
  }) => {
    return api
      .post("strategies/router-quote", { json: payload })
      .json<TRouterQuote>();
  },

  getCrossChainQuote: async (payload: TCrossChainQuoteRequest) => {
    return api
      .post("strategies/cross-chain/quote", { json: payload })
      .json<TCrossChainQuote>();
  },

  getCrossChainStatus: async (params: {
    fromChainId: number;
    toChainId: number;
    txHash: string;
  }) => {
    const qs = new URLSearchParams({
      from_chain_id: String(params.fromChainId),
      to_chain_id: String(params.toChainId),
      tx_hash: params.txHash,
    }).toString();
    return api
      .get(`strategies/cross-chain/status?${qs}`)
      .json<TCrossChainStatusResponse>();
  },
};
