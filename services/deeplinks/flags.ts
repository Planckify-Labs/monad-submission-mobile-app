/**
 * Deep-link feature flags — spec §12.
 *
 * Compile-time constants in the style of `FEATURE_STELLAR_DAPP_BRIDGE` in
 * `services/bridge/boot.ts`: a flag flips in a release, never remotely.
 * When a flag is `false` the scheme is still registered at the OS level,
 * so the interstitial can say "not enabled in this version" instead of
 * the OS bouncing the link to another wallet silently.
 *
 * Rollout (spec §15): every phase ships to preview with its flag on and
 * is flipped for production in the release that follows its device
 * matrix passing. Flip here, in one commit, per phase.
 *
 * Pure module (no Expo / RN imports) so the kernel tests can import it.
 */

/** Phase 0 — kernel, interstitial, root spine + lock gate. */
export const FEATURE_DEEPLINK_KERNEL = true;
/** Phase 1 — Class A payment URIs (ERC-681, Solana Pay transfer, sui:pay, SEP-0007 pay). */
export const FEATURE_DEEPLINK_PAY_URIS = true;
/** Phase 1 — Class B signing URIs (Solana Pay tx request, SEP-0007 tx). */
export const FEATURE_DEEPLINK_SIGN_URIS = true;
/** Phase 2 — WalletConnect v2 across all namespaces. */
export const FEATURE_WALLETCONNECT = true;
/** Phase 3 — Solana Mobile Wallet Adapter (Android, dedicated activity). D-1: preview soak first. */
export const FEATURE_MWA = true;
/** Phase 3 — Phantom-compatible encrypted deep links (`/ul/v1/*`). */
export const FEATURE_ENCRYPTED_LINK = true;
/**
 * Phase 2b — WalletConnect Link Mode (EVM only). One-Click Auth is live
 * regardless; this flag only adds `redirect.linkMode` to the session
 * metadata, which the SDK disables internally for non-EVM sessions.
 * Flip after `https://takumipay.xyz/wc` is registered in the
 * WalletConnect Dashboard (D-11) and the latency win is measured (§15).
 */
export const FEATURE_WALLETCONNECT_LINK_MODE = false;

/**
 * D-8 — MWA native callers must pass Digital Asset Links verification.
 * A constant, not a flag: there is no build in which this is off.
 */
export const MWA_REQUIRE_DAL = true as const;

/**
 * Phase 3b — MWA origin attestation for browser-launched (web) dApps.
 *   - `off`: never challenge; web dApps stay "Unverified app" (D-8).
 *   - `opt-in`: challenge only dApps that request the
 *     `solana:attestOrigin` feature in `authorize.features`. Clients that
 *     do not implement the retry are unaffected.
 *   - `required`: challenge every web dApp. Only once the ecosystem
 *     client (`@solana-mobile/mobile-wallet-adapter-protocol`) ships the
 *     retry, or every unattesting web dApp fails to connect.
 */
export const MWA_ORIGIN_ATTESTATION: "off" | "opt-in" | "required" = "opt-in";

/** Maps a `DeepLinkIntent` class to the flag that gates it. */
export function isClassEnabled(
  cls: "payment" | "signing" | "pair" | "associate" | "encrypted-link",
): boolean {
  switch (cls) {
    case "payment":
      return FEATURE_DEEPLINK_PAY_URIS;
    case "signing":
      return FEATURE_DEEPLINK_SIGN_URIS;
    case "pair":
      return FEATURE_WALLETCONNECT;
    case "associate":
      return FEATURE_MWA;
    case "encrypted-link":
      return FEATURE_ENCRYPTED_LINK;
  }
}
