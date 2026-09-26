import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  Animated,
  Dimensions,
  Keyboard,
  Modal,
  PanResponder,
  Platform,
  StatusBar,
  StyleSheet,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ModalCloseButton from "./ModalCloseButton";
import type { BaseModalProps, BaseModalRef, ModalHeight } from "./types";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");

/**
 * Floor for the Android bottom safe-area offset, independent of whatever
 * `useSafeAreaInsets()` reports.
 *
 * `react-native-safe-area-context`'s insets are measured by a native view
 * mounted once at the app root (`SafeAreaProvider` in `app/_layout.tsx`).
 * This `Modal` is a SEPARATE native window (`statusBarTranslucent` +
 * `navigationBarTranslucent`), and on Android that split is a documented
 * source of a stale/zero `bottom` reaching this hook
 * (react-native-safe-area-context#124, #153): the sheet then renders flush
 * to the physical edge, painting over the gesture-nav pill's reserved
 * space instead of stopping above it. 24dp mirrors Android's own gesture
 * handle touch-target height, so this is a safety floor, not a substitute
 * for the real inset — `Math.max` below always keeps the larger of the
 * two, so a device that DOES report a bigger real inset is unaffected.
 */
const ANDROID_MIN_BOTTOM_INSET = 24;

const resolvePx = (
  value: ModalHeight | number | `${number}%` | undefined,
  screen: number,
): number | undefined => {
  if (value == null) return undefined;
  if (typeof value === "number") return value;
  if (value.endsWith("%")) {
    const pct = Number.parseFloat(value);
    if (Number.isNaN(pct)) return undefined;
    return (screen * pct) / 100;
  }
  return undefined; // "auto"
};

/**
 * Shared bottom-sheet shell. Owns the look & feel every sheet in the app
 * should share: dimmed backdrop fade, slide-up entrance, drag-the-handle to
 * dismiss, safe-area padding, and keyboard-aware behavior (the sheet grows up
 * to `(screen − statusBar)` and pads its bottom by the keyboard height).
 *
 * Mechanics ported from `components/asset-explorer/NetworkSelectorModal.tsx`.
 * The slide is JS-driven (`useNativeDriver: false`) because the sheet node also
 * animates `height`/`paddingBottom` for the keyboard grow, and a single node
 * can't mix native + JS drivers. The backdrop fade is on its own node, so it
 * stays native-driven.
 *
 * Renders the standardized close (X) button itself (top-right) — sheets don't
 * add their own; opt out with `showCloseButton={false}`.
 *
 * Controlled (recommended):
 * @example
 * <BaseModal visible={open} onClose={() => setOpen(false)}>
 *   <ModalHeader title="Networks" />
 *   {content}
 * </BaseModal>
 *
 * Uncontrolled (imperative):
 * @example
 * const ref = useRef<BaseModalRef>(null);
 * <BaseModal ref={ref}>{content}</BaseModal>
 * // ref.current?.open() / ref.current?.close()
 */
