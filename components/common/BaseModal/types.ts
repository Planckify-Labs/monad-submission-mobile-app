import type React from "react";
import type { StyleProp, ViewStyle } from "react-native";

/**
 * Resting height of the sheet.
 * - `number` — fixed pixel height.
 * - `"<n>%"` — percentage of the screen height (e.g. `"67%"`).
 * - `"auto"` — sheet sizes to its content (capped by `maxHeight`).
 */
export type ModalHeight = number | `${number}%` | "auto";

export interface BaseModalProps {
  children: React.ReactNode;

  /**
   * Controlled visibility. When provided the parent owns the open/close state
   * (pair with `onClose`). When omitted the modal is uncontrolled — drive it
   * imperatively through the `ref` (`open()` / `close()`).
   */
  visible?: boolean;
  /** Called when the user requests a close (backdrop tap, drag-down, back button). */
  onClose?: () => void;
  /** Fires once the open animation finishes. */
  onOpened?: () => void;
  /** Fires once the close animation finishes (right before unmount). */
  onClosed?: () => void;

  // ── Sizing ────────────────────────────────────────────────────────────────
  /** @default "auto" */
  height?: ModalHeight;
  /** Cap applied only in `height="auto"` mode. @default "90%" */
  maxHeight?: number | `${number}%`;
  /**
   * When the keyboard opens, grow the sheet up to `(screen − statusBar)`.
   * Only applies when `height` is numeric/percent. @default true
   */
  growsWithKeyboard?: boolean;
  /** Pad the sheet bottom by the keyboard height so content clears it. @default true */
  avoidsKeyboard?: boolean;

  // ── Appearance ──────────────────────────────────────────────────────────────
  /** @default "#f5f6f9" (light-main-container) */
  backgroundColor?: string;
  /** Top corner radius. @default 24 */
  borderRadius?: number;
  /** Show the grab-handle bar (also the drag target). @default true */
  showHandle?: boolean;
  /**
   * Render the standardized close (X) button in the top-right corner. This is
   * the one default close for every sheet — don't add your own. @default true
   */
  showCloseButton?: boolean;
  /** Disable the default close button (e.g. mid-save). @default false */
  closeButtonDisabled?: boolean;
  /** Render the dimmed backdrop. @default true */
  showBackdrop?: boolean;
  /** Backdrop opacity at rest, 0–1. @default 0.5 */
  backdropOpacity?: number;

  // ── Behavior ──────────────────────────────────────────────────────────────
  /** Tap on the backdrop closes the sheet. @default true */
  enableBackdropClose?: boolean;
  /** Drag the handle down to close. @default true */
  enablePanToClose?: boolean;
  /** Drag distance (px) past which release closes. @default 50 */
  dragCloseThreshold?: number;
  /** Fling velocity past which release closes. @default 0.5 */
  velocityThreshold?: number;
  /** Open animation duration (ms). @default 300 */
  openDuration?: number;
  /** Close animation duration (ms). @default 200 */
  closeDuration?: number;

  // ── Style overrides (merged AFTER the internal styles) ──────────────────────
  /** Sheet container style. */
  style?: StyleProp<ViewStyle>;
  /** Inner content wrapper style. */
  contentStyle?: StyleProp<ViewStyle>;
  /** Backdrop style. */
  backdropStyle?: StyleProp<ViewStyle>;
  /** Sheet container className (NativeWind). */
  className?: string;
  /** Inner content wrapper className. */
  contentClassName?: string;
  /** Grab-handle row className. */
  handleClassName?: string;

  /** Android: draw the modal under the (translucent) status bar AND
   * navigation bar — drives both `Modal` props together since RN requires
   * them to match (mismatched pairing is unsupported / warns). RN's `Modal`
   * opens its own native window, separate from the app's edge-to-edge
   * Activity window, so its relationship to the system nav bar isn't
   * consistent across Android versions unless this is explicitly on; the
   * `bottom` safe-area inset used for `paddingBottom` below assumes it is.
   * See `react-native-edge-to-edge`'s "Modal component quirks". @default true */
  statusBarTranslucent?: boolean;
}

export interface BaseModalRef {
  /** Open the sheet (uncontrolled usage). */
  open: () => void;
  /** Close the sheet (runs the exit animation). */
  close: () => void;
}

/**
 * The standardized close (X) button — a red `X` in a tinted circle, ported
 * from `NetworkSelectorModal`. This is the app-wide default; use it directly
 * in any custom header so every sheet's close looks the same.
 */
export interface ModalCloseButtonProps {
  onPress?: () => void;
  disabled?: boolean;
  /** X icon size. @default 18 */
  size?: number;
  /** X icon color. @default "#c71c4b" (light-primary-red) */
  iconColor?: string;
  /** Override/extend the button container classes (defaults to the tinted circle). */
  className?: string;
  /** @default "Close" */
  accessibilityLabel?: string;
}

/**
 * Optional title row for a sheet's content. The close button is NOT here — it
 * lives on `BaseModal` (top-right, app-wide default). Use this for the title
 * and any leading/trailing header content (back button, icon, timer, …).
 */
export interface ModalHeaderProps {
  /** Title text. Hidden when absent or when `showTitle` is false. */
  title?: string;
  /** @default true */
  showTitle?: boolean;
  /** Optional node rendered on the leading side (replaces the title slot when set alongside it). */
  left?: React.ReactNode;
  /** Optional node rendered on the trailing side, before BaseModal's close. */
  right?: React.ReactNode;
  /** Row className. */
  className?: string;
  /** Title text className. */
  titleClassName?: string;
}
