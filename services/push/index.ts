/**
 * `services/push/index.ts` — FCM / APNs push client for PAID_OUT receipts.
 *
 * Spec: `docs/umkm-usdc-payout-spec.md` §6.3 (webhook → push), §8.3
 * (deep-link contract), §8.5 (linking config). Task 32.
 *
 * Shape:
 *   - `registerForPushNotifications()` — idempotent; requests permission,
 *     obtains the Expo push token, POSTs it to `users/me/push-token`.
 *     If the backend endpoint isn't implemented yet (404), we log and
 *     bail — this task ships the client half; the server half is
 *     orthogonal (task 50 / backend team).
 *   - `usePushNotificationHandler()` — installs two global listeners:
 *       1. foreground receive: if `data.intentId` is present, invalidate
 *          the intent query so the polling screen refreshes instantly
 *          instead of waiting for the 3 s interval.
 *       2. tap (background / killed): if `data.intentId` is present,
 *          deep-link to the receipt screen per §8.5 #1.
 *
 * Three-role separation (memory `feedback_role_separation.md`): the
 * wallet never signs for pushes. The server sends; we receive and
 * refresh. Do not log `data.signature | data.nonce | data.amount` —
 * the spec forbids routing sensitive fields through push payloads.
 *
 * Graceful degradation: every step here fails-closed with a log. Missing
 * permissions, missing backend endpoint, missing Android channel — the
 * app keeps working, the user just doesn't see the push banner.
 *
 * Chain-extension discipline (memory `feedback_chain_extension_discipline.md`):
 * the deep-link is namespace-agnostic. `intentId` is all the receipt
 * needs — the intent carries its own chain discriminator.
 */

import { useQueryClient } from "@tanstack/react-query";
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { HTTPError } from "ky";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { optionalAuthApi } from "@/constants/configs/ky";
import { pointsQueryKeys } from "@/constants/queryKeys/pointsQueryKeys";
import { redeemQueryKeys } from "@/constants/queryKeys/redeemQueryKeys";
import { transactionsQueryKeys } from "@/constants/queryKeys/transactionsQueryKeys";
import {
  armPendingAgentPrompt,
  setAgentPrefillDirect,
} from "@/hooks/useAgentPrefill";
import { usePaymentIntentInvalidator } from "@/hooks/usePaymentIntentInvalidator";

/**
 * Android 8+ requires every notification to belong to a channel — the
 * OS silently drops notifications that reference a missing channel. We
 * register this at boot (idempotent; safe to call on every cold start)
 * so the server's FCM payload with `channelId: "payouts"` lands.
 */
const ANDROID_PAYOUT_CHANNEL_ID = "payouts";
const ANDROID_POINTS_CHANNEL_ID = "points";
const ANDROID_STRATEGIES_CHANNEL_ID = "strategies";
const ANDROID_TRANSFERS_CHANNEL_ID = "transfers";

/**
 * Register the Android notification channel for payout receipts. No-op
 * on iOS (iOS has no channel concept — category/thread IDs are APNs-side).
 */
export async function registerAndroidPayoutChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync(ANDROID_PAYOUT_CHANNEL_ID, {
      name: "Payout receipts",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#c71c4b",
      description:
        "Notifications when a merchant receives IDR for your payment.",
    });
  } catch (err) {
    console.warn("[push] failed to register Android payout channel:", err);
  }
}

/**
 * Register the Android notification channel for point deposits and
 * redemptions. No-op on iOS.
 */
export async function registerAndroidPointsChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync(ANDROID_POINTS_CHANNEL_ID, {
      name: "Points & redemptions",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#c71c4b",
      description:
        "Notifications when a point deposit is confirmed or a redemption is ready.",
    });
  } catch (err) {
    console.warn("[push] failed to register Android points channel:", err);
  }
}

/**
 * Register the Android notification channel for auto-compound nudges
 * (`AutoCompoundWatcherProcessor` sends `channelId: "strategies"`). No-op
 * on iOS.
 */
