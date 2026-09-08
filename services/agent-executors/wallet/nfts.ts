/**
 * `get_wallet_nfts` — the connected wallet's collectibles.
 *
 * Unlike token balances, NFT ownership cannot be read from plain RPC: there
 * is no on-chain call that enumerates what an address holds. This goes
 * through the indexer registry, which is also where the "wallet is still
 * being indexed" retry lives (`services/indexer/ZerionNftProvider.ts`).
 *
 * EVM-only for now. The server scopes the tool out on other namespaces
 * (agent-api `namespaceScope.ts`), so the guard here is the backstop rather
 * than the expected path.
 */

import { indexerRegistry } from "@/services/indexer/registry";
import type { NFTAsset, PaginatedResult } from "@/services/indexer/types";
import {
  ExecutorError,
  ExecutorErrorCode,
  type MobileToolExecutor,
  safeExecute,
} from "../types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export const getWalletNfts: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    if (context.wallet.namespace !== "eip155") {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "collectibles_not_supported_on_this_chain",
      );
    }

    const address = context.wallet.address;
    if (!address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }

    const chainId = context.activeChainId;
    if (typeof chainId !== "number") {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "no active chain",
      );
    }

    const rawLimit = (input as Record<string, unknown>).limit;
    const limit =
      typeof rawLimit === "number" && Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.floor(rawLimit), 1), MAX_LIMIT)
        : DEFAULT_LIMIT;

    let page: PaginatedResult<NFTAsset>;
    try {
      page = await indexerRegistry.call<PaginatedResult<NFTAsset>>("getNFTs", {
        address,
        chainId,
        limit,
        excludeSpam: true,
      });
    } catch {
      // Every provider declined. That is "we cannot look this up", which is
      // NOT the same as "the wallet owns nothing" — say so rather than
      // letting the model report an empty collection as fact.
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "collectibles_lookup_unavailable",
      );
    }

    return {
      status: "success",
      data: {
        chain_id: chainId,
        count: page.items.length,
        has_more: page.hasMore,
        nfts: page.items.map((nft) => ({
          name: nft.metadata.name,
          collection_name: nft.collection.name,
          token_id: nft.tokenId,
          contract_address: nft.contractAddress,
          token_type: nft.tokenType,
          amount: nft.balance,
          image_url: nft.metadata.imageUrl,
          floor_price: nft.collection.floorPrice,
        })),
      },
    };
  });
