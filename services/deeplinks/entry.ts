/**
 * The two doors into the intake pipeline that live inside the app:
 *
 *   - `intakeFromSystem` is what `app/+native-intent.tsx` calls for every
 *     OS-delivered URL (cold `getInitialURL`, warm `url` events).
 *   - `intakeFromWebView` is what the in-app dApps browser calls when a
 *     page navigates to one of the kernel's schemes (`wc:`, `ethereum:`,
 *     `takumiwallet://`, our universal link, …). Without it the WebView
 *     hands such URLs to the OS, which bounces them straight back into
 *     us as a *warm OS link*: the interstitial then treats an in-app
 *     flow as external (Android chooser, "return to caller" after the
 *     decision), and Android shows a wallet chooser to a user who is
 *     already inside a wallet.
 *
 * Both share the same dependencies and analytics; only the envelope's
 * `source` differs (`cold` / `warm` vs `internal`).
 */

import { Platform } from "react-native";
import { track } from "@/services/analytics/posthog";
import { readActiveBlockchainRows } from "@/services/blockchains/cache";
import { isOwnScheme, VERIFIED_HOST } from "@/services/security/deeplinkGate";
import { getSigningModeSync } from "@/services/security/signingMode";
import { walletConnectTransport } from "@/services/transports/walletconnect";
import {
  INBOX_ROUTE,
  type IntakeEvent,
  type IntakeResult,
  intake,
} from "./intake";
import { isKernelLink } from "./kernelLink";
import { markConsumed, wasConsumed } from "./ledger";
import type { DeepLinkEnvelope } from "./types";

export { isKernelLink };

function deps() {
  return {
    chainRows: readActiveBlockchainRows,
    signingModeOn: getSigningModeSync,
    ledger: { wasConsumed, markConsumed },
    onEvent: emit,
    onWake: (w: { topic: string; requestId: string }) =>
      void walletConnectTransport.wake(w),
  };
}

function platform(): DeepLinkEnvelope["platform"] {
  return Platform.OS === "ios" ? "ios" : "android";
}

export function intakeFromSystem(args: {
  path: string;
  initial: boolean;
}): IntakeResult {
  return intake(
    {
      raw: args.path,
      source: args.initial ? "cold" : "warm",
      initial: args.initial,
      receivedAt: Date.now(),
      platform: platform(),
    },
    deps(),
  );
}

/**
 * Run a WebView-originated link through the kernel and navigate for it.
 * Returns `true` when the link was taken (the WebView must cancel the
 * navigation), `false` when it is not ours.
 */
export function intakeFromWebView(url: string): boolean {
  if (!isKernelLink(url)) return false;
  // Resolved here, not at module scope: `app/+native-intent.tsx` imports
  // this file while expo-router is still building its linking config.
  const { router } = require("expo-router") as {
    router: { push: (href: never) => void };
  };
  let result: IntakeResult;
  try {
    result = intake(
      {
        raw: url,
        source: "internal",
        initial: false,
        receivedAt: Date.now(),
        platform: platform(),
      },
      deps(),
    );
  } catch (e) {
    if (__DEV__) console.warn("[deeplinks/entry] intake threw", e);
    router.push(`${INBOX_ROUTE}?error=1` as never);
    return true;
  }
  switch (result.kind) {
    case "inbox":
      router.push(INBOX_ROUTE as never);
      return true;
    case "route":
      router.push(result.href as never);
      return true;
    case "passthrough":
    case "ignore":
      return true;
  }
}

export function emit(event: IntakeEvent): void {
  try {
    if (event.name === "deeplink_received") {
      track("deeplink_received", {
        class: event.class,
        transport: event.transport,
        verification: event.verification,
        namespace: event.namespace ?? undefined,
        source: event.source,
      });
    } else {
      track("deeplink_rejected", { code: event.code });
    }
  } catch {
    // analytics is best-effort
  }
}
