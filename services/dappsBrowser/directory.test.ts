import { describe, expect, it } from "vitest";
import type { TDapp } from "@/api/types/dapp";
import {
  ALL_CATEGORY_ID,
  buildDirectory,
  buildJumpBackIn,
  type DirectoryEntry,
  type FavoriteSite,
  metaLine,
  rankLabel,
  toDirectoryEntry,
  type VisitedSite,
} from "./directory";

const NOW = Date.UTC(2026, 7, 13);
const minutesAgo = (n: number) => NOW - n * 60_000;

const entry = (
  over: Partial<DirectoryEntry> & { id: string },
): DirectoryEntry => ({
  name: over.id,
  description: "",
  websiteUrl: `https://${over.id}.example`,
  logoUrl: "",
  categoryId: "dex",
  categoryName: "DEX",
  host: `${over.id}.example`,
  isFavorite: false,
  isPopular: false,
  isConnected: false,
  sortOrder: 0,
  ...over,
});

const visit = (over: Partial<VisitedSite> & { host: string }): VisitedSite => ({
  url: `https://${over.host}`,
  title: over.host,
  lastVisitedAt: minutesAgo(5),
  ...over,
});

const names = (entries: readonly { name: string }[]) =>
  entries.map((e) => e.name);

const never = () => false;

describe("toDirectoryEntry", () => {
  const apiDapp = (over: Partial<TDapp>): TDapp =>
    ({
      id: "uniswap",
      name: "Uniswap",
      description: "Swap any token",
      logoUrl: "https://cdn.example/uni.png",
      websiteUrl: "https://app.uniswap.org/swap",
      categoryId: "dex",
      isPopular: true,
      isSponsor: false,
      isHighlight: false,
      isActive: true,
      isFavorite: false,
      createdAt: "",
      updatedAt: "",
      category: { name: "DEX" },
      ...over,
    }) as TDapp;

  it("flattens the API row and derives the bare host", () => {
    const flat = toDirectoryEntry(apiDapp({}), {
      isFavorite: never,
      connectedHosts: new Set(),
    });
    expect(flat?.host).toBe("app.uniswap.org");
    expect(flat?.categoryName).toBe("DEX");
    expect(flat?.isPopular).toBe(true);
  });

  it("drops rows with no id or no website, which cannot be opened", () => {
    const options = { isFavorite: never, connectedHosts: new Set<string>() };
    expect(toDirectoryEntry(apiDapp({ websiteUrl: "" }), options)).toBeNull();
    expect(toDirectoryEntry(apiDapp({ id: "" }), options)).toBeNull();
  });

  it("lets the local favourites store win over the cached server flag", () => {
    const flat = toDirectoryEntry(apiDapp({ isFavorite: false }), {
      isFavorite: (id) => id === "uniswap",
      connectedHosts: new Set(),
    });
    expect(flat?.isFavorite).toBe(true);
  });

  it("marks a row connected when a grant exists for its host", () => {
    const flat = toDirectoryEntry(apiDapp({}), {
      isFavorite: never,
      connectedHosts: new Set(["app.uniswap.org"]),
    });
    expect(flat?.isConnected).toBe(true);
  });
});

describe("buildDirectory", () => {
  const ENTRIES = [
    entry({ id: "cetus", name: "Cetus", sortOrder: 1 }),
    entry({ id: "aave", name: "Aave", categoryId: "lending", sortOrder: 5 }),
    entry({ id: "jupiter", name: "Jupiter", isPopular: true, sortOrder: 3 }),
    entry({ id: "uniswap", name: "Uniswap", isPopular: true, sortOrder: 1 }),
    entry({ id: "bluefin", name: "Bluefin", sortOrder: 1 }),
  ];

  it("ranks popular first, then sortOrder, then name", () => {
    const ranked = buildDirectory({
      entries: ENTRIES,
      categoryId: ALL_CATEGORY_ID,
    });
    expect(names(ranked)).toEqual([
      "Uniswap",
      "Jupiter",
      "Bluefin",
      "Cetus",
      "Aave",
    ]);
  });

  it("scopes to one category when a tab is selected", () => {
    const ranked = buildDirectory({ entries: ENTRIES, categoryId: "lending" });
    expect(names(ranked)).toEqual(["Aave"]);
  });

  it("does not float the user's own favourites or sessions up the chart", () => {
    const ranked = buildDirectory({
      entries: ENTRIES.map((e) =>
        e.id === "aave" ? { ...e, isFavorite: true, isConnected: true } : e,
      ),
      categoryId: ALL_CATEGORY_ID,
    });
    expect(names(ranked).at(-1)).toBe("Aave");
  });

  it("leaves the caller's array untouched", () => {
    const source = [...ENTRIES];
    buildDirectory({ entries: source, categoryId: ALL_CATEGORY_ID });
    expect(names(source)).toEqual(names(ENTRIES));
  });
});

