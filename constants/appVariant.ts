/**
 * Build variant + private URL scheme at runtime.
 *
 * `app.config.ts` decides the variant from `APP_VARIANT` (set per EAS
 * profile in `eas.json`) and publishes it as `extra.appVariant`; the
 * scheme below mirrors `app.config.ts#getScheme` so transports that
 * must redirect back into *this* build (WalletConnect, MWA attestation)
 * never target a sibling install.
 */

import Constants from "expo-constants";

export type AppVariant = "development" | "preview" | "production";

export function resolveAppVariant(): AppVariant {
  const v = Constants.expoConfig?.extra?.appVariant;
  if (v === "development" || v === "preview") return v;
  return "production";
}

export const APP_VARIANT: AppVariant = resolveAppVariant();

/** Mirrors `app.config.ts#getScheme`. */
export const APP_SCHEME =
  APP_VARIANT === "development"
    ? "takumiwallet-dev"
    : APP_VARIANT === "preview"
      ? "takumiwallet-preview"
      : "takumiwallet";
