/**
 * Mera passkey onboarding (docs/monad-metropolis-2026-spec.md §3).
 *
 * The only module in the app that talks to WebAuthn. Two entry points:
 *
 *   - `createPasskeyWallet()` — one platform-passkey creation ceremony
 *     (Face ID / Touch ID / Android biometric) that also evaluates the
 *     PRF extension, then derives the EVM key from the output.
 *   - `signInWithPasskeyWallet()` — one assertion ceremony against any
 *     discoverable TakumiPay passkey on the device; reproduces the same
 *     PRF output, therefore the same address. This is the "existing
 *     user, new device" path and needs no server round-trip.
 *
 * Neither step makes a network call: Mera is purely on-device crypto
 * (§3.1). The relying party is `takumipay.xyz`, which is why the
 * `.well-known` association files on the landing page must list every
 * build variant that ships this flow (§3.3 / §3.5).
 *
 * Import-order contract: `pollyfills.ts` must have run first (it does,
 * via `app/_layout.tsx`) so `crypto.getRandomValues` exists for Mera's
 * challenge / user-handle generation. Mera throws `CRYPTO_UNAVAILABLE`
 * otherwise, which `classifyPasskeyError` maps to a generic failure.
 *
 * The derived row is EVM-only and docks into the existing wallet
 * pipeline as `type: "Passkey"` — `walletService.getAccountForWallet`
 * signs it exactly like a private-key import, so send / agent / dApp
 * bridge / gasless all work unchanged (§3.5, §4.2).
 */

import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  type WebAuthnClient,
} from "@category-labs/mera";
import { reactNativeWebAuthnClient } from "@category-labs/mera/react-native-webauthn-client";
import { NativeModules, Platform } from "react-native";
import { Passkey } from "react-native-passkey";
import type { TWallet } from "@/constants/types/walletTypes";
import {
  DEFAULT_PASSKEY_WALLET_NAME,
  derivePasskeyWallet,
  PASSKEY_RP_ID,
  PASSKEY_RP_NAME,
} from "./derive";
import type { KnownPasskeyCredential } from "./lastCredential";

const RP = { id: PASSKEY_RP_ID, name: PASSKEY_RP_NAME } as const;

/**
 * Platform passkeys need iOS 15+ / Android 9+ (API 28) AND the
 * `react-native-passkey` native module in the binary. `Passkey.isSupported()`
 * only checks the OS version; on a dev build that predates the dependency
 * the JS side reaches a linking-error proxy and every ceremony fails as
 * `PASSKEY_OPERATION_FAILED <- Unknown error`, which reads like a config
 * problem. Check the module directly so that case surfaces as
 * "unsupported" with a loud `__DEV__` hint instead.
 */
