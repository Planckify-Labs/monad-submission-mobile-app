function djb2Hex(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  // second-pass scramble for better distribution without a real hash lib
  let g = 0;
  for (let i = input.length - 1; i >= 0; i--) {
    g = ((g << 7) ^ input.charCodeAt(i)) | 0;
  }
  return (
    (h >>> 0).toString(16).padStart(8, "0") +
    (g >>> 0).toString(16).padStart(8, "0")
  );
}

// No `new URL` here. React Native's `URL` is a regex shim whose
// `hostname` / `host` only match `https?://` — every other scheme reads
// back as an empty host, which would collapse all transport-prefixed
// origin keys (`wc+https://…`, `mwa+unverified://…`, deep-link spec §4.9)
// into one grant bucket on device while passing under Node. Explicit
// parsing keeps the same output for http(s) and defined output for the
// rest (`feedback_rn_url_is_regex_shim`).
const AUTHORITY_RE =
  /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?([^:/?#]+)(?::(\d+))?/i;

/**
 * Origin keys produced by `services/deeplinks/originKey.ts` carry a
 * transport prefix and are already canonical; they are returned verbatim
 * so the pairing topic / package segment is never normalised away.
 */
const TRANSPORT_KEY_RE = /^(wc|mwa|ul|sep7)\+[a-z]+:\/\//i;

export function originKey(url: string): string {
  if (TRANSPORT_KEY_RE.test(url)) return url;
  const m = AUTHORITY_RE.exec(url);
  if (!m) return url.toLowerCase();
  const scheme = m[1].toLowerCase();
  const host = m[2].toLowerCase().replace(/\.$/, "");
  const port = m[3] ? `:${m[3]}` : "";
  return `${scheme}://${host}${port}`;
}

export function hashOrigin(url: string): string {
  return djb2Hex(originKey(url));
}

export function originHost(url: string): string {
  const m = AUTHORITY_RE.exec(url);
  if (!m) return url.toLowerCase();
  return m[2].toLowerCase().replace(/\.$/, "");
}

export function caip2(namespace: string, reference: string | number): string {
  return `${namespace}:${reference}`;
}

export function caip10(
  namespace: string,
  reference: string | number,
  address: string,
): string {
  return `${namespace}:${reference}:${address}`;
}
