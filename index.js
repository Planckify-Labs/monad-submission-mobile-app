/**
 * App entry — deep-link spec §8.1.
 *
 * `expo-router/entry` registers the main app root exactly as before
 * (`registerRootComponent(ExpoRoot)`). On Android a second root,
 * `TakumiMwaEntrypoint`, is registered for the dedicated Mobile Wallet
 * Adapter host activity declared by `plugins/withSolanaMobileWalletAdapter`.
 * It is never rendered by `MainActivity`; it only exists so the MWA
 * activity's `getMainComponentName()` resolves.
 */
import "expo-router/entry";
import { AppRegistry, Platform } from "react-native";

if (Platform.OS === "android") {
  AppRegistry.registerComponent(
    "TakumiMwaEntrypoint",
    () => require("./services/transports/mwa/MwaEntrypoint").MwaEntrypoint,
  );
}
