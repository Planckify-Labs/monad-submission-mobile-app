// TWV-2026-024 — Universal/App Link gate. Custom URL schemes
// (`takumiwallet://`) are NOT exclusively registrable; only verified
// HTTPS App Links / Universal Links are. Sensitive deeplinks (send,
// sign, WalletConnect pair, chain add) MUST resolve via HTTPS;
// custom-scheme deeplinks for these targets fall through to a
// preview screen with an explicit warning, never auto-execute.
//
// Wired (docs/deeplink-wallet-interactions-spec.md §4.2): the intake
// pipeline in `services/deeplinks/intake.ts` is the single caller. The
// two policies it takes from here are the verified host and the
// seed-material denylist, scoped per F4: the denylist runs on the URL
// **fragment** for every link and on the query **keys** only for our
// own routes (`takumiwallet://…`, `https://takumipay.xyz/…`). Protocol
// schemes own their own parameter validation — SEP-0007 legitimately
// carries `&signature=…`, which the old unscoped regex rejected.
//
// No `new URL`: RN's implementation is a regex shim
// (`feedback_rn_url_is_regex_shim`); parsing goes through `splitUri`.

import {
  hostnameOfHttps,
  type SplitUri,
  splitUri,
} from "@/services/deeplinks/uri";

export const VERIFIED_HOST = "takumipay.xyz";

/**
 * Our own custom schemes. Expo also registers the bundle identifier as an
 * iOS scheme automatically, so those are ours too.
 */
export const OWN_SCHEMES: readonly string[] = [
  "takumiwallet",
  "takumiwallet-dev",
  "takumiwallet-preview",
  "com.planckify.takumiwallet",
  "com.planckify.takumiwallet.dev",
  "com.planckify.takumiwallet.preview",
];

export function isOwnScheme(scheme: string): boolean {
  return OWN_SCHEMES.includes(scheme.toLowerCase());
}

/**
 * File routes that carry intent and must never be reachable by URL
 * (invariant S-2). Kept as documentation + test fixture: `+native-intent`
 * never returns any of these for an external URL, on any scheme or host.
 */
export const SENSITIVE_PATHS: ReadonlySet<string> = new Set<string>([
  "/send",
  "/sign",
  "/wc",
  "/add-chain",
  "/payment",
  "/pay-merchant",
  "/pay-x402",
  "/withdraw",
  "/deposit",
  "/approvals",
  "/agent-permissions",
  "/gas-settings",
]);

export const FRAGMENT_DENY = /(seed|mnemonic|privatekey|pk|signature)/i;

/** `true` when the split URI belongs to our own scheme or verified host. */
export function isOurRoute(
  raw: string,
  split: SplitUri | null = splitUri(raw),
): boolean {
  if (!split) return false;
  if (isOwnScheme(split.scheme)) return true;
  if (split.scheme === "https" || split.scheme === "http") {
    return hostnameOfHttps(raw.replace(/^http:/i, "https:")) === VERIFIED_HOST;
  }
  return false;
}

/**
 * F4 / S-8 — seed-shaped material never rides on a fragment; on query
 * keys it is refused only for our own routes.
 */
export function isSeedMaterialBlocked(
  raw: string,
  split: SplitUri | null = splitUri(raw),
): boolean {
  if (!split) return false;
  if (split.fragment !== null && FRAGMENT_DENY.test(split.fragment))
    return true;
  if (isOurRoute(raw, split)) {
    for (const key of split.query.keys()) {
      if (FRAGMENT_DENY.test(key)) return true;
    }
  }
  return false;
}

export type DeeplinkVerdict =
  | { ok: true; preview: true; route: string; reason?: string }
  | {
      ok: false;
      code: "non_https" | "wrong_host" | "fragment_blocked" | "malformed";
      reason: string;
    };

/**
 * Inspect an incoming deeplink. Returns a verdict the intake pipeline
 * uses to either route to a preview screen (preview: true) or reject
 * outright. NEVER returns an "auto-execute" verdict — the preview is
 * mandatory for sensitive paths.
 */
export function inspectDeeplink(rawUrl: string): DeeplinkVerdict {
  const split = splitUri(rawUrl);
  if (!split)
    return { ok: false, code: "malformed", reason: "URL parse failed" };

  if (isSeedMaterialBlocked(rawUrl, split)) {
    return {
      ok: false,
      code: "fragment_blocked",
      reason: "URL carries seed-shaped material",
    };
  }

  const isHttp = split.scheme === "https" || split.scheme === "http";
  if (!isHttp) {
    // Custom-scheme deeplinks for sensitive paths are NEVER auto-executed.
    // They route to the preview screen with a warning that this is not
    // an exclusively-verified entry point.
    const path = `/${split.ssp.replace(/^\/\//, "").replace(/^\/+/, "")}`;
    if (SENSITIVE_PATHS.has(path)) {
      return {
        ok: true,
        preview: true,
        route: split.rawQuery ? `${path}?${split.rawQuery}` : path,
        reason:
          "Sensitive route opened via non-verified scheme — preview required.",
      };
    }
    return { ok: true, preview: true, route: path };
  }

  const host = hostnameOfHttps(rawUrl.replace(/^http:/i, "https:"));
  if (host !== VERIFIED_HOST) {
    return {
      ok: false,
      code: "wrong_host",
      reason: "host is not the App-Links-verified host",
    };
  }
  if (split.scheme !== "https") {
    return {
      ok: false,
      code: "non_https",
      reason: "verified host requires https",
    };
  }
  const path = split.ssp.replace(/^\/\/[^/]*/, "") || "/";
  return {
    ok: true,
    preview: true,
    route: split.rawQuery ? `${path}?${split.rawQuery}` : path,
  };
}
