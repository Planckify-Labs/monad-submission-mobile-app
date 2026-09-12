import * as LocalAuthentication from "expo-local-authentication";
import {
  isNoCredentialError,
  refreshDeviceSecurityLevel,
} from "@/services/security/deviceSecurityLevel";
import { requestPinConfirmation } from "@/services/security/pinGate";

/**
 * Per-action auth gate: OS biometric or device credential, falling back
 * to the in-app PIN when the device has no screen lock at all.
 *
 * Without the fallback a lock-less device never sees an OS sheet (the
 * module returns `not_enrolled` / `passcode_not_set` straight away), so
 * every gated action read as "Authentication failed" forever. The PIN
 * path reuses `PinConfirmationModal`, which runs setup first when no PIN
 * exists yet. See `services/security/deviceSecurityLevel.ts`.
 *
 * The posture is re-read on every call (cheap, no prompt) so a screen
 * lock removed mid-session is caught here too, not only at the next
 * cold start; the OS error codes cover the remaining race.
 */
export async function authenticateUser(
  promptMessage = "Authenticate to continue",
): Promise<boolean> {
  try {
    const level = await refreshDeviceSecurityLevel();
    if (level === "none") return requestPinConfirmation(promptMessage);

    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      fallbackLabel: "Use passcode",
    });
    if (result.success) return true;
    if (isNoCredentialError(result.error)) {
      return requestPinConfirmation(promptMessage);
    }
    return false;
  } catch (error) {
    if (__DEV__) console.warn("[authUtils] authenticate threw", error);
    return false;
  }
}
