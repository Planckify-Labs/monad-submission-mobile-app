import { Animated, LayoutChangeEvent } from "react-native";
import type { TDapp } from "@/api/types/dapp";
import { TWallet } from "@/constants/types/walletTypes";

export interface TDAppNavigationProps {
  onNavigateToDapp: (url: string) => void;
}

export interface BrowserState {
  canGoBack: boolean;
  canGoForward: boolean;
  /** Turns the navigation bar's reload button into a stop button. */
  loading: boolean;
}

export interface TBrowserAddressBarProps {
  /** The URL the WebView has actually committed to; "" on the hub. */
  pageUrl: string;
  /**
   * What the user is typing. Only rendered while editing, so page
   * navigation events can never overwrite an in-progress edit.
   */
  draft: string;
  onChangeDraft: (text: string) => void;
  isEditing: boolean;
  onStartEditing: () => void;
  /** Leaves edit mode without navigating. */
  onCancelEditing: () => void;
  onSubmit: () => void;
  isWalletConnected?: boolean;
  /** Opens the wallet connection manager sheet. */
  onPressWallet?: () => void;
}

export interface TBrowserNavigationControlsProps {
  browserState: BrowserState;
  onGoBack: () => void;
  onGoForward: () => void;
  onSearch: () => void;
  onRefresh: () => void;
  /** Same button as refresh, while a load is in flight. */
  onStop: () => void;
  onHome: () => void;
}

export interface TDAppCardProps {
  dapp: TDapp;
  isCompact?: boolean;
  onPress: (url: string) => void;
}

export interface TCategoryDAppsListProps extends TDAppNavigationProps {
  horizontalScrollX?: Animated.Value;
}

export interface TFloatingDAppsCategoryTabProps {
  onLayout: (event: LayoutChangeEvent) => void;
  tabWidth: number;
  horizontalScrollX: Animated.Value;
}

export interface TErrorMessageProps {
  onRetry: () => void;
  message?: string;
}

export interface TTransactionRequest {
  to?: string;
  value?: string;
  data?: string;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

export interface TTransactionModalProps {
  visible: boolean;
  onClose: () => void;
  onApprove: () => Promise<void>;
  onReject: () => void;
  transaction: TTransactionRequest;
  wallet: TWallet;
  dappUrl: string;
}

export interface TEcosystemHubProps extends TDAppNavigationProps {
  activeCategory: TCategoryTab;
  onCategoryChange?: (category: TCategoryTab) => void;
  horizontalScrollX?: Animated.Value;
}

export interface TSkeletonProps {
  width?: number | string;
  height?: number;
  borderRadius?: number;
}

export interface TDimensionConstants {
  SCREEN_WIDTH: number;
  PROMO_CARD_WIDTH: number;
  POPULAR_CARD_WIDTH: number;
}

export type TCategoryTab = string;

export interface TEcosystemHubProps {
  onNavigateToDapp: (url: string) => void;
  activeCategory: TCategoryTab;
  onCategoryChange?: (category: TCategoryTab) => void;
  horizontalScrollX?: Animated.Value;
}

export interface TTransactionRequest {
  to?: string;
  value?: string;
  data?: string;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

export interface TTransactionModalProps {
  visible: boolean;
  onClose: () => void;
  onApprove: () => Promise<void>;
  onReject: () => void;
  transaction: TTransactionRequest;
  wallet: TWallet;
  dappUrl: string;
}
