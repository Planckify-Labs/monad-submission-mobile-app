import { useEffect } from "react";
import { AppState, type AppStateStatus, Platform } from "react-native";
import {
  startAgentKeepAlive,
  stopAgentKeepAlive,
} from "@/modules/agent-keep-alive";
import { useAgentBusy } from "./useAgentBusy";

/** Body of the Android foreground-service notification. */
const KEEP_ALIVE_COPY = "Finishing your request…";

/**
 * Keeps an in-flight Takumi Agent turn alive across backgrounding. Mounted
 * once in `AppShell`; reads the global `useAgentBusy()` signal so it knows
 * nothing about agent internals.
 *
 * Only `thinking` (the SSE stream) is protected. `awaiting_approval` /
 * `awaiting_preview` are the turn idling on the user, and a `dataSync`
 * service with a persistent notification would be misleading there.
 *
 * Platform-divergent start timing, on purpose:
 * - Android claims the service for the whole stream, from the foreground,
 *   because Android 12+ refuses a foreground-service start once the app is
 *   already in the background. The notification therefore shows even while
 *   the app is in front; that is the price of being allowed to hold it later.
 * - iOS claims only on the background transition: `beginBackgroundTask`
 *   buys a finite window, so there is nothing to gain from holding it early.
 */
export function useAgentBackgroundKeepAlive(): void {
  const { isBusy, reason } = useAgentBusy();
  const streaming = isBusy && reason === "thinking";

  useEffect(() => {
    if (!streaming) return undefined;

    if (Platform.OS === "android") {
      if (AppState.currentState === "active") {
        startAgentKeepAlive(KEEP_ALIVE_COPY);
      }
      return () => stopAgentKeepAlive();
    }

    if (Platform.OS === "ios") {
      const sync = (state: AppStateStatus) => {
        if (state === "active") stopAgentKeepAlive();
        else startAgentKeepAlive(KEEP_ALIVE_COPY);
      };
      sync(AppState.currentState);
      const sub = AppState.addEventListener("change", sync);
      return () => {
        sub.remove();
        stopAgentKeepAlive();
      };
    }

    return undefined;
  }, [streaming]);
}
