import type {
  TDeliveryType,
  TFulfilment,
  TFulfilmentStatus,
} from "@/api/types/fulfilment";
import type { TCustomerInfo } from "@/api/types/redeem";

export type TFulfilmentTone = "pending" | "warn" | "ok" | "bad";

export type TFulfilmentStep = {
  key: "paid" | "processing" | "done";
  label: string;
  detail?: string;
  state: "done" | "active" | "todo" | "failed";
};

export type TFulfilmentSummary = {
  /** One line for the header / list row. */
  title: string;
  /** What the buyer should expect next, if anything. */
  detail?: string;
  tone: TFulfilmentTone;
  steps: TFulfilmentStep[];
};

const POINTS = new Intl.NumberFormat("en-US");

function formatClock(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

export function formatPoints(points: string | number | bigint): string {
  return `${POINTS.format(typeof points === "string" ? Number(points) : points)} points`;
}

/**
 * "Delivered as …" — set expectations before paying and label the card
 * after. `target` is the number / id / email typed at checkout.
 */
export function deliveryTypeLabel(
  deliveryType: TDeliveryType | undefined,
  target?: string,
): string {
  switch (deliveryType) {
    case "DIRECT_TOPUP":
      return target
        ? `Sent directly to ${target}`
        : "Sent directly to your account";
    case "BILL_PAYMENT":
      return "Bill paid on your behalf — receipt in the app";
    case "EMAIL":
      return target
        ? `Emailed by the provider to ${target}`
        : "Emailed by the provider to the address you enter";
    case "VOUCHER_CODE":
    default:
      return "Voucher code, shown here in the app";
  }
}

/** Mirrors the server's target extraction, for the checkout preview. */
export function customerInfoTarget(
  customerInfo: TCustomerInfo | undefined,
  deliveryType?: TDeliveryType,
): string | undefined {
  if (!customerInfo) return undefined;
  const entries = Array.isArray(customerInfo)
    ? customerInfo
    : Object.entries(customerInfo).map(([key, value]) => ({ key, value }));
  const preferred =
    deliveryType === "EMAIL"
      ? /email|mail/i
      : /phone|hp|msisdn|nomor|number|user|id|meter|account|customer/i;
  const hit =
    entries.find((e) => preferred.test(e.key) && String(e.value).trim()) ??
    entries.find((e) => String(e.value).trim());
  return hit ? String(hit.value) : undefined;
}

/**
 * Human status for the money leg alone — used when the API predates the
 * fulfilment block, and for the transaction row.
 */
export function moneyStatusLabel(status: string): string {
  switch (status) {
    case "COMPLETED":
    case "CONFIRMED":
      return "Completed";
    case "PENDING":
    case "PROCESSING":
      return "Processing";
    case "FAILED":
      return "Failed";
    case "REFUNDED":
      return "Refunded";
    default:
      return status;
  }
}

export const fulfilmentStatusLabel = (status: TFulfilmentStatus): string => {
  switch (status) {
    case "QUEUED":
      return "Sending to provider";
    case "SUBMITTED":
      return "Preparing your order";
    case "DELAYED":
      return "Taking longer than usual";
    case "DELIVERED":
      return "Delivered";
    case "FAILED":
      return "Couldn't be delivered";
    case "NEEDS_RECONCILE":
      return "Being checked";
    case "REFUNDED":
      return "Refunded";
  }
};

/**
 * The whole story of an order in buyer language: a headline, what to
 * expect, and the three-step timeline. Pure so it can be unit-tested.
 */
export function summariseFulfilment(input: {
  fulfilment?: TFulfilment | null;
  moneyStatus: string;
  kind: "purchase" | "redemption";
}): TFulfilmentSummary {
  const { fulfilment, moneyStatus, kind } = input;
  const paidLabel = kind === "purchase" ? "Paid" : "Points spent";
  const deliveredLabel =
    fulfilment?.deliveryType === "BILL_PAYMENT" ? "Bill paid" : "Delivered";

  // Older API: only the money leg exists. Don't claim a delivery it can't see.
  if (!fulfilment) {
    const label = moneyStatusLabel(moneyStatus);
    const ok = moneyStatus === "COMPLETED";
    const bad = moneyStatus === "FAILED";
    return {
      title: label,
      tone: ok ? "ok" : bad ? "bad" : "pending",
      steps: [
        { key: "paid", label: paidLabel, state: ok || bad ? "done" : "active" },
        {
          key: "processing",
          label: "Processing",
          state: ok ? "done" : bad ? "failed" : "todo",
        },
        { key: "done", label: deliveredLabel, state: ok ? "done" : "todo" },
      ],
    };
  }

  const { status, expectedBy, fulfilledAt, refund, error } = fulfilment;
  const paidDone = status !== "QUEUED" || moneyStatus === "COMPLETED";
  const paymentFailed = status === "QUEUED" && moneyStatus === "FAILED";

  const steps = (
    processing: TFulfilmentStep["state"],
    done: TFulfilmentStep["state"],
    processingDetail?: string,
    doneLabel = deliveredLabel,
    doneDetail?: string,
  ): TFulfilmentStep[] => [
    {
      key: "paid",
      label: paidLabel,
      state: paymentFailed ? "failed" : paidDone ? "done" : "active",
      detail: paymentFailed ? "We couldn't verify the payment" : undefined,
    },
    {
      key: "processing",
      label: "Preparing",
      state: processing,
      detail: processingDetail,
    },
    { key: "done", label: doneLabel, state: done, detail: doneDetail },
  ];

  switch (status) {
    case "QUEUED":
      if (paymentFailed) {
        return {
          title: "Payment couldn't be verified",
          detail: "You don't need to do anything — we'll update you.",
          tone: "bad",
          steps: steps("todo", "todo"),
        };
      }
      return {
        title:
          moneyStatus === "COMPLETED"
            ? "Sending to provider"
            : "Confirming your payment",
        detail: "This usually takes under a minute.",
        tone: "pending",
        steps: steps(moneyStatus === "COMPLETED" ? "active" : "todo", "todo"),
      };
    case "SUBMITTED": {
      const eta = expectedBy
        ? `Usually ready by ${formatClock(expectedBy)}`
        : "Usually ready within a few minutes";
      return {
        title: "Preparing your order",
        detail: "We'll notify you the moment it's ready.",
        tone: "pending",
        steps: steps("active", "todo", eta),
      };
    }
    case "DELAYED":
      return {
        title: "Taking longer than usual",
        detail:
          "The provider is still processing it. We're on it and will update you.",
        tone: "warn",
        steps: steps(
          "active",
          "todo",
          "Longer than expected — still processing",
        ),
      };
    case "NEEDS_RECONCILE":
      return {
        title: "We're checking this order",
        detail:
          "It needs a manual check. Your money is safe — we'll update you within 24 hours.",
        tone: "warn",
        steps: steps("active", "todo", "Being checked by our team"),
      };
    case "DELIVERED":
      return {
        title: deliveredLabel,
        tone: "ok",
        steps: steps(
          "done",
          "done",
          undefined,
          deliveredLabel,
          fulfilledAt ? formatClock(fulfilledAt) : undefined,
        ),
      };
    case "FAILED": {
      const refundLine =
        refund?.status === "PENDING_REVIEW"
          ? "Your refund is being reviewed — usually within 24 hours."
          : refund?.status === "REJECTED"
            ? "Please contact support about this order."
            : "Your refund is being arranged.";
      return {
        title: "Couldn't be delivered",
        detail: error ? `${error} ${refundLine}` : refundLine,
        tone: "bad",
        steps: steps(
          "failed",
          "todo",
          error ?? undefined,
          "Refund",
          refundLine,
        ),
      };
    }
    case "REFUNDED": {
      if (refund?.status === "REVERSED") {
        return {
          title: "Delivered after refund",
          detail: `It arrived after we refunded you, so ${formatPoints(refund.points)} were deducted again.`,
          tone: "ok",
          steps: steps("done", "done"),
        };
      }
      const pts = refund ? formatPoints(refund.points) : "your points";
      return {
        title: "Refunded",
        detail: `We couldn't deliver this order. ${pts} are back in your balance — you can retry with points.`,
        tone: "bad",
        steps: steps(
          "failed",
          "done",
          error ?? undefined,
          "Refunded",
          `${pts} returned`,
        ),
      };
    }
  }
}
