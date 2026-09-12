/**
 * `AppMinimizer` — sends the app's task to the back on Android so the
 * user lands on the app they came from (the browser that opened a
 * WalletConnect link, say). This is what every Android wallet does after
 * a deep-linked approval; `BackHandler.exitApp()` would finish the
 * activity instead and lose the React tree.
 *
 * iOS has no equivalent (the status-bar breadcrumb is the way back), so
 * `moveTaskToBack` reports `false` there and callers fall back to the
 * dApp's own redirect URL when it gave one.
 */

import { requireOptionalNativeModule } from "expo-modules-core";

interface AppMinimizerNative {
  moveTaskToBack(): boolean;
}

const native = requireOptionalNativeModule<AppMinimizerNative>("AppMinimizer");

/** `true` when the task was moved to the back. */
export function moveTaskToBack(): boolean {
  try {
    return native?.moveTaskToBack() ?? false;
  } catch {
    return false;
  }
}

export const isAppMinimizerAvailable = native != null;