export async function registerAndroidStrategiesChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync(
      ANDROID_STRATEGIES_CHANNEL_ID,
      {
        name: "Strategies & yield",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#c71c4b",
        description: "Reminders to compound rewards on your active positions.",
      },
    );
  } catch (err) {
    console.warn("[push] failed to register Android strategies channel:", err);
  }
}

/**
 * Register the Android notification channel for incoming transfers
 * (`TransactionsService.create` sends `channelId: "transfers"` when a
 * TRANSFER-type transaction names this device's wallet as recipient).
 * No-op on iOS.
 */
export async function registerAndroidTransfersChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync(
      ANDROID_TRANSFERS_CHANNEL_ID,
      {
        name: "Transfers",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#c71c4b",
        description:
          "Notifications when you receive a transfer from another wallet.",
      },
    );
  } catch (err) {
    console.warn("[push] failed to register Android transfers channel:", err);
  }
}

// Tracks the last attempted wallet list so the foreground-retry hook can
// re-use it without the call site needing to pass it again.
const retryState = {
  failed: false,
  wallets: [] as string[],
};

/**
 * Request push permission, obtain an Expo push token, and POST it to
 * the backend. Idempotent — safe to call whenever the wallet list changes.
 * Returns true on success, false on any unrecoverable failure (so callers
 * can decide whether to retry). Fails-closed on every branch so the app
 * always keeps working without push.
 */
export async function registerForPushNotifications(
  wallets: string[],
): Promise<boolean> {
  await registerAndroidPayoutChannel();
  await registerAndroidPointsChannel();
  await registerAndroidStrategiesChannel();
  await registerAndroidTransfersChannel();

  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    console.log("[push] skipping registration in Expo Go");
    return true; // not a failure — expected environment
  }

  try {
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== "granted") {
      const requested = await Notifications.requestPermissionsAsync();
      status = requested.status;
    }
    if (status !== "granted") {
      console.log("[push] permission not granted — not retrying");
      retryState.failed = false; // permission denied is not a transient failure
      return true;
    }

    const tokenRes = await Notifications.getExpoPushTokenAsync();
    const token = tokenRes.data;
    if (!token) {
      console.warn("[push] getExpoPushTokenAsync returned empty");
      return false;
    }

    if (__DEV__) {
      console.log(
        `\n========== EXPO PUSH TOKEN (copy below) ==========\n${token}\n==================================================\n`,
      );
    }

    const ok = await postPushToken(token, wallets);
    retryState.failed = !ok;
    retryState.wallets = wallets;
    return ok;
  } catch (err) {
    console.warn("[push] registerForPushNotifications threw:", err);
    retryState.failed = true;
    retryState.wallets = wallets;
    return false;
  }
}

/**
 * Mount once at the app root. When the app comes back to the foreground
 * and the last registration attempt failed (e.g. was offline), retries
 * automatically — no user action required.
 */
export function usePushRegistrationRetry(): void {
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (
        nextState === "active" &&
        retryState.failed &&
        retryState.wallets.length > 0
      ) {
        console.log("[push] retrying registration on foreground");
        void registerForPushNotifications(retryState.wallets);
      }
    });
    return () => sub.remove();
  }, []);
}

const POST_RETRY_DELAYS_MS = [0, 1000, 3000]; // immediate, 1 s, 3 s

// Returns true on success (including 404 = not-yet-deployed), false on
// exhausted retries so the caller can schedule a foreground retry.
async function postPushToken(
  token: string,
  wallets: string[],
): Promise<boolean> {
  for (let attempt = 0; attempt < POST_RETRY_DELAYS_MS.length; attempt++) {
    const delay = POST_RETRY_DELAYS_MS[attempt] ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    try {
      // Controller responds 204 No Content — don't call `.json()`, it
      // would try (and fail) to parse an empty body.
      await optionalAuthApi.post("users/me/push-token", {
        json: { token, platform: Platform.OS, wallets },
      });
      console.log("[push] token registered with backend");
      return true;
    } catch (err) {
      const status =
        err instanceof HTTPError
          ? err.response.status
          : (err as { response?: { status?: number } })?.response?.status;

      if (status === 404) {
        console.log(
          "[push] backend /users/me/push-token not deployed yet — skipping",
        );
        return true;
      }

      const isLast = attempt === POST_RETRY_DELAYS_MS.length - 1;
      if (isLast) {
        console.warn(
          `[push] registration failed after ${POST_RETRY_DELAYS_MS.length} attempts:`,
          err,
        );
        return false;
      }
      console.warn(
        `[push] registration attempt ${attempt + 1} failed, retrying:`,
        err,
      );
    }
  }
  return false;
}

