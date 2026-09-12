/**
 * Deep-link kernel types — `docs/deeplink-wallet-interactions-spec.md` §4.3.
 *
 * Everything an OS link, a QR, a paste, or a push hands the wallet
 * collapses into a `DeepLinkEnvelope`, is parsed into exactly one
 * `DeepLinkIntent`, and is held in the inbox until the user acts on it.
 * Chain knowledge lives behind `DeepLinkSchemeHandler` registrations
 * (`services/chains/<ns>/deeplinks.ts`); nothing in this module names a
 * chain, a scheme, or a namespace literal.
 *
 * Pure module: no React, no Expo, no native imports. Node-testable.
 */

import type { TBlockchain } from "@/api/types/blockchain";
import type { TWallet } from "@/constants/types/walletTypes";
import type { ApprovalIntent } from "@/services/bridge/approval";
import type { Namespace } from "@/services/chains/types";
import type { PaymentIntent } from "@/services/paymentIntent/types";

export type DeepLinkSource =
  | "cold"
  | "warm"
  | "push"
  | "scan"
  | "paste"
  | "internal";

export type DeepLinkPlatform = "android" | "ios";

export interface DeepLinkEnvelope {
  /** Never logged in production; hashed for the replay ledger. */
  raw: string;
  source: DeepLinkSource;
  /** expo-router's `initial` (cold-start URL vs. warm `url` event). */
  initial: boolean;
  receivedAt: number;
  platform: DeepLinkPlatform;
}

export type DeepLinkRejectCode =
  | "too_large"
  | "fragment_blocked"
  | "malformed"
  | "unsupported_scheme"
  | "unsupported_chain"
  | "unsupported_operation"
  | "not_https"
  | "signature_missing"
  | "signature_invalid"
  | "signing_key_changed"
  | "network_mismatch"
  | "wrong_account"
  | "replayed"
  | "signing_mode"
  | "expired"
  | "no_wallet_for_namespace"
  | "route_not_allowed"
  | "not_enabled"
  | "malicious"
  | "recipient_invalid"
  | "insufficient_asset";

export type DeepLinkTransport =
  | "os-link"
  | "walletconnect"
  | "mwa"
  | "encrypted-link";

export type ProvenanceVerification =
  /** Custom scheme, nothing to check. */
  | { kind: "none" }
  /**
   * Arrived on our verified host: proves the link targeted US
   * exclusively, says nothing about who sent it.
   */
  | { kind: "universal-link" }
  | { kind: "sep7-signature"; domain: string; keyPinned: boolean }
  | { kind: "digital-asset-links"; package: string }
  /**
   * MWA origin attestation (spec "Identity verification" > Android, Phase
   * 3b): the browser attested the web dApp's origin through the
   * wallet-hosted script and the wallet verified the token.
   */
  | { kind: "origin-attestation"; origin: string }
  | {
      kind: "wc-verify";
      validation: "VALID" | "INVALID" | "UNKNOWN";
      isScam: boolean;
    }
  | { kind: "failed"; reason: DeepLinkRejectCode };

/** Who is (claimed to be) asking, and how strongly we believe it. */
export interface Provenance {
  /**
   * What the link says. Displayed as a headline only when
   * `verification.kind !== "none"`; otherwise as a muted secondary line
   * labelled unverified.
   */
  claimedOrigin?: string;
  verification: ProvenanceVerification;
  /** Origin never seen before (SEP-0007 threat 2; WC "unverified"). */
  firstSeen: boolean;
  transport: DeepLinkTransport;
  /**
   * The envelope's source, so sheets can say "From a link" vs "From a QR
   * code". Absent for transport-originated requests (WC / MWA / ul).
   */
  source?: DeepLinkSource;
}

export type ReturnChannel =
  | { kind: "none" }
  /** Class A/B: the result is the chain itself. */
  | { kind: "broadcast" }
  /** SEP-0007 `callback=url:` — POST `xdr=<signed>` as a form body. */
  | { kind: "http-callback"; url: string; form: "sep7-xdr" }
  /** Phantom-compatible encrypted redirect. */
  | { kind: "os-redirect"; url: string; encrypted: true }
  /** WalletConnect `redirect.native` (no payload). */
  | { kind: "os-redirect"; url: string; encrypted: false }
  /** Answered on the session that carried the request. */
  | { kind: "transport" };

/**
 * Read-only screens a link may open directly. Anything else on our host
 * or scheme is `route_not_allowed`. Keep this list short on purpose —
 * every entry is a URL that any app on the device can drive.
 */
export type AllowlistedHref =
  | "/wallet"
  | "/activities"
  | "/notification"
  | "/dapp-permissions"
  | "/about";

/**
 * What the interstitial shows for a Class B request before any network
 * call is made. Built by the handler's pure `parse()`; every value is
 * derived from the link itself and is labelled as such on screen.
 */
