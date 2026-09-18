import type { TTransactionStatus } from "@/api/types/transaction";

/**
 * How a merchant payment's status reads on the Activity list card and the
 * Activity detail: one map so the two never disagree. PENDING is live from
 * the moment the tx is broadcast until the server has verified it against
 * the chain, so it says what's happening rather than "Pending" (which
 * reads as if the user still owes an action); FAILED is only ever a chain
 * verdict, so nothing moved.
 */
export const PAYMENT_STATUS_CHIP: Record<
  TTransactionStatus,
  { label: string; color: string; bg: string }
> = {
  PENDING: {
    label: "Confirming",
    color: "#b45309",
    bg: "rgba(245, 158, 11, 0.1)",
  },
  PROCESSING: {
    label: "Processing",
    color: "#1d4ed8",
    bg: "rgba(59, 130, 246, 0.1)",
  },
  COMPLETED: {
    label: "Completed",
    color: "#047857",
    bg: "rgba(16, 185, 129, 0.1)",
  },
  FAILED: {
    label: "Didn't go through",
    color: "#dc2626",
    bg: "rgba(239, 68, 68, 0.1)",
  },
};
