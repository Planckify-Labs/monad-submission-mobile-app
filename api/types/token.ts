export interface TToken {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  blockchainId: string;
  contractAddress: string | null;
  logoUrl: string | null;
  isStablecoin: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  isNativeCurrency: boolean;
  peggedCurrency?: string | null;
  isPaymentEnabled?: boolean;
}

export type TokenListResponse = TToken[];

export interface TTokenSearchParams {
  symbol?: string;
  name?: string;
  blockchainId?: string;
  contractAddress?: string;
  isStablecoin?: boolean;
  isActive?: boolean;
  take?: number;
  cursor?: string;
  isNativeCurrency?: boolean;
  isPaymentEnabled?: boolean;
}

/**
 * Token identity resolved by contract address, for surfaces holding an
 * address the catalogue does not list (the dApp approval sheet can be handed
 * any ERC-20 on any supported chain).
 *
 * `decimals` is the token's scale, range-checked server-side. It is what
 * lets the approval sheet render "6 USDT" and accept "6" as typed input
 * instead of falling back to raw base units.
 */
export interface TTokenIdentity {
  symbol: string | null;
  logo: string | null;
  decimals: number | null;
}
