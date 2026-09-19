/**
 * The fulfilment leg of an order — whether the provider actually handed
 * the product over — as returned by `GET /purchases/:id` and
 * `GET /redeem/:id` under `fulfilment`. Mirrors `FulfilmentView` on the
 * server (src/fulfilment/fulfilment-view.ts).
 */
export type TFulfilmentStatus =
  | "QUEUED"
  | "SUBMITTED"
  | "DELAYED"
  | "DELIVERED"
  | "FAILED"
  | "NEEDS_RECONCILE"
  | "REFUNDED";

export type TDeliveryType =
  | "VOUCHER_CODE"
  | "DIRECT_TOPUP"
  | "BILL_PAYMENT"
  | "EMAIL";

export type TDeliveryParseTier = "exact" | "template" | "heuristic" | "none";

export type TDeliveryField = {
  label: string;
  value: string;
  copyable?: boolean;
};

/**
 * One shape for every product. The server parses whatever the provider
 * sent into `primary` (the thing to redeem) + `fields`; `raw` is always
 * present and must be shown whenever `parse !== "exact"`.
 */
export type TDeliveryPayload = {
  kind: "voucher" | "topup" | "bill" | "email";
  primary?: TDeliveryField;
  fields: TDeliveryField[];
  raw: string | null;
  parse: TDeliveryParseTier;
  parserId: string | null;
  /** Where a top-up / bill / email went (the number or address typed at checkout). */
  target?: string;
};

export type TFulfilmentRefundStatus =
  | "PENDING_REVIEW"
  | "COMPLETED"
  | "REJECTED"
  | "REVERSED";

export type TFulfilment = {
  status: TFulfilmentStatus;
  deliveryType: TDeliveryType;
  expectedBy: string | null;
  fulfilledAt: string | null;
  lastCheckedAt: string | null;
  /** Buyer-safe reason on FAILED / NEEDS_RECONCILE. */
  error: string | null;
  delivery: TDeliveryPayload | null;
  refund: { status: TFulfilmentRefundStatus; points: string } | null;
};

/** Still moving — the detail screen should keep polling. */
export const isFulfilmentOpen = (status: TFulfilmentStatus | undefined) =>
  status === "QUEUED" ||
  status === "SUBMITTED" ||
  status === "DELAYED" ||
  status === "NEEDS_RECONCILE";
