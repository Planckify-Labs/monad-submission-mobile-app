/**
 * Redirect-link policy for the Phantom-compatible transport (spec §9):
 * `redirect_link` must be a custom scheme (returns to the app) or an
 * https URL on the same origin as `app_url` (opens the browser, shown
 * as a "Return to {app}" button). Pure, node-testable.
 */

import { hostnameOfHttps, splitUri } from "@/services/deeplinks/uri";

function isCustomScheme(url: string): boolean {
  const s = splitUri(url);
  return !!s && s.scheme !== "https" && s.scheme !== "http";
}

export function validateRedirect(
  redirectLink: string,
  appUrl: string,
): "custom" | "https" | null {
  if (isCustomScheme(redirectLink)) return "custom";
  const rh = hostnameOfHttps(redirectLink);
  const ah = hostnameOfHttps(appUrl);
  if (rh && ah && rh === ah) return "https";
  return null;
}

/** Append query params to a redirect link, preserving any it already has. */
export function withParams(
  url: string,
  params: Record<string, string>,
): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${url}${url.includes("?") ? "&" : "?"}${qs}`;
}
