import { Store } from "lucide-react-native";
import React from "react";
import { Text, View } from "react-native";
import type { TPaymentTransactionDetail } from "@/api/types/transaction";

import { formatExactTokenAmount } from "@/utils/tokenAmount";

interface MerchantPaymentHeadingProps {
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

export default function MerchantPaymentHeading({
  payment,
}: MerchantPaymentHeadingProps) {
  // Full precision on purpose: this is a receipt, so the hero figure has
  // to match the Amount row in the card below it exactly.
  const amount = formatExactTokenAmount(
    payment.amount,
    payment.token?.decimals,
  );

  const merchantName =
    payment.intent?.merchant?.displayName ?? payment.merchantName ?? "Merchant";

  return (
    <View className="items-center mb-6">
      <View className="w-24 h-24 rounded-3xl mb-4 items-center justify-center bg-light-primary-red/10">
        <Store size={40} color="#c71c4b" />
      </View>

      <Text className="text-light-primary-red font-extrabold text-2xl text-center">
        {amount} {payment.token?.symbol}
      </Text>
      <Text className="text-light-matte-black font-bold text-base text-center">
        {merchantName}
      </Text>
      {payment.intent ? (
        <Text className="text-light-matte-black/70 text-sm mt-2 text-center">
          ≈ {formatIdrMinor(payment.intent.fiatAmountMinor)}
        </Text>
      ) : payment.amountInFiat ? (
        <Text className="text-light-matte-black/70 text-sm mt-2 text-center">
          ≈ {payment.fiatCurrency} {payment.amountInFiat}
        </Text>
      ) : null}
    </View>
  );
}
