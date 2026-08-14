/**
 * Turns a WebView load failure into hand-written copy for the browser's
 * error page.
 *
 * `react-native-webview`'s built-in `defaultRenderError` paints the raw
 * platform triple on screen ("Domain: undefined / Error Code: -2 /
 * Description: net::ERR_INTERNET_DISCONNECTED"). That is exactly the
 * machine-shaped string CLAUDE.md forbids showing a user, and it is also
 * not what a production browser does: Chrome and Safari collapse dozens
 * of network error codes into a handful of human situations (you are
 * offline, the site cannot be found, the connection is not private) with
 * one clear recovery action. This module is that collapse step.
 *
 * The raw code/description never leaves here. Callers log it behind
 * `__DEV__` and render only the returned copy.
 *
 * Platform note: the two OSes disagree on both fields, so neither alone
 * is enough.
 *   - Android reports Chromium's `net::ERR_*` name in `description`
 *     while `code` is a coarse `WebViewClient.ERROR_*` constant that
 *     routinely disagrees with it (the offline screenshot that prompted
 *     this file was code `-2` = ERROR_HOST_LOOKUP with description
 *     `net::ERR_INTERNET_DISCONNECTED`). Description wins there.
 *   - iOS reports `NSURLErrorDomain` numeric codes with a localised,
 *     untranslatable-by-us description. Domain + code wins there.
 */

export type PageErrorKind =
  | "offline"
  | "dns"
  | "unreachable"
  | "timeout"
  | "ssl"
  | "blocked"
  | "unknown";

export type PageLoadErrorInput = {
  /** Platform error code. Android: WebViewClient.ERROR_*; iOS: NSURLError*. */
  code?: number;
  /** Android: "net::ERR_*". iOS: a localised sentence. Never shown to users. */
  description?: string;
  /** iOS: "NSURLErrorDomain" / "WebKitErrorDomain". Android: often absent. */
  domain?: string;
};

export type PageErrorCopy = {
  kind: PageErrorKind;
  /** Short headline. Hand-written, no interpolated platform text. */
  title: string;
  /** One or two sentences of advice. May contain the host we were loading. */
  body: string;
  /** False when retrying cannot help or should not be one tap away. */
  canRetry: boolean;
  /**
   * "danger" swaps the page to the security-interstitial treatment and
   * makes "Go back" the primary action, mirroring how browsers refuse to
   * make bypassing a certificate error the path of least resistance.
   */
  severity: "info" | "danger";
  /**
   * True when the failure is purely "no network". Browsers auto-reload
   * these once connectivity returns; we approximate that by retrying when
   * the user comes back to the app.
   */
  retryOnReconnect: boolean;
};

// iOS NSURLErrorDomain codes we care about.
const NSURL_NOT_CONNECTED = -1009;
const NSURL_TIMED_OUT = -1001;
const NSURL_CANNOT_FIND_HOST = -1003;
const NSURL_CANNOT_CONNECT_TO_HOST = -1004;
const NSURL_NETWORK_CONNECTION_LOST = -1005;
const NSURL_DNS_LOOKUP_FAILED = -1006;
const NSURL_BAD_URL = -1000;
const NSURL_UNSUPPORTED_URL = -1002;
const NSURL_CANCELLED = -999;
const NSURL_SECURE_CONNECTION_FAILED = -1200;
const NSURL_SERVER_CERT_UNTRUSTED = -1202;
const NSURL_SERVER_CERT_EXPIRED = -1203;
const NSURL_SERVER_CERT_INVALID = -1204;
const NSURL_CLIENT_CERT_REJECTED = -1205;

// WebKitErrorDomain 102 = "frame load interrupted by policy change", which
// is what iOS reports for a navigation we ourselves declined in
// `onShouldStartLoadWithRequest`. Not a failure the user should see.
const WEBKIT_FRAME_LOAD_INTERRUPTED = 102;

/**
 * Loads that were deliberately abandoned, not broken. A redirect landing
 * while the previous request is still in flight, a fast second tap, or our
 * own origin whitelist rejecting a navigation all surface here. Browsers
 * show nothing for these; if we painted an error page the user would see
 * a failure screen flash over a page that is loading perfectly well.
 */
export function shouldIgnorePageLoadError({
  code,
  description,
  domain,
}: PageLoadErrorInput): boolean {
  const desc = (description ?? "").toUpperCase();
  if (desc.includes("ERR_ABORTED")) return true;
  if (desc.includes("CANCELLED") || desc.includes("CANCELED")) return true;
  if (code === NSURL_CANCELLED) return true;
  if (
    domain === "WebKitErrorDomain" &&
    code === WEBKIT_FRAME_LOAD_INTERRUPTED
  ) {
    return true;
  }
  return false;
}

