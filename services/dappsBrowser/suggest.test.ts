import { describe, expect, it } from "vitest";
import {
  buildSuggestions,
  type CatalogEntry,
  type HistoryEntry,
  type SuggestionListItem,
} from "./suggest";

const NOW = Date.UTC(2026, 7, 13);
const daysAgo = (n: number) => NOW - n * 86_400_000;

const dapp = (over: Partial<CatalogEntry> & { id: string }): CatalogEntry => ({
  name: over.id,
  description: "",
  websiteUrl: `https://${over.id}.example`,
  logoUrl: "",
  categoryName: "DeFi",
  isFavorite: false,
  isPopular: false,
  ...over,
});

const visit = (
  over: Partial<HistoryEntry> & { host: string },
): HistoryEntry => ({
  url: `https://${over.host}`,
  title: over.host,
  visitCount: 1,
  lastVisitedAt: daysAgo(1),
  ...over,
});

/** Row titles in order, headers rendered as "# Label". */
const outline = (items: SuggestionListItem[]): string[] =>
  items.map((item) =>
    item.type === "header" ? `# ${item.label}` : item.suggestion.title,
  );

const rows = (items: SuggestionListItem[]) =>
  items.flatMap((item) => (item.type === "row" ? [item.suggestion] : []));

const CATALOG: CatalogEntry[] = [
  dapp({
    id: "jupiter",
    name: "Jupiter",
    websiteUrl: "https://jup.ag",
    categoryName: "DEX",
    isPopular: true,
  }),
  dapp({
    id: "jupiter-perps",
    name: "Jupiter Perps",
    websiteUrl: "https://jup.ag/perps",
    categoryName: "Perps",
  }),
  dapp({
    id: "uniswap",
    name: "Uniswap",
    websiteUrl: "https://app.uniswap.org",
    categoryName: "DEX",
    description: "Swap tokens on Ethereum",
  }),
  dapp({
    id: "aave",
    name: "Aave",
    websiteUrl: "https://app.aave.com",
    categoryName: "Lending",
    isFavorite: true,
  }),
];

describe("buildSuggestions — typed URL", () => {
  it("puts the literal destination first so it is never buried", () => {
    const items = buildSuggestions({
      query: "jup.ag",
      catalog: CATALOG,
      history: [],
      now: NOW,
    });
    expect(items[0]).toMatchObject({
      type: "row",
      suggestion: { kind: "navigate", url: "https://jup.ag", title: "jup.ag" },
    });
  });

  it("does not offer a navigate row for a plain query", () => {
    const items = buildSuggestions({
      query: "best dex",
      catalog: CATALOG,
      history: [],
      now: NOW,
    });
    expect(rows(items).some((r) => r.kind === "navigate")).toBe(false);
  });

  it("always ends with the web-search escape hatch", () => {
    for (const query of ["jup.ag", "best dex", "uniswap"]) {
      const items = buildSuggestions({
        query,
        catalog: CATALOG,
        history: [],
        now: NOW,
      });
      const last = items[items.length - 1];
      expect(last.type === "row" && last.suggestion.kind, query).toBe("search");
    }
  });
});

describe("buildSuggestions — matching", () => {
  it("matches a dApp by name prefix", () => {
    const items = buildSuggestions({
      query: "uni",
      catalog: CATALOG,
      history: [],
      now: NOW,
    });
    expect(rows(items).map((r) => r.title)).toContain("Uniswap");
  });

  it("matches a dApp by a label inside its host", () => {
    // "uniswap" has to find app.uniswap.org, not just a host that starts with it.
    const items = buildSuggestions({
      query: "uniswap",
      catalog: CATALOG,
      history: [],
      now: NOW,
    });
    expect(rows(items)[0].title).toBe("Uniswap");
  });

  it("matches on a word boundary inside the name", () => {
    const items = buildSuggestions({
      query: "perps",
      catalog: CATALOG,
      history: [],
      now: NOW,
    });
    expect(rows(items).map((r) => r.title)).toContain("Jupiter Perps");
  });

  it("matches by category", () => {
    const items = buildSuggestions({
      query: "lending",
      catalog: CATALOG,
      history: [],
      now: NOW,
    });
    expect(rows(items).map((r) => r.title)).toContain("Aave");
  });

  it("ranks a description hit below a name hit", () => {
    const catalog = [
      dapp({ id: "a", name: "Zebra", description: "swap tokens" }),
      dapp({ id: "b", name: "Swap Central" }),
    ];
    const items = buildSuggestions({
      query: "swap",
      catalog,
      history: [],
      now: NOW,
    });
    const titles = rows(items)
      .filter((r) => r.kind === "dapp")
      .map((r) => r.title);
    expect(titles).toEqual(["Swap Central", "Zebra"]);
  });

  it("boosts favourites above equally-matching entries", () => {
    const catalog = [
      dapp({ id: "a", name: "Swap One" }),
      dapp({ id: "b", name: "Swap Two", isFavorite: true }),
    ];
    const items = buildSuggestions({
      query: "swap",
      catalog,
      history: [],
      now: NOW,
    });
    expect(rows(items)[0].title).toBe("Swap Two");
  });

  it("returns only the search row when nothing matches", () => {
    const items = buildSuggestions({
      query: "zzzznope",
      catalog: CATALOG,
      history: [],
      now: NOW,
    });
    expect(rows(items)).toHaveLength(1);
    expect(rows(items)[0].kind).toBe("search");
  });
});

