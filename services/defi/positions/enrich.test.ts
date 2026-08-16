/**
 * `enrichPositionLive` — the shared live-value pipeline that wires the
 * previously-dead `computePnl` (services/defi/positions/pnl.ts) into both
 * the chat executor (`defi_list_positions`) and the native Strategies tab.
 * Before this, `current_amount_usd`/PnL were permanently null/0 for every
 * position on every protocol — `StrategyPosition.currentAmountUsd` was
 * never written server-side and `computePnl` was never called anywhere.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readPosition: vi.fn(),
  getAssetPrices: vi.fn(),
}));

vi.mock("@/services/defi/positions/reader", () => ({
  readPosition: h.readPosition,
}));
vi.mock("@/api/endpoints/strategies", () => ({
  strategiesApi: { getAssetPrices: h.getAssetPrices },
}));

import { enrichPositionLive } from "./enrich";

const BASE_POSITION = {
  protocolSlug: "compound-v3",
  chainId: 8453,
  poolId: null,
  assetSymbol: "USDT",
  assetContract: "0xusdt",
  amountAtDeposit: "10000000", // 10 USDT @ 6 decimals
  amountAtDepositUsd: 10,
  status: "active",
};

beforeEach(() => {
  h.readPosition.mockReset();
  h.getAssetPrices.mockReset();
});

describe("enrichPositionLive", () => {
  it("returns null fields (never a live read) for a closed position", async () => {
    const result = await enrichPositionLive(
      { ...BASE_POSITION, status: "closed" },
      "0xwallet",
      undefined,
    );
    expect(result).toEqual({
      currentAmountRaw: null,
      currentAmountUsd: null,
      pnlUsd: null,
      pnlPct: null,
    });
    expect(h.readPosition).not.toHaveBeenCalled();
  });

  it("computes a real USD value and PnL from the on-chain read + spot price", async () => {
    // 10.5 USDT accrued from a 10 USDT deposit.
    h.readPosition.mockResolvedValue({ currentAmount: 10_500_000n });
    h.getAssetPrices.mockResolvedValue([{ usd: 1 }]);

    const result = await enrichPositionLive(
      BASE_POSITION,
      "0xwallet",
      undefined,
    );

    expect(result.currentAmountRaw).toBe("10500000");
    expect(result.currentAmountUsd).toBeCloseTo(10.5, 5);
    expect(result.pnlUsd).toBeCloseTo(0.5, 5);
    expect(result.pnlPct).toBeCloseTo(5, 5);
  });

  it("reports the live raw balance without a $ figure when no price is available", async () => {
    h.readPosition.mockResolvedValue({ currentAmount: 10_500_000n });
    h.getAssetPrices.mockResolvedValue([{ usd: null }]);

    const result = await enrichPositionLive(
      BASE_POSITION,
      "0xwallet",
      undefined,
    );

    expect(result.currentAmountRaw).toBe("10500000");
    expect(result.currentAmountUsd).toBeNull();
    expect(result.pnlUsd).toBeNull();
    expect(result.pnlPct).toBeNull();
  });

  it("degrades to null fields when the on-chain adapter can't resolve", async () => {
    h.readPosition.mockResolvedValue(null);

    const result = await enrichPositionLive(
      BASE_POSITION,
      "0xwallet",
      undefined,
    );

    expect(result).toEqual({
      currentAmountRaw: null,
      currentAmountUsd: null,
      pnlUsd: null,
      pnlPct: null,
    });
    expect(h.getAssetPrices).not.toHaveBeenCalled();
  });

  it("degrades to null fields (never throws) when the on-chain read rejects", async () => {
    h.readPosition.mockRejectedValue(new Error("rpc down"));

    const result = await enrichPositionLive(
      BASE_POSITION,
      "0xwallet",
      undefined,
    );

    expect(result).toEqual({
      currentAmountRaw: null,
      currentAmountUsd: null,
      pnlUsd: null,
      pnlPct: null,
    });
  });

  it("still reports the raw balance when the price lookup itself rejects", async () => {
    h.readPosition.mockResolvedValue({ currentAmount: 10_500_000n });
    h.getAssetPrices.mockRejectedValue(new Error("price service down"));

    const result = await enrichPositionLive(
      BASE_POSITION,
      "0xwallet",
      undefined,
    );

    expect(result.currentAmountRaw).toBe("10500000");
    expect(result.currentAmountUsd).toBeNull();
  });
});