function kindFromDescription(description: string): PageErrorKind | null {
  const d = description.toUpperCase();
  if (!d.includes("ERR_")) return null;

  if (d.includes("ERR_INTERNET_DISCONNECTED") || d.includes("ERR_NETWORK_IO")) {
    return "offline";
  }
  if (
    d.includes("ERR_NAME_NOT_RESOLVED") ||
    d.includes("ERR_NAME_RESOLUTION_FAILED") ||
    d.includes("ERR_DNS")
  ) {
    return "dns";
  }
  if (d.includes("ERR_TIMED_OUT") || d.includes("ERR_TIMEOUT")) {
    return "timeout";
  }
  if (
    d.includes("ERR_CERT") ||
    d.includes("ERR_SSL") ||
    d.includes("ERR_BAD_SSL")
  ) {
    return "ssl";
  }
  if (
    d.includes("ERR_BLOCKED_BY") ||
    d.includes("ERR_UNSAFE") ||
    d.includes("ERR_UNKNOWN_URL_SCHEME") ||
    d.includes("ERR_DISALLOWED_URL_SCHEME")
  ) {
    return "blocked";
  }
  if (
    d.includes("ERR_CONNECTION") ||
    d.includes("ERR_ADDRESS_UNREACHABLE") ||
    d.includes("ERR_EMPTY_RESPONSE") ||
    d.includes("ERR_PROXY") ||
    d.includes("ERR_TUNNEL")
  ) {
    return "unreachable";
  }
  return "unknown";
}

function kindFromIosCode(code: number): PageErrorKind {
  switch (code) {
    case NSURL_NOT_CONNECTED:
    case NSURL_NETWORK_CONNECTION_LOST:
      return "offline";
    case NSURL_CANNOT_FIND_HOST:
    case NSURL_DNS_LOOKUP_FAILED:
      return "dns";
    case NSURL_TIMED_OUT:
      return "timeout";
    case NSURL_CANNOT_CONNECT_TO_HOST:
      return "unreachable";
    case NSURL_SECURE_CONNECTION_FAILED:
    case NSURL_SERVER_CERT_UNTRUSTED:
    case NSURL_SERVER_CERT_EXPIRED:
    case NSURL_SERVER_CERT_INVALID:
    case NSURL_CLIENT_CERT_REJECTED:
      return "ssl";
    case NSURL_BAD_URL:
    case NSURL_UNSUPPORTED_URL:
      return "blocked";
    default:
      return "unknown";
  }
}

// Android WebViewClient.ERROR_* constants. Only consulted when the
// description carried no `net::ERR_*` token, because Android's code and
// description disagree often enough that the code is the weaker signal.
function kindFromAndroidCode(code: number): PageErrorKind {
  switch (code) {
    case -2: // ERROR_HOST_LOOKUP
      return "dns";
    case -6: // ERROR_CONNECT
    case -7: // ERROR_IO
      return "unreachable";
    case -8: // ERROR_TIMEOUT
      return "timeout";
    case -11: // ERROR_FAILED_SSL_HANDSHAKE
      return "ssl";
    case -10: // ERROR_UNSUPPORTED_SCHEME
    case -12: // ERROR_BAD_URL
    case -16: // ERROR_UNSAFE_RESOURCE
      return "blocked";
    default:
      return "unknown";
  }
}

export function classifyPageErrorKind(
  input: PageLoadErrorInput,
): PageErrorKind {
  const fromDescription = kindFromDescription(input.description ?? "");
  if (fromDescription) return fromDescription;

  if (typeof input.code === "number") {
    return input.domain?.startsWith("NSURL")
      ? kindFromIosCode(input.code)
      : kindFromAndroidCode(input.code);
  }
  return "unknown";
}

/**
 * `host` is the bare hostname we were trying to reach ("app.uniswap.org").
 * It is our own parse of the URL the user navigated to, not platform error
 * text, so it is safe to show.
 */
export function classifyPageLoadError(
  input: PageLoadErrorInput,
  host?: string,
): PageErrorCopy {
  const kind = classifyPageErrorKind(input);
  // "this site" keeps every sentence grammatical when we could not parse a
  // host, instead of leaving a hole or printing "undefined".
  const site = host && host.length > 0 ? host : "this site";

  switch (kind) {
    case "offline":
      return {
        kind,
        title: "You are offline",
        body: "Check your Wi-Fi or mobile data, then try again.",
        canRetry: true,
        severity: "info",
        retryOnReconnect: true,
      };
    case "dns":
      return {
        kind,
        title: "Site not found",
        body: `We could not find ${site}. Check the address for a typo, or the site may no longer exist.`,
        canRetry: true,
        severity: "info",
        retryOnReconnect: false,
      };
    case "unreachable":
      return {
        kind,
        title: "Site did not respond",
        body: `${site} refused the connection. It may be down right now.`,
        canRetry: true,
        severity: "info",
        retryOnReconnect: false,
      };
    case "timeout":
      return {
        kind,
        title: "Taking too long",
        body: `${site} did not respond in time. Your connection may be slow.`,
        canRetry: true,
        severity: "info",
        retryOnReconnect: false,
      };
    case "ssl":
      return {
        kind,
        title: "Connection is not private",
        body: `We could not verify the security certificate for ${site}, so the page was blocked. Someone may be trying to intercept it.`,
        // Retrying an untrusted certificate just re-fails, and offering it as
        // the obvious action trains people to tap through security warnings.
        canRetry: false,
        severity: "danger",
        retryOnReconnect: false,
      };
    case "blocked":
      return {
        kind,
        title: "Page blocked",
        body: `${site} tried to open something this browser does not allow. Only secure https pages can load here.`,
        canRetry: false,
        severity: "danger",
        retryOnReconnect: false,
      };
    default:
      return {
        kind: "unknown",
        title: "Page did not load",
        body: `Something went wrong while loading ${site}. Please try again.`,
        canRetry: true,
        severity: "info",
        retryOnReconnect: false,
      };
  }
}