const BaseModal = forwardRef<BaseModalRef, BaseModalProps>(
  (
    {
      children,
      visible,
      onClose,
      onOpened,
      onClosed,
      height = "auto",
      maxHeight = "90%",
      growsWithKeyboard = true,
      avoidsKeyboard = true,
      backgroundColor = "#f5f6f9",
      borderRadius = 24,
      showHandle = true,
      showCloseButton = true,
      closeButtonDisabled = false,
      showBackdrop = true,
      backdropOpacity = 0.5,
      enableBackdropClose = true,
      enablePanToClose = true,
      dragCloseThreshold = 50,
      velocityThreshold = 0.5,
      openDuration = 300,
      closeDuration = 200,
      style,
      contentStyle,
      backdropStyle,
      className,
      contentClassName,
      handleClassName,
      statusBarTranslucent = true,
    },
    ref,
  ) => {
    const { top, bottom } = useSafeAreaInsets();
    const bottomOffset =
      Platform.OS === "ios"
        ? 16
        : Math.max(bottom, ANDROID_MIN_BOTTOM_INSET);
    const statusBarHeight = Math.max(
      top,
      Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0,
    );

    const isControlled = visible !== undefined;
    const [internalOpen, setInternalOpen] = useState(false);
    const open = isControlled ? (visible as boolean) : internalOpen;

    // `rendered` keeps the Modal mounted through the exit animation so both
    // gesture-close and programmatic close (visible -> false) animate out.
    const [rendered, setRendered] = useState(open);

    const resolvedHeightPx = resolvePx(height, SCREEN_HEIGHT);
    const resolvedMaxHeightPx = resolvePx(maxHeight, SCREEN_HEIGHT);
    const isFixedHeight = resolvedHeightPx != null;

    const fadeAnim = useRef(new Animated.Value(0)).current;
    const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
    // 0 = keyboard closed, 1 = fully open. Drives the grow + bottom padding.
    const kbProgress = useRef(new Animated.Value(0)).current;
    const [keyboardHeight, setKeyboardHeight] = useState(0);

    // Lifecycle callbacks via refs so inline parent callbacks don't re-trigger
    // the open/close animation on every render.
    const onOpenedRef = useRef(onOpened);
    const onClosedRef = useRef(onClosed);
    onOpenedRef.current = onOpened;
    onClosedRef.current = onClosed;

    // Measured content height (auto mode) so the close animation slides exactly
    // the sheet's height rather than the whole screen.
    const [measuredHeight, setMeasuredHeight] = useState(0);
    const closedTranslateRef = useRef(SCREEN_HEIGHT);
    closedTranslateRef.current = isFixedHeight
      ? (resolvedHeightPx as number)
      : measuredHeight || SCREEN_HEIGHT;

    const requestClose = useCallback(() => {
      if (!isControlled) setInternalOpen(false);
      onClose?.();
    }, [isControlled, onClose]);

    useImperativeHandle(
      ref,
      () => ({
        open: () => {
          if (!isControlled) setInternalOpen(true);
        },
        close: requestClose,
      }),
      [isControlled, requestClose],
    );

    // Mount as soon as we should be open.
    useEffect(() => {
      if (open) setRendered(true);
    }, [open]);

    // Animate in / out whenever the open intent changes (while mounted).
    useEffect(() => {
      if (!rendered) return;
      if (open) {
        fadeAnim.setValue(0);
        translateY.setValue(closedTranslateRef.current);
        Animated.parallel([
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: openDuration,
            useNativeDriver: true,
          }),
          Animated.timing(translateY, {
            toValue: 0,
            duration: openDuration,
            useNativeDriver: false,
          }),
        ]).start(({ finished }) => {
          if (finished) onOpenedRef.current?.();
        });
      } else {
        Keyboard.dismiss();
        Animated.parallel([
          Animated.timing(fadeAnim, {
            toValue: 0,
            duration: closeDuration,
            useNativeDriver: true,
          }),
          Animated.timing(translateY, {
            toValue: closedTranslateRef.current,
            duration: closeDuration,
            useNativeDriver: false,
          }),
        ]).start(({ finished }) => {
          if (finished) {
            kbProgress.setValue(0);
            setKeyboardHeight(0);
            setRendered(false);
            onClosedRef.current?.();
          }
        });
      }
    }, [
      open,
      rendered,
      openDuration,
      closeDuration,
      fadeAnim,
      translateY,
      kbProgress,
    ]);

    // Keyboard grow + bottom padding, synced to the keyboard's own duration.
    useEffect(() => {
      if (!rendered || (!growsWithKeyboard && !avoidsKeyboard)) return;
      const showEvent =
        Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
      const hideEvent =
        Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
      const showSub = Keyboard.addListener(showEvent, (e) => {
        setKeyboardHeight(e.endCoordinates.height);
        Animated.timing(kbProgress, {
          toValue: 1,
          duration: e.duration || 250,
          useNativeDriver: false,
        }).start();
      });
      const hideSub = Keyboard.addListener(hideEvent, (e) => {
        Animated.timing(kbProgress, {
          toValue: 0,
          duration: e.duration || 250,
          useNativeDriver: false,
        }).start(() => setKeyboardHeight(0));
      });
      return () => {
        showSub.remove();
        hideSub.remove();
      };
    }, [rendered, growsWithKeyboard, avoidsKeyboard, kbProgress]);

    const panResponder = useRef(
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, g) => g.dy > 0,
        onPanResponderMove: (_, g) => {
          if (g.dy > 0) translateY.setValue(g.dy);
        },
        onPanResponderRelease: (_, g) => {
          if (g.dy > dragCloseThreshold || g.vy > velocityThreshold) {
            requestClose();
          } else {
            Animated.spring(translateY, {
              toValue: 0,
              useNativeDriver: false,
              bounciness: 5,
            }).start();
          }
        },
      }),
    ).current;

    if (!rendered) return null;

    // Sheet height: grow from rest -> (screen − statusBar) as the keyboard opens.
    const animatedHeight =
      isFixedHeight && growsWithKeyboard
        ? kbProgress.interpolate({
            inputRange: [0, 1],
            outputRange: [
              resolvedHeightPx as number,
              SCREEN_HEIGHT - statusBarHeight,
            ],
            extrapolate: "clamp",
          })
        : undefined;
    const heightStyle:
      | number
      | Animated.AnimatedInterpolation<number>
      | undefined =
      animatedHeight ??
      (isFixedHeight ? (resolvedHeightPx as number) : undefined);

    const animatedPaddingBottom = avoidsKeyboard
      ? Animated.add(
          bottomOffset,
          Animated.multiply(kbProgress, keyboardHeight),
        )
      : bottomOffset;

    const onSheetLayout = !isFixedHeight
      ? (e: { nativeEvent: { layout: { height: number } } }) => {
          const h = e.nativeEvent.layout.height;
          if (Math.abs(h - measuredHeight) > 1) setMeasuredHeight(h);
        }
      : undefined;

    return (
      <Modal
        transparent
        visible
        animationType="none"
        statusBarTranslucent={statusBarTranslucent}
        navigationBarTranslucent={statusBarTranslucent}
        onRequestClose={requestClose}
      >
        <View style={{ flex: 1 }}>
          {showBackdrop && (
            <TouchableWithoutFeedback
              onPress={enableBackdropClose ? requestClose : undefined}
            >
              <Animated.View
                style={[
                  StyleSheet.absoluteFill,
                  {
                    backgroundColor: `rgba(0,0,0,${backdropOpacity})`,
                    opacity: fadeAnim,
                  },
                  backdropStyle,
                ]}
              />
            </TouchableWithoutFeedback>
          )}

          <Animated.View
            onLayout={onSheetLayout}
            className={className}
            style={[
              {
                position: "absolute",
                bottom: 0,
                left: 0,
                right: 0,
                height: heightStyle,
                maxHeight: isFixedHeight ? undefined : resolvedMaxHeightPx,
                paddingBottom: animatedPaddingBottom,
                backgroundColor,
                borderTopLeftRadius: borderRadius,
                borderTopRightRadius: borderRadius,
                transform: [{ translateY }],
                shadowColor: "#000",
                shadowOffset: { width: 0, height: -3 },
                shadowOpacity: 0.1,
                shadowRadius: 10,
                elevation: 10,
                flexDirection: "column",
              },
              style,
            ]}
          >
            {showHandle && (
              <View
                {...(enablePanToClose ? panResponder.panHandlers : {})}
                className={`w-full items-center pt-4 pb-2 ${
                  handleClassName ?? ""
                }`}
              >
                <View className="w-12 h-1 bg-gray-300 rounded-full" />
              </View>
            )}

            <View
              className={contentClassName}
              style={[isFixedHeight ? { flex: 1 } : null, contentStyle]}
            >
              {children}
            </View>

            {/* The single default close button for every sheet — sits in the
                header band (top-right), aligned with a left-aligned title.
                Opt out per sheet with `showCloseButton={false}`. */}
            {showCloseButton && (
              <View
                style={{ position: "absolute", top: 26, right: 20, zIndex: 20 }}
              >
                <ModalCloseButton
                  onPress={requestClose}
                  disabled={closeButtonDisabled}
                />
              </View>
            )}
          </Animated.View>
        </View>
      </Modal>
    );
  },
);

BaseModal.displayName = "BaseModal";

export default BaseModal;
