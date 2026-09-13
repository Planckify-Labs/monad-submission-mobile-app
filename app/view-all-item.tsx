import { FlashList } from "@shopify/flash-list";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import React, { useRef, useState } from "react";
import { Animated, Platform, Text, TouchableOpacity, View } from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { TProduct } from "@/api/types/product";
import OptimizedImage from "@/components/common/OptimizedImage";
import SearchBar from "@/components/common/SearchBar";
import SingleLoadingSekeleton from "@/components/common/SingleLoadingSekeleton";
import { useProductsByCategory } from "@/hooks/queries/useProducts";

const SkeletonItem = () => (
  <View className="items-center justify-center p-1">
    <SingleLoadingSekeleton
      width={64}
      height={64}
      borderRadius={16}
      style={{ marginBottom: 4 }}
    />
    <SingleLoadingSekeleton
      width={48}
      height={10}
      borderRadius={4}
      style={{ alignSelf: "center" }}
    />
  </View>
);

const LoadingSkeletons = () => {
  const skeletonItems = Array.from({ length: 12 }, (_, index) =>
    index.toString(),
  );

  return (
    <View className="px-4">
      <View className="w-full" style={{ minHeight: 300 }}>
        <FlashList
          data={skeletonItems}
          renderItem={() => <SkeletonItem />}
          keyExtractor={(item) => item}
          numColumns={4}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        />
      </View>
    </View>
  );
};

const ProductItem = React.memo(
  ({ product, router }: { product: TProduct; router: any }) => {
    const handlePress = React.useCallback(() => {
      router.push({
        pathname: "/purchase-item",
        params: { productId: product.id },
      });
    }, [product.id, router]);

    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={handlePress}
        className="items-center justify-center p-1"
      >
        {product.imageUrl ? (
          <View className="rounded-2xl overflow-hidden w-16 h-16 border-2 border-light-matte-black bg-light-primary-red/40">
            <OptimizedImage
              source={{ uri: product.imageUrl }}
              style={{ width: "100%", height: "100%" }}
              contentFit="cover"
            />
          </View>
        ) : (
          <View className="rounded-2xl border-2 border-light-matte-black w-16 aspect-square bg-light-primary-red/40" />
        )}
        <Text
          numberOfLines={2}
          ellipsizeMode="tail"
          className="text-[10px] text-center text-wrap max-w-16 mt-1"
        >
          {product.name}
        </Text>
      </TouchableOpacity>
    );
  },
);

ProductItem.displayName = "ProductItem";

export default function ViewAllItemScreen() {
  const { categoryId, categoryName } = useLocalSearchParams<{
    categoryId: string;
    categoryName: string;
  }>();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const scrollY = useRef(new Animated.Value(0)).current;

  const { bottom: bottomInset } = useSafeAreaInsets();
  const bottomOffset =
    Platform.OS === "ios" ? 0 : bottomInset > 0 ? bottomInset : 0;
  const {
    data: products,
    isLoading,
    error,
  } = useProductsByCategory(categoryId);

  const searchBarOpacity = scrollY.interpolate({
    inputRange: [50, 150],
    outputRange: [1, 0.2],
    extrapolate: "clamp",
  });

  const handleBackPress = () => {
    router.back();
  };

  const renderProductItem = React.useCallback(
    ({ item: product }: { item: TProduct }) => (
      <ProductItem product={product} router={router} />
    ),
    [router],
  );

  const keyExtractor = React.useCallback((product: TProduct) => product.id, []);

  if (isLoading) {
    return (
      <>
        <SystemBars style="dark" />
        <SafeAreaView
          className="flex-1 bg-light-main-container"
          edges={["top"]}
        >
          <View className="flex-row items-center p-4">
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={handleBackPress}
              className="mr-4"
            >
              <ArrowLeft color="#c71c4b" size={24} />
            </TouchableOpacity>
            <SingleLoadingSekeleton width={150} height={24} borderRadius={4} />
          </View>
          <View className="pb-4">
            <SingleLoadingSekeleton
              width="90%"
              height={48}
              borderRadius={24}
              style={{ alignSelf: "center" }}
            />
          </View>
          <LoadingSkeletons />
        </SafeAreaView>
      </>
    );
  }

  if (error && !products) {
    console.error("Error loading items:", error);
    return (
      <SafeAreaView className="flex-1 bg-light-main-container items-center justify-center">
        <Text>Failed to load items.</Text>
        <Text className="text-light-error mt-2">
          Something went wrong. Please try again.
        </Text>
      </SafeAreaView>
    );
  }

  const filteredProducts = searchQuery
    ? (products ?? []).filter(
        (product) =>
          product.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          product.description
            ?.toLowerCase()
            .includes(searchQuery.toLowerCase()),
      )
    : (products ?? []);

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView
        className="flex-1 bg-light-main-container"
        edges={["top"]}
        style={{ paddingBottom: bottomOffset }}
      >
        <View className="flex-row items-center p-4">
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={handleBackPress}
            className="mr-4"
          >
            <ArrowLeft color="#c71c4b" size={24} />
          </TouchableOpacity>
          <Text className="text-light-matte-black text-xl font-bold">
            {categoryName || "Products"}
          </Text>
        </View>

        <View className="flex-1 px-4 relative">
          <View className="absolute bg-transparent top-0 left-0 right-0 z-10">
            <SearchBar
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              searchBarOpacity={searchBarOpacity}
              variant="borderedMinimal"
              placeholder={`Search in ${categoryName || "Products"}...`}
            />
          </View>
          <FlashList
            data={filteredProducts}
            renderItem={renderProductItem}
            keyExtractor={keyExtractor}
            numColumns={4}
            className="pt-16 min-h-[300px]"
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingVertical: 18,
            }}
            onScroll={Animated.event(
              [{ nativeEvent: { contentOffset: { y: scrollY } } }],
              { useNativeDriver: false },
            )}
            scrollEventThrottle={16}
          />
        </View>
      </SafeAreaView>
    </>
  );
}
