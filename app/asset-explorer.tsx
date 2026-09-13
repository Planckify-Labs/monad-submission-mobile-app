import { useQueryClient } from "@tanstack/react-query";
import { Search, X } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import { SafeAreaView } from "react-native-safe-area-context";
import AddTokenForm from "@/components/asset-explorer/AddTokenForm";
import AssetExplorerHeader from "@/components/asset-explorer/AssetExplorerHeader";
import AssetWalletSelectorModal from "@/components/asset-explorer/AssetWalletSelectorModal";
import AvailableAssetList from "@/components/asset-explorer/AvailableAssetList";
import CollectiblesList from "@/components/asset-explorer/CollectiblesList";
import AssetExplorerTabs, {
  COLLECTIBLES_TAB_ENABLED,
} from "@/components/asset-explorer/MyAssetsAndExploreAssetTabs";
import NetworkRadioButtons from "@/components/asset-explorer/NetworkRadioButtons";
import NetworkSelectorModal from "@/components/asset-explorer/NetworkSelectorModal";
import UserAssetList from "@/components/asset-explorer/UserAssetList";
import WalletInfo from "@/components/asset-explorer/WalletInfo";
import TrustAssetConfirmModal from "@/components/wallet/TrustAssetConfirmModal";
import { SAMPLE_ASSETS } from "@/constants/dummyData/assets";
import type { TCryptoAsset } from "@/constants/types/assetTypes";
import { useBlockchains } from "@/hooks/queries/useBlockchains";
import { useDiscoveredAssets } from "@/hooks/queries/useDiscoveredAssets";
import { useNFTsQuery } from "@/hooks/queries/useNFTs";
import { useTokens } from "@/hooks/queries/useTokens";
import {
  useActiveNetwork,
  useActiveTab,
  useAssetSearchQuery,
} from "@/hooks/useAssetExplorerState";
import { useAssetSelection } from "@/hooks/useAssetSelection";
import { useUserAssetsWithBalances } from "@/hooks/useUserAssetsWithBalances";
import { useWallet } from "@/hooks/useWallet";
import { resolveNamespace } from "@/hooks/useWallet.helpers";
import { foldAddressForKey } from "@/services/chains/addressCompare";
import {
  adaptAssetForNetwork,
  filterAssets,
  getNetworkSpecificAssets,
} from "@/utils/assetUtils";
import { ALL_NETWORKS } from "@/utils/networkUtils";