export interface SigningSummary {
  /** e.g. "Signing request", "Payment request". */
  title: string;
  /** Human chain family label, e.g. "Stellar", "Solana". */
  chainLabel: string;
  /** Short facts, rendered as label/value rows. Values are display-capped. */
  lines: Array<{ label: string; value: string }>;
  /**
   * Set when the request is unsigned and the protocol defines a
   * signature (SEP-0007 threat 1). Adds the extra confirmation step.
   */
  unsigned?: boolean;
  /**
   * Attacker-supplied free text (`label`, `message`, `msg`), rendered in a
   * separate "from the link" block and never as the counterparty name
   * (D-13).
   */
  linkText?: string;
}

/**
 * An approval the bridge can enqueue on behalf of an external transport.
 * The bridge stamps `id`, `createdAt`, `annotations` and the provenance
 * annotation (`DappBridge.submitExternalIntent`).
 */
export type ExternalApprovalDraft = Omit<
  ApprovalIntent,
  "annotations" | "id" | "createdAt"
> & {
  provenance: Provenance;
  returnChannel?: ReturnChannel;
};

export type EncryptedLinkMethod =
  | "connect"
  | "disconnect"
  | "signMessage"
  | "signTransaction"
  | "signAllTransactions"
  | "signAndSendTransaction";

/**
 * Thrown by a handler's `build()` when verification or construction
 * fails after the interstitial's Continue. The interstitial maps `code`
 * to hand-written copy; `detail` is never shown to the user.
 */
export class DeepLinkBuildError extends Error {
  readonly code: DeepLinkRejectCode;
  /** Substituted into copy placeholders such as `{domain}`. */
  readonly domain?: string;
  /** Substituted into `{asset}`. */
  readonly asset?: string;
  /** `__DEV__` diagnostics only. */
  readonly detail?: string;
  /**
   * Structured data a recovery action needs (e.g. the newly fetched
   * SEP-0007 signing key behind "Trust the new key"). Never rendered.
   */
  readonly data?: Record<string, unknown>;
  constructor(
    code: DeepLinkRejectCode,
    opts?: {
      domain?: string;
      asset?: string;
      detail?: string;
      data?: Record<string, unknown>;
    },
  ) {
    super(`deeplink:${code}`);
    this.name = "DeepLinkBuildError";
    this.code = code;
    this.domain = opts?.domain;
    this.asset = opts?.asset;
    this.detail = opts?.detail;
    this.data = opts?.data;
  }
}

export type DeepLinkIntent =
  | { kind: "navigate"; href: AllowlistedHref }
  | { kind: "open-dapp"; url: string }
  | {
      kind: "payment";
      namespace: Namespace;
      intent: PaymentIntent;
      provenance: Provenance;
      /** What the interstitial shows (amount, asset, chain). */
      summary: SigningSummary;
    }
  | {
      kind: "signing";
      namespace: Namespace;
      summary: SigningSummary;
      /** May fetch (Solana Pay POST, stellar.toml). Runs after Continue. */
      build: (
        wallet: TWallet,
        ctx: BuildContext,
      ) => Promise<ExternalApprovalDraft>;
      returnChannel: ReturnChannel;
      provenance: Provenance;
      /** Protocol-pinned account (§4.7 rule 2), when the link names one. */
      pinnedAccount?: string;
    }
  | {
      kind: "pair";
      transport: "walletconnect";
      uri: string;
      provenance: Provenance;
      /**
       * Phase 2b Link Mode envelope (`/wc?wc_ev=…`): the SDK's own listener
       * dispatches it; the interstitial hands it off without a card.
       */
      linkMode?: boolean;
    }
  | { kind: "associate"; transport: "mwa"; uri: string; provenance: Provenance }
  /**
   * WalletConnect "request redirect": a dApp sent a request over the relay
   * and opened `<wallet link>/wc?requestId=&sessionTopic=` so the wallet
   * comes to the front. Nothing to approve from the link itself; the
   * request arrives on the session. The kernel wakes the transport and
   * navigates nowhere.
   */
  | {
      kind: "wake";
      transport: "walletconnect";
      topic: string;
      requestId: string;
    }
  | {
      kind: "encrypted-link";
      method: EncryptedLinkMethod;
      params: Readonly<Record<string, string>>;
      provenance: Provenance;
    }
  | { kind: "reject"; code: DeepLinkRejectCode; domain?: string };

/**
 * Everything a handler's `parse()` is allowed to consult besides the
 * URI. Injected by the kernel so parsers stay pure and testable.
 */
export interface DeepLinkParseContext {
  /**
   * Backend `/blockchains` rows from the on-device cache, or `null` when
   * nothing has been cached yet (first launch, offline). Handlers treat
   * `null` as "cannot verify" and defer the check to the build step.
   */
  chainRows: () => TBlockchain[] | null;
}

/** What `build()` may consult in addition to the bound wallet. */
export interface BuildContext {
  chainRows: () => TBlockchain[] | null;
  /** Fetch with the §10 S-6 discipline (timeout, redirect cap, body cap). */
  fetch: typeof fetch;
}
