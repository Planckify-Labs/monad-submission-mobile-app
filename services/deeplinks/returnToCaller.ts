/**
 * Hand the user back to the app that deep-linked us (deep-link spec §7.3
 * step 4, "redirect after approval"). Order of preference:
 *
 *   1. The dApp's own `redirect.native` (a custom scheme): opens it.
 *   2. Android: `moveTaskToBack` (modules/app-minimizer), which shows
 *      whatever launched us, usually the browser. This is what a web dApp
 *      in Chrome needs, since it has no redirect URL of its own.
 *   3. iOS with a `redirect.universal`: a "Return to {app}" notice (auto
 *      opening it from a wallet is refused by Safari in some cases).
 *   4. Otherwise nothing: iOS shows the system back breadcrumb.
 *
 * Only ever called for flows that arrived through an OS link; in-app
 * browser flows never leave the app (`source: "internal"`).
 */

import { Linking, Platform } from "react-native";
import { moveTaskToBack } from "@/modules/app-minimizer";
import { INTERSTITIAL_COPY } from "./copy";
import { deepLinkNotices } from "./notices";

export interface CallerRedirect {
  native?: string;
  universal?: string;
}

export function returnToCaller(args: {
  appName: string;
  redirect?: CallerRedirect;
  /** Notice title when we cannot leave automatically (e.g. "Connected"). */
  noticeTitle: string;
}): void {
  const { appName, redirect, noticeTitle } = args;
  const native = redirect?.native;
  const universal = redirect?.universal;
  if (native && !/^https?:/i.test(native)) {
    Linking.openURL(native).catch(() => {
      if (!fallbackToBackground()) {
        deepLinkNotices.push({
          title: noticeTitle,
          body: INTERSTITIAL_COPY.sentBackTo.replace("{app}", appName),
        });
      }
    });
    return;
  }
  if (fallbackToBackground()) return;
  if (universal && /^https:/i.test(universal)) {
    deepLinkNotices.push({
      title: noticeTitle,
      body: INTERSTITIAL_COPY.sentBackTo.replace("{app}", appName),
      action: {
        label: INTERSTITIAL_COPY.returnTo.replace("{app}", appName),
        onPress: () => {
          Linking.openURL(universal).catch(() => {});
        },
      },
    });
  }
}

function fallbackToBackground(): boolean {
  if (Platform.OS !== "android") return false;
  return moveTaskToBack();
}
