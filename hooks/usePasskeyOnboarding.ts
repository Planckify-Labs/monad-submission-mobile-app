/**
 * Mera passkey onboarding flow (docs/monad-metropolis-2026-spec.md §3.5).
 *
 * The screen-independent half of "Continue with passkey": run the
 * ceremony, land the derived `Passkey` wallet in the bundle (or
 * re-select it if this device already holds it), point the app at Monad,
 * and complete the wallet-bound session handshake silently. The host
 * supplies only presentation (`onStep`/`onStart`/`onStop`), navigation
 * (`onComplete`) and error surfacing (`onError`) — same split as
 * `useGoogleWalletAuth`, so the login screen and a future in-app sheet
 * share one implementation of the security-relevant decisions.
 *
 * Why the handshake is silent: the user just passed a platform
 * biometric to create/assert the passkey. Sending them to `/auth` for a
 * second "Sign & Continue" tap would be exactly the "this is crypto"
 * friction the track judges against. `authenticateWallet` is best-effort
 * — a failed handshake leaves the wallet on device and every authed
 * surface falls back to its inline sign-in CTA, as with Google.
 */

import { useCallback, useState } from "react";
import type { TWallet } from "@/constants/types/walletTypes";
import { useWallet } from "@/hooks/useWallet";
import { track } from "@/services/analytics/posthog";
import { authenticateWallet } from "@/services/auth/authenticateWallet";
import {
  classifyPasskeyError,
  isNoPasskeyError,
  type PasskeyErrorCopy,
  passkeyErrorCodes,
  unsupportedPasskeyCopy,
} from "@/services/walletKit/evm/mera/errors";
import {
  type KnownPasskeyCredential,
  readLastPasskeyCredential,
  writeLastPasskeyCredential,
} from "@/services/walletKit/evm/mera/lastCredential";
import {
  createPasskeyWallet,
  isPasskeySupported,
  signInWithPasskeyWallet,
  supportsSilentPasskeyProbe,
} from "@/services/walletKit/evm/mera/passkeyWallet";

/**
 * `continue` = sign in if a passkey exists, else create (the one-button
 * login path). It resolves to `create` / `sign_in` once the OS has said
 * which ceremony actually ran, so analytics and `onComplete` never see
 * `continue`.
 */
export type PasskeyOnboardingPath = "create" | "sign_in" | "continue";

export type PasskeyOnboardingOptions = {
  /** Advance the host's progress indicator (0-3). */
  onStep?: (index: number) => void;
  onStart?: () => void;
  onStop?: () => void;
  delay?: (ms: number) => Promise<void>;
  onComplete?: (path: PasskeyOnboardingPath) => void | Promise<void>;
  onError?: (copy: PasskeyErrorCopy) => void;
  /**
   * Only consulted on an OS that cannot probe for passkeys silently (iOS
   * 15): the user dismissed the system's "no passkeys" sheet and the app
   * has no record of a passkey on this device. Resolve `true` to create a
   * new account, `false` to stop. Never called on Android / iOS 16+.
   */
  onConfirmFirstTime?: () => Promise<boolean>;
};

