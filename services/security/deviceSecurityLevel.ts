/**
 * Device screen-lock posture, as reported by `expo-local-authentication`.
 *
 * A device with no biometric AND no PIN / pattern / passcode can never
 * pass `authenticateAsync`: Android early-returns `not_enrolled` before
 * any sheet is shown (`KeyguardManager#isDeviceSecure()` is false) and
 * iOS returns `passcode_not_set`. Gating on the OS there just strands
 * the user with a button that does nothing.
 *
 * Policy for such a device:
 *   - No cold-start `LockScreen` (see `InitializeApp` in `app/_layout.tsx`).
 *   - Every per-action OS-auth surface (`utils/authUtils.authenticateUser`)
 *     falls back to the in-app PIN, which walks the user through setup on
 *     first use (`PinConfirmationModal` → `PinSetupModal`). Same UX the
 *     send / redeem / sign-in flows already use.
 *
 * The last-known level is mirrored to MMKV so the boot-time lock decision
 * can be made synchronously, before the first render, instead of
 * flashing a lock screen that is about to be dismissed.
 */

import * as LocalAuthentication from "expo-local-authentication";
import { storage } from "@/lib/storage/mmkv";

export type DeviceSecurityLevel = "none" | "secret" | "biometric";

const CACHE_KEY = "device_security_level";

/** Sync, last-known posture from the previous refresh. `null` until then. */
export function getCachedDeviceSecurityLevel(): DeviceSecurityLevel | null {
  const raw = storage.getString(CACHE_KEY);
  return raw === "none" || raw === "secret" || raw === "biometric" ? raw : null;
}

/**
 * Live posture from the OS. Cheap (no prompt), so call it right before
 * every auth decision rather than trusting the mirror: the user may have
 * added or removed their screen lock since the last check.
 *
 * On a native failure the mirror is left untouched and `"secret"` is
 * returned, which keeps the lock in place; the OS error codes handled
 * by callers (`isNoCredentialError`) still catch a genuinely lock-less
 * device on the next prompt.
 */
export async function refreshDeviceSecurityLevel(): Promise<DeviceSecurityLevel> {
  try {
    const enrolled = await LocalAuthentication.getEnrolledLevelAsync();
    const level = mapSecurityLevel(enrolled);
    storage.set(CACHE_KEY, level);
    return level;
  } catch (e) {
    if (__DEV__) {
      console.warn("[deviceSecurityLevel] getEnrolledLevelAsync threw", e);
    }
    return "secret";
  }
}

function mapSecurityLevel(
  level: LocalAuthentication.SecurityLevel,
): DeviceSecurityLevel {
  switch (level) {
    case LocalAuthentication.SecurityLevel.NONE:
      return "none";
    case LocalAuthentication.SecurityLevel.SECRET:
      return "secret";
    default:
      // BIOMETRIC_WEAK / BIOMETRIC_STRONG (and the deprecated BIOMETRIC).
      return "biometric";
  }
}

/**
 * `authenticateAsync` outcomes that mean "the device has nothing to
 * authenticate with", as opposed to a failed or cancelled attempt. Callers
 * route these to the in-app PIN instead of reporting a failure.
 *
 * `not_available` is included because on Android it only reaches JS after
 * the module's own device-credential retry has also failed, so there is
 * no OS path left to offer.
 */
export function isNoCredentialError(
  error: LocalAuthentication.LocalAuthenticationError | undefined,
): boolean {
  return (
    error === "not_enrolled" ||
    error === "passcode_not_set" ||
    error === "not_available"
  );
}
