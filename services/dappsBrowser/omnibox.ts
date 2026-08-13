/**
 * Address-bar ("omnibox") parsing for the dApps browser.
 *
 * This module deliberately does its own parsing instead of leaning on
 * `new URL()`. React Native's `URL` is a regex shim
 * (`react-native/Libraries/Blob/URL.js`), not a WHATWG parser: it never
 * throws on malformed input, does no IDNA conversion, and returns `""`
 * for a hostname it can't match. Every `try { new URL(x) } catch {}`
 * guard written around it is therefore dead code. An address bar is the
 * one place in a wallet where "roughly parses" is not good enough, since
 * whatever it produces becomes the origin the dApp bridge grants
 * permissions against.
 *
 * Everything here is pure and RN-free so it can be unit-tested.
 */

/** Where a non-URL query goes. Single constant so the engine is swappable. */
export const SEARCH_ENGINE_URL = "https://duckduckgo.com/?q=";
export const SEARCH_ENGINE_NAME = "DuckDuckGo";

/** What the user typed, resolved into something we can act on. */
export type OmniboxIntent =
  | {
      kind: "url";
      /** Fully-qualified https URL, safe to hand to the WebView. */
      url: string;
      /** Lowercased hostname, for display and the security chip. */
      host: string;
      /** True when the user typed http:// and we upgraded to https. */
      upgraded: boolean;
      /** True when we dropped `user:pass@` credentials from the input. */
      strippedCredentials: boolean;
    }
  | { kind: "search"; query: string; url: string };

export interface ParsedUrl {
  scheme: string;
  host: string;
  port: string;
  /** Path + query + fragment, or "" when the URL is bare. */
  rest: string;
  isSecure: boolean;
  /**
   * The hostname may not read the way it renders: it holds non-ASCII
   * characters or an already-encoded `xn--` label. Both are the raw
   * material of homograph phishing (`аpp.uniswap.org` with a Cyrillic а).
   */
  isSpoofRisk: boolean;
}

/** Chip state for the icon at the left of the address bar. */
export type SecurityLevel = "none" | "secure" | "caution" | "insecure";

// Characters browsers strip before parsing a URL (tab / LF / CR and the
// rest of the C0/C1 control range), plus the invisible ones used to
// disguise a hostname: zero-width joiners, BOM, word joiner, and the
// bidi overrides behind right-to-left spoofing.
const STRIPPED_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

// `scheme://` — a hierarchical URL. Captures the scheme.
const HIERARCHICAL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

// `scheme:` with an opaque body (javascript:, data:, mailto:, about:).
// The `(?!\d)` lookahead is what keeps `jup.ag:8080` from being read as a
// scheme named "jup.ag" — dots are legal scheme characters.
const OPAQUE_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

// A DNS label: 1-63 chars of letters/digits/hyphen, never starting or
// ending with a hyphen. Non-ASCII is allowed through so IDN hosts still
// navigate; `isSpoofRisk` flags them separately rather than blocking.
const LABEL =
  "[a-z0-9\\u00a1-\\uffff](?:[a-z0-9\\u00a1-\\uffff-]{0,61}[a-z0-9\\u00a1-\\uffff])?";
// The last label (the TLD) must be alphabetic. That single rule is what
// keeps "1.5", "v2.0" and "0.01" out of the navigation path.
const HOSTNAME = new RegExp(
  `^(?:${LABEL}\\.)+[a-z\\u00a1-\\uffff]{2,63}$`,
  "i",
);

const MAX_HOST_LENGTH = 253;

interface Authority {
  host: string;
  port: string;
  rest: string;
  hadCredentials: boolean;
}

/** Strips the characters that browsers refuse to carry into a URL. */
export function sanitiseOmniboxInput(raw: string): string {
  return raw.replace(STRIPPED_CHARS, "").trim();
}

/**
 * Splits everything after `scheme://` into host / port / remainder.
 * Returns null when the authority is structurally junk.
 */
