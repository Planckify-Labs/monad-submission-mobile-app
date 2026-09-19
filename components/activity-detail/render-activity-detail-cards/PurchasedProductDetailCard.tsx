import { Image } from "expo-image";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import {
  CheckCircle,
  Clock,
  Copy,
  CreditCard,
  ExternalLink,
  Link,
  Package,
  XCircle,
} from "lucide-react-native";
import { Text, TouchableOpacity, View } from "react-native";
import { formatUnits } from "viem";
import type { TPurchaseResponse } from "@/api/types/purchase";
import type { TRedemptionDetail } from "@/api/types/redeem";
import { formatCurrency } from "@/utils/currencyUtils";
import { formatDate } from "@/utils/dateUtils";
import {
  fulfilmentStatusLabel,
  moneyStatusLabel,
} from "@/utils/fulfilmentUtils";
import { copyToClipboard } from "@/utils/helperUtils";
import { truncateAddress } from "@/utils/walletUtils";
import DeliveryCard from "./DeliveryCard";
import FulfilmentTimeline from "./FulfilmentTimeline";

/** Re-open checkout for the same variant with the same inputs. */
function retryWithPoints(variantId: string, customerInfo: unknown) {
  router.push({
    pathname: "/payment",
    params: {
      variantId,
      customerInfo: JSON.stringify(customerInfo ?? []),
    },
  });
}

/** Status glyph/colour keyed by either leg's status. */
function statusIcon(status: string) {
  switch (status) {
    case "COMPLETED":
    case "CONFIRMED":
    case "DELIVERED":
      return <CheckCircle size={16} color="#10b981" />;
    case "PENDING":
    case "PROCESSING":
    case "QUEUED":
    case "SUBMITTED":
    case "DELAYED":
    case "NEEDS_RECONCILE":
      return <Clock size={16} color="#f59e0b" />;
    case "FAILED":
    case "REFUNDED":
      return <XCircle size={16} color="#ef4444" />;
    default:
      return <Clock size={16} color="#6b7280" />;
  }
}

function statusColor(status: string) {
  switch (status) {
    case "COMPLETED":
    case "CONFIRMED":
    case "DELIVERED":
      return "text-emerald-600";
    case "PENDING":
    case "PROCESSING":
    case "QUEUED":
    case "SUBMITTED":
    case "DELAYED":
    case "NEEDS_RECONCILE":
      return "text-yellow-600";
    case "FAILED":
    case "REFUNDED":
      return "text-red-600";
    default:
      return "text-gray-600";
  }
}