export default function AssetExplorer() {
  const [_showAddToken, setShowAddToken] = useState(false);
  const [tokenAddress, setTokenAddress] = useState("");
  const [_isLoading, setIsLoading] = useState(false);
  const [availableAssets, setAvailableAssets] = useState<TCryptoAsset[]>([]);

  const { wallets, activeWalletIndex, activeChain } = useWallet();
  const activeWallet = wallets[activeWalletIndex];

  const { activeTab, setActiveTab } = useActiveTab();
  const { activeNetwork, activeBlockchainId } = useActiveNetwork();
  const { searchQuery } = useAssetSearchQuery();

  const { data: blockchains } = useBlockchains({ isActive: true });

  // Namespace of the network the user is currently browsing in this
  // screen. Falls back to the globally-active chain's namespace when the
  // per-screen selection hasn't synced yet (first render before
  // `NetworkRadioButtons` commits). Drives the wallet-selector filter so
  // adding a Solana asset only surfaces Solana wallets, and vice versa.
  const activeNamespace = useMemo(() => {
    const blockchain = blockchains?.find((b) => b.id === activeBlockchainId);
    if (blockchain) return resolveNamespace(blockchain);
    return activeChain.namespace;
  }, [blockchains, activeBlockchainId, activeChain.namespace]);

  const walletsForActiveNamespace = useMemo(
    () => wallets.filter((w) => w.namespace === activeNamespace),
    [wallets, activeNamespace],
  );

  // Chain selector for the portfolio read layer. EVM chains are addressed by
  // their numeric id; chains that have none (Solana) go by namespace.
  // `null` means "this chain has no discovery coverage", which is NOT the same
  // as `undefined`. An absent chain filter tells the server "every chain you
  // support", so returning undefined here would make a Sui or Stellar wallet
  // spend a request querying its address against every EVM chain, for a result
  // that can only be empty.
  const portfolioChains = useMemo(() => {
    const blockchain = blockchains?.find((b) => b.id === activeBlockchainId);
    if (typeof blockchain?.chainId === "number") return [blockchain.chainId];
    if (activeNamespace === "solana") return ["solana"];
    return null;
  }, [blockchains, activeBlockchainId, activeNamespace]);

  // Tokens this wallet actually holds, including ones missing from the
  // curated catalogue. Identity only: balances are still read on-chain, so
  // this only lengthens the list the balance readers already work through.
  const {
    assets: discoveredAssets,
    refreshFromSource: refreshDiscoveredAssets,
  } = useDiscoveredAssets({
    chains: portfolioChains ?? undefined,
    enabled: Boolean(activeWallet?.address) && portfolioChains !== null,
  });

  // Collectibles. Unlike token balances, NFT ownership cannot be read from
  // plain RPC, so this goes through the indexer registry.
  const evmChainId = useMemo(() => {
    const blockchain = blockchains?.find((b) => b.id === activeBlockchainId);
    return typeof blockchain?.chainId === "number" ? blockchain.chainId : 0;
  }, [blockchains, activeBlockchainId]);

  const {
    collections: nftCollections,
    isLoading: isLoadingNFTs,
    isError: isNFTsError,
    hasNextPage: hasMoreNFTs,
    isFetchingNextPage: isFetchingMoreNFTs,
    fetchNextPage: fetchMoreNFTs,
  } = useNFTsQuery(
    // Hidden behind COLLECTIBLES_TAB_ENABLED: pass no address while off so the
    // hook's own `enabled: !!address` guard keeps this from firing at all —
    // a hidden tab must not spend Zerion's NFT quota in the background.
    COLLECTIBLES_TAB_ENABLED && evmChainId > 0
      ? activeWallet?.address
      : undefined,
    evmChainId,
  );

  const {
    userAssets,
    addAsset,
    removeAsset,
    addCustomToken,
    addMultipleAssets,
    isAssetAdded,
    refetchBalances,
    requestTrust,
    pendingTrustAsset,
    confirmTrust,
    cancelTrust,
    establishingAssetId,
  } = useUserAssetsWithBalances();

  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  // Pull-to-refresh: drop server-backed caches that the asset explorer
  // reads (token catalogue + blockchain catalogue) and re-fetch balances
  // for the user's added assets. `refetchQueries` forces a round-trip
  // even when the cache is still within `staleTime`, which is the point —
  // the user is explicitly asking "re-sync now".
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.refetchQueries({
          queryKey: ["tokens"],
          exact: false,
        }),
        queryClient.refetchQueries({
          queryKey: ["blockchains"],
          exact: false,
        }),
        queryClient.invalidateQueries({
          queryKey: ["userAssets"],
          exact: false,
        }),
      ]);
      // The discovery endpoint is cache-first by default, so a plain refetch
      // would re-serve the same list. Only this explicit call asks upstream
      // for a newer one — that is the whole point of the pull.
      await refreshDiscoveredAssets();
      refetchBalances();
    } finally {
      setRefreshing(false);
    }
  }, [queryClient, refetchBalances, refreshDiscoveredAssets]);

  const {
    selectionMode,
    selectedAssets,
    currentAsset,
    walletSelectorVisible,
    handleAssetLongPress,
    handleToggleAssetSelection,
    cancelSelectionMode,
    openWalletSelector,
    closeWalletSelector,
    confirmSelection,
    isAssetSelected,
  } = useAssetSelection();

  const { data: tokens, isLoading: isLoadingTokens } = useTokens({
    blockchainId: activeBlockchainId,
    isActive: true,
    // Native currency is implicit for every chain (shown in the balance
    // pill / WalletInfo header), so exclude it from the Explore list.
    isNativeCurrency: false,
  });

  useEffect(() => {
    if (tokens) {
      const tokenAssets = tokens.map((token) => ({
        id: token.id || `token-${token.contractAddress}`,
        name: token.name || "Unknown Token",
        symbol: token.symbol || "???",
        logo: token.logoUrl || token.symbol?.charAt(0) || "?",
        balance: "0",
        value: "0.00",
        change: "0%",
        contractAddress: token.contractAddress ?? undefined,
        decimals: token.decimals,
      }));

      // Append held-but-uncatalogued tokens. The curated catalogue stays the
      // primary, trusted list; discovery only adds rows it doesn't already
      // have, so a token the user holds stops being invisible just because
      // nobody registered it yet.
      const catalogued = new Set(
        tokenAssets
          .map((a) =>
            a.contractAddress
              ? foldAddressForKey(a.contractAddress)
              : undefined,
          )
          .filter((a): a is string => Boolean(a)),
      );
      const extras = discoveredAssets
        .filter((asset) => {
          // The native coin lives in the balance pill, not this list.
          if (!asset.address) return false;
          // Case rule is per address encoding, not per chain: EVM/Sui hex
          // folds, Solana base58 does not. `foldAddressForKey` reads it off
          // the address shape, so this stays chain-agnostic.
          return !catalogued.has(foldAddressForKey(asset.address));
        })
        .map((asset) => ({
          id: `discovered-${asset.chainId ?? asset.namespace}-${asset.address}`,
          name: asset.name,
          symbol: asset.symbol,
          // `logoUrl` is nullable upstream, so keep the initial-letter
          // placeholder every other row already falls back to.
          logo: asset.logoUrl || asset.symbol.charAt(0) || "?",
          balance: "0",
          value: "0.00",
          change: "0%",
          contractAddress: asset.address ?? undefined,
          decimals: asset.decimals,
        }));

      setAvailableAssets([...tokenAssets, ...extras]);
    } else if (!activeBlockchainId || !isLoadingTokens) {
      const networkAssets = getNetworkSpecificAssets(
        SAMPLE_ASSETS,
        activeNetwork,
        ALL_NETWORKS,
      );
      setAvailableAssets(networkAssets);
    }
  }, [
    tokens,
    isLoadingTokens,
    activeNetwork,
    activeBlockchainId,
    discoveredAssets,
  ]);

  const filteredAvailableAssets = useMemo(
    () =>
      filterAssets(availableAssets, searchQuery).map((asset) =>
        adaptAssetForNetwork(asset, activeNetwork, ALL_NETWORKS),
      ),
    [availableAssets, searchQuery, activeNetwork],
  );

  const filteredUserAssets = useMemo(
    () => filterAssets(userAssets, searchQuery),
    [userAssets, searchQuery],
  );

  const _handleAddCustomToken = useCallback(async () => {
    setIsLoading(true);
    try {
      await addCustomToken(tokenAddress);
      setTokenAddress("");
      setShowAddToken(false);
    } catch (error) {
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [tokenAddress, addCustomToken]);

  const handleAddSelectedAssets = useCallback(() => {
    if (selectedAssets.length > 0) {
      openWalletSelector();
    }
  }, [selectedAssets, openWalletSelector]);

  const handleAddAssetsToWallets = useCallback(
    (
      walletIndices: number[],
      _: TCryptoAsset | null,
      assetsToAdd?: TCryptoAsset[],
    ) => {
      if (!assetsToAdd || assetsToAdd.length === 0) return;

      walletIndices.forEach(() => {
        addMultipleAssets(assetsToAdd);
      });

      confirmSelection();
    },
    [addMultipleAssets, confirmSelection],
  );

  const handleAssetPress = useCallback(
    (asset: TCryptoAsset) => {
      if (selectionMode) {
        handleToggleAssetSelection(asset);
      } else {
        openWalletSelector(asset);
      }
    },
    [selectionMode, handleToggleAssetSelection, openWalletSelector],
  );

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView className="flex-1 bg-light-main-container" edges={["top"]}>
        <ScrollView
          className="flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 120 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={["#c71c4b"]}
              tintColor="#c71c4b"
            />
          }
        >
          <View className="flex-1 px-4 pt-2">
            <AssetExplorerHeader
              selection={{
                selectionMode,
                selectedAssetsCount: selectedAssets.length,
              }}
              onCancel={cancelSelectionMode}
              onAdd={handleAddSelectedAssets}
            />

            {!selectionMode && <WalletInfo activeWallet={activeWallet} />}

            <AssetExplorerTabs
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              selectionMode={selectionMode}
            />

            {COLLECTIBLES_TAB_ENABLED && activeTab === "collectibles" ? (
              <CollectiblesList
                collections={nftCollections}
                searchQuery={searchQuery}
                isLoading={isLoadingNFTs}
                isError={isNFTsError}
                hasMore={Boolean(hasMoreNFTs)}
                isFetchingMore={isFetchingMoreNFTs}
                onLoadMore={fetchMoreNFTs}
              />
            ) : activeTab === "my-assets" ? (
              <UserAssetList
                data={{
                  userAssets,
                  filteredUserAssets,
                  searchQuery,
                }}
                onNavigateToExplore={() => setActiveTab("explore-assets")}
                removeAsset={removeAsset}
                onTrustPress={requestTrust}
                establishingAssetId={establishingAssetId}
              />
            ) : (
              <AvailableAssetList
                data={{
                  filteredAssets: filteredAvailableAssets,
                  searchQuery,
                }}
                state={{
                  isLoading: isLoadingTokens,
                  selectionMode,
                }}
                isAssetAdded={isAssetAdded}
                isAssetSelected={isAssetSelected}
                onAssetPress={handleAssetPress}
                onAssetLongPress={handleAssetLongPress}
                onAddPress={openWalletSelector}
              />
            )}
          </View>
        </ScrollView>
        {!selectionMode && <NetworkRadioButtons />}
      </SafeAreaView>

      <NetworkSelectorModal />

      <AssetWalletSelectorModal
        visible={walletSelectorVisible}
        data={{
          asset: currentAsset,
          assets: selectionMode ? selectedAssets : undefined,
          wallets: walletsForActiveNamespace,
          activeNetwork,
        }}
        onClose={closeWalletSelector}
        onConfirm={(walletIndices, selectedAsset, selectedAssets) => {
          if (selectionMode && selectedAssets) {
            handleAddAssetsToWallets(walletIndices, null, selectedAssets);
          } else if (selectedAsset) {
            addAsset(selectedAsset);
          }
          closeWalletSelector();
        }}
      />

      <TrustAssetConfirmModal
        visible={pendingTrustAsset !== null}
        asset={pendingTrustAsset}
        isSubmitting={
          pendingTrustAsset !== null &&
          establishingAssetId === pendingTrustAsset.id
        }
        onCancel={cancelTrust}
        onConfirm={confirmTrust}
      />
    </>
  );
}
