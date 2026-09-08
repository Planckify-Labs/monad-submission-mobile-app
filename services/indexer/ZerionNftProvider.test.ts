/**
 * NFT provider: chain gating, the 202 "still indexing" path, and the field
 * mapping onto `NFTAsset`.
 *
 * Both failure modes here must FALL THROUGH (throw `IndexerNotSupportedError`)
 * rather than resolve empty: an empty list is indistinguishable from "this
 * wallet owns nothing", which is a lie the UI would render as fact.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getNfts = vi.fn();
vi.mock("@/api/endpoints/portfolio", () => ({
  portfolioApi: {
    getNfts: (...args: unknown[]) => getNfts(...args),
  },
}));

const { ZerionNftProvider } = await import("./ZerionNftProvider");
const { IndexerNotSupportedError } = await import("./types");

function envelope(over: Record<string, unknown> = {}) {
  return {
    status: "ready",
    data: [],
    fetchedAt: "2026-09-04T00:00:00.000Z",
    fromCache: false,
    nextCursor: null,
    ...over,
  };
}

const NFT_ROW = {
  chainId: 8453,
  namespace: "eip155" as const,
  contractAddress: "0xabc",
  tokenId: "42",
  amount: 1,
  name: "Punk #42",
  description: "A punk",
  previewUrl: "https://cdn.example/preview.png",
  detailUrl: "https://cdn.example/detail.png",
  collectionName: "Punks",
  collectionIconUrl: "https://cdn.example/icon.png",
  floorPrice: 1.5,
  valueUsd: 1.5,
};

beforeEach(() => {
  getNfts.mockReset();
});

describe("chain gating", () => {
  it("declines a chain the indexer does not cover, without a round trip", async () => {
    const provider = new ZerionNftProvider();

    await expect(
      provider.getNFTs({ address: "0xwallet", chainId: 999999 }),
    ).rejects.toBeInstanceOf(IndexerNotSupportedError);
    expect(getNfts).not.toHaveBeenCalled();
  });
});

describe("field mapping", () => {
  it("maps detail/preview media, collection and floor price", async () => {
    getNfts.mockResolvedValue(envelope({ data: [NFT_ROW], nextCursor: "abc" }));
    const provider = new ZerionNftProvider();

    const page = await provider.getNFTs({ address: "0xwallet", chainId: 8453 });

    expect(page.hasMore).toBe(true);
    expect(page.cursor).toBe("abc");
    expect(page.items[0]).toMatchObject({
      contractAddress: "0xabc",
      tokenId: "42",
      tokenType: "ERC-721",
      collection: { name: "Punks", floorPrice: 1.5 },
      metadata: {
        name: "Punk #42",
        imageUrl: "https://cdn.example/detail.png",
      },
    });
  });

  it("falls back to the preview when there is no detail render", async () => {
    getNfts.mockResolvedValue(
      envelope({ data: [{ ...NFT_ROW, detailUrl: null }] }),
    );
    const provider = new ZerionNftProvider();

    const page = await provider.getNFTs({ address: "0xwallet", chainId: 8453 });

    expect(page.items[0].metadata.imageUrl).toBe(
      "https://cdn.example/preview.png",
    );
  });

  it("treats a holding count above one as ERC-1155", async () => {
    getNfts.mockResolvedValue(envelope({ data: [{ ...NFT_ROW, amount: 3 }] }));
    const provider = new ZerionNftProvider();

    const page = await provider.getNFTs({ address: "0xwallet", chainId: 8453 });

    expect(page.items[0].tokenType).toBe("ERC-1155");
    expect(page.items[0].balance).toBe(3);
  });
});

describe("wallet still being indexed", () => {
  it("polls while the answer is 'indexing', then serves the real page", async () => {
    getNfts
      .mockResolvedValueOnce(envelope({ status: "indexing" }))
      .mockResolvedValueOnce(envelope({ status: "indexing" }))
      .mockResolvedValueOnce(envelope({ data: [NFT_ROW] }));
    const provider = new ZerionNftProvider();

    vi.useFakeTimers();
    const pending = provider.getNFTs({ address: "0xwallet", chainId: 8453 });
    await vi.runAllTimersAsync();
    const page = await pending;
    vi.useRealTimers();

    expect(getNfts).toHaveBeenCalledTimes(3);
    expect(page.items).toHaveLength(1);
  });

  it("falls through instead of claiming an empty wallet when indexing never finishes", async () => {
    getNfts.mockResolvedValue(envelope({ status: "indexing" }));
    const provider = new ZerionNftProvider();

    vi.useFakeTimers();
    const pending = provider.getNFTs({ address: "0xwallet", chainId: 8453 });
    const assertion = expect(pending).rejects.toBeInstanceOf(
      IndexerNotSupportedError,
    );
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
  });
});
