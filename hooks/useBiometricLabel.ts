/**
 * What to call the passkey gesture on THIS phone.
 *
 * Non-crypto users don't know the word "passkey" any more than "seed
 * phrase"; Google and Apple both hide it behind the gesture the user
 * already knows ("Use your fingerprint", "Continue with Face ID"). The
 * login button borrows that vocabulary. Passkeys still work with only a
 * device PIN / pattern, so the fallback is "screen lock", never "passkey".
 *
 * Resolves asynchronously; the first render uses the generic label so the
 * button is never blank.
 */

import * as LocalAuthentication from "expo-local-authentication";
import { useEffect, useState } from "react";
import { Platform } from "react-native";

export type BiometricLabel = {
  /** e.g. "fingerprint", "Face ID", "screen lock" */
  noun: string;
  /** e.g. "Continue with fingerprint" */
  cta: string;
};

const GENERIC: BiometricLabel = {
  noun: "screen lock",
  cta: "Continue with screen lock",
};

export function labelForTypes(
  types: readonly LocalAuthentication.AuthenticationType[],
  enrolled: boolean,
  os: typeof Platform.OS = Platform.OS,
): BiometricLabel {
  if (!enrolled) return GENERIC;
  const { FACIAL_RECOGNITION, FINGERPRINT, IRIS } =
    LocalAuthentication.AuthenticationType;
  let noun: string;
  if (os === "ios") {
    // Apple devices have exactly one biometric, so the type is exact.
    if (types.includes(FACIAL_RECOGNITION)) noun = "Face ID";
    else if (types.includes(FINGERPRINT)) noun = "Touch ID";
    else return GENERIC;
  } else if (types.includes(FINGERPRINT)) {
    // The passkey provider verifies the user with BiometricPrompt at the
    // STRONG (Class 3) tier. Most Android face unlock implementations are
    // Class 2, so when both are enrolled the prompt the user actually sees
    // is the fingerprint one. expo-local-authentication reports enrolled
    // types without their class, so fingerprint wins whenever present.
    noun = "fingerprint";
  } else if (types.includes(FACIAL_RECOGNITION)) {
    noun = "face unlock";
  } else if (types.includes(IRIS)) {
    noun = "iris unlock";
  } else {
    return GENERIC;
  }
  return { noun, cta: `Continue with ${noun}` };
}

export function useBiometricLabel(): BiometricLabel {
  const [label, setLabel] = useState<BiometricLabel>(GENERIC);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [types, enrolled] = await Promise.all([
          LocalAuthentication.supportedAuthenticationTypesAsync(),
          LocalAuthentication.isEnrolledAsync(),
        ]);
        if (!cancelled) setLabel(labelForTypes(types, enrolled));
      } catch {
        // Keep the generic label; the ceremony itself decides what works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return label;
}
