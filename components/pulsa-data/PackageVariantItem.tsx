import { ChevronRight } from "lucide-react-native";
import React, { memo } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import type { TProductVariant } from "@/api/types/product";
import { describeVariant, formatQuota, formatValidity } from "@/services/ppob";

interface PackageVariantItemProps {
  variant: TProductVariant;
  disabled: boolean;
  onPress: (variant: TProductVariant) => void;
  /** Render for a 2-column grid (used on the pulsa/phone-credit tab). */
  grid?: boolean;
}

function formatPoints(points: number | null): string {
  return (points ?? 0).toLocaleString();
}

/** One labeled column in the data-plan card (Quota / Validity / Price). */
function CardSection({
  label,
  value,
  sub,
  accent,
  align = "left",
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  align?: "left" | "right";
}) {
  return (
    <View className={`flex-1 ${align === "right" ? "items-end" : ""}`}>
      <Text className="text-light-matte-black/50 text-[11px] mb-1">
        {label}
      </Text>
      <Text
        className={`font-bold text-base ${
          accent ? "text-light-primary-red" : "text-light-matte-black"
        }`}
        numberOfLines={1}
      >
        {value}
      </Text>
      {sub ? (
        <Text className="text-light-matte-black/40 text-[10px]">{sub}</Text>
      ) : null}
    </View>
  );
}

const Divider = () => <View className="w-px bg-light-matte-black/10 mx-3" />;

export const PackageVariantItem = memo(function PackageVariantItem({
  variant,
  disabled,
  onPress,
  grid = false,
}: PackageVariantItemProps) {
  const { dataMb, validityDays, pricePoints } = describeVariant(variant);
  const quota = formatQuota(dataMb);
  const validity = formatValidity(validityDays);
  const price = formatPoints(pricePoints);
  const dimmed = disabled ? "opacity-50" : "";

  // ---- Compact grid card (phone credit / pulsa) --------------------------
  if (grid) {
    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => onPress(variant)}
        disabled={disabled}
        className={`bg-light rounded-2xl border border-light-matte-black/5 p-3 flex-1 m-1 ${dimmed}`}
      >
        <View className="flex-row items-start justify-between">
          <Text
            className="text-light-matte-black font-bold text-base flex-1 pr-1"
            numberOfLines={2}
          >
            {variant.name}
          </Text>
          {validity ? (
            <View className="bg-light-main-container rounded-full px-2 py-0.5">
              <Text className="text-light-matte-black/60 text-[10px]">
                {validity}
              </Text>
            </View>
          ) : null}
        </View>
        <View className="h-px bg-light-matte-black/5 my-2.5" />
        <Text className="text-light-primary-red font-bold text-base">
          {price}{" "}
          <Text className="text-xs font-normal text-light-matte-black/50">
            points
          </Text>
        </Text>
      </TouchableOpacity>
    );
  }

  // ---- Structured data-plan card (Quota | Validity | Price) --------------
  if (quota) {
    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => onPress(variant)}
        disabled={disabled}
        className={`bg-light rounded-2xl mb-3 overflow-hidden border border-light-matte-black/5 ${dimmed}`}
      >
        <View className="flex-row px-4 pt-3.5 pb-3">
          <CardSection label="Quota" value={quota} />
          <Divider />
          <CardSection label="Validity" value={validity ?? "-"} />
          <Divider />
          <CardSection
            label="Price"
            value={price}
            sub="points"
            accent
            align="right"
          />
        </View>
        <View className="bg-light-main-container px-4 py-2.5 flex-row items-center">
          <Text
            className="flex-1 text-light-matte-black/70 text-xs"
            numberOfLines={1}
          >
            {variant.name}
          </Text>
          <ChevronRight size={16} color="#9ca3af" />
        </View>
      </TouchableOpacity>
    );
  }

  // ---- Simple row card (data plans without a parsed quota, fallbacks) ----
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={() => onPress(variant)}
      disabled={disabled}
      className={`bg-light rounded-2xl mb-3 p-4 border border-light-matte-black/5 flex-row items-center ${dimmed}`}
    >
      <View className="flex-1 pr-2">
        <Text
          className="text-light-matte-black font-bold text-base"
          numberOfLines={2}
        >
          {variant.name}
        </Text>
        {validity ? (
          <Text className="text-light-matte-black/50 text-xs mt-0.5">
            Validity {validity}
          </Text>
        ) : null}
      </View>
      <Text className="text-light-primary-red font-bold text-base">
        {price}{" "}
        <Text className="text-xs font-normal text-light-matte-black/50">
          points
        </Text>
      </Text>
    </TouchableOpacity>
  );
});
