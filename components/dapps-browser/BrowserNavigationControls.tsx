import {
  ArrowLeft,
  ArrowRight,
  Home,
  RotateCcw,
  Search,
  X,
} from "lucide-react-native";
import React, { memo, useCallback } from "react";
import { TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { COLORS, ICON_SIZES } from "../../constants/dapps-browser";
import { TBrowserNavigationControlsProps } from "../../types/dapps-browser";
import { getButtonStyle, getIconColor } from "../../utils/dappsBrowserUtils";

const BrowserNavigationControls = memo<TBrowserNavigationControlsProps>(
  function BrowserNavigationControls({
    browserState,
    onGoBack,
    onGoForward,
    onSearch,
    onRefresh,
    onStop,
    onHome,
  }: TBrowserNavigationControlsProps) {
    const { bottom } = useSafeAreaInsets();

    const handleGoBack = useCallback(() => {
      if (browserState.canGoBack) {
        onGoBack();
      }
    }, [browserState.canGoBack, onGoBack]);

    const handleGoForward = useCallback(() => {
      if (browserState.canGoForward) {
        onGoForward();
      }
    }, [browserState.canGoForward, onGoForward]);

    return (
      <View
        className="flex-row gap-3 px-4 pt-2 bg-light-main-container items-center justify-center"
        style={{ paddingBottom: bottom > 0 ? bottom : 8 }}
      >
        <TouchableOpacity
          onPress={handleGoBack}
          disabled={!browserState.canGoBack}
          activeOpacity={0.7}
          className={getButtonStyle(browserState.canGoBack)}
        >
          <ArrowLeft
            size={ICON_SIZES.MEDIUM}
            color={getIconColor(browserState.canGoBack)}
            strokeWidth={2}
          />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handleGoForward}
          disabled={!browserState.canGoForward}
          activeOpacity={0.7}
          className={getButtonStyle(browserState.canGoForward)}
        >
          <ArrowRight
            size={ICON_SIZES.MEDIUM}
            color={getIconColor(browserState.canGoForward)}
            strokeWidth={2}
          />
        </TouchableOpacity>

        {/* One control, two jobs: reload when idle, stop mid-load. That
            mirrors every phone browser and keeps the address bar free of a
            duplicate of this button. */}
        <TouchableOpacity
          onPress={browserState.loading ? onStop : onRefresh}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={
            browserState.loading ? "Stop loading" : "Reload page"
          }
          className={getButtonStyle(true, "secondary")}
        >
          {browserState.loading ? (
            <X
              size={ICON_SIZES.MEDIUM}
              color={COLORS.PRIMARY_RED}
              strokeWidth={2.5}
            />
          ) : (
            <RotateCcw
              size={ICON_SIZES.MEDIUM}
              color={COLORS.PRIMARY_RED}
              strokeWidth={2}
            />
          )}
        </TouchableOpacity>

        <TouchableOpacity
          onPress={onSearch}
          activeOpacity={0.7}
          className={getButtonStyle(true, "secondary")}
        >
          <Search
            size={ICON_SIZES.MEDIUM}
            color={COLORS.PRIMARY_RED}
            strokeWidth={2}
          />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={onHome}
          activeOpacity={0.7}
          className={getButtonStyle(true, "secondary")}
        >
          <Home
            size={ICON_SIZES.MEDIUM}
            color={COLORS.PRIMARY_RED}
            strokeWidth={2}
          />
        </TouchableOpacity>
      </View>
    );
  },
);

export default BrowserNavigationControls;
