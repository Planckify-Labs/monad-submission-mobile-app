import {
  ArrowLeft,
  Ban,
  Compass,
  RotateCcw,
  SearchX,
  ServerCrash,
  ShieldAlert,
  TimerOff,
  TriangleAlert,
  WifiOff,
} from "lucide-react-native";
import React, { memo, useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";
import {
  classifyPageLoadError,
  type PageErrorKind,
  type PageLoadErrorInput,
} from "@/services/dappsBrowser/pageError";
import BrowserNoticePage, { type NoticeAction } from "./BrowserNoticePage";

const ICON_BY_KIND: Record<
  PageErrorKind,
  React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>
> = {
  offline: WifiOff,
  dns: SearchX,
  unreachable: ServerCrash,
  timeout: TimerOff,
  ssl: ShieldAlert,
  blocked: Ban,
  unknown: TriangleAlert,
};

type BrowserPageErrorProps = {
  /** Raw platform failure. Classified here; never rendered as-is. */
  error: PageLoadErrorInput;
  /** Bare hostname we were loading, from our own URL parse. */
  host?: string;
  canGoBack?: boolean;
  onRetry: () => void;
  onGoBack: () => void;
  onGoHome: () => void;
};

/**
 * The browser's network-error page, replacing `react-native-webview`'s
 * `defaultRenderError` (which paints "Domain: undefined / Error Code: -2 /
 * Description: net::ERR_INTERNET_DISCONNECTED" at the user).
 *
 * Shape borrowed from what desktop and mobile browsers converged on: one
 * icon, one plain-language headline, one sentence of advice, and a single
 * obvious recovery action, with the failed URL still in the address bar and
 * history intact behind it so this reads as a page state rather than a
 * dead end. Diagnostics stay in `__DEV__`.
 */
const BrowserPageError = memo<BrowserPageErrorProps>(function BrowserPageError({
  error,
  host,
  canGoBack = false,
  onRetry,
  onGoBack,
  onGoHome,
}) {
  const copy = useMemo(() => classifyPageLoadError(error, host), [error, host]);
  const isDanger = copy.severity === "danger";

  // Browsers reload an offline page by themselves the moment connectivity
  // comes back. We have no connectivity listener in the bundle, but the
  // fix for "you are offline" almost always happens outside the app
  // (pulling down the shade, toggling Wi-Fi, walking somewhere with
  // signal), so returning to the foreground is a good proxy for "something
  // about the network may have changed". Only for failures reconnecting
  // can actually fix.
  const retryRef = useRef(onRetry);
  retryRef.current = onRetry;
  useEffect(() => {
    if (!copy.retryOnReconnect) return;
    let wasBackgrounded = false;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && wasBackgrounded) {
        wasBackgrounded = false;
        retryRef.current();
      } else if (state !== "active") {
        wasBackgrounded = true;
      }
    });
    return () => sub.remove();
  }, [copy.retryOnReconnect]);

  const actions: NoticeAction[] = [];
  if (copy.canRetry) {
    actions.push({
      label: "Try again",
      onPress: onRetry,
      variant: "primary",
      icon: RotateCcw,
    });
  }
  if (canGoBack) {
    // On a security failure, leaving is the safe move, so it takes the
    // filled button and retry is demoted or absent entirely.
    actions.push({
      label: "Go back",
      onPress: onGoBack,
      variant: isDanger && !copy.canRetry ? "primary" : "outline",
      icon: ArrowLeft,
    });
  }
  actions.push({
    label: "Back to dApps",
    onPress: onGoHome,
    variant: "ghost",
    icon: Compass,
  });

  return (
    <BrowserNoticePage
      icon={ICON_BY_KIND[copy.kind]}
      tone={isDanger ? "warning" : "neutral"}
      title={copy.title}
      body={copy.body}
      actions={actions}
      // Developer-only. The platform code and description are exactly the
      // machine-shaped text users must never see.
      footnote={
        __DEV__
          ? `${error.domain ?? "-"} ${error.code ?? "-"} ${error.description ?? ""}`.trim()
          : undefined
      }
    />
  );
});

export default BrowserPageError;
