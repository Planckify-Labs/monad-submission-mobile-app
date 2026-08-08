import { describe, expect, it } from "vitest";
import { approvalSummaryFromToolInput } from "./approvalSummary";

const BASE = "eip155:8453";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_BASE = `${BASE}/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`;
const DEST = "9YTiQ3afuodm26rhUqzaUsnk2ryyEhXdJ3gXX2beELij";

const bridgeInput = {
  from_chain: BASE,
  to_chain: SOLANA,
  from_asset: USDC_BASE,
  amount_raw: "5000000",
  to_address: DEST,
};

describe("approvalSummaryFromToolInput — bridge", () => {
  /**
   * The destination is what the known-destination envelope asks the user
   * to confirm. An approval that hides it would record a confirmation for
   * an address the user never saw, which is worse than having no envelope.
   */
  it("always shows the destination address", () => {
    const summary = approvalSummaryFromToolInput(bridgeInput, undefined);
    expect(summary).toContain("9YTiQ3");
    expect(summary).toContain("arriving at");
  });

  it("names both chains, not just the asset", () => {
    const summary = approvalSummaryFromToolInput(bridgeInput, undefined);
    expect(summary).toContain("Base");
    expect(summary).toContain("Solana");
  });

  // "5000000" and "5" are the same argument rendered with and without
  // decimals. Printing the raw one on the screen the user approves
  // against is the bug this guards.
  it("formats the amount when decimals are known", () => {
    const summary = approvalSummaryFromToolInput(
      bridgeInput,
      undefined,
      undefined,
      { symbol: "USDC", decimals: 6 },
    );
    expect(summary).toContain("5 USDC");
    expect(summary).not.toContain("5000000");
  });

  it("omits the amount entirely when decimals are unknown", () => {
    const summary = approvalSummaryFromToolInput(bridgeInput, undefined);
    expect(summary).not.toContain("5000000");
  });

  it("keeps fractional amounts exact", () => {
    const summary = approvalSummaryFromToolInput(
      { ...bridgeInput, amount_raw: "1234567" },
      undefined,
      undefined,
      { symbol: "USDC", decimals: 6 },
    );
    expect(summary).toContain("1.234567 USDC");
  });

  // Model prose must never be the approval text for a value transfer.
  it("ignores the server human_summary for a bridge", () => {
    const summary = approvalSummaryFromToolInput(
      bridgeInput,
      "Totally safe, just a test transfer",
    );
    expect(summary).not.toContain("Totally safe");
  });

  it("still describes the route when the destination is absent", () => {
    const { to_address: _omit, ...noDest } = bridgeInput;
    const summary = approvalSummaryFromToolInput(noDest, undefined);
    expect(summary).toContain("Base");
    expect(summary).toContain("Solana");
    expect(summary).not.toContain("arriving at");
  });
});

describe("approvalSummaryFromToolInput — non-bridge writes", () => {
  it("renders a send with its recipient", () => {
    const summary = approvalSummaryFromToolInput(
      { to: "0x1234567890abcdef1234567890abcdef12345678", amount: "1.5" },
      undefined,
    );
    expect(summary).toContain("Send");
    expect(summary).toContain("1.5");
    expect(summary).toContain("0x1234");
  });

  it("labels an allowance as Approve and names the spender", () => {
    const summary = approvalSummaryFromToolInput(
      { spender: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" },
      undefined,
    );
    expect(summary).toContain("Approve");
    expect(summary).toContain("0xabcd");
  });

  it("falls back to the server summary only when there are no facts", () => {
    expect(
      approvalSummaryFromToolInput({ plan_id: "p1" }, "Run the saved plan"),
    ).toBe("Run the saved plan");
  });
});
