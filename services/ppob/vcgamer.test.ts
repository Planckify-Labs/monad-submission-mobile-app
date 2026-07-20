import { beforeAll, describe, expect, it } from "vitest";
import type { TProductVariant } from "@/api/types/product";
import { bootPpobCategorizers } from "./boot";
import { groupVariantsByCategory } from "./categorize";
import {
  applyFacetFilter,
  buildFacetSections,
  emptySelection,
  facetKindOf,
  formatQuota,
  formatValidity,
  toggleFacetOption,
} from "./facets";
import { createVcGamerCategorizer } from "./partners/vcgamer";
import { PpobCategorizerRegistryImpl } from "./registry";

const categorizer = createVcGamerCategorizer();

// Dock the first-party partners into the shared singleton so the
// grouping helper (which resolves through it) sees vcGamer.
beforeAll(() => {
  bootPpobCategorizers();
});

/** Minimal variant stub — only fields the categorizer/grouping read. */
function variant(name: string, vendor = "vcGamer"): TProductVariant {
  return {
    id: name,
    name,
    description: `${name} for Telkomsel`,
    ProductPrice: [{ vendor: { name: vendor } }],
  } as unknown as TProductVariant;
}

const cat = (name: string) => categorizer.categorize(variant(name));

/** Variant with a price (points) for facet/filter tests. */
function priced(name: string, points: number): TProductVariant {
  return {
    id: `${name}#${points}`,
    name,
    description: `${name} for Telkomsel`,
    ProductPrice: [{ sellPrice: String(points), vendor: { name: "vcGamer" } }],
  } as unknown as TProductVariant;
}

const facets = (name: string) => categorizer.extractFacets!(variant(name));

describe("vcGamer categorizer — data bucket", () => {
  // One representative per data-plan family seen across all 7 operators.
  const dataNames = [
    "Data Internet Sakti 1.5 GB 7 Hari",
    "Data Bulk 1 GB / 30 Hari",
    "Data Ketengan OMG 15.000",
    "Voucher Telkomsel 2.5 GB 5 Hari",
    "1 GB 30 Hari",
    "800 MB 30 Hari",
    "XTRA ON 1GB", // quota with no space
    "AlwaysOn 150 GB",
    "HOTROD 500 MB 7 Hari",
    "Freedom Internet 10 GB 30 Hari",
    "Freedom U JUMBO 30 Hari", // family keyword, no explicit quota
    "Indosat Freedom Internet 5G 40 GB 30 Hari (25+15)",
    "Xtra Combo Flex XXXL", // family keyword, no quota
    "Voucher AIGO 65 GB / 60 Hari",
    "Telkomsel Data Flash 10.000", // data plan labelled as a rupiah amount
    "Voucher Smartfren Data 100.000",
    "Data Combo Sakti 35", // truncated name, "Data" keyword still catches
    "Internet 100 MB / 30 Hari",
    "Telkomsel Data 15 GB + 40 GB Videomax / 30 Hari",
  ];
  it.each(dataNames)("%s -> data", (name) => {
    expect(cat(name)).toBe("data");
  });
});

describe("vcGamer categorizer — phone_credit bucket", () => {
  // Pulsa nominal, card-validity extension, and voice all live here.
  const phoneNames = [
    "Pulsa Reguler 5.000",
    "5.000 Reguler",
    "Reguler 500.000",
    "Telkomsel 5.000",
    "Smartfren 45.000",
    "Tri 10.000",
    "Three 5.000",
    "Xl 60.000",
    "Voucher Indosat 10.000", // pulsa voucher — no "Data" token
    "Tambah Masa Aktif Kartu 5 Hari",
    "Axis Tambah Masa Aktif Kartu 90 Hari",
    "Indosat Tambah Masa Aktif Kartu 15 Hari",
    "Tri Tambah Masa Aktif Kartu 4 Bulan",
    "Telepon Unlimited Sesama + 60 Menit Semua Op - 30 Hari", // voice
  ];
  it.each(phoneNames)("%s -> phone_credit", (name) => {
    expect(cat(name)).toBe("phone_credit");
  });

  it("does not confuse a pulsa voucher with a data voucher", () => {
    expect(cat("Voucher Indosat 10.000")).toBe("phone_credit");
    expect(cat("Voucher Smartfren Data 10.000")).toBe("data");
  });

  it("tolerates trailing whitespace in vendor names", () => {
    expect(cat("Pulsa Reguler 30.000\t")).toBe("phone_credit");
    expect(cat("Data Bulanan OMG 55.000\t")).toBe("data");
  });
});

