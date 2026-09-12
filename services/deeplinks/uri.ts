/**
 * Strict, dependency-free URI splitter — spec §4.3 (F5).
 *
 * React Native's `URL` is a regex shim: it never throws, has no IDNA, and
 * exposes `hostname` / `pathname` / `searchParams` unreliably for
 * non-http schemes such as `ethereum:`, `solana:` or `web+stellar:`
 * (memory `feedback_rn_url_is_regex_shim`). Every deep-link handler
 * therefore parses through this module instead. `new URL()` is used
 * nowhere in the kernel; the universal-link path handlers use their own
 * explicit `https:` splitting via `splitHttpsUrl` below.
 *
 * Pure module: no React, no Expo, no native imports.
 */

/** RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ). */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

export interface SplitUri {
  /** Lower-cased scheme without the trailing colon. */
  scheme: string;
  /**
   * Scheme-specific part — everything between `scheme:` and the first
   * `?` / `#`. Leading `//` is preserved so handlers can distinguish
   * `wc:topic@2` from `takumiwallet://send`.
   */
  ssp: string;
  /** Parsed query. Keys are case-sensitive, decoding is per-component. */
  query: URLSearchParams;
  /** Raw query string (no leading `?`), for byte-exact re-use (SEP-0007). */
  rawQuery: string;
  /** Fragment without the leading `#`, or `null` when absent. */
  fragment: string | null;
}

/**
 * Split any URI into scheme / scheme-specific-part / query / fragment.
 * Returns `null` when the input has no valid scheme prefix.
 */
export function splitUri(raw: string): SplitUri | null {
  if (typeof raw !== "string") return null;
  const m = SCHEME_RE.exec(raw);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  let rest = raw.slice(m[0].length);

  let fragment: string | null = null;
  const hashIdx = rest.indexOf("#");
  if (hashIdx !== -1) {
    fragment = rest.slice(hashIdx + 1);
    rest = rest.slice(0, hashIdx);
  }

  let rawQuery = "";
  const qIdx = rest.indexOf("?");
  if (qIdx !== -1) {
    rawQuery = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
  }

  let query: URLSearchParams;
  try {
    query = new URLSearchParams(rawQuery);
  } catch {
    query = new URLSearchParams();
  }

  return { scheme, ssp: rest, query, rawQuery, fragment };
}

/**
 * `true` for an absolute `https://` URL with a non-empty ASCII host.
 * Explicit — no `new URL`.
 */
export function isAbsoluteHttpsUrl(s: string): boolean {
  return hostnameOfHttps(s) !== null;
}

const HTTPS_AUTHORITY_RE = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i;
const ASCII_HOST_RE =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * Hostname of an `https://` URL, lower-cased, or `null` when the input is
 * not an absolute https URL or the host is not plain ASCII (IDN hosts
 * must go through `inspectUrl` from `idnHomograph.ts` first). Userinfo
 * (`user:pass@`) is refused outright — it is only ever used to disguise
 * a host.
 */
export function hostnameOfHttps(s: string): string | null {
  if (typeof s !== "string") return null;
  const m = HTTPS_AUTHORITY_RE.exec(s);
  if (!m) return null;
  const authority = m[1];
  if (authority.includes("@")) return null;
  // Strip an explicit port.
  const host = authority.replace(/:\d{1,5}$/, "");
  if (!ASCII_HOST_RE.test(host)) return null;
  return host.toLowerCase().replace(/\.$/, "");
}

export interface SplitHttpsUrl {
  host: string;
  /** Always starts with `/`. Percent-encoding is preserved. */
  pathname: string;
  query: URLSearchParams;
  rawQuery: string;
  fragment: string | null;
}

/**
 * Explicit splitter for our own `https://takumipay.xyz/...` links. The
 * path handlers under `services/deeplinks/paths/` are the only callers.
 */
export function splitHttpsUrl(raw: string): SplitHttpsUrl | null {
  const host = hostnameOfHttps(raw);
  if (!host) return null;
  const split = splitUri(raw);
  if (!split) return null;
  // ssp = `//host[:port]/path`
  const afterSlashes = split.ssp.slice(2);
  const slash = afterSlashes.indexOf("/");
  const pathname = slash === -1 ? "/" : afterSlashes.slice(slash);
  return {
    host,
    pathname,
    query: split.query,
    rawQuery: split.rawQuery,
    fragment: split.fragment,
  };
}

/**
 * `decodeURIComponent` that never throws: a malformed escape yields
 * `null` so callers can reject the link as `malformed` instead of
 * crashing on attacker-controlled input.
 */
export function safeDecodeComponent(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Percent-decode that also treats `+` as space (form encoding). */
export function safeDecodeFormComponent(s: string): string | null {
  return safeDecodeComponent(s.replace(/\+/g, " "));
}

/**
 * Case-sensitive query lookup that tolerates a key being present without
 * a value (`?amount`), which `URLSearchParams` maps to `""`.
 */
export function queryFirst(query: URLSearchParams, key: string): string | null {
  const v = query.get(key);
  return v === null ? null : v;
}

/** Every value for a repeatable key, in order (Solana Pay `reference`). */
export function queryAll(query: URLSearchParams, key: string): string[] {
  return query.getAll(key);
}
