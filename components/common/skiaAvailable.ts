import { TurboModuleRegistry } from "react-native";

// `@shopify/react-native-skia` is native. A dev client built before it was
// added has no `RNSkiaModule`, and Skia's first use then throws
// `TurboModuleRegistry.getEnforcing(...): 'RNSkiaModule' could not be
// found` mid-render, taking the screen down with it. A try/catch around a
// `require` (the dappCookies pattern) cannot catch that here: Metro's
// `inlineRequires` defers Skia's evaluation to the render, past the catch.
// So probe the registry, which returns null instead of throwing, and only
// load a Skia renderer when the module is really there.

let available: boolean | undefined;

export function isSkiaAvailable(): boolean {
  if (available !== undefined) return available;
  available = TurboModuleRegistry.get("RNSkiaModule") != null;
  if (!available && __DEV__) {
    console.warn(
      "[skia] RNSkiaModule missing from this binary; rebuild the dev client. Skia visuals fall back or hide.",
    );
  }
  return available;
}
