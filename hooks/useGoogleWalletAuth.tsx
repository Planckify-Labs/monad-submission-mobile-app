/**
 * The Google sign-in → wallet resolution flow, extracted from
 * `app/login.tsx` so it can also run in-place from a sheet.
 *
 * WHY. The flow used to live entirely inside the login screen, which meant
 * "Continue with Google" was reachable only by leaving whatever you were
 * doing. That is fine at cold start and wrong everywhere else: a user who
 * discovers mid-chat that they hold no Sui wallet should be able to get one
 * without losing the conversation.
 *
 * WHAT IS SHARED vs WHAT IS THE HOST'S. Everything that decides WHICH wallet
 * the account ends up with lives here — that logic is security-sensitive
 * (it must never mint over a Drive backup, never co-opt an unrelated wallet,
 * and always scope the wallet to the Google account rather than the device)
 * and must not exist twice. What differs per host is only presentation and
 * what happens afterwards:
 *
 *   - `onStep` / `onStart` / `onStop` / `delay` — the host's progress UI.
 *     Login shows a staged "Signing In" popup; a sheet may show nothing.
 *   - `onComplete` — login navigates home; a sheet just closes. This is the
 *     important one: `router.replace("/")` from a sheet would destroy the
 *     screen the user was in the middle of.
 *   - `onRequestSeedPhrase` — both recovery paths hand off to
 *     `ImportSeedPhraseSheet`, but each host owns where that sheet lives.
 *   - `onError` — copy is identical, but the host decides how to surface it.
 *
 * The three Google-flow sheets (OTP, Drive restore, "Account found") are
 * rendered BY this hook and returned as `sheets`, so both hosts get the same
 * wiring rather than re-deriving five callbacks each.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import AccountFoundSheet from "@/components/auth/AccountFoundSheet";
import GoogleOtpSheet from "@/components/auth/GoogleOtpSheet";
import RestoreBackupSheet from "@/components/wallet/backup/RestoreBackupSheet";
import type { TWallet } from "@/constants/types/walletTypes";
import {
  configureGoogleSignIn,
  type GoogleAuthError,
  registerGoogleWallet,
  type TGoogleAuthResponse,
  type TGoogleChallenge,
  useGoogleSignIn,
} from "@/hooks/queries/useGoogleAuth";
import { useWallet } from "@/hooks/useWallet";
import { track } from "@/services/analytics/posthog";
import { authenticateWallet } from "@/services/auth/authenticateWallet";
import {
  getGoogleAccountForWallet,
  linkGoogleAccountToWallet,
} from "@/services/auth/googleAccountLink";
import {
  googleWalletPrefix,
  tagWalletsAsGoogle,
} from "@/services/auth/googleWallets";
import { hasDriveScope } from "@/services/backup/driveAppData";
import { BACKUP_ERROR_COPY, BackupError } from "@/services/backup/errors";
import {
  hasRemoteBackup,
  recordBackupTimestamp,
} from "@/services/backup/seedBackup";
import {
  bootstrapFirstLoginWallets,
  restoreWalletsFromMnemonic,
} from "@/services/walletKit/bootstrap";
import { loadWalletsFromStorage } from "@/services/walletService";

/**
 * The five post-OTP outcomes that end in a usable wallet — see
 * `google_signin_completed` in services/analytics/events.ts.
 */
export type GoogleSignInPath =
  | "existing_wallet"
  | "drive_restore"
  | "new_account"
  | "account_found_new_wallet"
  | "account_found_recovery_phrase";

export type GoogleWalletAuthOptions = {
  /** Advance the host's progress indicator (0-3). */
  onStep?: (step: number) => void;
  /** Host's blocking spinner on / off. */
  onStart?: () => void;
  onStop?: () => void;
  /** Host's paced delay, so sheet transitions don't collide. */
  delay?: (ms: number) => Promise<void>;
  /**
   * A wallet for this account now exists on the device and the session
   * handshake has run. Login navigates home; a sheet closes itself.
   */
  onComplete?: (path: GoogleSignInPath) => void | Promise<void>;
  /**
   * Recovery paths hand off to `ImportSeedPhraseSheet`. The host owns that
   * sheet, and must tag imported wallets with `googleAccount`.
   */
  onRequestSeedPhrase?: () => void;
  /** Surface a failure. Both hosts use `Alert.alert` today. */
  onError?: (title: string, message: string) => void;
};

