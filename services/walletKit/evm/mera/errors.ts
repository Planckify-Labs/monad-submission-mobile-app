/**
 * User-facing classification of Mera / WebAuthn failures.
 *
 * Hard rule (CLAUDE.md "User-facing errors"): the UI never renders
 * `err.message`. Mera throws `MeraError` with a stable `code`; this maps
 * each code to hand-written copy and keeps the raw error for `__DEV__`
 * logs only. Pure — no RN imports — so it is Node-testable.
 */

import { isMeraError } from "@category-labs/mera";

export type PasskeyErrorKind =
  | "cancelled"
  | "unsupported"
  | "prf-unavailable"
  | "failed";

export type PasskeyErrorCopy = {
  kind: PasskeyErrorKind;
  title: string;
  message: string;
};

const COPY: Record<PasskeyErrorKind, Omit<PasskeyErrorCopy, "kind">> = {
  cancelled: {
    title: "Sign-in cancelled",
    message: "No changes were made. Try again whenever you're ready.",
  },
  unsupported: {
    title: "Set up a screen lock first",
    message:
      "To keep your account safe, this phone needs a fingerprint, face unlock or screen lock. Set one up in your phone's settings, then try again.",
  },
  "prf-unavailable": {
    title: "This phone can't secure an account yet",
    message:
      "Try updating your phone's software, or sign in on a different phone.",
  },
  failed: {
    title: "Couldn't sign you in",
    message: "Something went wrong. Please try again.",
  },
};

/**
 * Best-effort detection of a user-initiated dismissal. Native passkey
 * layers surface it as an error whose text mentions cancellation
 * (`UserCancelled` on Android, `ASAuthorizationError.canceled` on iOS);
 * Mera wraps it under `PASSKEY_OPERATION_FAILED` with the native error as
 * `cause`. Only the shape is inspected — nothing from it is shown.
 */
function looksCancelled(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const rec = cur as {
      message?: unknown;
      code?: unknown;
      error?: unknown;
      cause?: unknown;
    };
    const text = `${String(rec.code ?? "")} ${String(rec.error ?? "")} ${String(rec.message ?? "")}`;
    if (/cancel/i.test(text)) return true;
    cur = rec.cause;
  }
  return false;
}

/**
 * Walk the `cause` chain and collect the stable native codes
 * (`react-native-passkey` rejects with codes such as `NoCredentials`,
 * `UserCancelled`, `NotConfigured`, `RequestFailed`). Used for the
 * sign-in → create fallback and for `__DEV__` logging; never shown.
 */
export function passkeyErrorCodes(err: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    // Mera: `code`. react-native-passkey: a plain `{ error, message }`
    // object (not an Error). DOM/iOS: `name`.
    const rec = cur as {
      code?: unknown;
      error?: unknown;
      name?: unknown;
      cause?: unknown;
    };
    if (typeof rec.code === "string") codes.push(rec.code);
    else if (typeof rec.error === "string") codes.push(rec.error);
    else if (typeof rec.name === "string") codes.push(rec.name);
    cur = rec.cause;
  }
  return codes;
}

/**
 * True when the OS reported that no TakumiPay passkey exists on this
 * device / account for the assertion. Android surfaces it as
 * `NoCredentials`; iOS has no distinct code (it shows an empty picker the
 * user dismisses, which is a cancel and stays a cancel).
 */
export function isNoPasskeyError(err: unknown): boolean {
  return passkeyErrorCodes(err).some((c) => /NoCredentials?/i.test(c));
}

export function classifyPasskeyError(err: unknown): PasskeyErrorCopy {
  let kind: PasskeyErrorKind = "failed";
  if (isMeraError(err)) {
    if (err.code === "PRF_UNAVAILABLE") kind = "prf-unavailable";
    else if (err.code === "PASSKEY_OPERATION_FAILED") {
      kind = looksCancelled(err) ? "cancelled" : "failed";
    }
  } else if (looksCancelled(err)) {
    kind = "cancelled";
  }
  return { kind, ...COPY[kind] };
}

export function unsupportedPasskeyCopy(): PasskeyErrorCopy {
  return { kind: "unsupported", ...COPY.unsupported };
}
