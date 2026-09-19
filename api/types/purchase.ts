import type { TDeliveryType, TFulfilment } from "./fulfilment";

export type TPurchaseCreateRequest = {
  refId: string;
  walletAddress: string;
  bookingId: string;
  contractAddress: string;
  networkId: string;
  transactionHash: string;
};

export type TVendorResponse = {
  code: number;
  data: {
    trx_code: string;
    selling_total: number;
    transaction_status: "PENDING" | "SUCCESS" | "FAILED";
  };
  status: "SUCCESS" | "FAILED";
  rc_code: string;
};

export type TProduct = {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  code: string;
  categoryId: string;
  isActive: boolean;
  isVoucher?: boolean;
  /** Resolved server-side; absent on older API versions. */
  deliveryType?: TDeliveryType;
  createdAt: string;
  updatedAt: string;
};

export type TProductVariant = {
  id: string;
  name: string;
  description: string;
  variantCode: string;
  productId: string;
  isVoucher: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  subCategoryId: string | null;
  product: TProduct;
};

export type TBlockchain = {
  id: string;
  name: string;
  chainId: number | null;
  chainSlug: string | null;
  rpcUrl: string;
  blockExplorer: string;
  isEVM: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  isTestnet: boolean;
};

export type TToken = {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  blockchainId: string;
  contractAddress: string;
  logoUrl: string;
  isStablecoin: boolean;
  isActive: boolean;
  isNativeCurrency: boolean;
  createdAt: string;
  updatedAt: string;
  blockchain: TBlockchain;
};

export type TTransaction = {
  id: string;
  userId: string;
  tokenId: string;
  type: "PAYMENT" | "DEPOSIT" | "WITHDRAWAL";
  status: "PENDING" | "CONFIRMED" | "FAILED";
  amount: string;
  amountInFiat: string;
  fiatCurrency: string;
  txHash: string;
  senderAddress: string;
  recipientAddress: string;
  createdAt: string;
  updatedAt: string;
  token: TToken;
};

export type TBooking = {
  id: string;
  createdAt: string;
  customerInfo: Array<{
    key: string;
    value: string;
  }>;
};

export type TPurchaseResponse = {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "REFUNDED";
  transactionId: string;
  transactionCreatedAt: string;
  productVariantId: string;
  refId: string;
  createdAt: string;
  updatedAt: string;
  transaction: TTransaction;
  productVariant: TProductVariant;
  /** Legacy — prefer `fulfilment.delivery`. */
  voucherCode?: string | null;
  /** Absent on API versions that predate the fulfilment leg. */
  fulfilment?: TFulfilment;
  booking: TBooking;
};