export function isPasskeySupported(): boolean {
  try {
    if (!Passkey.isSupported()) return false;
    if (!NativeModules.Passkey) {
      if (__DEV__) {
        console.warn(
          "[passkey] react-native-passkey native module is not linked in this binary. Rebuild the dev client (eas build --profile development) — a JS reload cannot fix this.",
        );
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a "no passkey here" probe can fail silently on this OS.
 * Android (Credential Manager `preferImmediatelyAvailableCredentials`) and
 * iOS 16+ (`ASAuthorizationController.preferImmediatelyAvailableCredentials`,
 * with react-native-passkey disambiguating error 1001) both report
 * `NoCredentials` without UI. iOS 15 ignores the flag: it shows Apple's
 * "no passkeys" sheet and a dismissal is indistinguishable from a cancel,
 * so callers there must ask the user instead of assuming.
 */
export function supportsSilentPasskeyProbe(): boolean {
  if (Platform.OS === "android") return true;
  if (Platform.OS === "ios")
    return Number.parseInt(String(Platform.Version), 10) >= 16;
  return false;
}

/**
 * The account label the OS passkey manager shows. A fresh random user
 * handle is minted inside Mera per call, so two creations never
 * overwrite each other; the timestamp just keeps the list legible.
 */
function passkeyUserName(): string {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `TakumiPay ${stamp}`;
}

export async function createPasskeyWallet(name?: string): Promise<TWallet> {
  const created = await createPasskeyWithPrfOutput({
    rp: RP,
    user: { name: passkeyUserName(), displayName: PASSKEY_RP_NAME },
    webAuthnClient: reactNativeWebAuthnClient,
  });
  try {
    return derivePasskeyWallet({
      prfOutput: created.prfOutput,
      passkey: {
        credentialId: created.credentialId,
        rpId: PASSKEY_RP_ID,
        ...(created.transports ? { transports: [...created.transports] } : {}),
      },
      name: name ?? DEFAULT_PASSKEY_WALLET_NAME,
    });
  } finally {
    created.prfOutput.fill(0);
  }
}

/**
 * Mera's RN client always asserts through `Passkey.getPlatformKey`, which on
 * Android with no passkey for this app shows Credential Manager's "Sign in
 * another way / View options" bar and waits; dismissing it is reported as
 * `UserCancelled`, so a sign-in-then-create flow can never tell "no passkey"
 * from "user backed out". `Passkey.getImmediate` sets
 * `preferImmediatelyAvailableCredentials` (Android) /
 * `ASAuthorizationController.preferImmediatelyAvailableCredentials` (iOS
 * 16+): when nothing is on the device the request fails silently with
 * `NoCredentials` and no UI, which is exactly the signal the one-button
 * login needs. When a passkey IS present the normal picker + biometric
 * sheet still appears.
 *
 * Mera does not export its client factory (only the built client), so the
 * platform call is swapped for the duration of one assertion. Ceremonies
 * are serialized by the caller (`usePasskeyOnboarding.busy`), so the swap
 * cannot leak into a concurrent create. Revisit if Mera exposes
 * `createReactNativeWebAuthnClient` or an "immediate" option upstream.
 */
const immediateWebAuthnClient: WebAuthnClient = {
  createCredential: (request) =>
    reactNativeWebAuthnClient.createCredential(request),
  async getCredential(request) {
    const original = Passkey.getPlatformKey;
    Passkey.getPlatformKey = Passkey.getImmediate;
    try {
      return await reactNativeWebAuthnClient.getCredential(request);
    } finally {
      Passkey.getPlatformKey = original;
    }
  },
};

export async function signInWithPasskeyWallet(
  name?: string,
  options?: {
    /**
     * Fail fast with `NoCredentials` (no OS fallback UI) when this device
     * has no passkey for TakumiPay. Used by the one-button login.
     */
    immediate?: boolean;
    /**
     * Pin the assertion to one known passkey so the OS skips its picker
     * and goes straight to the biometric, even when other Google accounts
     * on the phone also hold a TakumiPay passkey (Mera's "remember the
     * credential" recipe). If that passkey is gone the OS reports
     * `NoCredentials`; the caller falls back to a discoverable assertion.
     */
    credential?: KnownPasskeyCredential;
  },
): Promise<TWallet> {
  const asserted = await getPasskeyPrfOutput({
    rpId: PASSKEY_RP_ID,
    ...(options?.credential
      ? {
          credential: {
            credentialId: options.credential.credentialId,
            ...(options.credential.transports
              ? { transports: [...options.credential.transports] }
              : {}),
          },
        }
      : {}),
    webAuthnClient: options?.immediate
      ? immediateWebAuthnClient
      : reactNativeWebAuthnClient,
  });
  try {
    return derivePasskeyWallet({
      prfOutput: asserted.prfOutput,
      passkey: { credentialId: asserted.credentialId, rpId: PASSKEY_RP_ID },
      name: name ?? DEFAULT_PASSKEY_WALLET_NAME,
    });
  } finally {
    asserted.prfOutput.fill(0);
  }
}
