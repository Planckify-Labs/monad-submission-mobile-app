import { describe, expect, it } from "vitest";
import type { AgentMessagePart } from "@/services/agent-messages/types";
import { consolidateToolParts } from "./mergeToolParts";

type Row = {
  id?: string;
  protocol_slug?: string;
  namespace?: string;
  chain_id?: number;
};

function successPart(
  toolCallId: string,
  rows: Row[],
  toolName = "defi_list_opportunities",
  input: unknown = {},
): AgentMessagePart {
  return {
    type: "tool",
    toolName,
    toolCallId,
    input,
    state: "output-available",
    output: {
      status: "success",
      data: { opportunities: rows, count: rows.length },
    },
  };
}

function pendingPart(
  toolCallId: string,
  toolName = "defi_list_opportunities",
): AgentMessagePart {
  return {
    type: "tool",
    toolName,
    toolCallId,
    input: {},
    state: "input-available",
  };
}

function failedPart(
  toolCallId: string,
  toolName = "defi_list_opportunities",
): AgentMessagePart {
  return {
    type: "tool",
    toolName,
    toolCallId,
    input: {},
    state: "output-available",
    output: { status: "failed", error: "unknown_error" },
  };
}

function opportunitiesOf(output: unknown): Row[] {
  return (output as { data: { opportunities: Row[] } }).data.opportunities;
}

describe("consolidateToolParts", () => {
  it("leaves a single call untouched", () => {
    const parts = [successPart("a", [{ id: "1" }])];
    const { suppressed, outputs } = consolidateToolParts(parts);
    expect(suppressed.size).toBe(0);
    expect(outputs.size).toBe(0);
  });

  it("merges sibling successes into the first card", () => {
    // The reported bug: one turn, one goal, three chain-scoped calls.
    const parts = [
      successPart("a", [{ id: "sui-1" }, { id: "sui-2" }]),
      successPart("b", [{ id: "sol-1" }]),
      successPart("c", [{ id: "evm-1" }]),
    ];
    const { suppressed, outputs } = consolidateToolParts(parts);

    expect([...suppressed]).toEqual(["b", "c"]);
    const merged = outputs.get("a");
    expect(opportunitiesOf(merged).map((r) => r.id)).toEqual([
      "sui-1",
      "sui-2",
      "sol-1",
      "evm-1",
    ]);
    expect((merged as { data: { count: number } }).data.count).toBe(4);
  });

  it("dedupes rows that repeat across sibling calls", () => {
    const parts = [
      successPart("a", [{ id: "shared" }, { id: "only-a" }]),
      successPart("b", [{ id: "shared" }, { id: "only-b" }]),
    ];
    const { outputs } = consolidateToolParts(parts);
    expect(opportunitiesOf(outputs.get("a")).map((r) => r.id)).toEqual([
      "shared",
      "only-a",
      "only-b",
    ]);
  });

  it("falls back to a pool tuple when rows carry no id", () => {
    const row = { protocol_slug: "navi", namespace: "sui", chain_id: 0 };
    const parts = [successPart("a", [row]), successPart("b", [{ ...row }])];
    const { outputs } = consolidateToolParts(parts);
    expect(opportunitiesOf(outputs.get("a"))).toHaveLength(1);
  });

  it("hides a pending sibling once a card is already on screen", () => {
    const parts = [successPart("a", [{ id: "1" }]), pendingPart("b")];
    const { suppressed, outputs } = consolidateToolParts(parts);
    expect([...suppressed]).toEqual(["b"]);
    // Nothing to merge yet — the survivor keeps its own output.
    expect(outputs.size).toBe(0);
  });

  it("shows ONE skeleton while parallel calls are still in flight", () => {
    // No collapse-flicker: the turn renders a single card from the first
    // frame, which later becomes the merged result.
    const parts = [pendingPart("a"), pendingPart("b"), pendingPart("c")];
    const { suppressed } = consolidateToolParts(parts);
    expect([...suppressed]).toEqual(["b", "c"]);
  });

  it("hands the slot to a retry when the first attempt failed", () => {
    const parts = [failedPart("a"), pendingPart("b")];
    const { suppressed } = consolidateToolParts(parts);
    expect([...suppressed]).toEqual(["a"]);
  });

  it("suppresses a failure superseded by a success", () => {
    const parts = [failedPart("a"), successPart("b", [{ id: "1" }])];
    const { suppressed } = consolidateToolParts(parts);
    expect([...suppressed]).toEqual(["a"]);
  });

  it("keeps the last failure when every sibling failed", () => {
    const parts = [failedPart("a"), failedPart("b")];
    const { suppressed } = consolidateToolParts(parts);
    expect([...suppressed]).toEqual(["a"]);
  });

  it("scopes consolidation per tool name", () => {
    const parts = [
      successPart("a", [{ id: "1" }]),
      successPart("b", [{ id: "2" }], "defi_list_positions"),
    ];
    const { suppressed, outputs } = consolidateToolParts(parts);
    expect(suppressed.size).toBe(0);
    expect(outputs.size).toBe(0);
  });

  it("never merges rows for a tool outside the merge registry", () => {
    // A paged catalog: page 2 is not "more of page 1", so the two cards
    // stay independent and no union is computed.
    const parts = [
      successPart("a", [{ id: "1" }], "get_redemption_catalog", { page: 1 }),
      successPart("b", [{ id: "2" }], "get_redemption_catalog", { page: 2 }),
    ];
    const { suppressed, outputs } = consolidateToolParts(parts);
    expect(suppressed.size).toBe(0);
    expect(outputs.size).toBe(0);
  });
});

