import type { ConfigContext, ExpoConfig } from "expo/config";

const IS_DEV = process.env.APP_VARIANT === "development";
const IS_PREVIEW = process.env.APP_VARIANT === "preview";

const getBundleId = () => {
  if (IS_DEV) return "com.planckify.takumiwallet.dev";
  if (IS_PREVIEW) return "com.planckify.takumiwallet.preview";
  return "com.planckify.takumiwallet";
};

const getAppName = () => {
  if (IS_DEV) return "TakumiPay (Dev)";
  if (IS_PREVIEW) return "TakumiPay (Preview)";
  return "TakumiPay";
};

const getScheme = () => {
  if (IS_DEV) return "takumiwallet-dev";
  if (IS_PREVIEW) return "takumiwallet-preview";
  return "takumiwallet";
};

// TODO(TWV-2026-055) — EAS Update code signing is DEFERRED.
// The original plan (see `docs/runbooks/eas-update-signing.md`) wires the
// production OTA channel to an AWS KMS-backed signing key with two-person
// approval so the client can refuse tampered update manifests. The public
// cert was never produced, so the signing block is disabled to unblock
// shipping. Before EAS Update is actually used in production, run the
// key ceremony, commit `certs/eas-update-prod.pem`, bump the
// `keyid` below to the rotation month, and re-enable the block in the
// `updates` config. Until then, OTA updates are NOT cryptographically
// verified — treat `eas update` as off-limits for the production channel.
//
// const CODE_SIGNING_CERTIFICATE = "./certs/eas-update-prod.pem";
// const CODE_SIGNING_METADATA = {
//   keyid: "eas-update-prod-2026",
//   alg: "rsa-v1_5-sha256",
// } as const;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: getAppName(),
  slug: "takumiwallet",
  version: "5.23.0",
  runtimeVersion: { policy: "fingerprint" },
  updates: {
    fallbackToCacheTimeout: 0,
    // TODO(TWV-2026-055) — re-enable once the signing cert is committed:
    // ...(IS_DEV || IS_PREVIEW
    //   ? {}
    //   : {
    //       codeSigningCertificate: CODE_SIGNING_CERTIFICATE,
    //       codeSigningMetadata: CODE_SIGNING_METADATA,
    //     }),
  },
  orientation: "portrait",
  icon: "./assets/images/takumipay-logo.png",
  // Deep-link wallet interactions (docs/deeplink-wallet-interactions-spec.md
  // §12). Our own scheme plus the chain-native and WalletConnect schemes
  // every ecosystem emits. Custom schemes are contended on both OSes and
  // are accepted as *input* only: every link goes through
  // `app/+native-intent.tsx` → the intake pipeline → the interstitial,
  // never straight to a screen. `solana-wallet` (MWA) is Android-only and
  // owned by `./plugins/withSolanaMobileWalletAdapter` (dedicated
  // activity), not listed here.
  scheme: [getScheme(), "ethereum", "solana", "sui", "web+stellar", "wc"],
  userInterfaceStyle: "automatic",
  jsEngine: "hermes",
  newArchEnabled: true,
  ios: {
    supportsTablet: true,
    jsEngine: "hermes",
    bundleIdentifier: getBundleId(),
    icon: {
      light: "./assets/icons/light.png",
      dark: "./assets/icons/dark.png",
    },
    // TWV-2026-024 — Universal Links. Custom URL schemes
    // (`takumiwallet://`) are NOT exclusively registrable; a phishing
    // app can register the same scheme and intercept WalletConnect
    // pairing URIs. AASA hosted at
    // `https://takumipay.xyz/.well-known/apple-app-site-association`
    // verifies this app as the sole opener for `https://takumipay.xyz/*`.
    //
    // `webcredentials:` — Mera passkeys (docs/monad-metropolis-2026-spec.md
    // §3.3). The passkey relying party is `takumipay.xyz`; iOS only lets an
    // app create/assert passkeys for a domain whose AASA `webcredentials`
    // block lists this app id, for EVERY bundle variant that ships the
    // flow (`.preview` is the judged build).
    associatedDomains: [
      "applinks:takumipay.xyz",
      "webcredentials:takumipay.xyz",
    ],
    infoPlist: {
      // Only schemes we *query* with `canOpenURL` (none today); dApp
      // return links are opened with `openURL` inside try/catch, so this
      // stays empty on purpose (50-entry cap, unbounded dApp schemes).
      LSApplicationQueriesSchemes: [],
    },
  },
  android: {
    adaptiveIcon: {
      foregroundImage: "./assets/images/adaptive-icon.png",
      backgroundColor: "#f5f6f9",
    },
    jsEngine: "hermes",
    edgeToEdgeEnabled: true,
    package: getBundleId(),
    // Firebase / FCM config. Single google-services.json carries
    // client_info entries for all three bundle IDs (dev / preview /
    // prod) under the same Firebase project (takumipay-b6ef3), so
    // push delivery is unified across build profiles.
    googleServicesFile: "./google-services.json",
    // TWV-2026-059 — disable `adb backup` and Auto Backup. The wallet's
    // credentials live in Android Keystore via SecureStore, which is
    // excluded from `adb backup` by default, but a wallet binary must
    // not let any side-file (MMKV, AsyncStorage, Expo FileSystem) leak
    // via the USB debugging surface either. `dataExtractionRules` (API
    // 31+) and `fullBackupContent` (legacy) are referenced via
    // `manifestPlaceholders` / `extraManifestAttrs`; the ruleset XML
    // files live under `./android/data_extraction_rules.xml` and
    // `./android/backup_rules.xml` in the config-plugin output.
    allowBackup: false,
    permissions: [
      "android.permission.CAMERA",
      "android.permission.RECORD_AUDIO",
    ],
    // TWV-2026-024 — verified Android App Links. assetlinks.json at
    // `https://takumipay.xyz/.well-known/assetlinks.json` is verified
    // by Play / Android on first install; until verification succeeds,
    // the system shows a disambiguation dialog instead of opening the
    // wallet — never auto-routes to a phishing app that registered the
    // same `https` host.
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [{ scheme: "https", host: "takumipay.xyz", pathPrefix: "/" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
      // Generic, non-verified catch-all — no `host`, no `autoVerify`.
      // Android ≤ 11 only (deep-link spec F1): on Android 12+ a generic
      // web intent resolves to an app only for domains it is verified
      // for, so this filter is dead there and nothing may depend on it.
      // On older devices it puts TakumiPay in the "Open with" chooser
      // for third-party http(s) links; whatever the user picks us for
      // is routed by `app/+native-intent.tsx` into the sandboxed dApp
      // browser (`open-dapp`), never treated as a transport.
      {
        action: "VIEW",
        data: [{ scheme: "https" }, { scheme: "http" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  web: {
    bundler: "metro",
    output: "single",
    favicon: "./assets/images/takumipay-no-bg.png",
  },
  plugins: [
    "react-native-edge-to-edge",
    "./plugins/withAndroidBackupRules",
    "./plugins/withRemoveAndroidMediaPermissions",
    // Android-only: MWA host activity + `solana-wallet` filters + the
    // `/mobilewalletadapter` autoVerify filter (deep-link spec §8.1).
    "./plugins/withSolanaMobileWalletAdapter",
    "expo-router",
    [
      "expo-camera",
      {
        image: "./assets/images/takumipay-logo.png",
        imageWidth: 100,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
      },
    ],
    [
      "expo-audio",
      {
        microphonePermission:
          "TakumiPay uses the microphone to transcribe your voice into chat messages.",
        // We only record (voice-to-text transcription in TakumiAgent), never
        // play audio in the background. expo-audio defaults
        // enableBackgroundPlayback to true, which pulls in
        // FOREGROUND_SERVICE_MEDIA_PLAYBACK + a foreground media session
        // service we never use and Play Console then requires a policy
        // declaration for. Disabling it removes that permission/service
        // entirely instead of declaring an unused capability.
        enableBackgroundPlayback: false,
      },
    ],
    [
      "expo-splash-screen",
      {
        backgroundColor: "#f5f6f9",
        image: "./assets/images/splash-icon-light.png",
        dark: {
          image: "./assets/images/splash-icon-dark.png",
          backgroundColor: "#000000",
        },
        light: {
          image: "./assets/images/splash-icon-light.png",
          backgroundColor: "#f5f6f9",
        },
        imageWidth: 150,
      },
    ],
    // TWV-2026-059 — backup rules are owned by `withAndroidBackupRules`
    // (wholesale exclude). Tell expo-secure-store to skip its own
    // auto-backup stamping so it stops warning about the conflict.
    ["expo-secure-store", { configureAndroidBackup: false }],
    [
      "expo-web-browser",
      {
        experimentalLauncherActivity: true,
      },
    ],
    "expo-font",
    [
      "@react-native-google-signin/google-signin",
      {
        iosUrlScheme:
          "com.googleusercontent.apps.744419386674-851aigcjotu3nakge5l3drbk9dpij9ah",
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    tsconfigPaths: true,
  },
  owner: "cstralpt",
  extra: {
    router: {},
    eas: {
      projectId: "b9724893-72a7-440c-98a9-950ff3537f30",
    },
    // TWV-2026-065 — commit hash shown on the About screen. EAS sets
    // `EAS_BUILD_GIT_COMMIT_HASH`; GitHub Actions sets `GITHUB_SHA`.
    // Local dev falls back to "local-dev" so the screen still renders.
    commitHash:
      process.env.EAS_BUILD_GIT_COMMIT_HASH ??
      process.env.GITHUB_SHA ??
      "local-dev",
    // TWV-2026-065 — which EAS profile produced this binary. Consumed
    // by `constants/about.ts` / `app/about.tsx` to pick the right
    // signing-cert fingerprint row.
    appVariant: IS_DEV ? "development" : IS_PREVIEW ? "preview" : "production",
  },
});