describe("buildJumpBackIn", () => {
  const ENTRIES = [
    entry({
      id: "uniswap",
      name: "Uniswap",
      websiteUrl: "https://app.uniswap.org",
      host: "app.uniswap.org",
      logoUrl: "https://cdn.example/uni.png",
    }),
    entry({
      id: "jupiter",
      name: "Jupiter",
      websiteUrl: "https://jup.ag",
      host: "jup.ag",
    }),
  ];

  const favorite = (
    over: Partial<FavoriteSite> & { id: string },
  ): FavoriteSite => ({
    name: over.id,
    websiteUrl: `https://${over.id}.example`,
    ...over,
  });

  it("orders by most recent visit and borrows the catalogue name and logo", () => {
    const chips = buildJumpBackIn({
      history: [
        visit({ host: "jup.ag", title: "Jupiter | Swap", lastVisitedAt: 10 }),
        visit({ host: "app.uniswap.org", title: "Uniswap", lastVisitedAt: 20 }),
      ],
      entries: ENTRIES,
      favorites: [],
      connectedHosts: new Set(),
    });
    expect(chips.map((c) => c.label)).toEqual(["Uniswap", "Jupiter"]);
    expect(chips[0].logoUrl).toBe("https://cdn.example/uni.png");
  });

  it("keeps a visited site the catalogue has never heard of", () => {
    const chips = buildJumpBackIn({
      history: [visit({ host: "stranger.xyz", title: "Stranger" })],
      entries: ENTRIES,
      favorites: [],
      connectedHosts: new Set(),
    });
    expect(chips).toHaveLength(1);
    expect(chips[0].label).toBe("Stranger");
    expect(chips[0].initial).toBe("S");
  });

  it("appends favourites the user has not visited lately", () => {
    const chips = buildJumpBackIn({
      history: [visit({ host: "jup.ag" })],
      entries: ENTRIES,
      favorites: [
        favorite({
          id: "scallop",
          name: "Scallop",
          websiteUrl: "https://app.scallop.io",
        }),
      ],
      connectedHosts: new Set(),
    });
    expect(chips.map((c) => c.label)).toEqual(["Jupiter", "Scallop"]);
  });

  it("shows a site that is both visited and starred exactly once", () => {
    const chips = buildJumpBackIn({
      history: [visit({ host: "jup.ag" })],
      entries: ENTRIES,
      favorites: [
        favorite({
          id: "jupiter",
          name: "Jupiter",
          websiteUrl: "https://jup.ag",
        }),
      ],
      connectedHosts: new Set(),
    });
    expect(chips).toHaveLength(1);
    expect(chips[0].id).toBe("jup.ag");
  });

  it("flags the chips whose host currently holds a connection", () => {
    const chips = buildJumpBackIn({
      history: [visit({ host: "jup.ag" }), visit({ host: "app.uniswap.org" })],
      entries: ENTRIES,
      favorites: [],
      connectedHosts: new Set(["jup.ag"]),
    });
    expect(chips.filter((c) => c.isConnected).map((c) => c.id)).toEqual([
      "jup.ag",
    ]);
  });

  it("caps the strip so it stays one line of chips", () => {
    const history = Array.from({ length: 12 }, (_, i) =>
      visit({ host: `site-${i}.example`, lastVisitedAt: i }),
    );
    expect(
      buildJumpBackIn({
        history,
        entries: [],
        favorites: [],
        connectedHosts: new Set(),
      }),
    ).toHaveLength(10);
  });
});

describe("row labels", () => {
  it("pads the rank to two digits", () => {
    expect([rankLabel(0), rankLabel(9), rankLabel(99)]).toEqual([
      "01",
      "10",
      "100",
    ]);
  });

  it("joins category and host, and omits either when missing", () => {
    expect(
      metaLine(entry({ id: "a", categoryName: "DEX", host: "a.io" })),
    ).toBe("DEX  ·  a.io");
    expect(metaLine(entry({ id: "a", categoryName: "", host: "a.io" }))).toBe(
      "a.io",
    );
    expect(metaLine(entry({ id: "a", categoryName: "DEX", host: "" }))).toBe(
      "DEX",
    );
  });
});
