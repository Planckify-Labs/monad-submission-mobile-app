import { router } from "expo-router";
import { ArrowLeft, ChevronDown, Wallet } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import {
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { formatUnits } from "viem";
import { TToken } from "@/api/types/token";
import ChainSelector from "@/components/common/ChainSelector";
import LoadinngSpinnerPopup from "@/components/common/LoadinngSpinnerPopup";
import TokenSelectorModal from "@/components/wallet/TokenSelectorModal";
import WalletSelectorModal from "@/components/wallet/WalletSelectorModal";
import { assertEvmChain } from "@/constants/configs/chainConfig";
import { useBlockchains } from "@/hooks/queries/useBlockchains";
import { useTokens } from "@/hooks/queries/useTokens";
import { useWallet } from "@/hooks/useWallet";

const PAYMENT_PLATFORMS = [
  { id: "ovo", name: "OVO" },
  { id: "dana", name: "DANA" },
  { id: "gopay", name: "GoPay" },
  { id: "linkaja", name: "Link aja" },
];

const QUICK_AMOUNTS = ["10", "50", "100", "250", "500"];

export default function Withdraw() {
  const {
    wallets,
    activeWallet,
    activeWalletIndex,
    setActiveWallet,
    getPublicClientForActiveChain,
    activeChain: rawActiveChain,
  } = useWallet();

  // TODO(task-13): replace `activeChain.chain.*` reach-through with
  // namespace-aware kit accessor.
  const activeChain = assertEvmChain(rawActiveChain);

  const { data: blockchains } = useBlockchains();

  const activeBackendChain = React.useMemo(
    () => blockchains?.find((b) => b.chainId === activeChain.chain.id) || null,
    [blockchains, activeChain.chain.id],
  );

  const { data: stablecoinTokens } = useTokens({
    isStablecoin: true,
    isActive: true,
    blockchainId: activeBackendChain?.id,
  });

  const [selectedPlatform, setSelectedPlatform] = useState(
    PAYMENT_PLATFORMS[0],
  );
  const [phoneNumber, setPhoneNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [balance, setBalance] = useState<bigint>(BigInt(0));
  const [walletModalVisible, setWalletModalVisible] = useState(false);
  const [tokenModalVisible, setTokenModalVisible] = useState(false);
  const [isLoadingBalance, setIsLoadingBalance] = useState(true);
  const [selectedToken, setSelectedToken] = useState<TToken>();
  const [transactionStatus, setTransactionStatus] = useState("");

  useEffect(() => {
    const fetchBalance = async () => {
      if (!activeWallet.address) return;

      setIsLoadingBalance(true);
      try {
        const publicClient = getPublicClientForActiveChain();
        if (!publicClient) return;

        const balanceValue = await publicClient.getBalance({
          address: activeWallet.address as `0x${string}`,
        });

        setBalance(balanceValue);
      } catch (error) {
        console.error("Error fetching balance:", error);
        console.error("Error: Failed to fetch wallet balance");
      } finally {
        setIsLoadingBalance(false);
      }
    };

    fetchBalance();
  }, [activeWallet, getPublicClientForActiveChain]);

  useEffect(() => {
    if (stablecoinTokens && stablecoinTokens.length > 0) {
      if (
        !selectedToken ||
        !stablecoinTokens.some((token) => token.id === selectedToken.id)
      ) {
        setSelectedToken(stablecoinTokens[0]);
      }
    } else {
      setSelectedToken(undefined);
    }
  }, [stablecoinTokens, selectedToken]);

  const handleSelectWallet = (index: number) => {
    setActiveWallet(index);
    setWalletModalVisible(false);
  };

  const handleSelectToken = (token: TToken) => {
    setSelectedToken(token);
    setTokenModalVisible(false);
  };

  const handleMaxAmount = useCallback(() => {
    if (isLoadingBalance) return;

    const formattedBalance = formatUnits(balance, 18);
    setAmount(parseFloat(formattedBalance).toString());
  }, [balance, isLoadingBalance]);

  const handleQuickAmount = (value: string) => {
    setAmount(value);
  };

  const validateInputs = useCallback(() => {
    if (!phoneNumber.trim()) {
      console.error("Error: Please enter a phone number");
      return false;
    }

    if (!amount || parseFloat(amount) <= 0) {
      console.error("Error: Please enter a valid amount");
      return false;
    }

    try {
      const amountValue = parseFloat(amount);
      const balanceValue = parseFloat(formatUnits(balance, 18));

      if (amountValue > balanceValue) {
        console.error("Insufficient Balance: You don't have enough funds");
        return false;
      }
    } catch (error) {
      console.error("Error validating inputs:", error);
      console.error("Error: Invalid amount format");
      return false;
    }

    return true;
  }, [phoneNumber, amount, balance]);

  const handleWithdraw = useCallback(async () => {
    if (!validateInputs()) return;

    setIsLoading(true);
    setTransactionStatus("Preparing withdrawal...");

    try {
      setTransactionStatus("Processing withdrawal request...");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      setTransactionStatus("Confirming with payment provider...");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      setTransactionStatus("Finalizing transaction...");
      await new Promise((resolve) => setTimeout(resolve, 1000));

      console.log(
        "Withdrawal Successful:",
        `You have successfully withdrawn ${amount} ${selectedToken?.symbol || "tokens"} to ${selectedPlatform.name} account ${phoneNumber}`,
      );
      router.back();
    } catch (error) {
      console.error("Withdrawal error:", error);
      console.error(
        "Withdrawal Failed: An error occurred during the withdrawal process",
      );
    } finally {
      setIsLoading(false);
    }
  }, [amount, phoneNumber, selectedPlatform, selectedToken, validateInputs]);

  const formatBalance = (rawBalance: bigint) => {
    return parseFloat(formatUnits(rawBalance, 18)).toFixed(4);
  };

  const { bottom } = useSafeAreaInsets();
  const bottomOffset = Platform.OS === "ios" ? 0 : bottom > 0 ? bottom : 0;
  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView
        className="flex-1 bg-light-main-container"
        edges={["top"]}
        style={{ paddingBottom: bottomOffset }}
      >
        <View className="flex-1 p-6 pb-0">
          <View className="flex-row items-center mb-6">
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => router.back()}
              className="mr-4"
            >
              <ArrowLeft color="#c71c4b" size={24} />
            </TouchableOpacity>
            <Text className="text-light-matte-black text-xl font-bold">
              Withdraw
            </Text>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            <View className="bg-light rounded-xl mb-6 shadow-sm">
              <View className="mb-6 p-5">
                <Text className="text-light-matte-black/70 mb-2">From</Text>
                <TouchableOpacity
                  activeOpacity={0.7}
                  className="bg-light-main-container p-4 rounded-xl flex-row items-center justify-between"
                  onPress={() => setWalletModalVisible(true)}
                >
                  <View>
                    <Text className="text-light-matte-black font-medium">
                      {activeWallet.name || "My Wallet"}
                    </Text>
                    <Text className="text-light-matte-black/60 text-xs">
                      {activeWallet?.address?.substring(0, 6)}...
                      {activeWallet?.address?.substring(
                        activeWallet.address.length - 4,
                      )}
                    </Text>
                  </View>
                  <ChevronDown size={20} color="#c71c4b" />
                </TouchableOpacity>

                <View className="flex-row items-center justify-between mt-2">
                  <Text className="text-light-matte-black/60 text-xs">
                    Balance:{" "}
                    {isLoadingBalance
                      ? "Loading..."
                      : `${formatBalance(balance)} ${getPublicClientForActiveChain()?.chain?.nativeCurrency.symbol}`}
                  </Text>
                  <ChainSelector />
                </View>
              </View>

              <View className="mb-6 p-5">
                <Text className="text-light-matte-black/70 mb-2">Token</Text>
                <TouchableOpacity
                  activeOpacity={0.7}
                  className="bg-light-main-container p-4 rounded-xl flex-row items-center justify-between"
                  onPress={() => setTokenModalVisible(true)}
                >
                  <Text className="text-light-matte-black font-medium">
                    {selectedToken
                      ? `${selectedToken.symbol} - ${selectedToken.name}`
                      : "Select Token"}
                  </Text>
                  <ChevronDown size={20} color="#c71c4b" />
                </TouchableOpacity>
              </View>

              <View className="mb-6">
                <Text className="text-light-matte-black/70 mb-2 mx-5">
                  To Platform
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  className="mb-4"
                >
                  <View className="mx-5 flex-row gap-2">
                    {PAYMENT_PLATFORMS.map((platform) => (
                      <TouchableOpacity
                        key={platform.id}
                        activeOpacity={0.7}
                        className={`p-3 rounded-xl items-center mr-3 w-24 ${
                          selectedPlatform.id === platform.id
                            ? "bg-light-primary-red/10"
                            : "bg-light-main-container"
                        }`}
                        onPress={() => setSelectedPlatform(platform)}
                      >
                        <View className="w-10 h-10 bg-light-primary-red/10 rounded-full items-center justify-center mb-2">
                          <Wallet size={20} color="#c71c4b" />
                        </View>
                        <Text
                          className={`text-xs font-medium ${
                            selectedPlatform.id === platform.id
                              ? "text-light-primary-red"
                              : "text-light-matte-black"
                          }`}
                        >
                          {platform.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>

                <View className="mx-5">
                  <Text className="text-light-matte-black/70 mb-2">
                    Phone Number
                  </Text>
                  <TextInput
                    className="bg-light-main-container p-4 rounded-xl text-light-matte-black"
                    value={phoneNumber}
                    onChangeText={setPhoneNumber}
                    placeholder="Enter phone number"
                    placeholderTextColor="#20222c80"
                    keyboardType="phone-pad"
                  />
                </View>
              </View>

              <View className="mb-6 p-5">
                <View className="flex-row items-center justify-between mb-2">
                  <Text className="text-light-matte-black/70">Amount</Text>
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={handleMaxAmount}
                  >
                    <Text className="text-light-primary-red text-xs font-medium">
                      MAX
                    </Text>
                  </TouchableOpacity>
                </View>
                <View className="flex-row items-center">
                  <TextInput
                    className="bg-light-main-container p-4 rounded-xl text-light-matte-black flex-1"
                    value={amount}
                    onChangeText={setAmount}
                    placeholder="0.0"
                    placeholderTextColor="#20222c80"
                    keyboardType="decimal-pad"
                  />
                  <Text className="absolute right-4 text-light-matte-black/70">
                    {selectedToken?.symbol || ""}
                  </Text>
                </View>

                <View className="flex-row flex-wrap justify-between mt-3">
                  {QUICK_AMOUNTS.map((quickAmount) => (
                    <TouchableOpacity
                      key={quickAmount}
                      activeOpacity={0.7}
                      className="bg-light-main-container py-2 px-3 rounded-lg mb-2"
                      onPress={() => handleQuickAmount(quickAmount)}
                    >
                      <Text className="text-light-primary-red text-xs font-medium">
                        {quickAmount}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <TouchableOpacity
                activeOpacity={0.7}
                className="bg-light-primary-red p-4 rounded-xl mx-5 mb-5"
                onPress={handleWithdraw}
                disabled={isLoading}
              >
                <Text className="text-white font-bold text-center">
                  {isLoading ? "Processing..." : "Withdraw"}
                </Text>
              </TouchableOpacity>
            </View>

            <View className="bg-light rounded-xl p-5 mb-6 shadow-sm">
              <Text className="text-light-matte-black font-medium mb-3">
                Withdrawal Information
              </Text>
              <Text className="text-light-matte-black/70 text-sm mb-2">
                • Withdrawals are processed within 24 hours
              </Text>
              <Text className="text-light-matte-black/70 text-sm mb-2">
                • Minimum withdrawal amount: 10{" "}
                {selectedToken?.symbol || "tokens"}
              </Text>
              <Text className="text-light-matte-black/70 text-sm mb-2">
                • Withdrawal fee: 1% of the amount
              </Text>
              <Text className="text-light-matte-black/70 text-sm">
                • Make sure the phone number is registered with the selected
                platform
              </Text>
            </View>
          </ScrollView>
        </View>

        <LoadinngSpinnerPopup
          visible={isLoading}
          title="Processing Withdrawal"
          message={transactionStatus}
        />

        <WalletSelectorModal
          visible={walletModalVisible}
          onClose={() => setWalletModalVisible(false)}
          wallets={wallets}
          activeWalletIndex={activeWalletIndex}
          onSelectWallet={handleSelectWallet}
          title="Select Wallet"
        />

        <TokenSelectorModal
          visible={tokenModalVisible}
          onClose={() => setTokenModalVisible(false)}
          selectedToken={selectedToken}
          onSelectToken={handleSelectToken}
          tokens={stablecoinTokens || []}
          title="Select Token"
        />
      </SafeAreaView>
    </>
  );
}
