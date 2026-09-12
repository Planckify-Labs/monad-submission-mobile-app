/**
 * `/ul/v1/<method>?…` — Phantom-compatible encrypted deep links (spec §9).
 *
 * Only the method name and the raw query parameters are extracted here;
 * decryption, session validation and redirect rules live in
 * `services/transports/encryptedLink/` and run after the user's Continue.
 */

import type { DeepLinkIntent, EncryptedLinkMethod } from "../types";
import type { PathParseArgs } from "./index";

const METHODS: readonly EncryptedLinkMethod[] = [
  "connect",
  "disconnect",
  "signMessage",
  "signTransaction",
  "signAllTransactions",
  "signAndSendTransaction",
];

/** Parameters every method must carry (Phantom docs). */
const REQUIRED: Record<EncryptedLinkMethod, readonly string[]> = {
  connect: ["dapp_encryption_public_key", "redirect_link", "app_url"],
  disconnect: [
    "dapp_encryption_public_key",
    "nonce",
    "redirect_link",
    "payload",
  ],
  signMessage: [
    "dapp_encryption_public_key",
    "nonce",
    "redirect_link",
    "payload",
  ],
  signTransaction: [
    "dapp_encryption_public_key",
    "nonce",
    "redirect_link",
    "payload",
  ],
  signAllTransactions: [
    "dapp_encryption_public_key",
    "nonce",
    "redirect_link",
    "payload",
  ],
  signAndSendTransaction: [
    "dapp_encryption_public_key",
    "nonce",
    "redirect_link",
    "payload",
  ],
};

export function parseUlPath({
  rest,
  query,
  provenance,
}: PathParseArgs): DeepLinkIntent {
  const [version, method] = rest;
  if (version !== "v1" || !method)
    return { kind: "reject", code: "unsupported_operation" };
  if (!(METHODS as readonly string[]).includes(method)) {
    return { kind: "reject", code: "unsupported_operation" };
  }
  const m = method as EncryptedLinkMethod;
  const params: Record<string, string> = {};
  for (const [k, v] of query.entries()) params[k] = v;
  for (const key of REQUIRED[m]) {
    if (!params[key]) return { kind: "reject", code: "malformed" };
  }
  return {
    kind: "encrypted-link",
    method: m,
    params,
    provenance: {
      ...provenance,
      // No verifier exists in this protocol; the sender is always unverified.
      verification: { kind: "none" },
      transport: "encrypted-link",
    },
  };
}