export function usePasskeyOnboarding({
  onStep,
  onStart,
  onStop,
  delay,
  onComplete,
  onError,
  onConfirmFirstTime,
}: PasskeyOnboardingOptions = {}) {
  const { wallets, activeChain, addWallets, setActiveWallet } = useWallet();
  const [busy, setBusy] = useState<PasskeyOnboardingPath | null>(null);

  const step = useCallback((i: number) => onStep?.(i), [onStep]);
  const wait = useCallback(
    async (ms: number) => {
      if (delay) await delay(ms);
    },
    [delay],
  );

  const run = useCallback(
    async (path: PasskeyOnboardingPath) => {
      if (busy) return;
      if (!isPasskeySupported()) {
        onError?.(unsupportedPasskeyCopy());
        return;
      }
      setBusy(path);
      let wallet: TWallet;
      try {
        // The ceremony runs BEFORE the progress overlay: the OS passkey
        // sheet is the UI here, and a spinner behind it reads as a hang.
        //
        // "continue" is the one-button path: assert against any TakumiPay
        // passkey already on this device / account (same passkey, same
        // wallet), and only when the OS reports there is none do we mint
        // a new one. A cancel on the picker stays a cancel; we never
        // create a second passkey behind the user's back, since a new
        // credential is a new PRF secret and therefore a new wallet.
        if (path === "create") {
          wallet = await createPasskeyWallet();
        } else if (path === "sign_in") {
          wallet = await signInWithPasskeyWallet();
        } else {
          // 1. Pinned: the passkey this device used last (a wallet row still
          //    here, else the MMKV hint that survives a wipe). The OS skips
          //    its picker and goes straight to the biometric, so a phone
          //    with several Google accounts still lands on the same wallet.
          // 2. Discoverable: any TakumiPay passkey the OS knows (new phone,
          //    or the pinned one was deleted) — the OS shows its picker.
          // 3. Create: only when the OS reports there is none at all.
          const known: KnownPasskeyCredential | null =
            wallets.find((w) => w.type === "Passkey" && w.passkey)?.passkey ??
            readLastPasskeyCredential();
          const attempts: Array<[string, () => Promise<TWallet>]> = [
            ...(known
              ? [
                  [
                    `pinned ${known.credentialId.slice(0, 8)}…`,
                    // A stored credential id is evidence a passkey exists,
                    // so this is a normal request, not the silent probe:
                    // the OS goes straight to the biometric for that one
                    // passkey. Only the discoverable step below relies on
                    // `preferImmediatelyAvailableCredentials`.
                    () =>
                      signInWithPasskeyWallet(undefined, {
                        credential: known,
                      }),
                  ] as [string, () => Promise<TWallet>],
                ]
              : []),
            [
              "discoverable",
              () => signInWithPasskeyWallet(undefined, { immediate: true }),
            ],
          ];
          let asserted: TWallet | null = null;
          for (const [label, attempt] of attempts) {
            try {
              if (__DEV__) console.info(`[passkey] assert (${label})`);
              asserted = await attempt();
              if (__DEV__) console.info(`[passkey] assert (${label}) ok`);
              break;
            } catch (err) {
              if (isNoPasskeyError(err)) {
                if (__DEV__) {
                  console.info(
                    `[passkey] assert (${label}) → no credential (${passkeyErrorCodes(err).join(" <- ")})`,
                  );
                }
                continue;
              }
              // iOS 15 only: the probe cannot be silent, so a dismissed
              // "no passkeys" sheet on a device with no record of one is
              // most likely a first-time user. Ask instead of guessing.
              if (
                label === "discoverable" &&
                !known &&
                !supportsSilentPasskeyProbe() &&
                classifyPasskeyError(err).kind === "cancelled" &&
                onConfirmFirstTime
              ) {
                if (await onConfirmFirstTime()) continue;
              }
              throw err;
            }
          }
          if (asserted) {
            wallet = asserted;
            path = "sign_in";
          } else {
            if (__DEV__)
              console.info("[passkey] no passkey on device, creating one");
            wallet = await createPasskeyWallet();
            path = "create";
          }
        }
        if (wallet.passkey) writeLastPasskeyCredential(wallet.passkey);
      } catch (err) {
        const copy = classifyPasskeyError(err);
        if (__DEV__) {
          const codes = passkeyErrorCodes(err);
          console.warn(
            `[passkey] ceremony failed (${codes.join(" <- ") || "no code"}):`,
            err,
          );
          // Mera's RN demo: react-native-passkey reports a failed
          // rpId <-> app association as RequestFailed (Android) with a
          // misleading "missing credentials" message. First thing to
          // check is the .well-known files for THIS build variant.
          if (codes.includes("RequestFailed")) {
            console.warn(
              "[passkey] RequestFailed usually means the platform refused rpId takumipay.xyz for this package/cert: verify /.well-known/assetlinks.json (get_login_creds + this build's cert) or apple-app-site-association (webcredentials).",
            );
          }
        }
        track("passkey_onboarding_failed", { path, reason: copy.kind });
        setBusy(null);
        // A cancel is the user's own action — no dialog.
        if (copy.kind !== "cancelled") onError?.(copy);
        return;
      }

      try {
        onStart?.();
        step(0);
        await wait(200);

        // Same passkey on a device that already derived this wallet
        // (e.g. sign-in after a create): re-select, don't duplicate.
        const existingIdx = wallets.findIndex(
          (w) => w.address.toLowerCase() === wallet.address.toLowerCase(),
        );
        const existing = existingIdx >= 0;
        step(1);
        if (existing) {
          setActiveWallet(existingIdx);
        } else {
          const saved = await addWallets([wallet]);
          if (!saved) throw new Error("passkey wallet was not persisted");
        }

        step(2);
        await authenticateWallet(wallet, activeChain);

        step(3);
        track("passkey_onboarding_completed", { path, existing });
        await wait(300);
        await onComplete?.(path);
      } catch (err) {
        if (__DEV__) console.warn("[passkey] setup failed:", err);
        track("passkey_onboarding_failed", { path, reason: "setup" });
        onStop?.();
        onError?.(classifyPasskeyError(err));
      } finally {
        setBusy(null);
      }
    },
    [
      busy,
      wallets,
      activeChain,
      addWallets,
      setActiveWallet,
      onStart,
      onStop,
      onError,
      onComplete,
      onConfirmFirstTime,
      step,
      wait,
    ],
  );

  return {
    /** One tap: existing passkey → same wallet; no passkey → create one. */
    continue: () => run("continue"),
    /** Create a new passkey and its wallet. */
    create: () => run("create"),
    /** Reproduce the wallet from a passkey already on this device / account. */
    signIn: () => run("sign_in"),
    busy,
    supported: isPasskeySupported(),
  };
}
