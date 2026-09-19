import type {
  TDeliveryType,
  TFulfilment,
  TFulfilmentStatus,
} from "./fulfilment";

export type TRedeemExecuteRequest = {
  productVariantId: string;
  productPriceId: string;
  customerInfo:
    | { [key: string]: string }
    | Array<{ key: string; value: string }>;
};

export type TRedeemExecuteResponse = {
  id: string;
  status: "PENDING";
  pointsSpent: string;
  message: string;
};

export type TRedemptionStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "REFUNDED";

export type TRedemptionStatusResponse = {
  id: string;
  status: TRedemptionStatus;
  fulfilmentStatus?: TFulfilmentStatus;
  expectedBy?: string | null;
  pointsSpent: string;
  vendorRefId: string | null;
  createdAt: string;
};

export type TRedemptionProduct = {
  id: string;
  name: string;
  imageUrl: string | null;
  isVoucher: boolean;
  deliveryType?: TDeliveryType;
  variant: {
    id: string;
    name: string;
  };
  price: {
    amount: number;
    currency: string;
  };
};

export type TCustomerInfoEntry = { key: string; value: string };
export type TCustomerInfo =
  | Record<string, string>
  | TCustomerInfoEntry[]
  | null;

export type TRedemptionHistoryItem = {
  id: string;
  status: TRedemptionStatus;
  pointsSpent: string;
  vendorRefId: string | null;
  customerInfo: TCustomerInfo;
  product: TRedemptionProduct;
  createdAt: string;
  updatedAt: string;
};

export type TRedemptionDetail = TRedemptionHistoryItem & {
  /** Legacy — prefer `fulfilment.delivery`. */
  voucherCode: string | null;
  /** Absent on API versions that predate the fulfilment leg. */
  fulfilment?: TFulfilment;
};

export type TRedemptionHistoryResponse = {
  data: TRedemptionHistoryItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type TRedemptionHistoryParams = {
  limit?: number;
  cursor?: string;
  status?: TRedemptionStatus;
};