describe("vcGamer categorizer — other (safety net)", () => {
  it("routes names matching neither pattern to 'other' (not phone_credit)", () => {
    expect(cat("Mystery Bundle Spesial")).toBe("other");
    expect(cat("Paket Baru Keren")).toBe("other");
  });

  it("still classifies known names, so 'other' stays empty for real data", () => {
    expect(cat("Data Flash 5 GB 30 Hari")).toBe("data");
    expect(cat("Pulsa Reguler 5.000")).toBe("phone_credit");
    expect(cat("Tambah Masa Aktif Kartu 5 Hari")).toBe("phone_credit");
  });
});

describe("groupVariantsByCategory", () => {
  it("only surfaces the 'other' group when something lands in it", () => {
    const withoutOther = groupVariantsByCategory([
      variant("Pulsa Reguler 5.000"),
      variant("Data Flash 5 GB 30 Hari"),
    ]);
    expect(withoutOther!.map((g) => g.key)).toEqual(["phone_credit", "data"]);

    const withOther = groupVariantsByCategory([
      variant("Pulsa Reguler 5.000"),
      variant("Data Flash 5 GB 30 Hari"),
      variant("Mystery Bundle Spesial"),
    ]);
    expect(withOther!.map((g) => g.key)).toEqual([
      "phone_credit",
      "data",
      "other",
    ]);
    expect(withOther!.find((g) => g.key === "other")!.variants).toHaveLength(1);
  });

  it("groups vcGamer variants, preserving category order, dropping empties", () => {
    const groups = groupVariantsByCategory([
      variant("Pulsa Reguler 5.000"),
      variant("Data Internet Sakti 1.5 GB 7 Hari"),
      variant("Tambah Masa Aktif Kartu 5 Hari"),
      variant("Voucher AIGO 5 GB / 30 Hari"),
    ]);
    expect(groups).not.toBeNull();
    expect(groups!.map((g) => g.key)).toEqual(["phone_credit", "data"]);
    expect(groups![0].variants).toHaveLength(2); // pulsa + masa aktif
    expect(groups![1].variants).toHaveLength(2); // two data plans
  });

  it("omits a category with no variants", () => {
    const groups = groupVariantsByCategory([
      variant("Data Bulk 1 GB / 30 Hari"),
      variant("Freedom Internet 10 GB 30 Hari"),
    ]);
    expect(groups!.map((g) => g.key)).toEqual(["data"]);
  });

  it("returns null for an undocked vendor (UI falls back to a flat list)", () => {
    expect(
      groupVariantsByCategory([
        variant("Pulsa Reguler 5.000", "someOtherPpob"),
      ]),
    ).toBeNull();
  });

  it("returns null for an empty catalog", () => {
    expect(groupVariantsByCategory([])).toBeNull();
    expect(groupVariantsByCategory(undefined)).toBeNull();
  });
});