function splitAuthority(afterScheme: string): Authority | null {
  const boundary = afterScheme.search(/[/?#]/);
  let authority =
    boundary === -1 ? afterScheme : afterScheme.slice(0, boundary);
  const rest = boundary === -1 ? "" : afterScheme.slice(boundary);
  if (!authority) return null;

  // `https://uniswap.org@evil.com` is served by evil.com. Browsers strip
  // the credentials before display; so do we, so the bar can never show a
  // hostname the page is not actually served from.
  const at = authority.lastIndexOf("@");
  const hadCredentials = at !== -1;
  if (hadCredentials) authority = authority.slice(at + 1);

  let host = authority;
  let port = "";
  const withPort = authority.match(/^(.*):(\d{1,5})$/);
  if (withPort) {
    host = withPort[1];
    port = withPort[2];
  } else if (authority.includes(":")) {
    // A colon that isn't a port (an IPv6 literal, or garbage). Not a
    // shape this browser navigates to.
    return null;
  }

  host = host.toLowerCase().replace(/\.$/, "");
  if (!host) return null;

  return { host, port, rest, hadCredentials };
}

/** True when `host` is something we are willing to navigate to. */
export function isNavigableHost(host: string): boolean {
  if (!host || host.length > MAX_HOST_LENGTH) return false;
  return IPV4.test(host) || HOSTNAME.test(host);
}

/** Non-ASCII or punycode labels: the host may not read as it renders. */
export function isSpoofRiskHost(host: string): boolean {
  if (/[^\u0000-\u007f]/.test(host)) return true;
  return host.split(".").some((label) => label.startsWith("xn--"));
}

function toUrlIntent(authority: Authority, upgraded: boolean): OmniboxIntent {
  const hostPort = authority.port
    ? `${authority.host}:${authority.port}`
    : authority.host;
  return {
    kind: "url",
    url: `https://${hostPort}${authority.rest}`,
    host: authority.host,
    upgraded,
    strippedCredentials: authority.hadCredentials,
  };
}

/** The web-search URL for a query, independent of how it was classified. */
export function searchUrlFor(query: string): string {
  return `${SEARCH_ENGINE_URL}${encodeURIComponent(query)}`;
}

function toSearchIntent(query: string): OmniboxIntent {
  return { kind: "search", query, url: searchUrlFor(query) };
}

/**
 * Decides whether what the user typed is a site to open or a search to
 * run, mirroring how a phone browser's omnibox behaves.
 *
 * Returns null for empty input so callers can no-op instead of
 * navigating to an empty search.
 */
export function parseOmnibox(raw: string): OmniboxIntent | null {
  const input = sanitiseOmniboxInput(raw);
  if (!input) return null;

  const hierarchical = input.match(HIERARCHICAL_SCHEME);
  if (hierarchical) {
    const scheme = hierarchical[1].toLowerCase();
    // The WebView is https-only (`originWhitelist` + `mixedContentMode`),
    // and anything it refuses gets handed to `Linking.openURL` — so a
    // typed http:// URL used to eject the user into the system browser.
    // Upgrading here keeps them in the wallet.
    if (scheme === "https" || scheme === "http") {
      const authority = splitAuthority(input.slice(hierarchical[0].length));
      if (authority && isNavigableHost(authority.host)) {
        return toUrlIntent(authority, scheme === "http");
      }
    }
    // Every other scheme — javascript:, data:, file:, intent:, wc: — is
    // never navigated. Falling through to a search means a pasted or
    // deep-linked payload can't smuggle one past the address bar.
    return toSearchIntent(input);
  }

  if (OPAQUE_SCHEME.test(input)) return toSearchIntent(input);

  // A space means the user is searching. "jup.ag swap" is a query, not a
  // host, which is also how Chrome's omnibox reads it.
  if (/\s/.test(input)) return toSearchIntent(input);

  const authority = splitAuthority(input);
  if (authority && isNavigableHost(authority.host)) {
    return toUrlIntent(authority, false);
  }

  return toSearchIntent(input);
}

/**
 * Parses a URL the WebView has already committed to. These always carry a
 * scheme, so this is the read-side twin of `parseOmnibox`.
 */
export function parseUrl(url: string): ParsedUrl | null {
  const input = sanitiseOmniboxInput(url);
  const match = input.match(HIERARCHICAL_SCHEME);
  if (!match) return null;
  const authority = splitAuthority(input.slice(match[0].length));
  if (!authority) return null;
  const scheme = match[1].toLowerCase();
  return {
    scheme,
    host: authority.host,
    port: authority.port,
    rest: authority.rest,
    isSecure: scheme === "https",
    isSpoofRisk: isSpoofRiskHost(authority.host),
  };
}

/** Bare hostname for the collapsed address bar. "" when unparseable. */
export function displayHost(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed) return "";
  return parsed.host.replace(/^www\./, "");
}

/** Scheme + host + port, the unit permissions are granted against. */
export function originOf(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed) return "";
  const hostPort = parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host;
  return `${parsed.scheme}://${hostPort}`;
}

/** Which icon and treatment the address bar shows for `url`. */
export function securityLevel(url: string): SecurityLevel {
  if (!url) return "none";
  const parsed = parseUrl(url);
  if (!parsed) return "none";
  if (!parsed.isSecure) return "insecure";
  return parsed.isSpoofRisk ? "caution" : "secure";
}

/**
 * The URL we record in local history: origin plus path, with the query
 * and fragment dropped. Those carry session tokens, referral codes and
 * wallet addresses, none of which belong on disk or in a suggestion row.
 * Returns null for anything not worth remembering.
 */
export function toHistoryUrl(url: string): string | null {
  const parsed = parseUrl(url);
  if (!parsed || !parsed.isSecure) return null;
  const path = parsed.rest.split(/[?#]/)[0];
  const hostPort = parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host;
  return `https://${hostPort}${path === "/" ? "" : path}`;
}
