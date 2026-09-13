import { useLocalSearchParams } from "expo-router";
import React, { useEffect, useState } from "react";
import { Platform, Text, View } from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import ItemWithInput from "@/components/purchase-item/ItemVariantWithInput";
import ItemVariantWithInputSkeleton from "@/components/purchase-item/ItemVariantWithInputSkeleton";
import ItemWithoutInput from "@/components/purchase-item/ItemVariantWithoutInput";
import ItemVariantWithoutInputSkeleton from "@/components/purchase-item/ItemVariantWithoutInputSkeleton";
import {
  useProductById,
  useProductInputFields,
} from "@/hooks/queries/useProducts";

export default function PurchaseItemScreen() {
  const { productId } = useLocalSearchParams<{ productId: string }>();
  const [hasInput, setHasInput] = useState<boolean | null>(null);
  const {
    data: product,
    isLoading: isProductLoading,
    error: productError,
  } = useProductById(productId);
  const { data: inputFields, isLoading: isInputFieldsLoading } =
    useProductInputFields(productId);

  const { bottom: bottomInset } = useSafeAreaInsets();
  const bottomOffset =
    Platform.OS === "ios" ? 0 : bottomInset > 0 ? bottomInset : 0;
  const isLoading = isProductLoading || isInputFieldsLoading;
  const error = productError;

  useEffect(() => {
    if (inputFields && product) {
      setHasInput(inputFields.forms.length > 0);
    }
  }, [product, inputFields]);

  if (isLoading) {
    return (
      <SafeAreaView className="flex-1 bg-light-main-container" edges={["top"]}>
        <SystemBars style="dark" />
        {hasInput === null ? (
          <ItemVariantWithoutInputSkeleton />
        ) : hasInput ? (
          <ItemVariantWithInputSkeleton />
        ) : (
          <ItemVariantWithoutInputSkeleton />
        )}
      </SafeAreaView>
    );
  }

  if ((error && !product) || Object.keys(product ?? {}).length === 0) {
    console.error("Error loading product:", error);
    return (
      <SafeAreaView className="flex-1 bg-light-main-container" edges={["top"]}>
        <View className="flex-1 justify-center items-center p-6">
          <Text className="text-light-matte-black text-lg font-bold mb-2">
            Could not load product
          </Text>
          <Text className="text-light-error text-center mb-6">
            Something went wrong. Please try again.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView
        className="flex-1 bg-light-main-container"
        edges={["top"]}
        style={{ paddingBottom: bottomOffset }}
      >
        {hasInput === null ? (
          <ItemVariantWithoutInputSkeleton />
        ) : hasInput ? (
          <ItemWithInput productId={productId} />
        ) : (
          <ItemWithoutInput productId={productId} />
        )}
      </SafeAreaView>
    </>
  );
}
