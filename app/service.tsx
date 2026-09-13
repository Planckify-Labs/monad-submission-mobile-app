import React, { useRef, useState } from "react";
import { Animated, FlatList, ListRenderItemInfo, Text } from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import SearchBar from "@/components/common/SearchBar";
import PromotionBanner from "@/components/service/PromotionBanner";
import ServiceHeader from "@/components/service/ServiceHeader";
import ServiceScreenSkeleton from "@/components/service/ServiceScreenSkeleton";
import ServiceSectionContainer from "@/components/service/ServiceSectionContainer";
import { useProductsByCategories } from "@/hooks/queries/useProducts";

type ListItem =
  | { type: "header"; data: { title: string } }
  | {
      type: "searchBar";
      data: { searchQuery: string; setSearchQuery: (query: string) => void };
    }
  | {
      type: "banner";
      data: {
        title: string;
        description: string;
        buttonText: string;
        onPress: () => void;
      };
    }
  | {
      type: "section";
      data: {
        id: string;
        title: string;
        viewAllPath: string;
        items: Array<{
          id: string;
          name: string;
          description: string;
          icon: string;
        }>;
      };
    };

export default function ServiceScreen() {
  const [searchQuery, setSearchQuery] = useState("");
  const scrollY = useRef(new Animated.Value(0)).current;
  const {
    data: productsByCategories,
    isLoading,
    error,
  } = useProductsByCategories();

  const { bottom } = useSafeAreaInsets();
  const bottomOffset = bottom > 0 ? bottom + 8 : 8;
  const searchBarOpacity = scrollY.interpolate({
    inputRange: [50, 150],
    outputRange: [1, 0.2],
    extrapolate: "clamp",
  });

  const serviceList: ListItem[] = [
    {
      type: "header",
      data: {
        title: "Redeem",
      },
    },
    {
      type: "searchBar",
      data: {
        searchQuery,
        setSearchQuery,
      },
    },
    {
      type: "banner",
      data: {
        title: "Special Offer!",
        description: "Get 10% cashback on all data packages",
        buttonText: "Claim Now",
        onPress: () => {
          console.log("Banner button pressed");
        },
      },
    },
  ];

  if (productsByCategories) {
    productsByCategories.forEach((categoryData) => {
      const products = categoryData.products ?? [];
      const filteredProducts = searchQuery
        ? products.filter(
            (product) =>
              product.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
              product.description
                ?.toLowerCase()
                .includes(searchQuery.toLowerCase()),
          )
        : products;

      if (filteredProducts.length > 0) {
        serviceList.push({
          type: "section",
          data: {
            id: categoryData.category.id,
            title: categoryData.category.name,
            viewAllPath: "/asset-explorer",
            items: filteredProducts.map((product) => ({
              id: product.id,
              name: product.name,
              description: product.description,
              icon: product.imageUrl,
            })),
          },
        });
      }
    });
  }

  const renderServiceScreenItem = ({ item }: ListRenderItemInfo<ListItem>) => {
    if (item.type === "header") {
      return <ServiceHeader title="Redeem" />;
    } else if (item.type === "searchBar") {
      return (
        <SearchBar
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          searchBarOpacity={searchBarOpacity}
          variant="borderedMinimal"
          placeholder="search services..."
        />
      );
    } else if (item.type === "banner") {
      // temporary hide banner
      // return (
      //   <PromotionBanner
      //     title={item.data.title}
      //     description={item.data.description}
      //     buttonText={item.data.buttonText}
      //     onPress={item.data.onPress}
      //   />
      // );
      return null;
    } else {
      return <ServiceSectionContainer section={item.data} />;
    }
  };

  if (isLoading) {
    return (
      <SafeAreaView className="flex-1 bg-light-main-container">
        <ServiceScreenSkeleton />
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView className="flex-1 bg-light-main-container items-center justify-center">
        <Text>Failed to load services.</Text>
      </SafeAreaView>
    );
  }

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView className="flex-1 bg-light-main-container" edges={["top"]}>
        <FlatList
          data={serviceList}
          renderItem={renderServiceScreenItem}
          keyExtractor={(item, index) =>
            item.type === "section" ? item.data.id : `${item.type}-${index}`
          }
          showsVerticalScrollIndicator={false}
          stickyHeaderIndices={[1]}
          contentContainerStyle={{ paddingBottom: bottomOffset }}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: false },
          )}
          scrollEventThrottle={16}
        />
      </SafeAreaView>
    </>
  );
}
