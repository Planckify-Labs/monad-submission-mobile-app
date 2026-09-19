import type { TDeliveryType } from "./fulfilment";

export type TProductCategory = {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TVendor = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type TProductPrice = {
  id: string;
  productVariantId: string;
  vendorId: string;
  realValue: string;
  priceFromVendor: string;
  sellPrice: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  vendor: TVendor;
};

export type TProductVariant = {
  id: string;
  name: string;
  description: string;
  variantCode: string;
  isVoucher: boolean;
  productId: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  product: TProduct;
  ProductPrice: TProductPrice[];
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
  /** How the provider hands it over; resolved server-side. Absent on older APIs. */
  deliveryType?: TDeliveryType;
  createdAt: string;
  updatedAt: string;
  inputType: string | null;
  inputDescription: string | null;
};

export type TProductWithCategory = {
  category: TProductCategory;
  products: TProduct[];
};

export type TProductDetail = TProduct & {
  category: TProductCategory;
  variants: TProductVariant[];
};

export type TProductInputField = {
  key: string;
  type: string;
  alias: string;
  options?: string[];
};

export type TProductInputFields = {
  productId: string;
  productName: string;
  forms: TProductInputField[];
};

export type TPaymentFeatured = Record<string, { id: string }>;

export type TRecommendation = {
  id: string;
  name: string;
  imageUrl: string | null;
  code: string;
  categoryId: string;
  isVoucher: boolean;
  category: {
    id: string;
    name: string;
  };
  startingPrice: {
    amount: string;
    currency: string;
  } | null;
};