describe("consolidateToolParts — identical repeat calls", () => {
  it("collapses an exact repeat of any read tool", () => {
    const parts = [
      successPart("a", [{ id: "1" }], "get_redemption_catalog", { page: 1 }),
      successPart("b", [{ id: "1" }], "get_redemption_catalog", { page: 1 }),
    ];
    const { suppressed, outputs } = consolidateToolParts(parts);
    expect([...suppressed]).toEqual(["b"]);
    // Identical inputs mean identical rows; nothing to union.
    expect(outputs.size).toBe(0);
  });

  it("treats key order as irrelevant when comparing inputs", () => {
    const parts = [
      successPart("a", [], "get_wallet_assets", { symbol: "USDC", chain: 1 }),
      successPart("b", [], "get_wallet_assets", { chain: 1, symbol: "USDC" }),
    ];
    const { suppressed } = consolidateToolParts(parts);
    expect([...suppressed]).toEqual(["b"]);
  });

  it("keeps calls whose inputs genuinely differ", () => {
    const parts = [
      successPart("a", [], "get_product_details", { id: "p1" }),
      successPart("b", [], "get_product_details", { id: "p2" }),
    ];
    const { suppressed } = consolidateToolParts(parts);
    expect(suppressed.size).toBe(0);
  });

  it("NEVER collapses a repeated write, even with identical input", () => {
    // Two identical transfers can be two real transfers; hiding the
    // second receipt would hide money moving.
    const parts = [
      successPart("a", [], "send_token", { to: "0xabc", amount: "5" }),
      successPart("b", [], "send_token", { to: "0xabc", amount: "5" }),
    ];
    const { suppressed } = consolidateToolParts(parts);
    expect(suppressed.size).toBe(0);
  });

  it("leaves unknown tool names alone", () => {
    const parts = [
      successPart("a", [], "some_future_tool", { x: 1 }),
      successPart("b", [], "some_future_tool", { x: 1 }),
    ];
    const { suppressed } = consolidateToolParts(parts);
    expect(suppressed.size).toBe(0);
  });

  it("merges positions rows under their own list key", () => {
    const mk = (id: string, rows: Row[]): AgentMessagePart => ({
      type: "tool",
      toolName: "defi_list_positions",
      toolCallId: id,
      input: {},
      state: "output-available",
      output: {
        status: "success",
        data: { positions: rows, count: rows.length },
      },
    });
    const { outputs } = consolidateToolParts([
      mk("a", [{ id: "p1" }]),
      mk("b", [{ id: "p2" }]),
    ]);
    const merged = outputs.get("a") as {
      data: { positions: Row[]; count: number };
    };
    expect(merged.data.positions.map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(merged.data.count).toBe(2);
  });
});