/** Shape of the `data` payload we expect from server-sent PAID_OUT pushes. */
interface PayoutPushData {
  intentId?: string;
  // Display fields (safe to show in banner / log); the server never
  // includes signature / nonce / Circle internals per §6.3.
  merchantDisplayName?: string;
  fiatAmountMinor?: number;
  fiatCurrency?: string;
}

function readPayoutData(
  notification: Notifications.Notification,
): PayoutPushData | null {
  const raw = notification.request.content.data;
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.intentId !== "string" || data.intentId.length === 0) {
    return null;
  }
  return {
    intentId: data.intentId,
    merchantDisplayName:
      typeof data.merchantDisplayName === "string"
        ? data.merchantDisplayName
        : undefined,
    fiatAmountMinor:
      typeof data.fiatAmountMinor === "number"
        ? data.fiatAmountMinor
        : undefined,
    fiatCurrency:
      typeof data.fiatCurrency === "string" ? data.fiatCurrency : undefined,
  };
}

/** Shape of the `data` payload for point-deposit / redemption pushes. */
interface PointsPushData {
  type: "point_deposit" | "redemption";
  pointTransactionId?: string;
  redemptionId?: string;
}

function readPointsPushData(
  notification: Notifications.Notification,
): PointsPushData | null {
  const raw = notification.request.content.data;
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (data.type !== "point_deposit" && data.type !== "redemption") return null;
  return {
    type: data.type,
    pointTransactionId:
      typeof data.pointTransactionId === "string"
        ? data.pointTransactionId
        : undefined,
    redemptionId:
      typeof data.redemptionId === "string" ? data.redemptionId : undefined,
  };
}

/**
 * Shape of the `data` payload for a recurring-invest reminder
 * (DCA v1, docs/defi-quick-invest-spec.md §12.5).
 *
 * The server sends a plan-derived `prompt` — product wording only, no
 * vendor or infrastructure detail — which the device replays into the
 * agent as if the user had typed it. That lands on the normal
 * `defi_list_opportunities` → Quick Invest path. There is NO new deposit
 * UI and no new navigation primitive, and nothing is signed or submitted
 * by tapping the notification.
 */
interface RecurringInvestPushData {
  planId?: string;
  prompt?: string;
}

function readRecurringInvestPushData(
  notification: Notifications.Notification,
): RecurringInvestPushData | null {
  const raw = notification.request.content.data;
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (data.kind !== "recurring_invest_nudge") return null;
  return {
    planId: typeof data.planId === "string" ? data.planId : undefined,
    prompt: typeof data.prompt === "string" ? data.prompt : undefined,
  };
}

/** Shape of the `data` payload for incoming-transfer pushes. */
interface TransferPushData {
  transactionId?: string;
}

function readTransferPushData(
  notification: Notifications.Notification,
): TransferPushData | null {
  const raw = notification.request.content.data;
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (data.type !== "transfer") return null;
  return {
    transactionId:
      typeof data.transactionId === "string" ? data.transactionId : undefined,
  };
}

/**
 * Install foreground receive + tap handlers. Must be mounted once at
 * the top of the component tree (app/_layout.tsx) — listeners are
 * global, adding them per-screen would fire the invalidator N times.
 */