describe("extractFacets — family / quota / validity", () => {
  it("extracts package family across operators (provider stripped, tiers collapsed)", () => {
    expect(facets("Freedom Internet 10 GB 30 Hari").family).toBe(
      "Freedom Internet",
    );
    expect(facets("Data Internet Sakti 1.5 GB 7 Hari").family).toBe(
      "Data Internet Sakti",
    );
    expect(facets("HOTROD 1 GB 2 Hari").family).toBe("HOTROD");
    expect(facets("Xtra Combo Flex XXXL").family).toBe("Xtra Combo Flex");
    expect(facets("XTRA Hotrod Special L 7 Hari").family).toBe(
      "XTRA Hotrod Special",
    );
    expect(facets("Voucher AIGO 65 GB / 60 Hari").family).toBe("AIGO");
    expect(
      facets("Indosat Freedom Internet 5G 40 GB 30 Hari (25+15)").family,
    ).toBe("Freedom Internet 5G");
  });

  it("sums data quota in MB (GB=1000), including combos", () => {
    expect(facets("Data Internet Sakti 1.5 GB 7 Hari").dataMb).toBe(1500);
    expect(facets("800 MB 30 Hari").dataMb).toBe(800);
    expect(facets("XTRA ON 1GB").dataMb).toBe(1000);
    expect(facets("Xtra Combo 10 GB + 20 GB 30 Hari").dataMb).toBe(30000);
    expect(facets("Voucher Telkomsel 2.5 GB 5 Hari").dataMb).toBe(2500);
    expect(facets("Pulsa Reguler 5.000").dataMb).toBeNull();
  });

  it("extracts validity in days (Bulan -> *30)", () => {
    expect(facets("Data Internet Sakti 1.5 GB 7 Hari").validityDays).toBe(7);
    expect(facets("Data Bulk 1 GB / 30 Hari").validityDays).toBe(30);
    expect(facets("Tri Tambah Masa Aktif Kartu 4 Bulan").validityDays).toBe(
      120,
    );
    expect(facets("AlwaysOn 150 GB").validityDays).toBeNull();
  });
});

describe("buildFacetSections", () => {
  const dataVariants = [
    priced("Data Internet Sakti 1.5 GB 7 Hari", 3000),
    priced("Data Flash 5 GB 30 Hari", 8000),
    priced("Data Flash 10 GB 30 Hari", 12000),
    priced("HOTROD 1 GB 2 Hari", 2000),
    priced("HOTROD 12 GB 30 Hari", 15000),
    priced("Freedom Internet 20 GB 30 Hari", 25000),
    priced("Freedom Internet 40 GB 30 Hari", 45000),
    priced("Data Bulk 1 GB / 30 Hari", 4000),
  ];

  it("builds Package/Price/Quota/Validity sections from data variants", () => {
    const sections = buildFacetSections(dataVariants);
    const kinds = sections.map((s) => s.kind);
    expect(kinds).toContain("family");
    expect(kinds).toContain("quota");
    expect(kinds).toContain("validity");
    expect(kinds).toContain("price");
    // Family chips are the derived product lines, most-frequent first.
    const family = sections.find((s) => s.kind === "family")!;
    expect(family.options.map((o) => o.label)).toContain("HOTROD");
    expect(family.options.map((o) => o.label)).toContain("Freedom Internet");
  });

  it("omits the family section on the pulsa tab (no data variants)", () => {
    const pulsa = [
      priced("Pulsa Reguler 5.000", 6000),
      priced("Pulsa Reguler 10.000", 11000),
      priced("Telkomsel 20.000", 21000),
    ];
    const kinds = buildFacetSections(pulsa).map((s) => s.kind);
    expect(kinds).not.toContain("family");
    expect(kinds).not.toContain("quota");
  });

  it("returns [] for an undocked vendor (no filter sheet)", () => {
    const foreign = [
      { id: "x", name: "X", ProductPrice: [{ vendor: { name: "other" } }] },
    ] as unknown as TProductVariant[];
    expect(buildFacetSections(foreign)).toEqual([]);
  });
});

