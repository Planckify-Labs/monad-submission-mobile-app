/**
 * Portfolio read layer — mirrors `api/src/external/zerion/zerion.types.ts`.
 *
 * The api owns the third-party key; this app only ever talks to our own
 * `portfolio/*` routes.
 */

/**
 * Every portfolio response uses this envelope.
 *
 * `status: "indexing"` means the upstream indexer answered 202 Accepted and
 * has not finished indexing this wallet: `data` is empty rather than
 * incomplete. Poll, don't persist.
 *
 * `fromCache` / `fetchedAt` exist so a screen can honestly say how old its
 * data is, which matters because the default read is cache-first.
 */
export interface TPortfolioEnvelope<T> {
  status: "ready" | "indexing";
  data: T;
  fetchedAt: string;
  fromCache: boolean;
  /** Set when a refresh was rate-limited and the cached entry was served. */
  throttled?: boolean;
  nextCursor?: string | null;
}

/**
 * One asset the wallet is known to touch. Identity ONLY: there is deliberately
 * no quantity and no USD value here, because balances are read on-chain.
 */
export interface TDiscoveredAsset {
  namespace: "eip155" | "solana";
  /** Numeric chain id; `null` for non-EVM chains, which have none. */
  chainId: number | null;
  /** Contract address (EVM) or mint (Solana). `null` = the native coin. */
  address: string | null;
  symbol: string;
  name: string;
  decimals: number;
  /** Nullable upstream, so keep the existing placeholder path. */
  logoUrl: string | null;
  /** Upstream verification flag: an input to spam scoring, not a bypass. */
  verified: boolean;
}

export type TPortfolioPositionStatus =
  | "deposit"
  | "staked"
  | "locked"
  | "reward"
  | "borrowed";

/**
 * A protocol position discovered externally (not opened in this app).
 * `valueUsd` is the indexer's estimate, not an on-chain read, and must be
 * labelled as such wherever it is shown.
 */
export interface TPortfolioPosition {
  dappId: string | null;
  protocolName: string | null;
  poolAddress: string | null;
  zerionChainId: string;
  chainId: number | null;
  assetSymbol: string;
  assetContract: string | null;
  quantityRaw: string;
  decimals: number;
  valueUsd: number | null;
  logoUrl: string | null;
  status: TPortfolioPositionStatus;
}

export interface TPortfolioNft {
  chainId: number | null;
  namespace: "eip155" | "solana";
  contractAddress: string;
  tokenId: string;
  amount: number;
  name: string | null;
  description: string | null;
  previewUrl: string | null;
  detailUrl: string | null;
  collectionName: string | null;
  collectionIconUrl: string | null;
  floorPrice: number | null;
  valueUsd: number | null;
}

/**
 * Chain selector accepted by every portfolio route: a numeric chain id, or a
 * namespace string for chains that have no numeric id ("solana").
 */
export type TPortfolioChainSelector = number | string;

export interface TPortfolioQuery {
  chains?: TPortfolioChainSelector[];
  /**
   * Only ever true for a deliberate user gesture (pull-to-refresh). Automatic
   * refetches must leave this off, or they spend the shared upstream quota.
   */
  refresh?: boolean;
}