describe("buildSuggestions — history", () => {
  it("ranks a visited site above an unvisited catalogue entry", () => {
    const items = buildSuggestions({
      query: "sw",
      catalog: [dapp({ id: "swapcity", name: "Swapcity" })],
      history: [visit({ host: "swap.example", title: "Swap Example" })],
      now: NOW,
    });
    expect(outline(items)).toEqual([
      "# Recent",
      "Swap Example",
      "# Apps",
      "Swapcity",
      "sw",
    ]);
  });

  it("marks only history-backed rows with the host that can be forgotten", () => {
    // `historyHost` is what gates the long-press delete in the UI: a site
    // the user visited is theirs to remove, a catalogue app is not.
    const items = buildSuggestions({
      query: "swap",
      catalog: [dapp({ id: "swapcity", name: "Swapcity" })],
      history: [visit({ host: "swap.example", title: "Swap Example" })],
      now: NOW,
    });
    const byKind = Object.fromEntries(
      rows(items).map((row) => [row.kind, row.historyHost]),
    );
    expect(byKind.history).toBe("swap.example");
    expect(byKind.dapp).toBeUndefined();
    expect(byKind.search).toBeUndefined();
  });

  it("prefers a frequently visited site over a stale one", () => {
    const items = buildSuggestions({
      query: "x",
      catalog: [],
      history: [
        visit({
          host: "x-old.example",
          lastVisitedAt: daysAgo(13),
          visitCount: 1,
        }),
        visit({
          host: "x-hot.example",
          lastVisitedAt: daysAgo(0),
          visitCount: 9,
        }),
      ],
      now: NOW,
    });
    expect(rows(items)[0].subtitle).toBe("x-hot.example");
  });

  it("shows a known site once, in Recent, enriched from the catalogue", () => {
    // Without the merge this rendered twice: a bare history row and the
    // catalogue card for the same dApp.
    const items = buildSuggestions({
      query: "jup",
      catalog: CATALOG,
      history: [visit({ host: "jup.ag", title: "Jupiter | Swap" })],
      now: NOW,
    });
    const jupiterRows = rows(items).filter((r) => r.dappId === "jupiter");
    expect(jupiterRows).toHaveLength(1);
    expect(jupiterRows[0]).toMatchObject({
      kind: "history",
      // The bare history title ("Jupiter | Swap") is replaced by the
      // catalogue's name, and the row picks up its category chip.
      title: "Jupiter",
      subtitle: "jup.ag",
      badge: "DEX",
    });
  });

  it("still finds the app when a full URL is typed or pasted", () => {
    // Scoring the raw "https://app.uniswap.org" against a catalogue named
    // "Uniswap" matched nothing, so pasting a URL showed only the two
    // action rows and an otherwise empty screen.
    for (const query of [
      "https://app.uniswap.org",
      "app.uniswap.org",
      "https://www.app.uniswap.org/swap",
    ]) {
      const items = buildSuggestions({
        query,
        catalog: CATALOG,
        history: [],
        now: NOW,
      });
      expect(
        rows(items).map((r) => r.title),
        query,
      ).toContain("Uniswap");
    }
  });

  it("keeps the typed destination above the app it resolves to", () => {
    const items = buildSuggestions({
      query: "https://app.uniswap.org",
      catalog: CATALOG,
      history: [],
      now: NOW,
    });
    const kinds = rows(items).map((r) => r.kind);
    expect(kinds[0]).toBe("navigate");
    expect(kinds).toContain("dapp");
  });

  it("carries the category as a chip and the host as the subtitle", () => {
    const items = buildSuggestions({
      query: "aave",
      catalog: CATALOG,
      history: [],
      now: NOW,
    });
    expect(rows(items)[0]).toMatchObject({
      kind: "dapp",
      title: "Aave",
      subtitle: "app.aave.com",
      badge: "Lending",
      isFavorite: true,
    });
  });

  it("returns to the exact page recorded, not just the origin", () => {
    const items = buildSuggestions({
      query: "uni",
      catalog: [],
      history: [
        visit({
          host: "app.uniswap.org",
          url: "https://app.uniswap.org/swap",
          title: "Uniswap",
        }),
      ],
      now: NOW,
    });
    expect(rows(items)[0].url).toBe("https://app.uniswap.org/swap");
  });

  it("respects the recent limit", () => {
    const history = Array.from({ length: 10 }, (_, i) =>
      visit({ host: `site${i}.example`, lastVisitedAt: daysAgo(i) }),
    );
    const items = buildSuggestions({
      query: "site",
      catalog: [],
      history,
      now: NOW,
      recentLimit: 3,
    });
    expect(rows(items).filter((r) => r.kind === "history")).toHaveLength(3);
  });
});

describe("buildSuggestions — zero state", () => {
  it("shows recents then favourites and popular apps before typing", () => {
    const items = buildSuggestions({
      query: "",
      catalog: CATALOG,
      history: [visit({ host: "raydium.io", title: "Raydium" })],
      now: NOW,
    });
    expect(outline(items)).toEqual([
      "# Recent",
      "Raydium",
      "# Suggested apps",
      "Aave",
      "Jupiter",
    ]);
  });

  it("offers no search row with nothing typed", () => {
    const items = buildSuggestions({
      query: "   ",
      catalog: CATALOG,
      history: [],
      now: NOW,
    });
    expect(rows(items).some((r) => r.kind === "search")).toBe(false);
  });

  it("omits the Recent header on a fresh install", () => {
    const items = buildSuggestions({
      query: "",
      catalog: CATALOG,
      history: [],
      now: NOW,
    });
    expect(outline(items)).toEqual(["# Suggested apps", "Aave", "Jupiter"]);
  });
});
