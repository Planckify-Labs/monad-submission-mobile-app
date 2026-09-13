import { router, useLocalSearchParams } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import type { CustomerInfoItem } from "@/api/types/booking";
import LoadinngSpinnerPopup from "@/components/common/LoadinngSpinnerPopup";
import PaymentErrorModal from "@/components/common/PaymentErrorModal";
import PaymentSuccessModal from "@/components/common/PaymentSuccessModal";
import PinConfirmationModal from "@/components/common/PinConfirmationModal";
import { useIsAuthenticated } from "@/hooks/queries/useAuth";
import { usePointBalance } from "@/hooks/queries/usePoints";
import { useProductVariantById } from "@/hooks/queries/useProducts";
import {
  useExecuteRedemption,
  useRedemptionStatus,
} from "@/hooks/queries/useRedeem";
import { useGoToAuth } from "@/hooks/useGoToAuth";
import { track } from "@/services/analytics/posthog";

export default function PaymentScreen() {
  const [transactionStatus, setTransactionStatus] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [successModalVisible, setSuccessModalVisible] = useState(false);
  const [errorModalVisible, setErrorModalVisible] = useState(false);
  const [paymentError, setPaymentError] = useState<string>("");
  const [redemptionId, setRedemptionId] = useState<string | null>(null);
  const [paymentSuccess, setPaymentSuccess] = useState<{
    productName: string;
    pointsSpent: string;
    redemptionId: string;
  } | null>(null);

  const { variantId, customerInfo } = useLocalSearchParams<{
    variantId: string;
    customerInfo: string;
  }>();

  const parsedCustomerInfo = useMemo<CustomerInfoItem[]>(() => {
    if (!customerInfo) return [];
    try {
      return JSON.parse(customerInfo);
    } catch (error) {
      console.error("Error parsing customer info:", error);
      return [];
    }
  }, [customerInfo]);

  const { isAuthenticated } = useIsAuthenticated();
  const { navigatingToAuth, goToAuth } = useGoToAuth();
  const { data: variantData, isLoading: isLoadingVariant } =
    useProductVariantById(variantId);
  const { data: pointBalance, isFetching: isPointBalanceFetching } =
    usePointBalance();
  const { mutateAsync: executeRedemption } = useExecuteRedemption();

  // Poll redemption status until terminal state
  const { data: redemptionStatus } = useRedemptionStatus(redemptionId);
  // Guards against double-counting on a stray refetch after completion.
  const trackedCompletionRef = useRef(false);

  useEffect(() => {
    if (!redemptionStatus) return;

    if (redemptionStatus.status === "COMPLETED") {
      setIsLoading(false);
      setTransactionStatus("");
      setRedemptionId(null);
      setPaymentSuccess({
        productName: variantData?.name ?? "",
        pointsSpent: redemptionStatus.pointsSpent,
        redemptionId: redemptionStatus.id,
      });
      setSuccessModalVisible(true);
      if (!trackedCompletionRef.current) {
        trackedCompletionRef.current = true;
        track("bill_payment_completed", {
          product_category: variantData?.product?.categoryId,
          points_spent: Number(redemptionStatus.pointsSpent),
        });
      }
    } else if (redemptionStatus.status === "REFUNDED") {
      setIsLoading(false);
      setTransactionStatus("");
      setRedemptionId(null);
      setPaymentError(
        "Your redemption could not be fulfilled. Your points have been returned to your balance.",
      );
      setErrorModalVisible(true);
    } else if (
      redemptionStatus.status === "PENDING" ||
      redemptionStatus.status === "PROCESSING" ||
      redemptionStatus.status === "FAILED"
    ) {
      setTransactionStatus(
        redemptionStatus.status === "PROCESSING"
          ? "Processing your order..."
          : "Submitting your redemption...",
      );
    }
  }, [redemptionStatus, variantData?.name, variantData?.product?.categoryId]);

  const executePayment = useCallback(async () => {
    if (!variantData?.id || !variantData.ProductPrice?.[0]?.id) {
      console.error("Error: Missing variant or price data");
      return;
    }

    // Signed-out is surfaced inline by the primary CTA ("Sign In to
    // Redeem"), so this path is defensive only. Bail quietly if the
    // session lapsed mid-flow instead of hard-redirecting to /auth.
    if (!isAuthenticated) {
      return;
    }

    setIsLoading(true);
    setTransactionStatus("Submitting your redemption...");

    try {
      const result = await executeRedemption({
        productVariantId: variantId,
        productPriceId: variantData.ProductPrice[0].id,
        customerInfo: parsedCustomerInfo,
      });

      // Start polling for status
      setRedemptionId(result.id);
      setTransactionStatus("Processing your order...");
    } catch (error: any) {
      console.error("Redemption error:", error);

      const status = error?.response?.status;
      if (status === 400) {
        const body = await error?.response?.json?.().catch(() => null);
        const message: string = body?.message ?? "";
        if (__DEV__ && message) {
          console.warn("[payment] 400 body.message", message);
        }
        if (message.toLowerCase().includes("insufficient")) {
          setPaymentError(
            "You don't have enough points to complete this redemption. Please deposit more points.",
          );
        } else {
          // Never forward raw server `body.message` — it can carry API
          // configuration / RPC noise the user shouldn't see.
          setPaymentError("Invalid request. Please try again.");
        }
      } else {
        setPaymentError("Redemption failed. Please try again.");
      }

      setIsLoading(false);
      setTransactionStatus("");
      setErrorModalVisible(true);
    }
  }, [
    isAuthenticated,
    variantId,
    variantData,
    parsedCustomerInfo,
    executeRedemption,
  ]);

  const handlePaymentConfirmation = useCallback(() => {
    // Defensive: the Redeem button is swapped for a sign-in CTA while
    // signed out, so this only fires when authenticated. No redirect.
    if (!isAuthenticated) {
      return;
    }
    setPinModalVisible(true);
  }, [isAuthenticated]);

  const handlePinSubmit = useCallback(
    async (_pin: string) => {
      setPinModalVisible(false);
      await executePayment();
    },
    [executePayment],
  );

  const userPoints = parseInt(pointBalance?.balance ?? "0");
  const requiredPoints = variantData?.ProductPrice?.[0]?.sellPrice
    ? parseInt(variantData.ProductPrice[0].sellPrice)
    : 0;
  const hasInsufficientPoints =
    !isPointBalanceFetching &&
    requiredPoints > 0 &&
    userPoints < requiredPoints;

  const buttonDisabled = useMemo(() => {
    return (
      isLoading ||
      isLoadingVariant ||
      !variantData?.id ||
      !variantData?.ProductPrice?.[0]?.id ||
      hasInsufficientPoints
    );
  }, [isLoading, isLoadingVariant, variantData, hasInsufficientPoints]);

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
        <View className="flex-1 px-5 pt-2">
          <View className="flex-row items-center mb-6">
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => router.back()}
              className="mr-4"
            >
              <ArrowLeft color="#c71c4b" size={24} />
            </TouchableOpacity>
            <Text className="text-light-matte-black text-xl font-bold">
              Confirm Redemption
            </Text>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            {hasInsufficientPoints && (
              <View className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-4">
                <Text className="text-red-800 font-medium text-sm mb-1">
                  Insufficient Points
                </Text>
                <Text className="text-red-600 text-sm">
                  You need {requiredPoints.toLocaleString()} points but only
                  have {userPoints.toLocaleString()} points. Please deposit more
                  points to continue.
                </Text>
              </View>
            )}

            <View className="bg-white rounded-2xl p-4 mb-4 shadow-sm">
              <Text className="text-light-matte-black font-bold text-lg mb-3">
                Redemption Details
              </Text>

              <View className="bg-light-main-container/50 rounded-xl p-3 mb-4">
                <View className="flex-row items-center mb-2">
                  <View className="w-12 h-12 bg-light-primary-red/10 rounded-lg mr-3 items-center justify-center overflow-hidden">
                    {variantData?.product?.imageUrl ? (
                      <Image
                        source={{ uri: variantData.product.imageUrl }}
                        className="w-full h-full"
                        resizeMode="cover"
                      />
                    ) : (
                      <Text className="text-2xl">📦</Text>
                    )}
                  </View>
                  <View className="flex-1">
                    <Text
                      className="text-light-matte-black font-bold text-base"
                      numberOfLines={1}
                    >
                      {variantData?.name || "Loading..."}
                    </Text>
                    <Text
                      className="text-light-matte-black/60 text-sm"
                      numberOfLines={2}
                    >
                      {variantData?.description || "Loading..."}
                    </Text>
                  </View>
                </View>
              </View>

              <View className="bg-light-main-container/50 rounded-xl p-3">
                <Text className="text-light-matte-black font-medium text-sm mb-2">
                  Point Details
                </Text>

                <View className="flex-row justify-between items-center mb-2">
                  <Text className="text-light-matte-black/60 text-sm">
                    Required
                  </Text>
                  <Text className="text-light-primary-red font-bold text-base">
                    {variantData?.ProductPrice?.[0]?.sellPrice
                      ? `${parseInt(variantData.ProductPrice[0].sellPrice).toLocaleString()} points`
                      : "Loading..."}
                  </Text>
                </View>

                <View className="flex-row justify-between items-center">
                  <Text className="text-light-matte-black/60 text-sm">
                    Yours
                  </Text>
                  <Text className="text-light-matte-black font-medium text-sm">
                    {isPointBalanceFetching
                      ? "Loading..."
                      : `${userPoints.toLocaleString()} points`}
                  </Text>
                </View>
              </View>
            </View>

            {isAuthenticated === false ? (
              <TouchableOpacity
                activeOpacity={navigatingToAuth ? 1 : 0.7}
                className={`p-4 rounded-full shadow-md mb-4 flex-row items-center justify-center gap-3 ${
                  navigatingToAuth
                    ? "bg-light-primary-red/80"
                    : "bg-light-primary-red"
                }`}
                onPress={goToAuth}
                disabled={navigatingToAuth}
              >
                {navigatingToAuth && (
                  <ActivityIndicator size="small" color="#ffffff" />
                )}
                <Text className="font-bold text-center text-lg text-white">
                  {navigatingToAuth ? "Opening sign-in…" : "Sign In to Redeem"}
                </Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                activeOpacity={buttonDisabled ? 1 : 0.7}
                className={`p-4 rounded-full shadow-md mb-4 ${
                  buttonDisabled ? "bg-gray-400/35" : "bg-light-primary-red"
                }`}
                onPress={handlePaymentConfirmation}
                disabled={buttonDisabled}
              >
                <Text className="font-bold text-center text-lg text-white">
                  Redeem
                </Text>
              </TouchableOpacity>
            )}
          </ScrollView>

          <PinConfirmationModal
            visible={pinModalVisible}
            onClose={() => setPinModalVisible(false)}
            onConfirm={handlePinSubmit}
            title="Confirm Redemption"
          />
        </View>

        <LoadinngSpinnerPopup
          visible={isLoading}
          title="Processing Redemption"
          message={transactionStatus}
        />

        <PaymentSuccessModal
          visible={successModalVisible}
          onClose={() => setSuccessModalVisible(false)}
          productName={paymentSuccess?.productName}
          pointsSpent={paymentSuccess?.pointsSpent}
          redemptionId={paymentSuccess?.redemptionId}
        />

        <PaymentErrorModal
          visible={errorModalVisible}
          onClose={() => setErrorModalVisible(false)}
          errorMessage={paymentError}
          onRetry={() => {
            setErrorModalVisible(false);
            handlePaymentConfirmation();
          }}
        />
      </SafeAreaView>
    </>
  );
}
