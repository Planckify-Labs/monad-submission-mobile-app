import { Check, Search, Wallet, X } from "lucide-react-native";
import { memo, useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import type { TWallet } from "@/constants/types/walletTypes";
import { useWalletAccountGroups } from "@/hooks/useWalletAccountGroups";
import { isWalletSupported } from "@/services/walletKit/chainSupport";
import { walletKitRegistry } from "@/services/walletKit/registry";
import {
  flattenWalletGroups,
  type WalletGroupListItem,
} from "@/utils/walletGrouping";
import { truncateAddress } from "@/utils/walletUtils";
import WalletAccountGroupHeader from "./WalletAccountGroupHeader";

// Human-readable namespace label shown as a chip next to each wallet.
// Prefers the registered kit's `displayName` so adding a new chain
// family (Sui, Bitcoin, …) needs zero edits here — the label is
// whatever that kit advertises. Falls back to a capitalised namespace
// literal when a namespace has no registered kit (shouldn't happen in
// practice but keeps the UI from rendering `eip155`).
function namespaceLabel(ns: TWallet["namespace"]): string {
  try {
    const kit = walletKitRegistry.get(ns);
    if (kit.displayName) return kit.displayName;
  } catch {
    // Kit not registered — fall through to the capitalised literal.
  }
  if (ns === "eip155") return "Ethereum";
  return ns.charAt(0).toUpperCase() + ns.slice(1);
}

type WalletSelectorModalProps = {
  visible: boolean;
  onClose: () => void;
  wallets: TWallet[];
  activeWalletIndex: number;
  onSelectWallet: (index: number) => void;
  title?: string;
  disabledWalletIndex?: number;
  disabledLabel?: string;
  dappUrl?: string;
  isDappConnection?: boolean;
  onSelectWalletForDapp?: (wallet: TWallet, index: number) => void;
  onDeclineConnection?: () => void;
};

const WalletSelectorModal = memo(function WalletSelectorModal({
  visible,
  onClose,
  wallets,
  activeWalletIndex,
  onSelectWallet,
  title = "Select Wallet",
  disabledWalletIndex,
  disabledLabel = "Current wallet",
  dappUrl,
  isDappConnection = false,
  onSelectWalletForDapp,
  onDeclineConnection,
}: WalletSelectorModalProps) {
  const [searchQuery, setSearchQuery] = useState("");

  const activeAddress = wallets[activeWalletIndex]?.address;
  const { groups, isExpanded, toggleExpanded } = useWalletAccountGroups(
    wallets,
    activeAddress,
    visible,
  );

  const listItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const isVisible = (w: TWallet) => {
      if (!isWalletSupported(w)) return false;
      if (!q) return true;
      if ((w.name ?? "").toLowerCase().includes(q)) return true;
      if (w.address.toLowerCase().includes(q)) return true;
      if ((w.type ?? "").toLowerCase().includes(q)) return true;
      if (namespaceLabel(w.namespace).toLowerCase().includes(q)) return true;
      return false;
    };
    return flattenWalletGroups(groups, {
      isVisible,
      isExpanded,
      // A search narrows the list, so keep every matching group open.
      forceExpand: q.length > 0,
      activeAddress,
    });
  }, [groups, searchQuery, isExpanded, activeAddress]);

  // Closing without picking a wallet declines the pending dApp connection.
  const handleClose = useCallback(() => {
    if (isDappConnection && onDeclineConnection) {
      onDeclineConnection();
    }
    onClose();
  }, [isDappConnection, onDeclineConnection, onClose]);

  const getDomainFromUrl = useCallback((url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }, []);

  const handleWalletSelection = useCallback(
    (wallet: TWallet, index: number) => {
      if (isDappConnection && onSelectWalletForDapp) {
        onSelectWalletForDapp(wallet, index);
      } else {
        onSelectWallet(index);
      }
    },
    [isDappConnection, onSelectWalletForDapp, onSelectWallet],
  );

  const renderWalletItem = useCallback(
    (wallet: TWallet) => {
      const index = wallets.findIndex((w) => w.address === wallet.address);
      const isActive = index === activeWalletIndex;
      const isDisabled = index === disabledWalletIndex;

      return (
        <Pressable
          key={wallet.address}
          className={`flex-row items-center p-4 mb-2 rounded-2xl ${
            isActive ? "bg-light-primary-red/10" : "bg-light"
          }`}
          onPress={() => handleWalletSelection(wallet, index)}
          disabled={isDisabled}
        >
          <View className="flex-1">
            <View className="flex-row items-center">
              <Text
                className={`font-bold ${
                  isDisabled
                    ? "text-light-matte-black/40"
                    : "text-light-matte-black"
                }`}
                numberOfLines={1}
              >
                {wallet.name || `Wallet ${index + 1}`}
              </Text>
              <View
                className={`ml-2 px-2 py-0.5 rounded-full ${
                  wallet.namespace === "solana"
                    ? "bg-[#9945FF]/10"
                    : "bg-[#627EEA]/10"
                }`}
              >
                <Text
                  className={`text-[10px] font-semibold ${
                    wallet.namespace === "solana"
                      ? "text-[#9945FF]"
                      : "text-[#627EEA]"
                  }`}
                >
                  {namespaceLabel(wallet.namespace)}
                </Text>
              </View>
            </View>
            <Text
              className={`text-sm mt-0.5 ${
                isDisabled
                  ? "text-light-matte-black/40"
                  : "text-light-matte-black/70"
              }`}
            >
              {truncateAddress({ address: wallet.address, preset: "medium" })}
            </Text>
          </View>

          {isDisabled && disabledLabel && (
            <Text className="text-light-matte-black/40 text-xs mr-2">
              {disabledLabel}
            </Text>
          )}

          {isActive && !isDisabled && (
            <View className="w-6 h-6 rounded-full bg-light-primary-red/10 items-center justify-center">
              <Check size={14} color="#c71c4b" strokeWidth={3} />
            </View>
          )}
        </Pressable>
      );
    },
    [
      wallets,
      activeWalletIndex,
      disabledWalletIndex,
      disabledLabel,
      handleWalletSelection,
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
          {renderWalletItem(item.wallet)}
        </View>
      );
    },
    [renderWalletItem, toggleExpanded],
  );

  const keyExtractor = useCallback(
    (item: WalletGroupListItem) =>
      item.type === "header" ? `header:${item.group.id}` : item.wallet.address,
    [],
  );

  return (
    <BaseModal
      visible={visible}
      onClose={handleClose}
      onClosed={() => setSearchQuery("")}
      height="67%"
      contentClassName="px-4"
    >
      <ModalHeader
        title={isDappConnection && dappUrl ? undefined : title}
        left={
          isDappConnection && dappUrl ? (
            <View className="flex-row items-center gap-2 flex-1 pr-3">
              <View className="w-8 h-8 bg-light-primary-red/10 rounded-full items-center justify-center">
                <Wallet size={16} color="#c71c4b" />
              </View>
              <View className="flex-1">
                <Text
                  className="text-light-matte-black text-lg font-bold"
                  numberOfLines={1}
                >
                  Connect Wallet
                </Text>
                <Text
                  className="text-light-matte-black/60 text-xs"
                  numberOfLines={1}
                >
                  {getDomainFromUrl(dappUrl)} wants to connect
                </Text>
              </View>
            </View>
          ) : undefined
        }
      />

      <View className="mb-3">
        <View className="bg-light rounded-2xl flex-row items-center px-4">
          <Search size={18} color="#20222c" />
          <TextInput
            className="flex-1 py-3 px-2 text-light-matte-black"
            placeholder="Search by name, address, or chain…"
            placeholderTextColor="#20222c80"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {searchQuery ? (
            <Pressable onPress={() => setSearchQuery("")}>
              <X size={16} color="#20222c" />
            </Pressable>
          ) : null}
        </View>
      </View>

      <View className="flex-1">
        <FlatList
          data={listItems}
          renderItem={renderListItem}
          keyExtractor={keyExtractor}
          extraData={`${searchQuery}:${activeWalletIndex}`}
          contentContainerStyle={{ paddingBottom: 16 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <View className="items-center py-10">
              <Text className="text-light-matte-black/60 text-center">
                {wallets.length === 0
                  ? "No wallets available. Please create or import a wallet first."
                  : `No wallets match "${searchQuery}"`}
              </Text>
            </View>
          }
        />
      </View>

      {isDappConnection ? (
        <View className="pb-2">
          <View className="bg-light rounded-2xl p-3 mb-3">
            <Text className="text-light-matte-black/60 text-xs text-center">
              Only connect to websites you trust. TakumiPay will never ask for
              your private keys or seed phrase.
            </Text>
          </View>
          <Pressable className="bg-light rounded-2xl p-4" onPress={handleClose}>
            <Text className="text-light-matte-black font-bold text-center">
              Cancel
            </Text>
          </Pressable>
        </View>
      ) : null}
    </BaseModal>
  );
});

export default WalletSelectorModal;
