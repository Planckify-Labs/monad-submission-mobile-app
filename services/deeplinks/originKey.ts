/**
 * Origin keys per transport — spec §4.9 (invariant S-17).
 *
 * `PermissionStore` grants are keyed by an origin string, and every chain
 * adapter resolves silent connects from it. For the WebView the origin is
 * the tracked top-frame URL and is trustworthy. For external transports
 * the "origin" is peer-supplied metadata; used verbatim, a malicious
 * WalletConnect peer could set `metadata.url = "https://app.uniswap.org"`
 * and inherit the browser grant the user gave the real Uniswap.
 *
 * `originKeyFor` is the only producer of external origin keys, and every
 * key it emits carries a transport prefix that can never collide with a
 * `https://` WebView origin. Verified and unverified keys for the same
 * peer are distinct on purpose.
 */

import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { hostnameOfHttps } from "./uri";

export type ExternalOriginIdentity =
  | {
      transport: "walletconnect";
      pairingTopic: string;
      /** WalletConnect Verify `verified.origin`, only when `validation === "VALID"`. */
      verifiedOrigin?: string | null;
    }
  | {
      transport: "mwa";
      /** `identity.uri` from the dApp, if any. */
      identityUri?: string | null;
      /** Calling package when Digital Asset Links verification passed. */
      verifiedPackage?: string | null;
      /** Browser-attested web origin (Phase 3b), e.g. `https://dapp.example`. */
      attestedOrigin?: string | null;
    }
  | {
      transport: "encrypted-link";
      /** base58 `dapp_encryption_public_key`. */
      dappPublicKey: string;
    }
  | {
      transport: "sep7";
      /** Verified `origin_domain` (signature checked). */
      domain: string;
    };

const PREFIX_RE = /^(wc|mwa|ul|sep7)\+/;

/** `true` when a key was produced by this module (never a WebView origin). */
export function isExternalOriginKey(key: string): boolean {
  return PREFIX_RE.test(key);
}

export function transportOfOriginKey(
  key: string,
): "walletconnect" | "mwa" | "encrypted-link" | "sep7" | null {
  const m = PREFIX_RE.exec(key);
  if (!m) return null;
  switch (m[1]) {
    case "wc":
      return "walletconnect";
    case "mwa":
      return "mwa";
    case "ul":
      return "encrypted-link";
    case "sep7":
      return "sep7";
    default:
      return null;
  }
}

function short(s: string): string {
  return bytesToHex(sha256(utf8ToBytes(s))).slice(0, 32);
}

export function originKeyFor(identity: ExternalOriginIdentity): string {
  switch (identity.transport) {
    case "walletconnect": {
      const host = identity.verifiedOrigin
        ? hostnameOfHttps(
            identity.verifiedOrigin.startsWith("https://")
              ? identity.verifiedOrigin
              : `https://${identity.verifiedOrigin}`,
          )
        : null;
      return host
        ? `wc+https://${host}#${identity.pairingTopic}`
        : `wc+unverified://${identity.pairingTopic}`;
    }
    case "mwa": {
      const host = identity.identityUri
        ? hostnameOfHttps(identity.identityUri)
        : null;
      if (identity.verifiedPackage && host) {
        return `mwa+https://${host}#${identity.verifiedPackage}`;
      }
      const attested = identity.attestedOrigin
        ? hostnameOfHttps(identity.attestedOrigin)
        : null;
      if (attested) return `mwa+https://${attested}#web`;
      return `mwa+unverified://${short(identity.identityUri ?? "")}`;
    }
    case "encrypted-link":
      return `ul+unverified://${identity.dappPublicKey}`;
    case "sep7":
      return `sep7+https://${identity.domain.toLowerCase()}`;
  }
}
