/**
 * Deep-link intake — spec §4.2 / §4.8 / §10.
 *
 * `app/+native-intent.tsx` hands every native URL here. In order:
 *   1. pass-through for URLs that are not ours to interpret (dev client,
 *      OAuth callbacks, plain app open),
 *   2. size cap (S-11),
 *   3. fragment denylist on every URL, query-key denylist only on our own
 *      routes (F4 / S-8),
 *   4. scheme dispatch: own scheme → legacy routes, verified host → path
 *      handlers, third-party http(s) → open in the in-app browser, any
 *      other scheme → the registry,
 *   5. policy: signing mode (S-13), push source (S-12), phase flags,
 *      cold-start replay ledger (S-10),
 *   6. result: direct route for Class D, inbox for everything else.
 *
 * Pure: all I/O comes in through `IntakeDeps`, so the whole pipeline is
 * node-testable and `+native-intent` is a five-line adapter around it.
 */

import {
  isOwnScheme,
  isSeedMaterialBlocked,
  OWN_SCHEMES,
  VERIFIED_HOST,
} from "@/services/security/deeplinkGate";
import { parseRequestRedirect } from "@/services/transports/walletconnect/deeplinks";
import { isClassEnabled } from "./flags";
import { type InboxItem, linkInbox } from "./inbox";
import { parseHostPath } from "./paths";
import { parseDeepLink } from "./schemeRegistry";
import type {
  AllowlistedHref,
  DeepLinkEnvelope,
  DeepLinkIntent,
  DeepLinkParseContext,
  DeepLinkRejectCode,
} from "./types";
import { hostnameOfHttps, type SplitUri, splitUri } from "./uri";

/** Android `TransactionTooLarge` is ~500 KB; iOS ~1 MB. We stop well short. */
export const MAX_LINK_BYTES = 256 * 1024;

export { isOwnScheme, OWN_SCHEMES, VERIFIED_HOST };

/**
 * URLs the kernel returns unchanged with no ledger entry and no
 * analytics. A test fails when `app.config.ts` gains a scheme that is
 * neither here nor in the registry.
 */
export const PASS_THROUGH_PREFIXES: readonly string[] = [
  "exp+takumiwallet",
  "expo-development-client://",
  "com.googleusercontent.apps.",
];

export interface IntakeDeps {
  chainRows: DeepLinkParseContext["chainRows"];
  signingModeOn: () => boolean;
  /**
   * A WalletConnect request redirect (`…/wc?requestId=&sessionTopic=`)
   * arrived: make sure the transport is up so the request on that
   * session reaches the approval host. No navigation follows.
   */
  onWake?: (wake: { topic: string; requestId: string }) => void;
  ledger: {
    wasConsumed: (raw: string) => boolean;
    markConsumed: (raw: string) => void;
  };
  onEvent?: (event: IntakeEvent) => void;
}

export type IntakeEvent =
  | {
      name: "deeplink_received";
      class: DeepLinkIntent["kind"];
      transport: string;
      verification: string;
      namespace: string | null;
      source: DeepLinkEnvelope["source"];
    }
  | { name: "deeplink_rejected"; code: DeepLinkRejectCode };

export type IntakeResult =
  | { kind: "passthrough"; path: string }
  /** Not for the router at all (another React root owns the URL). */
  | { kind: "ignore" }
  | { kind: "route"; href: string }
  | { kind: "inbox"; href: "/link-inbox"; item: InboxItem };

export const INBOX_ROUTE = "/link-inbox" as const;

const ALLOWLISTED_HREFS: readonly AllowlistedHref[] = [
  "/wallet",
  "/activities",
  "/notification",
  "/dapp-permissions",
  "/about",
];

export function isAllowlistedHref(href: string): href is AllowlistedHref {
  return (ALLOWLISTED_HREFS as readonly string[]).includes(href);
}

/**
 * `<app scheme>-mwa://…` is the private return leg of the MWA origin
 * attestation (`services/transports/mwa/attestation.ts`). It targets the
 * MWA host activity, but Android emits every `url` event to the single
 * React instance, so the main root sees it too and must stay put.
 */
export function isMwaActivityScheme(scheme: string): boolean {
  const s = scheme.toLowerCase();
  return s.endsWith("-mwa") && isOwnScheme(s.slice(0, -"-mwa".length));
}