export function usePushNotificationHandler(): void {
  const invalidateIntent = usePaymentIntentInvalidator();
  const queryClient = useQueryClient();

  useEffect(() => {
    // Foreground receive — the OS banner still shows (per
    // `initNotificationHandlers` in `services/notifications/handlers.ts`,
    // which sets `shouldShowBanner: true`). We additionally invalidate
    // the intent query so any open receipt screen refreshes instantly
    // without waiting for the 3 s poll interval.
    const receiveSub = Notifications.addNotificationReceivedListener(
      (notification) => {
        const payoutData = readPayoutData(notification);
        if (payoutData?.intentId) {
          invalidateIntent(payoutData.intentId);
          return;
        }

        const pointsData = readPointsPushData(notification);
        if (pointsData) {
          // Broad prefix — cheaper and safer than reconstructing every
          // param-shaped key variant (balance/history/depositStatus) by hand.
          queryClient.invalidateQueries({ queryKey: pointsQueryKeys.all });
          if (pointsData.type === "redemption") {
            queryClient.invalidateQueries({ queryKey: redeemQueryKeys.all });
          }
          return;
        }

        const transferData = readTransferPushData(notification);
        if (transferData) {
          queryClient.invalidateQueries({
            queryKey: transactionsQueryKeys.all,
          });
        }
      },
    );

    // Tap (background / killed) — navigate to the receipt deep link.
    // Expo Router typed-routes doesn't always know about
    // `/pay-merchant/receipt` during early builds, so we cast via
    // `as never` the same way `app/pay-merchant.tsx` does for
    // `/pay-merchant`.
    const responseSub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = readPayoutData(response.notification);
        if (!data?.intentId) {
          const pointsData = readPointsPushData(response.notification);
          if (pointsData) {
            if (pointsData.type === "redemption" && pointsData.redemptionId) {
              try {
                router.push({
                  pathname: "/activity-detail" as never,
                  params: { redemptionId: pointsData.redemptionId },
                });
              } catch (err) {
                console.warn(
                  "[push] activity-detail route not available:",
                  err,
                );
              }
              return;
            }

            // Point deposits have no dedicated detail screen yet — land
            // on the wallet screen, which shows the updated balance.
            try {
              router.push("/wallet" as never);
            } catch (err) {
              console.warn("[push] wallet route not available:", err);
            }
            return;
          }

          const recurringData = readRecurringInvestPushData(
            response.notification,
          );
          if (recurringData?.prompt) {
            // Two writes, both required. The React Query entry is what
            // `AgentMode` drains on this launch; the MMKV copy is what
            // survives a detour through sign-in, because a nudge fires
            // days or weeks after setup and the session may have expired
            // (§12.5b). The chat lives under the home pager, so routing
            // home is part of the hand-off, not separate from it.
            armPendingAgentPrompt(recurringData.prompt);
            setAgentPrefillDirect(recurringData.prompt, { autoSend: true });
            try {
              router.push("/" as never);
            } catch (err) {
              console.warn("[push] home route not available:", err);
            }
            return;
          }

          const transferData = readTransferPushData(response.notification);
          if (transferData?.transactionId) {
            try {
              router.push({
                pathname: "/activity-detail" as never,
                params: { transferId: transferData.transactionId },
              });
            } catch (err) {
              console.warn("[push] activity-detail route not available:", err);
            }
          }
          return;
        }
        try {
          router.push({
            pathname: "/pay-merchant/receipt" as never,
            params: { intentId: data.intentId },
          });
        } catch (err) {
          // Fall back to the base /pay-merchant screen if the receipt
          // nested route isn't registered yet — it still renders the
          // PaidCard from the M2 path when intent.status is terminal.
          console.warn(
            "[push] receipt route not available, falling back:",
            err,
          );
          try {
            router.push({
              pathname: "/pay-merchant" as never,
              params: { intentId: data.intentId },
            });
          } catch (fallbackErr) {
            console.warn("[push] fallback deep-link also failed:", fallbackErr);
          }
        }
      },
    );

    return () => {
      receiveSub.remove();
      responseSub.remove();
    };
  }, [invalidateIntent, queryClient]);
}
