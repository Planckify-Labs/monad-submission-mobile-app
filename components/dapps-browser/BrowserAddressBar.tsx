import { Image } from "expo-image";
import { Search, Shield, TriangleAlert, X } from "lucide-react-native";
import React, { memo, useEffect, useMemo } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  displayHost,
  type SecurityLevel,
  securityLevel,
} from "@/services/dappsBrowser/omnibox";
import { COLORS, ICON_SIZES } from "../../constants/dapps-browser";
import { TBrowserAddressBarProps } from "../../types/dapps-browser";

// Fixed widths for the trailing control in each mode. Pinning them makes
// the address pill's width a pure function of the edit state, so it can
// be interpolated instead of snapping when the wallet button gives way to
// Cancel.
const TRAILING_WIDTH_IDLE = 48;
const TRAILING_WIDTH_EDITING = 62;
const TRANSITION_MS = 200;

const SECURITY_ICON_COLOR: Record<SecurityLevel, string> = {
  none: COLORS.GRAY_400,
  secure: COLORS.GRAY_600,
  caution: COLORS.AMBER,
  insecure: COLORS.PRIMARY_RED,
};

function SecurityIcon({
  level,
  isPageLoaded,
}: {
  level: SecurityLevel;
  isPageLoaded: boolean;
}) {
  const size = ICON_SIZES.SMALL + 2;
  if (level === "none")
    return (
      <Search size={size} color={SECURITY_ICON_COLOR.none} strokeWidth={2} />
    );
  if (level === "secure")
    return (
      <Shield
        size={size}
        // Grey while the page is still coming in, emerald once it has
        // settled. The claim the shield makes ("this loaded over TLS and it
        // is done") is only true at the end, so it stays neutral until then
        // rather than promising something mid-flight. A caution or insecure
        // host never turns green: its warning colour outranks load state.
        color={isPageLoaded ? COLORS.EMERALD : SECURITY_ICON_COLOR.secure}
        strokeWidth={2.5}
      />
    );
  return (
    <TriangleAlert
      size={size}
      color={SECURITY_ICON_COLOR[level]}
      strokeWidth={2.5}
    />
  );
}

/**
 * The browser's address bar.
 *
 * Two distinct modes, the way a phone browser behaves:
 *
 *  - **idle** shows just the hostname, so a long URL with redirect
 *    parameters can't shift around or hide which site is actually loaded;
 *  - **editing** shows the full URL, selected, with a clear button and a
 *    Cancel that restores the page without navigating.
 *
 * The draft text is owned by the parent and is deliberately NOT written
 * back to while the user is editing: the page fires navigation-state
 * changes continuously (redirects, single-page routing), and letting those
 * reach the input was what overwrote whatever was half-typed.
 */
