/**
 * Hand-written copy for every deep-link rejection — spec §11.1 (S-15).
 *
 * Rules: one line of friendly copy, never the URI, never a status code,
 * never `err.message`; periods and colons, no em-dashes
 * (`feedback_no_emdash_in_ui_copy`). `{domain}` and `{Chain}` are the
 * only placeholders and are substituted with values the wallet itself
 * derived (a hostname we verified, a chain family label), never with
 * free text from the link.
 */

import type { DeepLinkRejectCode } from "./types";

export interface RejectCopy {
  title: string;
  body: string;
  /** Primary action label. */
  cta: "Close" | "Open settings" | "Add wallet" | "Trust the new key";
}

const COPY: Record<DeepLinkRejectCode, RejectCopy> = {
  too_large: {
    title: "Link too long",
    body: "This link is too long for the wallet to open.",
    cta: "Close",
  },
  fragment_blocked: {
    title: "Link blocked",
    body: "This link contains data the wallet will not accept.",
    cta: "Close",
  },
  malformed: {
    title: "Can't read this link",
    body: "The wallet couldn't understand this link. Ask the sender for a new one.",
    cta: "Close",
  },
  unsupported_scheme: {
    title: "Not supported",
    body: "The wallet doesn't support this kind of link yet.",
    cta: "Close",
  },
  unsupported_chain: {
    title: "Network not supported",
    body: "This request is for a network the wallet doesn't support yet.",
    cta: "Close",
  },
  unsupported_operation: {
    title: "Not supported yet",
    body: "This request asks for something the wallet can't do from a link yet.",
    cta: "Close",
  },
  not_https: {
    title: "Insecure link",
    body: "This request points to an insecure address, so it was not opened.",
    cta: "Close",
  },
  signature_missing: {
    title: "Unsigned request",
    body: "This request claims to come from {domain} but isn't signed. It was not opened.",
    cta: "Close",
  },
  signature_invalid: {
    title: "Signature check failed",
    body: "This request's signature doesn't match {domain}. It was not opened.",
    cta: "Close",
  },
  signing_key_changed: {
    title: "Signing key changed",
    body: "The signing key for {domain} has changed since you last used it. For your safety this request was not opened.",
    cta: "Trust the new key",
  },
  network_mismatch: {
    title: "Wrong network",
    body: "This request is for a different {Chain} network than this wallet uses.",
    cta: "Close",
  },
  wrong_account: {
    title: "Account not found",
    body: "This request is for an account that isn't in this wallet.",
    cta: "Close",
  },
  replayed: {
    title: "Already opened",
    body: "You've already opened this link.",
    cta: "Close",
  },
  signing_mode: {
    title: "Signing mode is on",
    body: "Links can't open payment or signing requests while signing mode is on.",
    cta: "Open settings",
  },
  expired: {
    title: "Link expired",
    body: "This link has expired. Ask the app for a new one.",
    cta: "Close",
  },
  no_wallet_for_namespace: {
    title: "No {Chain} wallet",
    body: "You don't have a {Chain} wallet yet. Create or import one to continue.",
    cta: "Add wallet",
  },
  route_not_allowed: {
    title: "Can't open this",
    body: "This link isn't something the wallet can open.",
    cta: "Close",
  },
  not_enabled: {
    title: "Not enabled in this version",
    body: "This kind of link isn't enabled in this version of the wallet yet.",
    cta: "Close",
  },
  malicious: {
    title: "Request refused",
    body: "This request asks for a signature the wallet can't provide. It was not opened.",
    cta: "Close",
  },
  recipient_invalid: {
    title: "Can't pay this address",
    body: "This address can't receive a payment.",
    cta: "Close",
  },
  insufficient_asset: {
    title: "Asset not held",
    body: "You don't hold {asset} in this wallet.",
    cta: "Close",
  },
};

export interface CopyVars {
  domain?: string;
  chain?: string;
  asset?: string;
}

/**
 * Resolve the copy for a reject code. Placeholders that have no value
 * fall back to neutral words so a missing substitution never renders
 * literal braces.
 */
export function rejectCopy(
  code: DeepLinkRejectCode,
  vars: CopyVars = {},
): RejectCopy {
  const base = COPY[code] ?? COPY.malformed;
  const domain = vars.domain ?? "this sender";
  const chain = vars.chain ?? "this";
  const asset = vars.asset ?? "that asset";
  const sub = (s: string) =>
    s
      .replace(/\{domain\}/g, domain)
      .replace(/\{Chain\}/g, chain)
      .replace(/\{asset\}/g, asset);
  return { title: sub(base.title), body: sub(base.body), cta: base.cta };
}

/** Extra confirmation shown for an unsigned SEP-0007 request (threat 1). */
export const UNSIGNED_REQUEST_COPY = {
  title: "Unverified request",
  body: "This request isn't signed, so the wallet can't confirm who sent it. Only continue if you trust the source.",
  confirm: "I understand, continue",
  dismiss: "Not now",
} as const;

/** Interstitial chrome. */
export const INTERSTITIAL_COPY = {
  fromLink: "From a link",
  fromQr: "From a QR code",
  fromPaste: "From your clipboard",
  unverifiedSender: "Unverified sender",
  verifiedBy: {
    "universal-link": "Opened through the wallet's verified link",
    "sep7-signature": "Signed by {domain}",
    "digital-asset-links": "Verified app",
    "origin-attestation": "Verified web app",
    "wc-verify": "Verified by WalletConnect",
  } as Record<string, string>,
  firstSeen: "First time connecting to {origin}.",
  continueLabel: "Continue",
  notNow: "Not now",
  openedFromUnverifiedLink: "Opened from an unverified link.",
  connectionRequestFrom: "Connection request from {name}",
  working: "Preparing your request...",
  sentBackTo: "Sent back to {app}.",
  returnTo: "Return to {app}",
  callbackDelivered: "Sent to {domain}.",
  callbackFailed:
    "Couldn't reach {domain}. Your signed transaction was not submitted.",
} as const;

/** Copy that must never contain an em-dash; tested in copy.test.ts. */
export const __ALL_COPY_STRINGS: string[] = [
  ...Object.values(COPY).flatMap((c) => [c.title, c.body, c.cta]),
  ...Object.values(UNSIGNED_REQUEST_COPY),
  ...Object.values(INTERSTITIAL_COPY).flatMap((v) =>
    typeof v === "string" ? [v] : Object.values(v),
  ),
];
