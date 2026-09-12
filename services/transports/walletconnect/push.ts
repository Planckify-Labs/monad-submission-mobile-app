/**
 * WalletConnect push registration (spec §7.5).
 *
 * The relay can only deliver to a connected socket. When the app is
 * closed, WalletConnect instead POSTs the request to the push server the
 * project's Dashboard "Push URL" points at: our own API
 * (`api/src/walletconnect-push`, `https://<api>/walletconnect/push`),
 * which sends a plain "open TakumiPay" notification through Expo. The
 * tap opens the app, the relay reconnects, and the request lands as
 * usual. For that the wallet registers its relay client id together with
 * the device's **Expo** push token (the same token `services/push`
 * registers with `/users/me/push-token`); `registerDeviceToken` posts it
 * to WalletConnect under our project id and WalletConnect forwards it to
 * the push URL. `notificationType` only labels the platform.
 *
 * `enableEncrypted: false` on purpose: the server never decrypts
 * anything; a visible notification is all that is needed.
 *
 * Always on. Until the Dashboard Push URL points at the API the
 * registration is stored by WalletConnect and delivers nowhere, which is
 * harmless; once it does, existing installs start receiving without an
 * app update.
 */

import type { IWalletKit } from "@reown/walletkit";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

let registeredToken: string | null = null;

export async function registerWalletConnectPush(
  kit: IWalletKit,
): Promise<void> {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") return;
    const expo = await Notifications.getExpoPushTokenAsync();
    const token = expo.data;
    if (!token || token === registeredToken) return;
    const clientId = await kit.core.crypto.getClientId();
    await kit.registerDeviceToken({
      clientId,
      token,
      notificationType:
        Platform.OS === "ios" ? (__DEV__ ? "apns-sandbox" : "apns") : "fcm",
      enableEncrypted: false,
    });
    registeredToken = token;
  } catch (e) {
    if (__DEV__) console.warn("[wc] push registration failed", e);
  }
}
