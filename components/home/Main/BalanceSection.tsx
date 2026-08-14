import { router, useRouter } from "expo-router";
import {
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  QrCode,
  Send,
} from "lucide-react-native";
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Image, Text, TouchableOpacity, Vibration, View } from "react-native";
import DepositIcon from "@/assets/icons/deposit-duotone.svg";
import WithdrawIcon from "@/assets/icons/withdraw-duotone.svg";
import ChainSelector from "@/components/common/ChainSelector";
import TakumipayHeaderLogo from "@/components/common/TakumipayHeaderLogo";
import { useIsAuthenticated } from "@/hooks/queries/useAuth";
import { useBlockchains } from "@/hooks/queries/useBlockchains";
import { usePointBalance } from "@/hooks/queries/usePoints";
import { usePaymentFeatured } from "@/hooks/queries/useProducts";
import { useTokens } from "@/hooks/queries/useTokens";
import { useGoToAuth } from "@/hooks/useGoToAuth";
import { useQRPrefetch } from "@/hooks/useQRPrefetch";
import { useWallet } from "@/hooks/useWallet";
import { useWalletBalance } from "@/hooks/useWalletBalance";
import { storage } from "@/lib/storage/mmkv";
import { track } from "@/services/analytics/posthog";
import {
  getNativeSymbol,
  matchesBlockchainRow,
} from "@/services/walletKit/chainInfo";
import { copyToClipboard } from "@/utils/helperUtils";
import DisplayTokenPickerModal from "./DisplayTokenPickerModal";
import RecievePaymentModal from "./RecievePaymentModal";

const SELECTED_DISPLAY_TOKEN_SYMBOL_KEY =
  "balance_section_display_token_symbol";

const quickPaymentItems = [
  {
    name: "Pulsa & Data Package",
    displayName: "Phone",
    icon: require("@/assets/icons/pulsa_data_package.png"),
    type: "pulsa-data" as const,
  },
  {
    name: "Gaming",
    displayName: "Gaming",
    icon: require("@/assets/icons/gaming_topup.png"),
    type: "category" as const,
  },
  {
    name: "Token PLN",
    displayName: "PLN",
    icon: require("@/assets/icons/pln.png"),
    type: "product" as const,
  },
];

export interface BalanceSectionRef {
  refetch: () => void;
}