function isPassThrough(raw: string, split: SplitUri | null): boolean {
  const lower = raw.toLowerCase();
  for (const p of PASS_THROUGH_PREFIXES) if (lower.startsWith(p)) return true;
  if (!split) return false;
  if (isOwnScheme(split.scheme)) {
    // `takumiwallet://` / `takumiwallet:///` = plain app open (expo-router's
    // root URL when the app is launched from the home screen).
    const path = split.ssp.replace(/^\/\//, "");
    if (path === "" || path === "/") return true;
    if (path.startsWith("expo-development-client")) return true;
  }
  if (split.scheme === "https" || split.scheme === "http") {
    const host = hostnameOfHttps(raw.replace(/^http:/i, "https:"));
    if (host === VERIFIED_HOST) {
      const afterHost = split.ssp.replace(/^\/\/[^/]*/, "");
      if (afterHost === "" || afterHost === "/") return !split.rawQuery;
    }
  }
  return false;
}

/**
 * Legacy `takumiwallet://<route>` shapes (spec §4.4 "Legacy custom-scheme
 * routes") plus the advertised custom-scheme forms in §5. Nothing here
 * opens a file route directly.
 */
function parseOwnScheme(
  split: SplitUri,
  envelope: DeepLinkEnvelope,
  ctx: DeepLinkParseContext,
): DeepLinkIntent {
  const path = split.ssp.replace(/^\/\//, "").replace(/^\/+/, "");
  const segments = path.split("/").filter(Boolean);
  const head = (segments[0] ?? "").toLowerCase();
  const provenance = {
    verification: { kind: "none" } as const,
    firstSeen: false,
    transport: "os-link" as const,
    source: envelope.source,
  };
  // Custom-scheme forms are parsed by the same path handlers as the
  // universal link, with `verification: none` instead of universal-link.
  const viaPath = parseHostPath(
    `/${segments.join("/")}`,
    split.query,
    envelope,
    ctx,
    provenance,
  );
  if (viaPath) return viaPath;

  switch (head) {
    case "send": {
      // Legacy `takumiwallet://send?to=&amount=&chain=` → Class-A EVM payment
      // through the inbox, never the direct `/send` push it used to get.
      const to = split.query.get("to") ?? "";
      const chain = split.query.get("chain");
      const amount = split.query.get("amount");
      const chainPart = chain && /^\d+$/.test(chain) ? `@${chain}` : "";
      const valuePart =
        amount && /^\d+$/.test(amount) ? `?value=${amount}` : "";
      // Synthesise the standard URI and let the registered EVM handler own
      // the parsing; the legacy route has no parser of its own.
      return parseDeepLink(
        envelope,
        ctx,
        `ethereum:${to}${chainPart}${valuePart}`,
      );
    }
    case "connect": {
      const uri = split.query.get("uri");
      if (!uri) return { kind: "reject", code: "malformed" };
      return parseDeepLink(envelope, ctx, uri);
    }
    default:
      return { kind: "reject", code: "route_not_allowed" };
  }
}

function classifyEnvelope(
  envelope: DeepLinkEnvelope,
  split: SplitUri,
  ctx: DeepLinkParseContext,
): DeepLinkIntent {
  // WalletConnect request redirect, on any carrier a dApp library may use
  // for it (our scheme, our universal link, or the bare `wc:` pairing URI
  // head). Checked first: `wc:<topic>@2/wc?requestId=…` would otherwise
  // read as a pairing URI with a bad version.
  const wake = parseRequestRedirect(envelope.raw);
  if (
    wake &&
    (isOwnScheme(split.scheme) ||
      split.scheme === "wc" ||
      ((split.scheme === "https" || split.scheme === "http") &&
        hostnameOfHttps(envelope.raw.replace(/^http:/i, "https:")) ===
          VERIFIED_HOST))
  ) {
    return { kind: "wake", transport: "walletconnect", ...wake };
  }
  if (isOwnScheme(split.scheme)) return parseOwnScheme(split, envelope, ctx);

  if (split.scheme === "https" || split.scheme === "http") {
    const asHttps = envelope.raw.replace(/^http:/i, "https:");
    const host = hostnameOfHttps(asHttps);
    if (!host) return { kind: "reject", code: "malformed" };
    if (host === VERIFIED_HOST) {
      if (split.scheme !== "https")
        return { kind: "reject", code: "not_https" };
      const afterHost = split.ssp.replace(/^\/\/[^/]*/, "") || "/";
      const out = parseHostPath(afterHost, split.query, envelope, ctx, {
        verification: { kind: "universal-link" },
        firstSeen: false,
        transport: "os-link",
        source: envelope.source,
      });
      return out ?? { kind: "reject", code: "route_not_allowed" };
    }
    // Third-party page the user chose to open with us (Android ≤ 11
    // chooser, F1). Never treated as anything but a browser navigation.
    return { kind: "open-dapp", url: envelope.raw };
  }

  return parseDeepLink(envelope, ctx);
}

function isIntentBearing(intent: DeepLinkIntent): boolean {
  return (
    intent.kind !== "navigate" &&
    intent.kind !== "open-dapp" &&
    intent.kind !== "wake" &&
    intent.kind !== "reject"
  );
}

function namespaceOf(intent: DeepLinkIntent): string | null {
  return "namespace" in intent ? intent.namespace : null;
}

function verificationOf(intent: DeepLinkIntent): string {
  return "provenance" in intent ? intent.provenance.verification.kind : "n/a";
}

function transportOf(intent: DeepLinkIntent): string {
  if ("transport" in intent && typeof intent.transport === "string")
    return intent.transport;
  if ("provenance" in intent) return intent.provenance.transport;
  return "os-link";
}

/**
 * Run the intake pipeline. Never throws.
 */
export function intake(
  envelope: DeepLinkEnvelope,
  deps: IntakeDeps,
): IntakeResult {
  const raw = envelope.raw;
  const split = splitUri(raw);

  if (split && isMwaActivityScheme(split.scheme)) return { kind: "ignore" };
  if (isPassThrough(raw, split)) return { kind: "passthrough", path: raw };

  const ctx: DeepLinkParseContext = { chainRows: deps.chainRows };

  const hold = (intent: DeepLinkIntent): IntakeResult => {
    if (intent.kind === "reject") {
      deps.onEvent?.({ name: "deeplink_rejected", code: intent.code });
      deps.ledger.markConsumed(raw);
    }
    const item = linkInbox.hold(envelope, intent, envelope.receivedAt);
    return { kind: "inbox", href: INBOX_ROUTE, item };
  };

  if (raw.length > MAX_LINK_BYTES)
    return hold({ kind: "reject", code: "too_large" });
  if (!split) return hold({ kind: "reject", code: "malformed" });

  // S-8 / F4: fragment denylist on every URL; query keys only for our own
  // routes (`services/security/deeplinkGate.ts` owns the policy).
  if (isSeedMaterialBlocked(raw, split)) {
    return hold({ kind: "reject", code: "fragment_blocked" });
  }

  let intent = classifyEnvelope(envelope, split, ctx);

  // A wake carries no intent of its own: the request it announces comes
  // over the session, where the transport's own checks apply. Nothing to
  // hold, nothing to replay-guard, nowhere to navigate.
  if (intent.kind === "wake") {
    deps.onEvent?.({
      name: "deeplink_received",
      class: "wake",
      transport: intent.transport,
      verification: "n/a",
      namespace: null,
      source: envelope.source,
    });
    deps.onWake?.({ topic: intent.topic, requestId: intent.requestId });
    return { kind: "ignore" };
  }

  // S-12: a push may only open a read-only screen.
  if (envelope.source === "push" && intent.kind !== "navigate") {
    intent = { kind: "reject", code: "route_not_allowed" };
  }

  // S-13: signing mode wins over every class that carries intent, and the
  // browser is disabled in that mode too.
  if (
    deps.signingModeOn() &&
    intent.kind !== "navigate" &&
    intent.kind !== "reject"
  ) {
    intent = { kind: "reject", code: "signing_mode" };
  }

  // Phase flags — the scheme is registered at the OS level regardless so
  // the interstitial can explain instead of the OS bouncing the link.
  if (
    (intent.kind === "payment" ||
      intent.kind === "signing" ||
      intent.kind === "pair" ||
      intent.kind === "associate" ||
      intent.kind === "encrypted-link") &&
    !isClassEnabled(intent.kind)
  ) {
    intent = { kind: "reject", code: "not_enabled" };
  }

  // S-10: cold-start replay (Android recents re-delivers the launch intent).
  if (
    isIntentBearing(intent) &&
    envelope.initial &&
    envelope.source === "cold"
  ) {
    if (deps.ledger.wasConsumed(raw)) {
      intent = { kind: "reject", code: "replayed" };
    }
  }

  if (intent.kind !== "reject") {
    deps.onEvent?.({
      name: "deeplink_received",
      class: intent.kind,
      transport: transportOf(intent),
      verification: verificationOf(intent),
      namespace: namespaceOf(intent),
      source: envelope.source,
    });
  }

  if (intent.kind === "navigate") return { kind: "route", href: intent.href };
  if (intent.kind === "open-dapp") {
    return {
      kind: "route",
      href: `/dapps-browser?url=${encodeURIComponent(intent.url)}`,
    };
  }
  return hold(intent);
}
