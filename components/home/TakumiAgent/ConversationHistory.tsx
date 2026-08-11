import { FlashList } from "@shopify/flash-list";
import { format } from "date-fns";
import { router } from "expo-router";
import {
  ChevronRight,
  CopyIcon,
  LogIn,
  Search,
  Wallet,
  X,
} from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { ChainSelectorSheet } from "@/components/common/ChainSelectorSheet";
import OptimizedImage from "@/components/common/OptimizedImage";
import WalletSelectorModal from "@/components/wallet/WalletSelectorModal";
import { useIsAuthenticated } from "@/hooks/queries/useAuth";
import {
  useConversationList,
  useDeleteConversation,
} from "@/hooks/queries/useConversations";
import { useWallet } from "@/hooks/useWallet";
import { formatChainLabel } from "@/services/walletKit/chainInfo";
import { copyToClipboard } from "@/utils/helperUtils";

interface ConversationHistory {
  onScrollToChat?: () => void;
  onResumeConversation: (conversationId: string) => void;
}

export default function ConversationHistory({
  onScrollToChat,
  onResumeConversation,
}: ConversationHistory) {
  const [searchQuery, setSearchQuery] = useState("");
  const [showWalletSelector, setShowWalletSelector] = useState(false);
  const [showChainSelector, setShowChainSelector] = useState(false);

  // No `changeActiveChainToConfig` here any more — switching is the
  // shared `ChainSelectorSheet`'s job, not this screen's.
  const { wallets, activeWalletIndex, activeChain, setActiveWallet } =
    useWallet();

  const activeWallet = useMemo(
    () => wallets[activeWalletIndex],
    [wallets, activeWalletIndex],
  );

  const { isAuthenticated, isLoading: isLoadingAuth } = useIsAuthenticated();

  const { data: convListData, isLoading: isLoadingConvs } = useConversationList(
    isAuthenticated === true ? activeWallet?.address : undefined,
  );
  const { mutate: deleteConv } = useDeleteConversation();

  const formattedAddress = useMemo(() => {
    if (!activeWallet?.address) return "...";
    return `${activeWallet.address.substring(0, 6)}...${activeWallet.address.substring(activeWallet.address.length - 4)}`;
  }, [activeWallet?.address]);

  const filteredConversations = useMemo(() => {
    const items = convListData?.items ?? [];
    if (!searchQuery.trim()) return items;
    const q = searchQuery.toLowerCase();
    return items.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.last_message_preview.toLowerCase().includes(q),
    );
  }, [convListData?.items, searchQuery]);

  const closeChainModal = useCallback(() => setShowChainSelector(false), []);

  const openChainModal = useCallback(() => setShowChainSelector(true), []);

  const handleWalletSwitch = (index: number) => {
    setActiveWallet(index, { source: "agent" });
    setShowWalletSelector(false);
  };

  return (
    <View className="flex-1 bg-light-main-container">
      <View className="flex-1 px-4">
        <View className="flex-row items-center mb-6">
          <View className="flex-1 bg-light rounded-full flex-row items-center px-4 py-2">
            <Search size={18} color="#20222c" />
            <TextInput
              className="flex-1 py-1 px-3 text-light-matte-black bg-lig"
              placeholder="Search conversations..."
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholderTextColor="#999"
            />
            {searchQuery ? (
              <TouchableOpacity onPress={() => setSearchQuery("")}>
                <X size={18} color="#20222c" />
              </TouchableOpacity>
            ) : null}
          </View>
          <TouchableOpacity className="relative" onPress={onScrollToChat}>
            <View className="absolute top-0 -right-2">
              <ChevronRight size={40} color="#c71c4b" strokeWidth={1.3} />
            </View>
            <View className="top-0 right-0">
              <ChevronRight size={40} color="#c71c4b" strokeWidth={1.3} />
            </View>
          </TouchableOpacity>
        </View>

        <Text className="text-sm font-light text-gray-500 uppercase mb-3">
          Conversations
        </Text>

        {isLoadingAuth ? (
          <View className="items-center py-8">
            <ActivityIndicator size="small" color="#c71c4b" />
          </View>
        ) : isAuthenticated === false ? (
          <View className="items-center py-10 px-6 flex-1 justify-center">
            <View className="w-14 h-14 rounded-full bg-light-primary-red/10 items-center justify-center mb-3">
              <LogIn size={24} color="#c71c4b" />
            </View>
            <Text className="text-light-matte-black font-semibold text-base mb-1">
              Sign in to see your history
            </Text>
            <Text className="text-sm text-gray-500 text-center mb-4">
              Your conversations with Takumi are saved to your wallet. Sign in
              to view them here.
            </Text>
            <TouchableOpacity
              onPress={() => router.push("/auth")}
              className="bg-light-primary-red rounded-full px-6 py-3"
            >
              <Text className="text-white font-semibold text-sm">Sign in</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlashList
            data={filteredConversations}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TouchableOpacity
                onPress={() => onResumeConversation(item.id)}
                className="rounded-lg px-4 py-3 mb-2 flex-row items-start justify-between"
              >
                <View className="flex-1 mr-3">
                  <Text
                    className="text-light-matte-black font-normal text-base"
                    numberOfLines={1}
                  >
                    {item.title}
                  </Text>
                  {item.last_message_preview ? (
                    <Text
                      className="text-xs text-gray-500 mt-0.5"
                      numberOfLines={1}
                    >
                      {item.last_message_preview}
                    </Text>
                  ) : null}
                  <Text className="text-[10px] text-gray-400 mt-1">
                    {format(new Date(item.updated_at), "MMM d, yyyy")}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() =>
                    deleteConv({
                      id: item.id,
                      walletAddress: activeWallet?.address ?? "",
                    })
                  }
                  hitSlop={8}
                  className="pt-1"
                >
                  <X size={14} color="#9ca3af" />
                </TouchableOpacity>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              isLoadingConvs ? (
                <View className="items-center py-8">
                  <ActivityIndicator size="small" color="#c71c4b" />
                </View>
              ) : (
                <View className="items-center py-8">
                  <Text className="text-sm text-gray-400">
                    No conversations yet
                  </Text>
                </View>
              )
            }
            scrollEnabled={true}
            showsVerticalScrollIndicator={false}
          />
        )}
        <View className="flex-row justify-between p-4 px-[4px]">
          <View className="flex-row gap-2 items-center">
            <TouchableOpacity onPress={openChainModal}>
              <View className="aspect-square w-[42px] rounded-full overflow-hidden bg-light/50 border-4 border-light-matte-black/80">
                <OptimizedImage source={{ uri: activeChain?.iconUrl }} />
              </View>
            </TouchableOpacity>
            <View>
              <Text className="text-sm text-light-matte-black font-semibold">
                {activeWallet?.name}
              </Text>
              <Text className="text-[10px] font-bold text-light-matte-black/70">
                {formatChainLabel(activeChain)}
              </Text>
              <TouchableOpacity
                className="flex-row gap-2"
                onPress={() =>
                  copyToClipboard(
                    activeWallet?.address || "failed to copy wallet address",
                    "Wallet Address",
                  )
                }
              >
                <Text className="text-xs text-light-matte-black/80">
                  {formattedAddress}
                </Text>
                <CopyIcon color="#c71c4b" size={13} />
              </TouchableOpacity>
            </View>
          </View>
          <View>
            <TouchableOpacity
              className="p-4 aspect-square rounded-full"
              onPress={() => setShowWalletSelector(true)}
            >
              <Wallet size={25} color="#c71c4b" />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <WalletSelectorModal
        visible={showWalletSelector}
        onClose={() => setShowWalletSelector(false)}
        wallets={wallets}
        activeWalletIndex={activeWalletIndex}
        onSelectWallet={handleWalletSwitch}
        title="Switch Wallet"
      />

      {/* The SAME picker the home-screen pill opens. This screen used to
          render its own copy, which is how it kept offering chains the
          user holds no wallet for after that was fixed on the other one.
          Only the trigger above is local now. */}
      <ChainSelectorSheet
        visible={showChainSelector}
        onClose={closeChainModal}
      />
    </View>
  );
}
