import { describe, expect, it } from "vitest";
import type { TFulfilment } from "@/api/types/fulfilment";
import {
  customerInfoTarget,
  deliveryTypeLabel,
  summariseFulfilment,
} from "./fulfilmentUtils";

const base: TFulfilment = {
  status: "SUBMITTED",
  deliveryType: "VOUCHER_CODE",
  expectedBy: null,
  fulfilledAt: null,
  lastCheckedAt: null,
  error: null,
  delivery: null,
  refund: null,
};

describe("summariseFulfilment", () => {
  it("without a fulfilment block it never claims a delivery", () => {
    const s = summariseFulfilment({
      fulfilment: undefined,
      moneyStatus: "COMPLETED",
      kind: "purchase",
    });
    expect(s.title).toBe("Completed");
    expect(s.steps.map((x) => x.state)).toEqual(["done", "done", "done"]);
  });

  it("paid but not delivered is 'preparing', with the ETA on the middle step", () => {
    const s = summariseFulfilment({
      fulfilment: { ...base, expectedBy: "2026-09-19T10:30:00Z" },
      moneyStatus: "COMPLETED",
      kind: "redemption",
    });
    expect(s.title).toBe("Preparing your order");
    expect(s.tone).toBe("pending");
    expect(s.steps[0]).toMatchObject({ label: "Points spent", state: "done" });
    expect(s.steps[1].state).toBe("active");
    expect(s.steps[1].detail).toMatch(/Usually ready by/);
    expect(s.steps[2].state).toBe("todo");
  });

  it("delayed and reconcile are warnings, never failures", () => {
    for (const status of ["DELAYED", "NEEDS_RECONCILE"] as const) {
      const s = summariseFulfilment({
        fulfilment: { ...base, status },
        moneyStatus: "COMPLETED",
        kind: "purchase",
      });
      expect(s.tone).toBe("warn");
      expect(s.steps[1].state).toBe("active");
    }
  });

  it("delivered completes every step", () => {
    const s = summariseFulfilment({
      fulfilment: {
        ...base,
        status: "DELIVERED",
        fulfilledAt: "2026-09-19T10:31:00Z",
      },
      moneyStatus: "COMPLETED",
      kind: "purchase",
    });
    expect(s.title).toBe("Delivered");
    expect(s.steps.every((x) => x.state === "done")).toBe(true);
  });

  it("a bill payment says 'Bill paid' instead of 'Delivered'", () => {
    const s = summariseFulfilment({
      fulfilment: {
        ...base,
        status: "DELIVERED",
        deliveryType: "BILL_PAYMENT",
      },
      moneyStatus: "COMPLETED",
      kind: "purchase",
    });
    expect(s.title).toBe("Bill paid");
  });

  it("refunded names the points and offers the retry", () => {
    const s = summariseFulfilment({
      fulfilment: {
        ...base,
        status: "REFUNDED",
        refund: { status: "COMPLETED", points: "150000" },
      },
      moneyStatus: "REFUNDED",
      kind: "purchase",
    });
    expect(s.title).toBe("Refunded");
    expect(s.detail).toContain("150,000 points are back in your balance");
    expect(s.steps[1].state).toBe("failed");
    expect(s.steps[2]).toMatchObject({ label: "Refunded", state: "done" });
  });

  it("failed with a held refund tells them it's in review", () => {
    const s = summariseFulfilment({
      fulfilment: {
        ...base,
        status: "FAILED",
        error: "Invalid user id",
        refund: { status: "PENDING_REVIEW", points: "5000000" },
      },
      moneyStatus: "FAILED",
      kind: "redemption",
    });
    expect(s.title).toBe("Couldn't be delivered");
    expect(s.detail).toContain("Invalid user id");
    expect(s.detail).toContain("being reviewed");
  });

  it("a payment that could not be verified fails the first step only", () => {
    const s = summariseFulfilment({
      fulfilment: { ...base, status: "QUEUED" },
      moneyStatus: "FAILED",
      kind: "purchase",
    });
    expect(s.title).toBe("Payment couldn't be verified");
    expect(s.steps[0].state).toBe("failed");
    expect(s.steps[1].state).toBe("todo");
  });

  it("delivered after refund with a reversal reads as delivered", () => {
    const s = summariseFulfilment({
      fulfilment: {
        ...base,
        status: "REFUNDED",
        refund: { status: "REVERSED", points: "150000" },
      },
      moneyStatus: "COMPLETED",
      kind: "purchase",
    });
    expect(s.title).toBe("Delivered after refund");
    expect(s.tone).toBe("ok");
  });
});

describe("deliveryTypeLabel / customerInfoTarget", () => {
  it("names the target for top-ups and emails", () => {
    expect(deliveryTypeLabel("DIRECT_TOPUP", "0812…")).toBe(
      "Sent directly to 0812…",
    );
    expect(deliveryTypeLabel("EMAIL", "a@b.c")).toMatch(
      /Emailed by the provider to a@b.c/,
    );
    expect(deliveryTypeLabel("VOUCHER_CODE")).toMatch(/shown here in the app/);
    expect(deliveryTypeLabel(undefined)).toMatch(/Voucher code/);
  });

  it("picks the email key for EMAIL and the id-ish key otherwise", () => {
    const info = [
      { key: "email", value: "a@b.c" },
      { key: "userId", value: "12345" },
    ];
    expect(customerInfoTarget(info, "EMAIL")).toBe("a@b.c");
    expect(customerInfoTarget(info, "DIRECT_TOPUP")).toBe("12345");
    expect(customerInfoTarget({ phone: "0812" })).toBe("0812");
    expect(customerInfoTarget(null)).toBeUndefined();
  });
});
