/**
 * The quota-protecting invariant, tested at the wire boundary.
 *
 * The portfolio endpoints are cache-first by default. Every automatic read
 * (mount, remount, staleTime expiry, reconnect) must therefore go out WITHOUT
 * `refresh`, and only a deliberate user gesture may set it. Getting this wrong
 * turns a screen mount into an upstream request and drains a shared daily
 * quota, so it is asserted rather than left to a comment.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("@/constants/configs/ky", () => ({
  api: { get: (...args: unknown[]) => get(...args) },
}));

const { portfolioApi } = await import("./portfolio");

/** The `searchParams` handed to ky for the most recent call. */
function lastParams(): URLSearchParams {
  const [, options] = get.mock.calls.at(-1) as [
    string,
    { searchParams: URLSearchParams },
  ];
  return options.searchParams;
}

function lastPath(): string {
  return (get.mock.calls.at(-1) as [string, unknown])[0];
}

beforeEach(() => {
  get.mockReset();
  get.mockReturnValue({ json: async () => ({ status: "ready", data: [] }) });
});

describe("refresh is opt-in", () => {
  it("omits `refresh` entirely on a default read", async () => {
    await portfolioApi.getDiscoveredAssets({ chains: [8453] });

    expect(lastPath()).toBe("portfolio/discovered-assets");
    expect(lastParams().has("refresh")).toBe(false);
  });

  it("omits `refresh` when it is explicitly false", async () => {
    await portfolioApi.getDiscoveredAssets({ chains: [8453], refresh: false });

    expect(lastParams().has("refresh")).toBe(false);
  });

  it("sends `refresh=true` only when asked", async () => {
    await portfolioApi.getDiscoveredAssets({ chains: [8453], refresh: true });

    expect(lastParams().get("refresh")).toBe("true");
  });

  it("holds for positions and NFTs too", async () => {
    await portfolioApi.getDefiPositions({});
    expect(lastParams().has("refresh")).toBe(false);

    await portfolioApi.getNfts({});
    expect(lastParams().has("refresh")).toBe(false);

    await portfolioApi.getNfts({ refresh: true });
    expect(lastParams().get("refresh")).toBe("true");
  });
});

describe("chain selectors", () => {
  it("joins numeric chain ids into the CSV param", async () => {
    await portfolioApi.getDiscoveredAssets({ chains: [1, 8453] });

    expect(lastParams().get("chain_ids")).toBe("1,8453");
  });

  it("passes a namespace through for chains with no numeric id", async () => {
    await portfolioApi.getDiscoveredAssets({ chains: ["solana"] });

    expect(lastParams().get("chain_ids")).toBe("solana");
  });

  it("omits the filter entirely when no chains are given", async () => {
    await portfolioApi.getDiscoveredAssets({});

    expect(lastParams().has("chain_ids")).toBe(false);
  });

  it("forwards NFT pagination", async () => {
    await portfolioApi.getNfts({ pageSize: 20, pageAfter: "cursor-1" });

    expect(lastParams().get("page_size")).toBe("20");
    expect(lastParams().get("page_after")).toBe("cursor-1");
  });
});
