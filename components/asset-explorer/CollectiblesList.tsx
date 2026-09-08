import { ImageOff } from "lucide-react-native";
import React, { useMemo } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import type { NFTAsset } from "@/services/indexer/types";

interface CollectiblesListProps {
  collections: {
    name: string;
    imageUrl?: string;
    floorPrice?: number;
    items: NFTAsset[];
  }[];
  searchQuery: string;
  isLoading: boolean;
  /**
   * True when the lookup itself failed. Kept distinct from an empty result:
   * "we could not check" must never be rendered as "you own nothing".
   */
  isError: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  onLoadMore: () => void;
}

function NftTile({ nft }: { nft: NFTAsset }) {
  const imageUrl = nft.metadata.imageUrl;

  return (
    <View className="w-1/2 p-1.5">
      <View className="bg-white rounded-2xl overflow-hidden">
        <View className="aspect-square bg-light-main-container items-center justify-center">
          {imageUrl ? (
            <Image
              source={{ uri: imageUrl }}
              className="w-full h-full"
              resizeMode="cover"
            />
          ) : (
            // Media is frequently missing or unpinned. A tile with no art is
            // still a real holding, so show the placeholder rather than
            // dropping the item.
            <ImageOff size={22} color="#9ca3af" />
          )}
        </View>
        <View className="px-3 py-2.5">
          <Text
            className="font-semibold text-sm text-light-matte-black"
            numberOfLines={1}
          >
            {nft.metadata.name}
          </Text>
          <Text className="text-xs text-gray-500 mt-0.5" numberOfLines={1}>
            {nft.collection.name}
          </Text>
        </View>
      </View>
    </View>
  );
}

const CollectiblesList = ({
  collections,
  searchQuery,
  isLoading,
  isError,
  hasMore,
  isFetchingMore,
  onLoadMore,
}: CollectiblesListProps) => {
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return collections;
    return collections
      .map((c) => ({
        ...c,
        items: c.items.filter(
          (nft) =>
            nft.metadata.name.toLowerCase().includes(q) ||
            c.name.toLowerCase().includes(q),
        ),
      }))
      .filter((c) => c.items.length > 0);
  }, [collections, searchQuery]);

  if (isLoading) {
    return (
      <View className="py-16 items-center">
        <ActivityIndicator color="#c71c4b" />
      </View>
    );
  }

  if (isError) {
    return (
      <View className="py-16 items-center px-8">
        <Text className="text-center text-sm text-gray-500">
          We couldn't load your collectibles right now. Pull down to try again.
        </Text>
      </View>
    );
  }

  if (filtered.length === 0) {
    return (
      <View className="py-16 items-center px-8">
        <Text className="text-center text-sm text-gray-500">
          {searchQuery.trim()
            ? "No collectibles match your search."
            : "You don't have any collectibles on this network yet."}
        </Text>
      </View>
    );
  }

  return (
    <View>
      {filtered.map((collection) => (
        <View key={collection.name} className="mb-4">
          <View className="flex-row items-center justify-between px-1.5 mb-1">
            <Text className="font-semibold text-base text-light-matte-black">
              {collection.name}
            </Text>
            <Text className="text-xs text-gray-500">
              {collection.items.length}
            </Text>
          </View>
          <View className="flex-row flex-wrap">
            {collection.items.map((nft) => (
              <NftTile
                key={`${nft.contractAddress}-${nft.tokenId}`}
                nft={nft}
              />
            ))}
          </View>
        </View>
      ))}

      {hasMore && (
        <Pressable
          className="mx-1.5 mb-4 py-3.5 rounded-2xl bg-white items-center"
          onPress={onLoadMore}
          disabled={isFetchingMore}
        >
          {isFetchingMore ? (
            <ActivityIndicator color="#c71c4b" />
          ) : (
            <Text className="font-semibold text-sm text-light-matte-black">
              Load more
            </Text>
          )}
        </Pressable>
      )}
    </View>
  );
};

export default CollectiblesList;