describe("applyFacetFilter", () => {
  const list = [
    priced("HOTROD 1 GB 2 Hari", 2000), // 1GB, 2d
    priced("Data Flash 5 GB 30 Hari", 8000), // 5GB, 30d
    priced("Freedom Internet 20 GB 30 Hari", 25000), // 20GB, 30d
    priced("Freedom Internet 40 GB 30 Hari", 45000), // 40GB, 30d
  ];

  it("returns everything when nothing is selected", () => {
    expect(applyFacetFilter(list, emptySelection())).toHaveLength(4);
  });

  it("filters by quota bucket (>20 GB)", () => {
    const sel = { ...emptySelection(), quota: ["quota:20000:"] };
    const names = applyFacetFilter(list, sel).map((v) => v.name);
    expect(names).toEqual(["Freedom Internet 40 GB 30 Hari"]);
  });

  it("ORs within a section, ANDs across sections", () => {
    // family = Freedom Internet AND quota in (>20GB OR 5-10GB)
    const sel = {
      ...emptySelection(),
      family: ["family:Freedom Internet"],
      quota: ["quota:20000:", "quota:5000:10000"],
    };
    const names = applyFacetFilter(list, sel).map((v) => v.name);
    expect(names).toEqual(["Freedom Internet 40 GB 30 Hari"]);
  });

  it("filters by validity (≤ 3 days)", () => {
    const sel = { ...emptySelection(), validity: ["validity:0:3"] };
    expect(applyFacetFilter(list, sel).map((v) => v.name)).toEqual([
      "HOTROD 1 GB 2 Hari",
    ]);
  });
});

describe("price bucketing + format helpers", () => {
  it("auto-scales price buckets from the current range", () => {
    // Spread of point prices; expect 4 contiguous buckets (< / a-b / b-c / >).
    const prices = [2000, 3000, 5000, 8000, 12000, 20000, 30000, 45000];
    const variants = prices.map((p, i) =>
      priced(`Data Flash ${i} GB 30 Hari`, p),
    );
    const priceSection = buildFacetSections(variants).find(
      (s) => s.kind === "price",
    );
    expect(priceSection).toBeDefined();
    expect(priceSection!.options.length).toBeGreaterThanOrEqual(3);
    expect(priceSection!.options[0].label.startsWith("<")).toBe(true);
    expect(priceSection!.options.at(-1)!.label.startsWith(">")).toBe(true);
  });

  it("formats quota and validity for display", () => {
    expect(formatQuota(1500)).toBe("1.5 GB");
    expect(formatQuota(1000)).toBe("1 GB");
    expect(formatQuota(800)).toBe("800 MB");
    expect(formatQuota(null)).toBeNull();
    expect(formatValidity(1)).toBe("1 day");
    expect(formatValidity(30)).toBe("30 days");
    expect(formatValidity(null)).toBeNull();
  });
});

describe("toggleFacetOption / facetKindOf", () => {
  it("adds then removes an option within its section", () => {
    let sel = emptySelection();
    sel = toggleFacetOption(sel, "quota", "quota:20000:");
    expect(sel.quota).toEqual(["quota:20000:"]);
    sel = toggleFacetOption(sel, "quota", "quota:20000:");
    expect(sel.quota).toEqual([]);
  });

  it("derives the section kind from an option id", () => {
    expect(facetKindOf("family:HOTROD")).toBe("family");
    expect(facetKindOf("quota:999:5000")).toBe("quota");
    expect(facetKindOf("price:-1:5000")).toBe("price");
  });
});

describe("registry — space docking / presence-check", () => {
  it("resolves case-insensitively and null when undocked", () => {
    const registry = new PpobCategorizerRegistryImpl();
    registry.register(categorizer);
    expect(registry.resolve("vcGamer")).toBe(categorizer);
    expect(registry.resolve("VCGAMER")).toBe(categorizer);
    expect(registry.resolve("digiflazz")).toBeNull();
    expect(registry.resolve(null)).toBeNull();
    expect(registry.has("vcgamer")).toBe(true);
  });
});
