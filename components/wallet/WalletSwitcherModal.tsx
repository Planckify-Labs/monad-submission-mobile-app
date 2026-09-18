import { Check, Plus, Search, Star, X } from "lucide-react-native";
import { memo, useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import Chip from "@/components/common/Chip";
import type { TWallet } from "@/constants/types/walletTypes";
import { usePinnedWallets } from "@/hooks/usePinnedWallets";
import { useWalletAccountGroups } from "@/hooks/useWalletAccountGroups";
import type { Namespace } from "@/services/chains/types";
import {
  filterSupportedWallets,
  isWalletSupported,
} from "@/services/walletKit/chainSupport";
import { ownedNamespaces } from "@/services/walletPresence";
import {
  flattenWalletGroups,
  type WalletGroupListItem,
} from "@/utils/walletGrouping";
import { truncateAddress, walletTypeLabel } from "@/utils/walletUtils";
import WalletAccountGroupHeader from "./WalletAccountGroupHeader";

type NamespaceFilter = "all" | Namespace;

const NAMESPACE_LABEL: Record<Namespace, string> = {
  eip155: "EVM",
  solana: "Solana",
  sui: "Sui",
  stellar: "Stellar",
};

type WalletSwitcherModalProps = {
  visible: boolean;
  onClose: () => void;
  wallets: TWallet[];
  activeWalletIndex: number;
  onSelectWallet: (index: number) => void;
  onAddWallet: () => void;
};

const WalletSwitcherModal = memo(function WalletSwitcherModal({
  visible,
  onClose,
  wallets,
  activeWalletIndex,
  onSelectWallet,
  onAddWallet,
}: WalletSwitcherModalProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [nsFilter, setNsFilter] = useState<NamespaceFilter>("all");

  const { isPinned, togglePin, canPinMore, maxPinned } = usePinnedWallets();

  // Only surface namespace pills the user actually has wallets in —
  // a solo-EVM user shouldn't see a dead "Solana" pill.
  const availableNamespaces = useMemo(
    () => ownedNamespaces(filterSupportedWallets(wallets)),
    [wallets],
  );

  const activeAddress = wallets[activeWalletIndex]?.address;
  const { groups, isExpanded, toggleExpanded } = useWalletAccountGroups(
    wallets,
    activeAddress,
    visible,
  );

  const listItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    // A chain tab or an active search narrows the list enough that
    // collapsing would just hide matches, so force every group open.
    const forceExpand = query.length > 0 || nsFilter !== "all";
    const isVisible = (wallet: TWallet) => {
      if (!isWalletSupported(wallet)) return false;
      if (nsFilter !== "all" && wallet.namespace !== nsFilter) return false;
      if (!query) return true;
      return (
        wallet.name.toLowerCase().includes(query) ||
        wallet.address.toLowerCase().includes(query) ||
        walletTypeLabel(wallet).toLowerCase().includes(query)
      );
    };
    return flattenWalletGroups(groups, {
      isVisible,
      isExpanded,
      forceExpand,
      activeAddress,
    });
  }, [groups, searchQuery, nsFilter, isExpanded, activeAddress]);

  const resetFilters = useCallback(() => {
    setSearchQuery("");
    setNsFilter("all");
  }, []);

  const handleWalletSelect = useCallback(
    (index: number) => {
      onSelectWallet(index);
      onClose();
    },
    [onSelectWallet, onClose],
  );

  const renderWalletItem = useCallback(
    ({ item }: { item: TWallet }) => {
      const originalIndex = wallets.findIndex(
        (w) => w.address === item.address,
      );
      const isActive = originalIndex === activeWalletIndex;
      const pinned = isPinned(item.address);
      // Disabling the pin tap when the cap is hit (and this row isn't
      // already pinned) keeps the UX honest — tapping would otherwise
      // silently no-op and leave users guessing why nothing happened.
      const pinDisabled = !pinned && !canPinMore;

      return (
        <Pressable
          className={`flex-row items-center p-4 mb-2 rounded-xl ${
            isActive ? "bg-light-primary-red/10" : "bg-light"
          }`}
          onPress={() => handleWalletSelect(originalIndex)}
        >
          <View className="flex-1">
            <Text className="text-light-matte-black font-bold">
              {item.name}
            </Text>
            <View className="flex-row items-center mt-1">
              <Text className="text-light-matte-black/60 text-sm mr-2">
                {truncateAddress({ address: item.address, preset: "medium" })}
              </Text>
              <Chip label={walletTypeLabel(item)} size="small" />
            </View>
          </View>

          <Pressable
            onPress={(e) => {
              e.stopPropagation();
              if (pinDisabled) return;
              togglePin(item.address);
            }}
            disabled={pinDisabled}
            accessibilityRole="button"
            accessibilityLabel={pinned ? "Unpin wallet" : "Pin wallet"}
            accessibilityHint={
              pinDisabled ? `Pin limit reached (max ${maxPinned}).` : undefined
            }
            hitSlop={8}
            className="w-9 h-9 rounded-full items-center justify-center mr-2"
          >
            <Star
              size={20}
              color={
                pinned ? "#c71c4b" : pinDisabled ? "#20222c30" : "#20222c80"
              }
              fill={pinned ? "#c71c4b" : "transparent"}
            />
          </Pressable>

          {isActive && (
            <View className="w-6 h-6 rounded-full bg-light-primary-red items-center justify-center">
              <Check size={14} color="#ffffff" strokeWidth={3} />
            </View>
          )}
        </Pressable>
      );
    },
    [
      wallets,
      activeWalletIndex,
      handleWalletSelect,
      isPinned,
      togglePin,
      canPinMore,
      maxPinned,
    ],
  );

  const renderListItem = useCallback(
    ({ item }: { item: WalletGroupListItem }) => {
      if (item.type === "header") {
        return (
          <WalletAccountGroupHeader
            group={item.group}
            count={item.count}
            expanded={item.expanded}
            collapsible={item.collapsible}
            containsActive={item.containsActive}
            onToggle={() => toggleExpanded(item.group.id)}
          />
        );
      }
      return (
        <View style={item.indented ? { paddingLeft: 12 } : undefined}>
          {renderWalletItem({ item: item.wallet })}
        </View>
      );
    },
    [renderWalletItem, toggleExpanded],
  );

  const keyExtractor = useCallback(
    (item: WalletGroupListItem, index: number) =>
      item.type === "header"
        ? `header:${item.group.id}`
        : item.wallet.address || `wallet-${index}`,
    [],
  );

  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      onClosed={resetFilters}
      height="75%"
      contentClassName="px-4"
    >
      <ModalHeader title="Select Wallet" />

      <View className="mb-3">
        <View className="bg-light rounded-xl flex-row items-center px-4">
          <Search size={18} color="#20222c" />
          <TextInput
            className="flex-1 py-3 px-2 text-light-matte-black"
            placeholder="Search by name, address, or type..."
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholderTextColor="#20222c80"
          />
          {searchQuery ? (
            <Pressable onPress={() => setSearchQuery("")}>
              <X size={16} color="#20222c" />
            </Pressable>
          ) : null}
        </View>
      </View>

      {availableNamespaces.length > 1 ? (
        <View className="mb-3 flex-row">
          {(["all", ...availableNamespaces] as NamespaceFilter[]).map((key) => {
            const isActive = nsFilter === key;
            const label = key === "all" ? "All" : NAMESPACE_LABEL[key];
            return (
              <Pressable
                key={key}
                onPress={() => setNsFilter(key)}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
                className={`px-4 py-2 rounded-full mr-2 ${
                  isActive ? "bg-light-primary-red" : "bg-light-matte-black/5"
                }`}
              >
                <Text
                  className={`text-sm font-semibold ${
                    isActive ? "text-light" : "text-light-matte-black/70"
                  }`}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <FlatList
        data={listItems}
        renderItem={renderListItem}
        keyExtractor={keyExtractor}
        extraData={`${searchQuery}:${nsFilter}:${activeWalletIndex}`}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View className="items-center py-8">
            <Text className="text-light-matte-black/60">No wallets found</Text>
          </View>
        }
        ListFooterComponent={
          <Pressable
            className="flex-row items-center justify-center p-4 mt-2 border-2 border-dashed border-light-matte-black/15 rounded-xl"
            onPress={() => {
              onClose();
              onAddWallet();
            }}
          >
            <Plus size={20} color="#c71c4b" />
            <Text className="text-light-primary-red font-medium ml-2">
              Add New Wallet
            </Text>
          </Pressable>
        }
      />
    </BaseModal>
  );
});

export default WalletSwitcherModal;