const BalanceSection = forwardRef<BalanceSectionRef>((props, ref) => {
  const { activeWallet, activeChain } = useWallet();
  useQRPrefetch();
  const nativeSymbol = getNativeSymbol(activeChain) ?? "N/A";

  const [isShowBalance, setShowBalance] = useState(false);
  const [selectedSymbol, setSelectedSymbol] = useState<string>(
    () => storage.getString(SELECTED_DISPLAY_TOKEN_SYMBOL_KEY) ?? nativeSymbol,
  );
  const [tokenPickerVisible, setTokenPickerVisible] = useState(false);

  const { data: blockchains } = useBlockchains({ isActive: true });

  const activeBlockchainId = useMemo(() => {
    if (!blockchains) return undefined;
    // Per-chain row matching (EVM by chainId; non-EVM by chainSlug prefix +
    // testnet parity, with a name/rpc fallback) lives on the kit so this
    // screen stays chain-agnostic.
    return blockchains.find((b) => matchesBlockchainRow(activeChain, b))?.id;
  }, [blockchains, activeChain]);

  const { data: chainTokens } = useTokens({
    blockchainId: activeBlockchainId,
    isActive: true,
  });

  // On chain switch: keep the user's symbol choice if the new chain has
  // the same token (e.g. USDC exists on both EVM and Solana). Only fall
  // back to native when the symbol genuinely doesn't exist on the target.
  const prevChainKeyRef = useRef(activeBlockchainId);
  useEffect(() => {
    if (!chainTokens || chainTokens.length === 0) return;
    const chainChanged = prevChainKeyRef.current !== activeBlockchainId;
    prevChainKeyRef.current = activeBlockchainId;

    const hasSelected = chainTokens.some((t) => t.symbol === selectedSymbol);
    if (hasSelected) return;

    if (chainChanged) {
      // Chain switched — try the persisted symbol from storage first
      const stored = storage.getString(SELECTED_DISPLAY_TOKEN_SYMBOL_KEY);
      if (stored && chainTokens.some((t) => t.symbol === stored)) {
        setSelectedSymbol(stored);
        return;
      }
    }

    const nativeToken = chainTokens.find((t) => t.isNativeCurrency);
    setSelectedSymbol(nativeToken?.symbol ?? nativeSymbol);
  }, [chainTokens, selectedSymbol, nativeSymbol, activeBlockchainId]);

  useEffect(() => {
    storage.set(SELECTED_DISPLAY_TOKEN_SYMBOL_KEY, selectedSymbol);
  }, [selectedSymbol]);

  // `tokenInfoReady` gates the balance query: when the user has selected
  // a non-native symbol but chainTokens hasn't loaded yet, we must NOT
  // let the balance hook fall back to native — that shows the wrong
  // number. Only mark ready once we can resolve the selected symbol.
  const selectedTokenInfo = useMemo(() => {
    if (!chainTokens) return undefined;
    const token = chainTokens.find((t) => t.symbol === selectedSymbol);
    if (!token) return undefined;
    return {
      contractAddress: token.contractAddress,
      decimals: token.decimals,
      isNativeCurrency: token.isNativeCurrency,
    };
  }, [chainTokens, selectedSymbol]);

  const tokenInfoReady = !!chainTokens && chainTokens.length > 0;

  const {
    isAuthenticated,
    isLoading: isAuthLoading,
    hadPreviousSession,
  } = useIsAuthenticated();
  const { navigatingToAuth, goToAuth } = useGoToAuth();
  const {
    data: pointBalance,
    isFetching: isPointsFetching,
    refetch: refetchPoints,
  } = usePointBalance();
  const { data: paymentFeatured, refetch: refetchPayment } =
    usePaymentFeatured();
  const { balance, isFetching, refetch } = useWalletBalance(
    activeWallet,
    activeChain,
    selectedTokenInfo,
    tokenInfoReady,
  );

  useImperativeHandle(ref, () => ({
    refetch: () => {
      refetch();
      refetchPoints();
      refetchPayment();
    },
  }));

  const handleQuickPaymentNavigate = async (
    item: (typeof quickPaymentItems)[0],
  ) => {
    let id = paymentFeatured?.[item.name]?.id;

    if (!id) {
      const maxRetries = 3;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const { data: freshData } = await refetchPayment();
        id = freshData?.[item.name]?.id;
        if (id) break;
      }
      if (!id) return;
    }

    if (item.type === "pulsa-data") {
      router.push({
        pathname: "/pulsa-data",
        params: { categoryId: id },
      });
    } else if (item.type === "category") {
      router.push({
        pathname: "/view-all-item",
        params: {
          categoryId: id,
          categoryName: item.displayName,
        },
      });
    } else if (item.type === "product") {
      router.push({
        pathname: "/purchase-item",
        params: { productId: id },
      });
    }
  };

  const [modalVisible, setModalVisible] = useState(false);
  const router = useRouter();

  const openModal = useCallback(() => {
    track("feature_opened", { feature: "receive_modal" });
    setModalVisible(true);
  }, []);
  const closeModal = useCallback(() => setModalVisible(false), []);

  return (
    <>
      <View className="px-4">
        <View className="bg-light rounded-2xl w-full p-5 shadow-sm">
          <View className="flex-row items-center justify-between mb-5">
            <View className="flex-row items-center">
              <TakumipayHeaderLogo width={100} color="#c71c4b" />
            </View>

            <ChainSelector />
          </View>

          <View className="flex-row items-center mb-3">
            <Text className="text-light-matte-black/70 text-xs mr-2">
              {activeWallet.name || "Wallet"}
            </Text>
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => copyToClipboard(activeWallet.address, "Address")}
              className="flex-row items-center ml-auto gap-2"
            >
              <Text className="text-light-matte-black/60 text-xs">
                {activeWallet?.address?.substring(0, 6)}...
                {activeWallet?.address?.substring(
                  activeWallet.address.length - 4,
                )}
              </Text>
              <Copy size={12} color="#c71c4b" className="ml-1" />
            </TouchableOpacity>
          </View>

          <View className="bg-light-main-container/50 p-4 rounded-xl mb-6">
            <View className="flex-row items-center justify-between mb-1">
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => {
                  track("feature_opened", { feature: "display_token_picker" });
                  setTokenPickerVisible(true);
                }}
                className="flex-row items-center"
              >
                <Text className="text-light-matte-black font-medium text-sm mr-1">
                  {selectedSymbol}
                </Text>
                <ChevronDown size={14} color="#c71c4b" />
              </TouchableOpacity>

              <TouchableOpacity
                activeOpacity={0.7}
                hitSlop={{ top: 10, bottom: 40, left: 20, right: 20 }}
                onPress={() => {
                  Vibration.vibrate(100);
                  setShowBalance((prevValue) => !prevValue);
                }}
              >
                {isShowBalance ? (
                  <Eye size={16} color="#c71c4b" />
                ) : (
                  <EyeOff size={16} color="#c71c4b" />
                )}
              </TouchableOpacity>
            </View>

            <View>
              {isShowBalance ? (
                <View>
                  <Text className="text-light-primary-red font-bold text-4xl">
                    {isFetching ? "..." : balance}
                  </Text>
                  {isAuthenticated ? (
                    <Text className="text-light-matte-black text-md font-light">
                      {isPointsFetching
                        ? "..."
                        : `${parseInt(pointBalance?.balance ?? "0").toLocaleString()} points`}
                    </Text>
                  ) : isAuthLoading || hadPreviousSession ? (
                    <Text className="text-light-matte-black text-md font-light">
                      ...
                    </Text>
                  ) : (
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={goToAuth}
                      disabled={navigatingToAuth}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text className="text-light-primary-red text-md font-medium underline">
                        {navigatingToAuth
                          ? "Opening sign-in…"
                          : "Sign in to view points"}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : (
                <View className="flex-row items-center gap-2 py-2">
                  <View className="h-2 bg-light-primary-red w-16 rounded-full" />
                  <View className="h-2 bg-light-primary-red w-10 rounded-full" />
                  <View className="h-2 bg-light-primary-red w-8 rounded-full" />
                </View>
              )}
            </View>
          </View>

          <View className="flex-row gap-4 flex-wrap">
            <View className="flex-1 min-w-[100px] gap-3 flex-row flex-wrap">
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => router.push("/deposit")}
                className="flex-1 min-w-[120px] bg-light-main-container rounded-xl py-3 px-3 flex-row items-center"
              >
                <View className="mr-2">
                  <DepositIcon width={32} height={32} />
                </View>
                <Text className="text-light-matte-black text-[10px] font-medium">
                  Add points
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => router.push("/withdraw")}
                className="flex-1 hidden min-w-[100px] bg-light-main-container rounded-xl py-3 px-3 flex-row items-center"
              >
                <View className="mr-2">
                  <WithdrawIcon width={32} height={32} />
                </View>
                <Text className="text-light-matte-black text-[10px] font-medium">
                  Withdraw
                </Text>
              </TouchableOpacity>

              <View className="flex-row gap-3 justify-evenly mt-1 w-full">
                {quickPaymentItems.map((item) => (
                  <TouchableOpacity
                    key={item.name}
                    activeOpacity={0.7}
                    className="items-center"
                    onPress={() => handleQuickPaymentNavigate(item)}
                  >
                    <View className="rounded-xl border-2 border-light-matte-black w-12 aspect-square bg-light-main-container items-center justify-center">
                      <Image
                        source={item.icon}
                        style={{ width: 28, height: 28 }}
                        resizeMode="contain"
                      />
                    </View>
                    <Text className="text-[10px] text-center text-wrap max-w-16 mt-1">
                      {item.displayName}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View className="">
              <View className="flex-row gap-3 flex-wrap justify-center">
                <TouchableOpacity
                  activeOpacity={0.7}
                  className="items-center m-1 mt-0"
                  onPress={openModal}
                >
                  <View className="bg-light-matte-black rounded-full items-center justify-center w-12 h-12 mb-1">
                    <QrCode size={20} color="#fff" />
                  </View>
                  <Text className="text-xs text-light-matte-black font-medium">
                    Receive
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  activeOpacity={0.7}
                  className="items-center m-1 mt-0"
                  onPress={() => router.push("/send")}
                >
                  <View className="bg-light-matte-black rounded-full items-center justify-center w-12 h-12 pt-[2px] pr-[2px] mb-1">
                    <Send size={20} color="#fff" fill="#fff" />
                  </View>
                  <Text className="text-xs text-light-matte-black font-medium">
                    Send
                  </Text>
                </TouchableOpacity>
              </View>
              <View className="flex-row gap-2 p-1 flex-wrap justify-between bg-light-main-container rounded-xl items-center">
                <TouchableOpacity
                  activeOpacity={0.7}
                  className="items-center"
                  onPress={() => router.push("/asset-explorer")}
                >
                  <View className="bg-light-matte-black- rounded-full items-center justify-center w-12 h-12 mb-1">
                    <Image
                      source={require("@/assets/icons/asset-dark.png")}
                      style={{ width: 30, height: 30 }}
                      resizeMode="contain"
                    />
                  </View>
                </TouchableOpacity>

                <TouchableOpacity
                  activeOpacity={0.7}
                  className="items-center"
                  onPress={() => router.push("/dapps-browser")}
                >
                  <View className="bg-light-matte-black- rounded-full items-center justify-center w-12 h-12 mb-1">
                    <Image
                      source={require("@/assets/icons/explorer-dark.png")}
                      style={{ width: 30, height: 30 }}
                      resizeMode="contain"
                    />
                  </View>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      </View>

      <RecievePaymentModal
        modalVisible={modalVisible}
        closeModal={closeModal}
        activeWallet={activeWallet}
        activeChain={activeChain}
      />

      <DisplayTokenPickerModal
        visible={tokenPickerVisible}
        onClose={() => setTokenPickerVisible(false)}
        tokens={chainTokens ?? []}
        selectedSymbol={selectedSymbol}
        onSelectSymbol={setSelectedSymbol}
      />
    </>
  );
});

BalanceSection.displayName = "BalanceSection";

export default BalanceSection;
