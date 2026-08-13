import { beforeEach, describe, expect, it } from "vitest";
import { storage } from "@/lib/storage/mmkv";
import { FaviconStore, isStorableIconUrl } from "./faviconStore";

const ICON = "https://tower.exchange/favicon.png";
const OTHER = "https://tower.exchange/new-brand.png";

beforeEach(() => {
  FaviconStore.clear();
});

describe("isStorableIconUrl", () => {
  it("takes an https URL", () => {
    expect(isStorableIconUrl(ICON)).toBe(true);
  });

  it("rejects anything that is not a plain https URL", () => {
    // http is refused by the WebView's mixed-content policy anyway, and a
    // data URI would put image bytes into MMKV.
    expect(isStorableIconUrl("http://tower.exchange/favicon.png")).toBe(false);
    expect(isStorableIconUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isStorableIconUrl("javascript:alert(1)")).toBe(false);
    expect(isStorableIconUrl("")).toBe(false);
    expect(isStorableIconUrl(undefined)).toBe(false);
    expect(isStorableIconUrl(42)).toBe(false);
  });

  it("rejects a URL long enough to be a payload", () => {
    expect(isStorableIconUrl(`https://x.example/${"a".repeat(600)}`)).toBe(
      false,
    );
  });
});

describe("FaviconStore", () => {
  it("remembers an icon per host", () => {
    FaviconStore.record({ host: "tower.exchange", url: ICON });
    expect(FaviconStore.get("tower.exchange")).toBe(ICON);
  });

  it("picks up a rebrand on the next visit", () => {
    FaviconStore.record({ host: "tower.exchange", url: ICON });
    FaviconStore.record({ host: "tower.exchange", url: OTHER });
    expect(FaviconStore.get("tower.exchange")).toBe(OTHER);
  });

  it("keeps the known icon when a later visit reports nothing", () => {
    // The whole point: a page that renders slowly, or is opened offline,
    // must not blank an icon the user has been seeing for weeks.
    FaviconStore.record({ host: "tower.exchange", url: ICON });
    FaviconStore.record({ host: "tower.exchange", url: "" });
    FaviconStore.record({ host: "tower.exchange", url: undefined });
    FaviconStore.record({ host: "tower.exchange", url: "not a url" });
    expect(FaviconStore.get("tower.exchange")).toBe(ICON);
  });

  it("ignores a record with no host", () => {
    FaviconStore.record({ host: "", url: ICON });
    expect(FaviconStore.map().size).toBe(0);
  });

  it("hands out the same map identity until something changes", () => {
    // `useSyncExternalStore` re-renders forever if getSnapshot allocates.
    FaviconStore.record({ host: "tower.exchange", url: ICON });
    expect(FaviconStore.map()).toBe(FaviconStore.map());
  });

  it("does not churn the snapshot when a visit reports the same icon", () => {
    FaviconStore.record({ host: "tower.exchange", url: ICON });
    const before = FaviconStore.map();
    FaviconStore.record({ host: "tower.exchange", url: ICON });
    expect(FaviconStore.map()).toBe(before);
  });

  it("counts a revisit as recent even when the icon has not changed", () => {
    // Otherwise eviction would be least-recently-CHANGED, and a much-used
    // site with a stable icon would age out before a site visited once.
    FaviconStore.record({ host: "old.example", url: ICON });
    FaviconStore.record({ host: "new.example", url: OTHER });
    FaviconStore.record({ host: "old.example", url: ICON });
    for (let i = 0; i < 299; i++) {
      FaviconStore.record({ host: `f${i}.example`, url: `https://x/${i}.png` });
    }
    expect(FaviconStore.get("old.example")).toBe(ICON);
    expect(FaviconStore.get("new.example")).toBeUndefined();
  });

  it("notifies subscribers on a change and not on a no-op", () => {
    let calls = 0;
    const unsubscribe = FaviconStore.subscribe(() => {
      calls += 1;
    });
    FaviconStore.record({ host: "a.example", url: ICON });
    expect(calls).toBe(1);
    FaviconStore.record({ host: "a.example", url: ICON });
    expect(calls).toBe(1);
    FaviconStore.record({ host: "a.example", url: "" });
    expect(calls).toBe(1);
    unsubscribe();
  });

  it("forgets one host without touching the others", () => {
    FaviconStore.record({ host: "a.example", url: ICON });
    FaviconStore.record({ host: "b.example", url: OTHER });
    FaviconStore.remove("a.example");
    expect(FaviconStore.get("a.example")).toBeUndefined();
    expect(FaviconStore.get("b.example")).toBe(OTHER);
  });

  it("caps the cache, evicting the least recently updated", () => {
    for (let i = 0; i < 320; i++) {
      FaviconStore.record({ host: `h${i}.example`, url: `https://x/${i}.png` });
    }
    expect(FaviconStore.map().size).toBe(300);
    // The most recent write survives, the first does not.
    expect(FaviconStore.get("h319.example")).toBeDefined();
    expect(FaviconStore.get("h0.example")).toBeUndefined();
  });

  it("survives a corrupt payload on disk", () => {
    storage.set("takumipay_browser_favicons", "{not json");
    expect(FaviconStore.map().size).toBe(0);
  });
});
