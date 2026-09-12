/**
 * Which WebView navigations the dApps browser keeps in-app and feeds to
 * the kernel (deep-link spec §4.2), versus hands to the OS. Pure.
 */

import { isOwnScheme, VERIFIED_HOST } from "@/services/security/deeplinkGate";
import { isOsOwnedScheme, registeredSchemes } from "./schemeRegistry";
import { hostnameOfHttps, splitUri } from "./uri";

/**
 * `true` when the dApps browser should keep this navigation in-app and
 * feed it to the kernel instead of letting the WebView hand it to the OS.
 */
export function isKernelLink(url: string): boolean {
  const split = splitUri(url);
  if (!split) return false;
  const scheme = split.scheme;
  // e.g. the MWA association scheme: the host activity, not the kernel.
  if (isOsOwnedScheme(scheme)) return false;
  if (isOwnScheme(scheme)) return true;
  if (scheme === "https" || scheme === "http") {
    const host = hostnameOfHttps(url.replace(/^http:/i, "https:"));
    if (host !== VERIFIED_HOST) return false;
    const path = split.ssp.replace(/^\/\/[^/]*/, "");
    return /^\/(pay|wc|ul|dapp|link|mobilewalletadapter)(\/|\?|$)/i.test(path);
  }
  return registeredSchemes().includes(scheme);
}
