/**
 * NFT positions, served through our own api (which owns the indexer key).
 *
 * NFTs are the one asset class we cannot read ourselves: plain RPC has no way
 * to enumerate what a wallet owns, and media plus floor price only exist at an
 * indexer. Everything else (token balances) stays on-chain by design — see
 * `hooks/queries/useDiscoveredAssets.ts`.
 *
 * This provider implements `getNFTs` and nothing else. Every other method, and
 * any chain the upstream indexer doesn't cover, throws
 * `IndexerNotSupportedError` so `IndexerRegistry` falls through to
 * `DirectRPCProvider` untouched.
 */

import { portfolioApi } from "@/api/endpoints/portfolio";
import type { TPortfolioNft } from "@/api/types/portfolio";
import type {
  ENSResolution,
  HistoryOpts,
  IndexerProvider,
  NFTAsset,
  NFTOpts,
  PaginatedResult,
  TokenApproval,
  TokenBalance,
  TokenPrice,
  WalletTransaction,
} from "./types";
import { IndexerNotSupportedError } from "./types";

/**
 * Chains the upstream indexer covers for NFTs. Kept deliberately narrow and
 * explicit: an unlisted chain falls through to the baseline provider rather
 * than round-tripping to an endpoint that can only answer empty.
 */
const NFT_CHAIN_IDS = new Set([1, 10, 56, 137, 8453, 42161, 43114]);

/** A wallet being indexed for the first time answers "indexing" until ready. */
const INDEXING_POLL_MS = 2500;
const INDEXING_MAX_ATTEMPTS = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNFTAsset(nft: TPortfolioNft, chainId: number): NFTAsset {
  return {
    contractAddress: nft.contractAddress,
    tokenId: nft.tokenId,
    // The indexer reports a holding count, not the standard. >1 can only be
    // ERC-1155; 1 is ambiguous, so assume the far more common ERC-721.
    tokenType: nft.amount > 1 ? "ERC-1155" : "ERC-721",
    balance: nft.amount,
    chainId,
    isSpam: false,
    collection: {
      name: nft.collectionName ?? "Unknown collection",
      imageUrl: nft.collectionIconUrl ?? undefined,
      isVerified: false,
      floorPrice: nft.floorPrice ?? undefined,
    },
    metadata: {
      name: nft.name ?? `#${nft.tokenId}`,
      description: nft.description ?? undefined,
      // `detail` is the full-size render, `preview` the thumbnail. Fall back
      // to the thumbnail so a missing detail render still shows something.
      imageUrl: nft.detailUrl ?? nft.previewUrl ?? undefined,
      attributes: [],
    },
  };
}

export class ZerionNftProvider implements IndexerProvider {
  readonly name = "ZerionNFT";
  /** Above DirectRPCProvider (100), which cannot serve NFTs at all. */
  readonly priority = 10;

  async getNFTs(opts: NFTOpts): Promise<PaginatedResult<NFTAsset>> {
    if (!NFT_CHAIN_IDS.has(opts.chainId)) {
      throw new IndexerNotSupportedError("getNFTs", this.name);
    }

    for (let attempt = 0; attempt < INDEXING_MAX_ATTEMPTS; attempt++) {
      const result = await portfolioApi.getNfts({
        chains: [opts.chainId],
        pageSize: opts.limit ?? 20,
        pageAfter: opts.cursor,
      });

      if (result.status === "indexing") {
        // Still building this wallet's index upstream. Keep the promise
        // pending so React Query's `isLoading` drives the existing skeleton,
        // rather than resolving to a misleading empty list.
        await sleep(INDEXING_POLL_MS);
        continue;
      }

      const items = result.data.map((nft) => toNFTAsset(nft, opts.chainId));
      return {
        items,
        cursor: result.nextCursor ?? undefined,
        hasMore: Boolean(result.nextCursor),
      };
    }

    // Gave up waiting on the index. Fall through to the next provider rather
    // than claiming the wallet holds nothing.
    throw new IndexerNotSupportedError("getNFTs", this.name);
  }

  // ─── Not served here ──────────────────────────────────────────────────────
  // Token balances are read on-chain from a discovered token list, so this
  // provider deliberately declines them.

  async getTokenBalances(
    _address: string,
    _chainId: number,
  ): Promise<TokenBalance[]> {
    throw new IndexerNotSupportedError("getTokenBalances", this.name);
  }

  async getTransactionHistory(
    _opts: HistoryOpts,
  ): Promise<PaginatedResult<WalletTransaction>> {
    throw new IndexerNotSupportedError("getTransactionHistory", this.name);
  }

  async getTokenApprovals(
    _address: string,
    _chainId: number,
  ): Promise<TokenApproval[]> {
    throw new IndexerNotSupportedError("getTokenApprovals", this.name);
  }

  async getTokenMetadata(): Promise<null> {
    throw new IndexerNotSupportedError("getTokenMetadata", this.name);
  }

  async getTokenPrices(
    _contractAddresses: string[],
    _chainId: number,
  ): Promise<TokenPrice[]> {
    throw new IndexerNotSupportedError("getTokenPrices", this.name);
  }

  async resolveENS(
    _nameOrAddress: string,
    _chainId: number,
  ): Promise<ENSResolution | null> {
    throw new IndexerNotSupportedError("resolveENS", this.name);
  }
}
