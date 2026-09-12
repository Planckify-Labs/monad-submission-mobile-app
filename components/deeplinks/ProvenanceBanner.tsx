/**
 * `ProvenanceBanner` — renders the `link_provenance` annotation every
 * externally-originated approval carries (deep-link spec §4.3, S-3).
 *
 * Rules it enforces on screen:
 *   - An unverified origin is never a headline. It renders as
 *     "Unverified sender" with the claimed domain in a muted secondary
 *     line (SEP-0007 rule 8, WalletConnect Verify guidance).
 *   - A verified origin names its verifier ("Signed by shop.example",
 *     "Verified app").
 *   - First contact is stated plainly (SEP-0007 threat 2).
 *   - Copy is fixed; the only dynamic text is a hostname the wallet
 *     itself verified or a hostname explicitly labelled as claimed.
 */

import {
  AlertTriangle,
  Link2,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react-native";
import React from "react";
import { Text, View } from "react-native";
import type { IntentAnnotation } from "@/services/bridge/inspector";
import { INTERSTITIAL_COPY } from "@/services/deeplinks/copy";
import type { Provenance } from "@/services/deeplinks/types";

export const LINK_PROVENANCE_CODE = "link_provenance";

export function findProvenance(
  annotations: readonly IntentAnnotation[] | undefined,
): Provenance | null {
  const a = annotations?.find((x) => x.code === LINK_PROVENANCE_CODE);
  const data = a?.data as Provenance | undefined;
  return data && typeof data === "object" && "verification" in data
    ? data
    : null;
}

/** D-15 / S-18: unverified external signing needs a second factor. */
export function provenanceRequiresStrongAuth(p: Provenance | null): boolean {
  if (!p) return false;
  const v = p.verification;
  if (v.kind === "none" || v.kind === "failed") return true;
  if (v.kind === "wc-verify" && (v.validation === "INVALID" || v.isScam))
    return true;
  return false;
}

function sourceLabel(p: Provenance): string {
  switch (p.source) {
    case "scan":
      return INTERSTITIAL_COPY.fromQr;
    case "paste":
      return INTERSTITIAL_COPY.fromPaste;
    default:
      return INTERSTITIAL_COPY.fromLink;
  }
}

function describe(p: Provenance): {
  tone: "ok" | "warn" | "danger";
  headline: string;
  secondary?: string;
} {
  const v = p.verification;
  switch (v.kind) {
    case "sep7-signature":
      return {
        tone: "ok",
        headline: INTERSTITIAL_COPY.verifiedBy["sep7-signature"].replace(
          "{domain}",
          v.domain,
        ),
      };
    case "digital-asset-links":
      return {
        tone: "ok",
        headline: INTERSTITIAL_COPY.verifiedBy["digital-asset-links"],
        secondary: p.claimedOrigin,
      };
    case "origin-attestation":
      return {
        tone: "ok",
        headline: INTERSTITIAL_COPY.verifiedBy["origin-attestation"],
        secondary: v.origin,
      };
    case "wc-verify":
      if (v.isScam) {
        return {
          tone: "danger",
          headline: "This app is flagged as malicious.",
          secondary: p.claimedOrigin,
        };
      }
      if (v.validation === "INVALID") {
        return {
          tone: "danger",
          headline: "This app's domain doesn't match what it claims.",
          secondary: p.claimedOrigin,
        };
      }
      if (v.validation === "UNKNOWN") {
        return {
          tone: "warn",
          headline: "Unverified app",
          secondary: p.claimedOrigin,
        };
      }
      return {
        tone: "ok",
        headline: INTERSTITIAL_COPY.verifiedBy["wc-verify"],
        secondary: p.claimedOrigin,
      };
    case "universal-link":
      return {
        tone: "ok",
        headline: INTERSTITIAL_COPY.verifiedBy["universal-link"],
        secondary: p.claimedOrigin
          ? `Sender claims: ${p.claimedOrigin} (not verified)`
          : undefined,
      };
    case "failed":
      return {
        tone: "danger",
        headline: "Verification failed",
        secondary: p.claimedOrigin,
      };
    default:
      return {
        tone: "warn",
        headline: INTERSTITIAL_COPY.unverifiedSender,
        secondary: p.claimedOrigin
          ? `Sender claims: ${p.claimedOrigin} (not verified)`
          : INTERSTITIAL_COPY.openedFromUnverifiedLink,
      };
  }
}

const TONE = {
  ok: {
    bg: "bg-emerald-50",
    border: "border-emerald-200",
    text: "text-emerald-900",
    color: "#047857",
  },
  warn: {
    bg: "bg-amber-50",
    border: "border-amber-200",
    text: "text-amber-900",
    color: "#b45309",
  },
  danger: {
    bg: "bg-red-50",
    border: "border-red-200",
    text: "text-red-900",
    color: "#b91c1c",
  },
} as const;

export function ProvenanceBanner({
  provenance,
}: {
  provenance: Provenance;
}): React.ReactElement {
  const d = describe(provenance);
  const t = TONE[d.tone];
  const Icon =
    d.tone === "ok"
      ? ShieldCheck
      : d.tone === "danger"
        ? ShieldAlert
        : AlertTriangle;
  return (
    <View
      className={`rounded-xl border ${t.bg} ${t.border} p-3 mb-3`}
      accessibilityLabel="link-provenance"
    >
      <View className="flex-row items-center">
        <Icon size={16} color={t.color} />
        <Text
          className={`ml-2 font-semibold ${t.text} flex-1`}
          numberOfLines={2}
        >
          {d.headline}
        </Text>
      </View>
      {d.secondary ? (
        <Text className={`mt-1 text-xs ${t.text} opacity-70`} numberOfLines={1}>
          {d.secondary}
        </Text>
      ) : null}
      <View className="flex-row items-center mt-1">
        <Link2 size={12} color={t.color} />
        <Text className={`ml-1 text-xs ${t.text} opacity-70`}>
          {sourceLabel(provenance)}
          {provenance.firstSeen ? "  ·  First time with this sender" : ""}
        </Text>
      </View>
    </View>
  );
}