const BrowserAddressBar = memo<TBrowserAddressBarProps>(
  function BrowserAddressBar({
    pageUrl,
    draft,
    onChangeDraft,
    isEditing,
    onStartEditing,
    onCancelEditing,
    onSubmit,
    isWalletConnected = true,
    onPressWallet,
    isPageLoaded = false,
    isBlocked = false,
  }) {
    const { top } = useSafeAreaInsets();

    const level = useMemo(
      () => (isBlocked ? "insecure" : securityLevel(pageUrl)),
      [pageUrl, isBlocked],
    );
    const host = useMemo(() => displayHost(pageUrl), [pageUrl]);

    // Drives the whole idle-to-editing transition off one value, so the
    // pill widening and the trailing cross-fade stay in lockstep.
    const progress = useSharedValue(isEditing ? 1 : 0);
    useEffect(() => {
      progress.value = withTiming(isEditing ? 1 : 0, {
        duration: TRANSITION_MS,
        easing: Easing.out(Easing.cubic),
      });
    }, [isEditing, progress]);

    // The pill is `flex-1`, so animating the trailing slot animates the
    // pill's width for free.
    const trailingStyle = useAnimatedStyle(() => ({
      width: interpolate(
        progress.value,
        [0, 1],
        [TRAILING_WIDTH_IDLE, TRAILING_WIDTH_EDITING],
      ),
    }));
    const walletStyle = useAnimatedStyle(() => ({
      opacity: 1 - progress.value,
    }));
    const cancelStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

    return (
      <View
        className="flex-row gap-3 px-4 pb-2 bg-light-main-container items-center"
        style={{ paddingTop: top > 0 ? top : 0 }}
      >
        <View className="flex-1 bg-light rounded-full flex-row items-center px-4 py-1 min-h-[44px]">
          <SecurityIcon level={level} isPageLoaded={isPageLoaded} />

          {isEditing ? (
            <>
              <TextInput
                value={draft}
                onChangeText={onChangeDraft}
                onSubmitEditing={onSubmit}
                placeholder="Search or enter website"
                className="flex-1 text-light-matte-black text-base ml-2"
                // This input only mounts once editing starts, so `autoFocus`
                // is what raises the keyboard. It has to be the native prop
                // rather than a `ref.focus()` in an effect: both platforms
                // apply autoFocus from the window-attach callback
                // (ReactEditText.onAttachedToWindow / didMoveToWindow),
                // whereas an effect fires in the same commit the view
                // mounts, before it is attached, and Android's
                // showSoftInput() silently no-ops on an unattached view.
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                autoComplete="off"
                // Not `keyboardType="url"`: that variant drops the space
                // key on Android, and this input doubles as a search box.
                keyboardType="default"
                returnKeyType="go"
                selectTextOnFocus
                // Android paints `selectionColor` at full opacity behind
                // the text, so it takes the low-alpha tint; iOS derives its
                // own light highlight from a solid tint and takes the solid
                // one. The caret and handles stay solid brand red on
                // Android through their own props (both iOS no-ops).
                selectionColor={
                  Platform.OS === "ios"
                    ? COLORS.PRIMARY_RED
                    : COLORS.SELECTION_TINT
                }
                cursorColor={COLORS.PRIMARY_RED}
                selectionHandleColor={COLORS.PRIMARY_RED}
                placeholderTextColor={COLORS.GRAY_400}
              />
              {draft.length > 0 && (
                <TouchableOpacity
                  onPress={() => onChangeDraft("")}
                  activeOpacity={0.7}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Clear address"
                  className="pl-2"
                >
                  <X
                    size={ICON_SIZES.SMALL}
                    color={COLORS.GRAY_400}
                    strokeWidth={2.5}
                  />
                </TouchableOpacity>
              )}
            </>
          ) : (
            // Nothing else lives in the idle pill on purpose. Reload and
            // stop are one toggling button in the bottom navigation bar;
            // duplicating them here both repeated an existing control and
            // resized the URL text every time a load started or finished.
            <Pressable
              onPress={onStartEditing}
              accessibilityRole="search"
              accessibilityLabel={
                host ? `Address bar, ${host}` : "Search or enter website"
              }
              className="flex-1 py-2 ml-2"
            >
              <Text
                className={`text-base ${
                  host ? "text-light-matte-black" : "text-light-matte-black/40"
                }`}
                numberOfLines={1}
              >
                {host || "Search or enter website"}
              </Text>
            </Pressable>
          )}
        </View>

        {/* Both controls stay mounted and overlap, so the swap is a
            cross-fade rather than one popping in where the other vanished.
            `pointerEvents` is what keeps the hidden one untappable. */}
        <Animated.View style={trailingStyle} className="h-12 justify-center">
          <Animated.View
            style={[StyleSheet.absoluteFillObject, walletStyle]}
            pointerEvents={isEditing ? "none" : "auto"}
            className="items-end justify-center"
          >
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={onPressWallet}
              accessibilityRole="button"
              accessibilityLabel="Manage wallet connections"
              accessibilityElementsHidden={isEditing}
              importantForAccessibility={
                isEditing ? "no-hide-descendants" : "auto"
              }
              className={`w-12 h-12 bg-light rounded-2xl items-center justify-center border-2 ${isWalletConnected ? "border-emerald-700" : "border-gray-400"}`}
            >
              <Image
                source={require("@/assets/images/takumipay-no-bg.png")}
                style={{ width: 20, height: 20 }}
                contentFit="contain"
              />
            </TouchableOpacity>
          </Animated.View>

          <Animated.View
            style={[StyleSheet.absoluteFillObject, cancelStyle]}
            pointerEvents={isEditing ? "auto" : "none"}
            className="items-end justify-center"
          >
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={onCancelEditing}
              accessibilityRole="button"
              accessibilityLabel="Cancel editing address"
              accessibilityElementsHidden={!isEditing}
              importantForAccessibility={
                isEditing ? "auto" : "no-hide-descendants"
              }
              hitSlop={8}
              className="h-12 justify-center"
            >
              <Text className="text-light-primary-red font-semibold text-base">
                Cancel
              </Text>
            </TouchableOpacity>
          </Animated.View>
        </Animated.View>
      </View>
    );
  },
);

export default BrowserAddressBar;
