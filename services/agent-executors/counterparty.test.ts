import { describe, expect, it } from "vitest";
import { bridgeDestinationChoice } from "@/services/bridgeRoutes/destinationChoice";
import {
  COUNTERPARTY_TOOL_NAMES,
  extractCounterparty,
  TOOLS_WITHOUT_COUNTERPARTY,
} from "./counterparty";
import { MOBILE_WRITE_TOOLS } from "./expectedMobileTools";

const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

describe("counterparty coverage", () => {
  /**
   * The whole point of the envelope is that a NEW write tool can't
   * silently opt out of it. `bridge_execute` shipped correctly tagged as
   * a write yet missing its approval gate because nothing asserted the
   * pairing — this is the guard that class of bug needs.
   */
  it("classifies every write tool as either having a counterparty or exempt", () => {
    const unclassified = [...MOBILE_WRITE_TOOLS].filter(
      (tool) =>
        !COUNTERPARTY_TOOL_NAMES.has(tool) &&
        !TOOLS_WITHOUT_COUNTERPARTY.has(tool),
    );
    expect(unclassified).toEqual([]);
  });

  it("never classifies a tool as both", () => {
    const both = [...COUNTERPARTY_TOOL_NAMES].filter((tool) =>
      TOOLS_WITHOUT_COUNTERPARTY.has(tool),
    );
    expect(both).toEqual([]);
  });

  it("only classifies tools that are actually writes", () => {
    const notWrites = [
      ...COUNTERPARTY_TOOL_NAMES,
      ...TOOLS_WITHOUT_COUNTERPARTY,
    ].filter((tool) => !MOBILE_WRITE_TOOLS.has(tool));
    expect(notWrites).toEqual([]);
  });
});

describe("extractCounterparty", () => {
  it("pins the namespace for a per-chain tool, ignoring the wallet's", () => {
    expect(extractCounterparty("send_sol", { to: "9YTiQ3" }, "eip155")).toEqual(
      {
        address: "9YTiQ3",
        namespace: "solana",
      },
    );
  });

  it("falls back to the paying wallet for chain-agnostic sends", () => {
    expect(
      extractCounterparty("send_native", { to: "0xabc" }, "eip155"),
    ).toEqual({ address: "0xabc", namespace: "eip155" });
  });

  // A bridge's destination chain is an argument, so its namespace is too —
  // taking the wallet's would classify a Base→Solana destination as EVM
  // and compare it under the wrong case rule.
  it("derives the namespace from the destination CAIP-2 for a bridge", () => {
    expect(
      extractCounterparty(
        "bridge_execute",
        { to_address: "9YTiQ3", to_chain: SOLANA_CAIP2 },
        "eip155",
      ),
    ).toEqual({ address: "9YTiQ3", namespace: "solana" });
  });

  /**
   * The gate must vet the address that will actually SIGN.
   *
   * After the user switches destination on the card, the executor resolves
   * to their pick while the model's argument still names the previous
   * wallet. If that previous wallet was an established one, checking the
   * argument would report "known" and wave the transfer through to an
   * address that is NOT established — skipping the ask entirely. So the
   * live pick has to outrank the argument here too, not just in the
   * executor.
   */
  it("prefers the user's live pick over the model's stale to_address", () => {
    bridgeDestinationChoice.set(SOLANA_CAIP2, "NEWLYPICKED");
    try {
      expect(
        extractCounterparty(
          "bridge_execute",
          { to_address: "STALE_FROM_MODEL", to_chain: SOLANA_CAIP2 },
          "eip155",
        ),
      ).toEqual({ address: "NEWLYPICKED", namespace: "solana" });
    } finally {
      bridgeDestinationChoice.__resetForTests();
    }
  });

  it("falls back to the argument when the user has picked nothing", () => {
    bridgeDestinationChoice.__resetForTests();
    expect(
      extractCounterparty(
        "bridge_execute",
        { to_address: "FROM_MODEL", to_chain: SOLANA_CAIP2 },
        "eip155",
      ),
    ).toEqual({ address: "FROM_MODEL", namespace: "solana" });
  });

  // A pick for a DIFFERENT chain must not leak into this route.
  it("ignores a pick recorded for another destination chain", () => {
    bridgeDestinationChoice.set("sui:mainnet", "SUI_PICK");
    try {
      expect(
        extractCounterparty(
          "bridge_execute",
          { to_address: "FROM_MODEL", to_chain: SOLANA_CAIP2 },
          "eip155",
        ),
      ).toEqual({ address: "FROM_MODEL", namespace: "solana" });
    } finally {
      bridgeDestinationChoice.__resetForTests();
    }
  });

  it("reads the spender for an allowance, not a recipient", () => {
    expect(
      extractCounterparty("approve_erc20", { spender: "0xdef" }, "eip155"),
    ).toEqual({ address: "0xdef", namespace: "eip155" });
  });

  it("returns null for an exempt tool even when the input looks addressy", () => {
    expect(
      extractCounterparty("defi_deposit", { to: "0xabc" }, "eip155"),
    ).toBeNull();
    expect(
      extractCounterparty("x402_fetch", { to: "0xabc" }, "eip155"),
    ).toBeNull();
  });

  // An omitted destination is resolved later by the executor, so there is
  // nothing to vet yet — and inventing one here would confirm an address
  // the user never saw.
  it("returns null when the address argument is absent or blank", () => {
    expect(extractCounterparty("send_sol", {}, "solana")).toBeNull();
    expect(extractCounterparty("send_sol", { to: "   " }, "solana")).toBeNull();
    expect(extractCounterparty("send_sol", undefined, "solana")).toBeNull();
  });

  it("returns null when no namespace can be determined", () => {
    expect(
      extractCounterparty("send_native", { to: "0xabc" }, undefined),
    ).toBeNull();
  });

  it("returns null for an unknown tool", () => {
    expect(
      extractCounterparty("some_future_tool", { to: "0xabc" }, "eip155"),
    ).toBeNull();
  });
});
