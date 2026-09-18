import { useRouter } from "expo-router";
import { Store } from "lucide-react-native";
import React, { useCallback } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { formatUnits } from "viem/utils";
import type { TTransaction } from "@/api/types/transaction";
import { formatDate } from "@/utils/dateUtils";
import { formatTokenAmount } from "@/utils/helperUtils";
import Chip from "../common/Chip";
import { PAYMENT_STATUS_CHIP } from "./paymentStatusChip";

const PaymentCard = React.memo(
  ({ transaction }: { transaction: TTransaction }) => {
    const router = useRouter();

    const handleCardPress = useCallback(() => {
      router.push({
        pathname: "/activity-detail",
        params: { paymentId: transaction.id },
      });
    }, [router, transaction.id]);

    const merchantName = transaction.merchantName ?? "Merchant";
    const chip = PAYMENT_STATUS_CHIP[transaction.status];

    const tokenAmount = (() => {
      if (!transaction.amount) return "0";
      try {
        const formatted = formatUnits(
          BigInt(transaction.amount),
          transaction.token.decimals as number,
        );
        return formatTokenAmount(formatted);
      } catch (error) {
        console.warn("Error formatting amount:", error);
        return transaction.amount;
      }
    })();

    return (
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={handleCardPress}
        className="bg-white rounded-xl shadow-sm w-full p-5 gap-3"
      >
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <View className="bg-light-main-container p-2 rounded-md">
              <Store size={18} stroke="#c71c4b" />
            </View>
            <View>
              <Text className="text-light-matte-black font-medium text-sm">
                Payment
              </Text>
              <Text className="text-light-matte-black/50 text-xs">
                {formatDate({ date: transaction.createdAt, preset: "short" })}
              </Text>
            </View>
          </View>
          <Chip
            label={chip.label}
            color={chip.color}
            backgroundColor={chip.bg}
            size="small"
          />
        </View>

        <View>
          <Text className="text-light-matte-black text-xs">Merchant</Text>
          <Text
            className="text-light-matte-black font-semibold text-sm"
            numberOfLines={1}
          >
            {merchantName}
          </Text>
        </View>

        <View className="pt-1">
          <Text className="text-light-matte-black text-xs">Amount</Text>
          <Text className="text-light-primary-red font-bold text-md">
            {tokenAmount} {transaction.token.symbol}
          </Text>
          {transaction?.amountInFiat ? (
            <Text className="text-light-matte-black text-sm">
              ≈ {transaction.fiatCurrency} {transaction.amountInFiat.toString()}
            </Text>
          ) : null}
        </View>

        <View className="border-t border-gray-200 mt-2 pt-2">
          <Text className="text-light-matte-black text-xs">Chain</Text>
          <Text className="text-light-matte-black text-sm">
            {transaction.token.blockchain.name}
          </Text>
        </View>
      </TouchableOpacity>
    );
  },
);

PaymentCard.displayName = "PaymentCard";

export default PaymentCard;
