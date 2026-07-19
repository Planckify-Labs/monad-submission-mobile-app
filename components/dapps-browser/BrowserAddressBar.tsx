import { Image } from "expo-image";
import { Shield } from "lucide-react-native";
import React, { memo } from "react";
import { TextInput, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { COLORS, ICON_SIZES } from "../../constants/dapps-browser";
import { TBrowserAddressBarProps } from "../../types/dapps-browser";

const BrowserAddressBar = memo<TBrowserAddressBarProps>(
  function BrowserAddressBar({
    addressBarText,
    onChangeText,
    onSubmitEditing,
    addressBarRef,
    isWalletConnected = true,
    onPressWallet,
  }) {
    const { top } = useSafeAreaInsets();

    return (
      <View
        className="flex-row gap-3 px-4 pb-2 bg-light-main-container items-center"
        style={{ paddingTop: top > 0 ? top : 0 }}
      >
        <View className="flex-1 bg-light rounded-full flex-row items-center px-4 py-1">
          <Shield
            size={ICON_SIZES.SMALL + 2}
            color={COLORS.GRAY_400}
            strokeWidth={2}
          />
          <TextInput
            ref={addressBarRef}
            value={addressBarText}
            onChangeText={onChangeText}
            onSubmitEditing={onSubmitEditing}
            placeholder="Search or enter website URL"
            className="flex-1 text-light-matte-black text-base"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            placeholderTextColor={COLORS.GRAY_400}
          />
        </View>

        <TouchableOpacity
          activeOpacity={0.7}
          onPress={onPressWallet}
          accessibilityRole="button"
          accessibilityLabel="Manage wallet connections"
          className={`w-12 h-12 bg-light rounded-2xl items-center justify-center relative border-2 ${isWalletConnected ? "border-emerald-700" : "border-gray-400"}`}
        >
          <Image
            source={require("@/assets/images/takumipay-no-bg.png")}
            style={{ width: 20, height: 20 }}
            contentFit="contain"
          />
        </TouchableOpacity>
      </View>
    );
  },
);

export default BrowserAddressBar;