export type GoogleWalletAuth = {
  /** Kick off the flow. Safe to call from any surface. */
  start: () => void;
  /** True between picker tap and the OTP challenge arriving. */
  isStarting: boolean;
  /**
   * Non-null exactly when a seed-phrase import is pending BECAUSE of a
   * Google recovery path. Pass straight to `ImportSeedPhraseSheet`'s
   * `tagSocial` so a plain import that merely follows a Google session
   * doesn't get tagged to the account.
   */
  seedRecoveryAccount: TGoogleAuthResponse["user"] | null;
  /**
   * Tail of the "Account found → recovery phrase" path. The sheet has
   * already derived and tagged the wallets; this records the identity link
   * and server registration so the NEXT device recognises the account.
   *
   * Lives here rather than in the host because it needs the Google access
   * token, which deliberately never leaves this hook.
   *
   * Returns true when it applied, i.e. this really was the recovery path.
   */
  completeSeedPhraseRecovery: (added: TWallet[]) => boolean;
  /** The user backed out of the seed sheet without importing. */
  cancelSeedPhraseRecovery: () => void;
  /** Render this: the OTP, Drive-restore, and Account-found sheets. */
  sheets: React.ReactElement;
};

const noopDelay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function useGoogleWalletAuth(
  options: GoogleWalletAuthOptions = {},
): GoogleWalletAuth {
  const {
    onStep,
    onStart,
    onStop,
    delay = noopDelay,
    onComplete,
    onRequestSeedPhrase,
    onError,
  } = options;

  const googleSignIn = useGoogleSignIn();
  const {
    addWallets,
    activeChain,
    wallets: liveWallets,
    setActiveWallet,
  } = useWallet();

  const [googleChallenge, setGoogleChallenge] =
    useState<TGoogleChallenge | null>(null);
  const [googleAccount, setGoogleAccount] = useState<
    TGoogleAuthResponse["user"] | null
  >(null);
  const [restoreSheetVisible, setRestoreSheetVisible] = useState(false);
  const [accountFoundSheetVisible, setAccountFoundSheetVisible] =
    useState(false);

  // Google access token, kept out of state so it never renders and doesn't
  // retrigger the async sign-in callbacks. Used to link the wallet server-side.
  const googleTokenRef = useRef<string | null>(null);
  // Server-masked email from the challenge, kept so the Account-found sheet can
  // still show it after `googleChallenge` is cleared.
  const emailMaskedRef = useRef<string | undefined>(undefined);
  // True only while a seed-phrase import is pending because WE asked for one
  // (Drive-restore fallback, or "Account found" → recovery phrase). Keeps a
  // plain import that merely happens to follow a Google session from being
  // tagged to the account.
  const [seedRecoveryPending, setSeedRecoveryPending] = useState(false);

  useEffect(() => {
    configureGoogleSignIn();
  }, []);

  const step = useCallback((n: number) => onStep?.(n), [onStep]);
  const start = useCallback(() => onStart?.(), [onStart]);
  const stop = useCallback(() => onStop?.(), [onStop]);
  const fail = useCallback(
    (title: string, message: string) => onError?.(title, message),
    [onError],
  );

  /**
   * Step 1. Verifies the Google account and asks the server to email a code.
   * No session exists yet — the challenge only opens the OTP sheet.
   */
  const startSignIn = useCallback(() => {
    track("google_signin_started");
    googleSignIn.mutate(undefined, {
      onSuccess: (challenge) => {
        track("google_signin_otp_requested");
        emailMaskedRef.current = challenge.emailMasked;
        setGoogleChallenge(challenge);
      },
      onError: (error: GoogleAuthError) => {
        // A cancelled picker is a normal outcome, not a failure to report.
        if (error.code === "in_progress") return;
        if (error.code === "cancelled") {
          track("google_signin_cancelled");
          return;
        }
        track("google_signin_failed", { reason: error.code });

        fail(
          "Sign In Failed",
          error.code === "account_conflict"
            ? "We couldn't sign you in with this account. Please use the method you originally signed up with."
            : error.code === "rate_limited"
              ? "Too many sign-in attempts. Please wait a moment and try again."
              : error.code === "email_undeliverable"
                ? "We couldn't send your verification email. Please try again."
                : error.code === "play_services_unavailable"
                  ? "Google Play Services isn't available on this device."
                  : "We couldn't sign you in with Google. Please try again.",
        );
      },
    });
  }, [googleSignIn, fail]);

  /**
   * Shared tail of every path that ends with a usable wallet on this device:
   * link the Google identity locally, run the chain-agnostic wallet handshake,
   * and hand back to the host.
   *
   * The mnemonic never leaves the device — `linkGoogleAccountToWallet` stores
   * identity only, never key material.
   */
  const finishSignIn = useCallback(
    async (
      accountWallets: TWallet[],
      account: TGoogleAuthResponse["user"] | null,
      opts: { path: GoogleSignInPath; activateExisting?: boolean },
    ) => {
      // The kit registry derives wallets EVM-first, so index 0 is the EVM row
      // — what the auth handshake and EVM-first surfaces (agent, send) default
      // to. Kept index-based (not a namespace check) to stay chain-agnostic.
      const primary = accountWallets[0];

      if (account) {
        // Device-local identity only, so the association survives even if the
        // wallet handshake below fails and the user re-auths from home.
        linkGoogleAccountToWallet(primary.address, {
          userId: account.id,
          email: account.email,
          name: account.name,
        });

        // Record the wallet against the account server-side so a future
        // new-device login can recognise it ("Account found"). Best-effort:
        // uses the Google token captured at OTP time, and never blocks the
        // UI or fails the sign-in. Idempotent, so it also backfills accounts
        // that predate this feature.
        const googleToken = googleTokenRef.current;
        if (googleToken) {
          void registerGoogleWallet(googleToken, primary.address);
        }
      }

      // Returning account whose wallet already lives in storage: make it the
      // active wallet so the app opens on this Google account's wallet, not
      // whatever happened to be selected last. (Mint / restore paths already
      // activate via `addWallets`.)
      if (opts.activateExisting) {
        const idx = liveWallets.findIndex(
          (w) => w.address.toLowerCase() === primary.address.toLowerCase(),
        );
        if (idx >= 0) setActiveWallet(idx);
      }

      step(2);

      // A failed handshake is not fatal: the wallet exists on device and every
      // authed surface falls back to its inline sign-in CTA.
      await authenticateWallet(primary, activeChain);

      step(3);
      track("google_signin_completed", { path: opts.path });
      await delay(300);
      await onComplete?.(opts.path);
    },
    [liveWallets, setActiveWallet, activeChain, step, delay, onComplete],
  );

  /**
   * Brand-new Google account (nothing on this device, no Drive backup, server
   * doesn't recognise it): mint a wallet that BELONGS to this account and add
   * it alongside whatever's already on the phone. A Google login gives the
   * account its own wallet — it never co-opts an unrelated wallet, and signing
   * in with a different account mints a different one.
   */
  const mintGoogleWalletAndFinish = useCallback(
    async (
      account: TGoogleAuthResponse["user"],
      path: Extract<
        GoogleSignInPath,
        "new_account" | "account_found_new_wallet"
      >,
    ) => {
      const minted = tagWalletsAsGoogle(
        await bootstrapFirstLoginWallets(googleWalletPrefix(account)),
        account,
      );
      if (minted.length === 0) {
        throw new Error("wallet bootstrap produced no wallets");
      }
      // Append — never replace the user's existing wallets.
      await addWallets(minted);
      await finishSignIn(minted, account, { path });
    },
    [addWallets, finishSignIn],
  );

  /**
   * Step 2 succeeded. The Google session proves who the user is; the app's own
   * session is wallet-bound, so we need a wallet before we can authenticate.
   *
   * The wallet is scoped to the **Google account**, not to the device. One
   * account = one wallet: signing in always lands on this account's own wallet,
   * and signing in with a different account gives a different wallet — even if
   * the device already holds other (seed-phrase / imported) wallets. So the
   * decision keys off "does *this account* have a wallet", never "does the
   * device have *any* wallet", and it never co-opts an unrelated wallet.
   */
  const handleOtpVerified = useCallback(
    async (response: TGoogleAuthResponse) => {
      setGoogleChallenge(null);
      setGoogleAccount(response.user);
      googleTokenRef.current = response.access_token;
      start();

      try {
        step(0);
        await delay(200);

        // Spec §14.1 / §14.8: login is auth-only. Wallet setup runs post-auth.
        step(1);
        const account = response.user;
        const localWallets = await loadWalletsFromStorage();

        // Wallets already tied to THIS Google account on THIS device.
        const linked = localWallets.filter(
          (w) => getGoogleAccountForWallet(w.address)?.userId === account.id,
        );
        if (linked.length > 0) {
          // Returning account, same device — open its wallet, never mint.
          await finishSignIn(linked, account, {
            path: "existing_wallet",
            activateExisting: true,
          });
          return;
        }

        // This account has no wallet on this device yet. Get one that BELONGS
        // to it — never silently mint over, and never co-opt, an unrelated
        // wallet already on the phone:
        //   1. Encrypted Drive backup → restore it.
        //   2. Server knows this account has a wallet elsewhere → prompt for
        //      the recovery phrase ("Account found").
        //   3. Nothing on record → brand-new account; mint its own wallet.
        //
        // Drive is optional (Google's granular-consent checkbox), so only look
        // for a backup when the scope was actually granted. A user who
        // unchecked it opted out of Drive — they must never be blocked from
        // signing in, nor re-prompted for the permission mid-login.
        let hasBackup = false;
        if (hasDriveScope()) {
          try {
            hasBackup = await hasRemoteBackup();
          } catch (backupError) {
            // A permission problem means Drive isn't usable for this account
            // (the scope check can false-positive on some Android builds where
            // it reports requested rather than granted scopes) — treat as "no
            // Drive backup" and continue. Genuine transient failures still
            // block, so we never mint over a backup we simply couldn't read.
            if (
              backupError instanceof BackupError &&
              backupError.code === "drive_permission_denied"
            ) {
              hasBackup = false;
            } else {
              throw backupError;
            }
          }
        }

        if (hasBackup) {
          stop();
          setRestoreSheetVisible(true);
        } else if (response.hasWallet) {
          stop();
          setAccountFoundSheetVisible(true);
        } else {
          await mintGoogleWalletAndFinish(account, "new_account");
        }
      } catch (error) {
        if (__DEV__) console.warn("post-OTP wallet setup failed:", error);
        stop();
        track("google_signin_setup_failed", {
          stage: "post_otp",
          reason: error instanceof BackupError ? error.code : "unknown",
        });

        // On a Drive read failure we do NOT fall through to minting: guessing
        // "no backup" would hand the user a new, empty wallet while their real
        // one sits in a backup we simply failed to read.
        fail(
          "Sign In Failed",
          error instanceof BackupError
            ? BACKUP_ERROR_COPY[error.code]
            : "We couldn't finish setting up your wallet. Please try again.",
        );
      }
    },
    [start, stop, step, delay, finishSignIn, mintGoogleWalletAndFinish, fail],
  );

  const handleOtpExpired = useCallback(() => setGoogleChallenge(null), []);

  /**
   * Drive backup decrypted — rebuild the exact same addresses from it and add
   * them (tagged to this Google account) alongside any wallets already on the
   * device. Append, never replace: the backup is this account's wallet, not a
   * device wipe.
   */
  const handleBackupRestored = useCallback(
    async (mnemonic: string, createdAt: number) => {
      setRestoreSheetVisible(false);
      start();

      try {
        step(0);
        step(1);
        const restored = googleAccount
          ? tagWalletsAsGoogle(
              await restoreWalletsFromMnemonic(
                mnemonic,
                googleWalletPrefix(googleAccount),
              ),
              googleAccount,
            )
          : await restoreWalletsFromMnemonic(mnemonic);
        if (restored.length === 0) {
          throw new Error("restore produced no wallets");
        }
        await addWallets(restored);
        // This wallet came *from* a Drive backup, so cache that status locally
        // (with the backup's real creation date, across all sibling chains) —
        // otherwise the wallet screen would show "Back up to Google Drive" and
        // offer to create one over the top of the backup we just restored.
        for (const w of restored) recordBackupTimestamp(w.address, createdAt);
        await finishSignIn(restored, googleAccount, { path: "drive_restore" });
      } catch (error) {
        if (__DEV__) console.warn("restore from backup failed:", error);
        stop();
        track("google_signin_setup_failed", { stage: "drive_restore" });
        fail(
          "Restore Failed",
          "We couldn't rebuild your wallet from that backup. Please try your seed phrase.",
        );
      }
    },
    [googleAccount, finishSignIn, addWallets, start, stop, step, fail],
  );

  const handleRestoreWithSeedInstead = useCallback(() => {
    setRestoreSheetVisible(false);
    setSeedRecoveryPending(true);
    onRequestSeedPhrase?.();
  }, [onRequestSeedPhrase]);

  const handleEnterRecoveryPhrase = useCallback(async () => {
    // Mirror the create-new path: close "Account found" and let it slide out
    // before the import sheet slides in, so the two sheets don't overlap
    // mid-transition. (The friendly "Signing In" popup comes later, once the
    // entered phrase is actually deriving wallets, inside the import sheet.)
    setSeedRecoveryPending(true);
    setAccountFoundSheetVisible(false);
    await delay(220);
    onRequestSeedPhrase?.();
  }, [delay, onRequestSeedPhrase]);

  const completeSeedPhraseRecovery = useCallback(
    (added: TWallet[]) => {
      const primary = added[0];
      const token = googleTokenRef.current;
      if (!primary || !seedRecoveryPending || !googleAccount) {
        setSeedRecoveryPending(false);
        return false;
      }
      linkGoogleAccountToWallet(primary.address, {
        userId: googleAccount.id,
        email: googleAccount.email,
        name: googleAccount.name,
      });
      if (token) void registerGoogleWallet(token, primary.address);
      track("google_signin_completed", {
        path: "account_found_recovery_phrase",
      });
      setSeedRecoveryPending(false);
      return true;
    },
    [seedRecoveryPending, googleAccount],
  );

  const cancelSeedPhraseRecovery = useCallback(
    () => setSeedRecoveryPending(false),
    [],
  );

  /**
   * "Account found" → restore from the Drive backup. Hands off to the same
   * `RestoreBackupSheet` the auto-detect path uses; its passphrase submit runs
   * the *interactive* restore, which requests Drive access (for the user who
   * skipped it at sign-in) before decrypting. If no backup turns up or the
   * passphrase is wrong, that sheet offers the seed-phrase fallback.
   */
  const handleRestoreFromDrive = useCallback(() => {
    setAccountFoundSheetVisible(false);
    setRestoreSheetVisible(true);
  }, []);

  /**
   * Last resort: the account has a wallet, but the user has neither the seed
   * phrase nor a Drive backup. Non-custodial means that wallet is unrecoverable
   * — by anyone — but that's already spelled out on the recovery-options view
   * that hosts this action, so we don't gate it behind a second dialog. Mint a
   * fresh (empty) wallet so they're not stranded.
   */
  const handleCreateNewFromAccountFound = useCallback(async () => {
    const account = googleAccount;
    if (!account) return;
    // Close the sheet and let it slide out, then bring up the spinner, and only
    // then run the CPU-heavy wallet derivation. Doing the derivation first
    // blocks the JS thread before the close/spinner can paint — it looks frozen.
    setAccountFoundSheetVisible(false);
    await delay(220);
    start();
    try {
      step(0);
      await delay(120);
      step(1);
      await mintGoogleWalletAndFinish(account, "account_found_new_wallet");
    } catch (error) {
      if (__DEV__) {
        console.warn("create-new after lost recovery failed:", error);
      }
      stop();
      track("google_signin_setup_failed", {
        stage: "account_found_new_wallet",
      });
      fail(
        "Sign In Failed",
        "We couldn't set up a new wallet. Please try again.",
      );
    }
  }, [
    googleAccount,
    mintGoogleWalletAndFinish,
    start,
    stop,
    step,
    delay,
    fail,
  ]);

  const sheets = (
    <>
      <GoogleOtpSheet
        visible={googleChallenge !== null}
        challenge={googleChallenge}
        onClose={() => setGoogleChallenge(null)}
        onVerified={handleOtpVerified}
        onExpired={handleOtpExpired}
      />

      <RestoreBackupSheet
        visible={restoreSheetVisible}
        onClose={() => setRestoreSheetVisible(false)}
        onRestored={handleBackupRestored}
        onUseSeedPhraseInstead={handleRestoreWithSeedInstead}
      />

      <AccountFoundSheet
        visible={accountFoundSheetVisible}
        onClose={() => setAccountFoundSheetVisible(false)}
        onRestoreFromDrive={handleRestoreFromDrive}
        onEnterRecoveryPhrase={handleEnterRecoveryPhrase}
        onCreateNewInstead={handleCreateNewFromAccountFound}
        emailMasked={emailMaskedRef.current}
      />
    </>
  );

  return {
    start: startSignIn,
    isStarting: googleSignIn.isPending,
    seedRecoveryAccount: seedRecoveryPending ? googleAccount : null,
    completeSeedPhraseRecovery,
    cancelSeedPhraseRecovery,
    sheets,
  };
}