function RedemptionDetailCard({
  redemption,
}: {
  redemption: TRedemptionDetail;
}) {
  const redemptionLabel = redemption.fulfilment
    ? fulfilmentStatusLabel(redemption.fulfilment.status)
    : moneyStatusLabel(redemption.status);
  const redemptionStatus = redemption.fulfilment?.status ?? redemption.status;

  return (
    <View className="gap-4 p-4">
      <FulfilmentTimeline
        kind="redemption"
        fulfilment={redemption.fulfilment}
        moneyStatus={redemption.status}
        onRetryWithPoints={() =>
          retryWithPoints(
            redemption.product.variant.id,
            redemption.customerInfo,
          )
        }
      />

      <DeliveryCard
        fulfilment={redemption.fulfilment}
        legacyVoucherCode={redemption.voucherCode}
        customerInfo={redemption.customerInfo}
      />

      <View className="bg-white rounded-2xl p-4 shadow-sm">
        <Text className="text-light-matte-black font-bold text-lg mb-4">
          Redemption Details
        </Text>

        <View className="bg-light-main-container/35 rounded-xl p-4 mb-4 border-l-4 border-light-primary-red">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-light-matte-black font-medium text-base">
              Redemption #{redemption.id.slice(-8).toUpperCase()}
            </Text>
            <View className="flex-row items-center">
              {statusIcon(redemptionStatus)}
              <Text
                className={`ml-1 font-medium text-sm ${statusColor(redemptionStatus)}`}
              >
                {redemptionLabel}
              </Text>
            </View>
          </View>
          <View className="mt-3">
            <View>
              <Text className="text-light-matte-black/60 text-xs mb-1">
                Redemption ID
              </Text>
              <View className="flex-row items-center justify-between bg-white rounded-lg p-2">
                <Text
                  className="text-light-matte-black text-xs font-mono flex-1"
                  numberOfLines={1}
                >
                  {redemption.id}
                </Text>
                <TouchableOpacity
                  onPress={() =>
                    copyToClipboard(redemption.id, "Redemption ID")
                  }
                  className="ml-2 p-1"
                >
                  <Copy size={12} color="#c71c4b" />
                </TouchableOpacity>
              </View>
            </View>
            {redemption.vendorRefId && (
              <View className="mt-2">
                <Text className="text-light-matte-black/60 text-xs mb-1">
                  Reference
                </Text>
                <View className="flex-row items-center justify-between bg-white rounded-lg p-2">
                  <Text
                    className="text-light-matte-black text-xs font-mono flex-1"
                    numberOfLines={1}
                  >
                    {redemption.vendorRefId}
                  </Text>
                  <TouchableOpacity
                    onPress={() =>
                      copyToClipboard(redemption.vendorRefId!, "Reference")
                    }
                    className="ml-2 p-1"
                  >
                    <Copy size={12} color="#c71c4b" />
                  </TouchableOpacity>
                </View>
              </View>
            )}
            <View className="flex-row justify-between items-center mt-2">
              <Text className="text-light-matte-black/60 text-xs">
                Date & Time
              </Text>
              <Text className="text-light-matte-black text-xs">
                {formatDate({ date: redemption.createdAt, preset: "long" })}
              </Text>
            </View>
          </View>
        </View>

        <View className="bg-light-main-container/35 rounded-xl p-4 mb-4">
          <View className="flex-row items-center mb-3">
            <Package size={16} color="#c71c4b" />
            <Text className="text-light-matte-black font-medium text-sm ml-2">
              Item Details
            </Text>
          </View>
          <View>
            <View className="flex-row justify-between items-start mb-2">
              <Text className="text-light-matte-black/60 text-sm flex-1">
                Name
              </Text>
              <Text className="text-light-matte-black text-sm font-medium flex-2 text-right">
                {redemption.product.name}
              </Text>
            </View>
            <View className="flex-row justify-between items-start">
              <Text className="text-light-matte-black/60 text-sm flex-1">
                Variant
              </Text>
              <Text className="text-light-matte-black text-sm font-medium flex-2 text-right">
                {redemption.product.variant.name}
              </Text>
            </View>
          </View>
        </View>

        <View className="bg-light-main-container/35 rounded-xl p-4">
          <View className="flex-row items-center mb-3">
            <CreditCard size={16} color="#c71c4b" />
            <Text className="text-light-matte-black font-medium text-sm ml-2">
              Points Summary
            </Text>
          </View>
          <View>
            <View className="flex-row justify-between items-center mb-2">
              <Text className="text-light-matte-black/60 text-sm">
                Points Spent
              </Text>
              <Text className="text-light-primary-red font-bold text-sm">
                {Number(redemption.pointsSpent).toLocaleString()} points
              </Text>
            </View>
          </View>
        </View>

        {redemption.customerInfo &&
          (() => {
            const entries = Array.isArray(redemption.customerInfo)
              ? redemption.customerInfo
              : Object.entries(redemption.customerInfo).map(([key, value]) => ({
                  key,
                  value,
                }));
            return entries.length > 0 ? (
              <View className="bg-light-main-container/35 rounded-xl p-4 mt-4">
                <View className="flex-row items-center mb-3">
                  <Package size={16} color="#c71c4b" />
                  <Text className="text-light-matte-black font-medium text-sm ml-2">
                    Customer Info
                  </Text>
                </View>
                {entries.map(({ key, value }) => (
                  <View
                    key={key}
                    className="flex-row justify-between items-center mb-1"
                  >
                    <Text className="text-light-matte-black/60 text-sm capitalize">
                      {key}
                    </Text>
                    <Text className="text-light-matte-black text-sm font-medium">
                      {String(value)}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null;
          })()}
      </View>
    </View>
  );
}

export default function PurchasedProductDetailCard({
  purchase,
  redemption,
}: {
  purchase?: TPurchaseResponse;
  redemption?: TRedemptionDetail;
}) {
  if (redemption) {
    return <RedemptionDetailCard redemption={redemption} />;
  }

  if (!purchase) return null;
  const openBlockchainExplorer = async (
    txHash: string,
    explorerUrl: string,
  ) => {
    const url = `${explorerUrl}/tx/${txHash}`;
    await WebBrowser.openBrowserAsync(url);
  };

  const purchaseLabel = purchase.fulfilment
    ? fulfilmentStatusLabel(purchase.fulfilment.status)
    : moneyStatusLabel(purchase.status);
  const purchaseStatus = purchase.fulfilment?.status ?? purchase.status;

  return (
    <View className="gap-4 p-4">
      <FulfilmentTimeline
        kind="purchase"
        fulfilment={purchase.fulfilment}
        moneyStatus={purchase.status}
        onRetryWithPoints={() =>
          retryWithPoints(
            purchase.productVariantId,
            purchase.booking?.customerInfo,
          )
        }
      />

      <DeliveryCard
        fulfilment={purchase.fulfilment}
        legacyVoucherCode={purchase.voucherCode}
        customerInfo={purchase.booking?.customerInfo}
      />

      <View className="bg-white rounded-2xl p-4 shadow-sm">
        <Text className="text-light-matte-black font-bold text-lg mb-4">
          Purchase Details
        </Text>

        <View className="bg-light-main-container/35 rounded-xl p-4 mb-4 border-l-4 border-light-primary-red">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-light-matte-black font-medium text-base">
              Purchase #{purchase.refId.slice(-8).toUpperCase()}
            </Text>
            <View className="flex-row items-center">
              {statusIcon(purchaseStatus)}
              <Text
                className={`ml-1 font-medium text-sm ${statusColor(purchaseStatus)}`}
              >
                {purchaseLabel}
              </Text>
            </View>
          </View>
          <View className="mt-3 space-y-1">
            <View>
              <Text className="text-light-matte-black/60 text-xs mb-1">
                Purchase ID
              </Text>
              <View className="flex-row items-center justify-between bg-white rounded-lg p-2">
                <Text
                  className="text-light-matte-black text-xs font-mono flex-1"
                  numberOfLines={1}
                >
                  {purchase.id}
                </Text>
                <TouchableOpacity
                  onPress={() => copyToClipboard(purchase.id, "Purchase ID")}
                  className="ml-2 p-1"
                >
                  <Copy size={12} color="#c71c4b" />
                </TouchableOpacity>
              </View>
            </View>
            <View>
              <Text className="text-light-matte-black/60 text-xs mb-1">
                Reference ID
              </Text>
              <View className="flex-row items-center justify-between bg-white rounded-lg p-2">
                <Text
                  className="text-light-matte-black text-xs font-mono flex-1"
                  numberOfLines={1}
                >
                  {purchase.refId}
                </Text>
                <TouchableOpacity
                  onPress={() =>
                    copyToClipboard(purchase.refId, "Reference ID")
                  }
                  className="ml-2 p-1"
                >
                  <Copy size={12} color="#c71c4b" />
                </TouchableOpacity>
              </View>
            </View>
            <View className="flex-row justify-between items-center">
              <Text className="text-light-matte-black/60 text-xs">
                Date & Time
              </Text>
              <Text className="text-light-matte-black text-xs">
                {formatDate({ date: purchase.createdAt, preset: "long" })}
              </Text>
            </View>
          </View>
        </View>

        <View className="bg-light-main-container/35 rounded-xl p-4 mb-4">
          <View className="flex-row items-center mb-3">
            <Package size={16} color="#c71c4b" />
            <Text className="text-light-matte-black font-medium text-sm ml-2">
              Item Details
            </Text>
          </View>

          <View className="space-y-2">
            <View className="flex-row justify-between items-start">
              <Text className="text-light-matte-black/60 text-sm flex-1">
                Product
              </Text>
              <Text className="text-light-matte-black text-sm font-medium flex-2 text-right">
                {purchase.productVariant.product.name}
              </Text>
            </View>

            <View className="flex-row justify-between items-start">
              <Text className="text-light-matte-black/60 text-sm flex-1">
                Variant
              </Text>
              <Text className="text-light-matte-black text-sm font-medium flex-2 text-right">
                {purchase.productVariant.name}
              </Text>
            </View>
          </View>
        </View>

        <View className="bg-light-main-container/35 rounded-xl p-4 mb-4">
          <View className="flex-row items-center mb-3">
            <CreditCard size={16} color="#c71c4b" />
            <Text className="text-light-matte-black font-medium text-sm ml-2">
              Transaction Details
            </Text>
          </View>

          <View className="space-y-2">
            <View className="flex-row justify-between items-center">
              <Text className="text-light-matte-black/60 text-sm">
                Amount Paid
              </Text>
              <View className="flex-row items-center">
                <View className="w-5 h-5 rounded-full mr-2 items-center justify-center overflow-hidden">
                  <Image
                    source={{ uri: purchase.transaction.token.logoUrl }}
                    className="w-full h-full"
                    contentFit="cover"
                  />
                </View>
                <Text className="text-light-primary-red font-bold text-sm">
                  {formatUnits(
                    BigInt(purchase.transaction.amount),
                    purchase.transaction.token.decimals,
                  )}{" "}
                  {purchase.transaction.token.symbol}
                </Text>
              </View>
            </View>

            <View className="flex-row justify-between items-center">
              <Text className="text-light-matte-black/60 text-sm">
                Fiat Amount
              </Text>
              <Text className="text-light-matte-black text-sm font-medium">
                {formatCurrency({
                  amount: purchase.transaction.amountInFiat,
                  currency: purchase.transaction.fiatCurrency,
                })}
              </Text>
            </View>

            <View className="flex-row justify-between items-center">
              <Text className="text-light-matte-black/60 text-sm">Network</Text>
              <Text className="text-light-matte-black text-sm font-medium">
                {purchase.transaction.token.blockchain.name}
              </Text>
            </View>

            <View className="flex-row justify-between items-center">
              <Text className="text-light-matte-black/60 text-sm">
                Token Address
              </Text>
              <TouchableOpacity
                onPress={() =>
                  copyToClipboard(
                    purchase.transaction.token.contractAddress,
                    "Contract address",
                  )
                }
                className="flex-row items-center"
              >
                <Text className="text-light-matte-black text-sm font-mono mr-1">
                  {truncateAddress({
                    address: purchase.transaction.token.contractAddress,
                    preset: "medium",
                  })}
                </Text>
                <Copy size={12} color="#c71c4b" />
              </TouchableOpacity>
            </View>

            <View className="h-px bg-light-matte-black/10 my-2" />

            <View className="flex-row justify-between items-center">
              <Text className="text-light-matte-black font-medium">
                Transaction Status
              </Text>
              <View className="flex-row items-center">
                {statusIcon(purchase.transaction.status)}
                <Text
                  className={`ml-1 font-medium text-sm ${statusColor(purchase.transaction.status)}`}
                >
                  {moneyStatusLabel(purchase.transaction.status)}
                </Text>
              </View>
            </View>
          </View>
        </View>

        <View className="bg-light-main-container/35 rounded-xl p-4">
          <View className="flex-row items-center mb-3">
            <Link size={16} color="#c71c4b" />
            <Text className="text-light-matte-black font-medium text-sm ml-2">
              Transaction Details
            </Text>
          </View>

          <View className="space-y-3">
            <View>
              <Text className="text-light-matte-black/60 text-xs mb-1">
                Transaction Hash
              </Text>
              <View className="flex-row items-center justify-between bg-white rounded-lg p-3">
                <Text
                  className="text-light-matte-black text-xs font-mono flex-1"
                  numberOfLines={1}
                >
                  {purchase.transaction.txHash}
                </Text>
                <View className="flex-row ml-2">
                  <TouchableOpacity
                    onPress={() =>
                      copyToClipboard(
                        purchase.transaction.txHash,
                        "Transaction hash",
                      )
                    }
                    className="mr-2 p-1"
                  >
                    <Copy size={14} color="#c71c4b" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() =>
                      openBlockchainExplorer(
                        purchase.transaction.txHash,
                        purchase.transaction.token.blockchain.blockExplorer,
                      )
                    }
                    className="p-1"
                  >
                    <ExternalLink size={14} color="#c71c4b" />
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            <View>
              <Text className="text-light-matte-black/60 text-xs mb-1">
                From Address
              </Text>
              <View className="flex-row items-center justify-between bg-white rounded-lg p-3">
                <Text
                  className="text-light-matte-black text-xs font-mono flex-1"
                  numberOfLines={1}
                >
                  {purchase.transaction.senderAddress}
                </Text>
                <TouchableOpacity
                  onPress={() =>
                    copyToClipboard(
                      purchase.transaction.senderAddress,
                      "Sender address",
                    )
                  }
                  className="ml-2 p-1"
                >
                  <Copy size={14} color="#c71c4b" />
                </TouchableOpacity>
              </View>
            </View>
            <View>
              <Text className="text-light-matte-black/60 text-xs mb-1">
                To Address
              </Text>
              <View className="flex-row items-center justify-between bg-white rounded-lg p-3">
                <Text
                  className="text-light-matte-black text-xs font-mono flex-1"
                  numberOfLines={1}
                >
                  {purchase.transaction.recipientAddress}
                </Text>
                <TouchableOpacity
                  onPress={() =>
                    copyToClipboard(
                      purchase.transaction.recipientAddress,
                      "Recipient address",
                    )
                  }
                  className="ml-2 p-1"
                >
                  <Copy size={14} color="#c71c4b" />
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}
