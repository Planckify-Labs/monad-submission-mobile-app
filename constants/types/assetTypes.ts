import type { TWallet } from "./walletTypes";

export type TCryptoAsset = {
  id: string;
  symbol: string;
  name: string;
  logo: string;
  balance: string;
  value: string;
  change: string;
  address?: string;
  isCustom?: boolean;
  contractAddress?: string;
  decimals?: number;
  networkSpecific?: boolean;
  supportedNetworks?: string[];
  /**
   * `true` when this asset has a receiver-side opt-in precondition
   * (Stellar trustlines) that hasn't been satisfied yet. Populated via
   * `WalletKitAdapter.hasTrustline` (optional capability, presence-checked
   * — `undefined`/`false` on every other namespace) in
   * `useUserAssetsWithBalances`. Drives the "Trust" button on the asset
   * card in `UserAssetItem`.
   */
  needsTrust?: boolean;
};

export type TExtendedCryptoAsset = TCryptoAsset & {
  contractAddress?: string;
};

export type TAssetTabType = "my-assets" | "explore-assets" | "collectibles";

// ============================================
// AssetItem DTOs
// ============================================
export type TAssetItemState = {
  isAdded: boolean;
  isSelected: boolean;
  selectionMode: boolean;
};

export type TAssetItemActions = {
  onPress: () => void;
  onLongPress?: () => void;
  onAddPress?: () => void;
};

export type TAssetItemProps = {
  item: TCryptoAsset;
  state: TAssetItemState;
  actions: TAssetItemActions;
};

// ============================================
// AssetExplorerHeader DTOs
// ============================================
export type TSelectionState = {
  selectionMode: boolean;
  selectedAssetsCount: number;
};

export type TAssetExplorerHeaderProps = {
  selection: TSelectionState;
  onCancel: () => void;
  onAdd: () => void;
};

// ============================================
// AddTokenForm DTOs
// ============================================
export type TAddTokenFormState = {
  tokenAddress: string;
  isLoading: boolean;
};

export type TAddTokenFormProps = {
  state: TAddTokenFormState;
  onAddressChange: (value: string) => void;
  onSubmit: () => void;
};

// ============================================
// AssetWalletSelectorModal DTOs
// ============================================
export type TWalletSelectorData = {
  asset: TCryptoAsset | null;
  assets?: TCryptoAsset[];
  wallets: TWallet[];
  activeNetwork: string;
};

export type TAssetWalletSelectorModalProps = {
  visible: boolean;
  data: TWalletSelectorData;
  onClose: () => void;
  onConfirm: (
    walletIndices: number[],
    asset: TCryptoAsset | null,
    assets?: TCryptoAsset[],
  ) => void;
};

export type TAssetCategoryTabsProps = {
  activeTab: TAssetTabType;
  setActiveTab: (tab: TAssetTabType) => void;
  selectionMode: boolean;
};
