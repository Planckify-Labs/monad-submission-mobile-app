import { openBrowserAsync } from "expo-web-browser";
import { Clock, Copy, ExternalLink, Store } from "lucide-react-native";
import React, { useCallback } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import type { TPaymentTransactionDetail } from "@/api/types/transaction";
import { PAYMENT_STATUS_CHIP } from "@/components/activities/paymentStatusChip";
import Chip from "@/components/common/Chip";
import { formatDate } from "@/utils/dateUtils";
import { copyToClipboard } from "@/utils/helperUtils";
import { formatExactTokenAmount } from "@/utils/tokenAmount";
import { buildExplorerTxUrl, truncateAddress } from "@/utils/walletUtils";

interface MerchantPaymentDetailCardProps {
  payment: TPaymentTransactionDetail;
}

const formatIdrMinor = (minor: number): string => {
  const s = Math.max(0, Math.floor(minor)).toString();
  const groups: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    groups.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return `Rp ${groups.join(".")}`;
};

const MerchantPaymentDetailCard = React.memo(
  ({ payment }: MerchantPaymentDetailCardProps) => {
    const openBlockExplorer = useCallback(() => {
      if (payment.txHash && payment.token?.blockchain?.blockExplorer) {
        openBrowserAsync(
          buildExplorerTxUrl(
            payment.token.blockchain.blockExplorer,
            payment.txHash,
          ),
        );
      }
    }, [payment.txHash, payment.token?.blockchain?.blockExplorer]);

    const formattedDate = formatDate({
      date: payment.createdAt,
      preset: "short",
    });

    const amount = formatExactTokenAmount(
      payment.amount,
      payment.token?.decimals,
    );

    const merchantName =
      payment.intent?.merchant?.displayName ??
      payment.merchantName ??
      "Merchant";

    return (
      <View className="mt-4">
        <View className="bg-gradient-to-r from-light-main-container to-white rounded-2xl p-5 border border-gray-100">
          <View className="bg-white rounded-2xl p-5 border border-gray-100">
            <View className="flex-row items-center justify-between mb-4">
              <View className="flex-row items-center gap-3">
                <View className="bg-light-primary-red/10 p-3 rounded-2xl">
                  <Store size={24} color="#c71c4b" />
                </View>
                <View className="flex-1">
                  <Text className="text-light-matte-black font-bold text-xl tracking-tight">
                    Payment Details
                  </Text>
                  <View className="h-1 bg-light-primary-red/20 rounded-full mt-1 w-16" />
                </View>
              </View>
            </View>

            <View className="flex-row items-center gap-2 mb-4 bg-light-main-container/50 p-3 rounded-xl">
              <Clock size={16} color="#c71c4b" />
              <Text className="text-light-matte-black/70 text-sm font-medium">
                {formattedDate}
              </Text>
            </View>

            <View className="flex-row justify-between items-center mb-4 pt-2 border-t border-gray-100">
              <Text className="text-light-matte-black/40 text-xs font-semibold uppercase tracking-wider">
                Payment Information
              </Text>
              <View className="flex-row space-x-1">
                <View className="w-2 h-2 bg-light-primary-red/30 rounded-full" />
                <View className="w-2 h-2 bg-light-primary-red/50 rounded-full" />
                <View className="w-2 h-2 bg-light-primary-red rounded-full" />
              </View>
            </View>

            <View className="space-y-3 mb-4">
              <View className="flex-row justify-between items-center">
                <Text className="text-light-matte-black font-medium text-sm">
                  Merchant
                </Text>
                <Text className="text-light-matte-black/70 text-sm font-semibold">
                  {merchantName}
                </Text>
              </View>

              {payment.intent?.merchant?.country && (
                <View className="flex-row justify-between items-center">
                  <Text className="text-light-matte-black font-medium text-sm">
                    Country
                  </Text>
                  <Text className="text-light-matte-black/70 text-sm">
                    {payment.intent.merchant.country}
                  </Text>
                </View>
              )}

              <View className="flex-row justify-between items-center">
                <Text className="text-light-matte-black font-medium text-sm">
                  Amount
                </Text>
                <Text className="text-light-matte-black/70 text-sm">
                  {amount} {payment.token?.symbol}
                </Text>
              </View>

              {payment.intent ? (
                <View className="flex-row justify-between items-center">
                  <Text className="text-light-matte-black font-medium text-sm">
                    Fiat Value
                  </Text>
                  <Text className="text-light-matte-black/70 text-sm">
                    {formatIdrMinor(payment.intent.fiatAmountMinor)}
                  </Text>
                </View>
              ) : payment.amountInFiat ? (
                <View className="flex-row justify-between items-center">
                  <Text className="text-light-matte-black font-medium text-sm">
                    Fiat Value
                  </Text>
                  <Text className="text-light-matte-black/70 text-sm">
                    {payment.fiatCurrency} {payment.amountInFiat}
                  </Text>
                </View>
              ) : null}

              <View className="flex-row justify-between items-center">
                <Text className="text-light-matte-black font-medium text-sm">
                  Status
                </Text>
                <Chip
                  label={PAYMENT_STATUS_CHIP[payment.status].label}
                  color={PAYMENT_STATUS_CHIP[payment.status].color}
                  backgroundColor={PAYMENT_STATUS_CHIP[payment.status].bg}
                  size="small"
                />
              </View>
            </View>

            {payment.txHash && (
              <View className="mb-4">
                <Text className="text-light-matte-black font-medium text-sm mb-2">
                  Transaction Hash
                </Text>
                <View className="flex-row items-center gap-2 bg-light-main-container p-3 rounded-xl">
                  <Text
                    className="text-light-matte-black/70 text-sm flex-1 font-mono"
                    numberOfLines={1}
                  >
                    {payment.txHash}
                  </Text>
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={() =>
                      copyToClipboard(payment.txHash || "", "Transaction hash")
                    }
                    className="p-1"
                  >
                    <Copy size={16} color="#c71c4b" />
                  </TouchableOpacity>
                  {payment.token?.blockchain?.blockExplorer && (
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={openBlockExplorer}
                      className="p-1"
                    >
                      <ExternalLink size={16} color="#c71c4b" />
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}

            <View className="space-y-4 mb-4">
              {payment.senderAddress && (
                <View>
                  <Text className="text-light-matte-black font-semibold text-sm mb-2">
                    From (Your Wallet)
                  </Text>
                  <View className="flex-row items-center gap-2 bg-light-main-container p-4 rounded-xl">
                    <Text className="text-light-matte-black/80 text-sm flex-1 font-mono font-medium">
                      {truncateAddress({ address: payment.senderAddress })}
                    </Text>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() =>
                        copyToClipboard(payment.senderAddress, "Sender address")
                      }
                    >
                      <Copy size={16} color="#c71c4b" />
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {payment.recipientAddress && (
                <View>
                  <Text className="text-light-matte-black font-semibold text-sm mb-2">
                    To (Merchant Treasury)
                  </Text>
                  <View className="flex-row items-center gap-2 p-4 rounded-xl bg-light-main-container">
                    <Text className="text-light-matte-black/80 text-sm flex-1 font-mono font-medium">
                      {truncateAddress({ address: payment.recipientAddress })}
                    </Text>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() =>
                        copyToClipboard(
                          payment.recipientAddress,
                          "Merchant address",
                        )
                      }
                    >
                      <Copy size={16} color="#c71c4b" />
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>

            <View className="border-t border-gray-100 pt-4">
              <View className="flex-row justify-between items-center mb-2">
                <Text className="text-light-matte-black font-medium text-sm">
                  Token
                </Text>
                <Text className="text-light-matte-black/70 text-sm">
                  {payment.token?.name} ({payment.token?.symbol})
                </Text>
              </View>

              <View className="flex-row justify-between items-center">
                <Text className="text-light-matte-black font-medium text-sm">
                  Network
                </Text>
                <Text className="text-light-matte-black/70 text-sm">
                  {payment.token?.blockchain?.name}
                </Text>
              </View>
            </View>
          </View>
        </View>
      </View>
    );
  },
);

MerchantPaymentDetailCard.displayName = "MerchantPaymentDetailCard";

export default MerchantPaymentDetailCard;
