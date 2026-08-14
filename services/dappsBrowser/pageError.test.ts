import { describe, expect, it } from "vitest";
import {
  classifyPageErrorKind,
  classifyPageLoadError,
  shouldIgnorePageLoadError,
} from "./pageError";

describe("classifyPageErrorKind", () => {
  it("trusts Android's description over its disagreeing code", () => {
    // The failure that prompted this module: WebViewClient reported
    // ERROR_HOST_LOOKUP (-2) while Chromium said the device was offline.
    // Classifying on the code alone would tell the user to check the
    // address for typos while their Wi-Fi is off.
    expect(
      classifyPageErrorKind({
        code: -2,
        description: "net::ERR_INTERNET_DISCONNECTED",
      }),
    ).toBe("offline");
  });

  it("maps the common Chromium net errors", () => {
    const cases: [string, string][] = [
      ["net::ERR_NAME_NOT_RESOLVED", "dns"],
      ["net::ERR_CONNECTION_REFUSED", "unreachable"],
      ["net::ERR_CONNECTION_RESET", "unreachable"],
      ["net::ERR_TIMED_OUT", "timeout"],
      ["net::ERR_CERT_AUTHORITY_INVALID", "ssl"],
      ["net::ERR_SSL_PROTOCOL_ERROR", "ssl"],
      ["net::ERR_UNKNOWN_URL_SCHEME", "blocked"],
      ["net::ERR_BLOCKED_BY_CLIENT", "blocked"],
      ["net::ERR_SOMETHING_WE_HAVE_NEVER_SEEN", "unknown"],
    ];
    for (const [description, kind] of cases) {
      expect(classifyPageErrorKind({ description })).toBe(kind);
    }
  });

  it("maps iOS NSURLErrorDomain codes", () => {
    const cases: [number, string][] = [
      [-1009, "offline"],
      [-1005, "offline"],
      [-1003, "dns"],
      [-1001, "timeout"],
      [-1004, "unreachable"],
      [-1200, "ssl"],
      [-1202, "ssl"],
      [-1002, "blocked"],
      [-4242, "unknown"],
    ];
    for (const [code, kind] of cases) {
      expect(
        classifyPageErrorKind({
          code,
          domain: "NSURLErrorDomain",
          // iOS ships a localised sentence here, which carries no token we
          // can match, so the code has to be doing the work.
          description: "The Internet connection appears to be offline.",
        }),
      ).toBe(kind);
    }
  });

  it("falls back to Android codes when no net:: token is present", () => {
    expect(classifyPageErrorKind({ code: -8, description: "" })).toBe(
      "timeout",
    );
    expect(classifyPageErrorKind({ code: -11 })).toBe("ssl");
    expect(classifyPageErrorKind({})).toBe("unknown");
  });
});

describe("shouldIgnorePageLoadError", () => {
  it("ignores loads that were abandoned rather than broken", () => {
    expect(shouldIgnorePageLoadError({ description: "net::ERR_ABORTED" })).toBe(
      true,
    );
    expect(
      shouldIgnorePageLoadError({ code: -999, domain: "NSURLErrorDomain" }),
    ).toBe(true);
    expect(
      shouldIgnorePageLoadError({ code: 102, domain: "WebKitErrorDomain" }),
    ).toBe(true);
  });

  it("does not swallow real failures", () => {
    expect(
      shouldIgnorePageLoadError({
        code: -2,
        description: "net::ERR_INTERNET_DISCONNECTED",
      }),
    ).toBe(false);
    // Same numeric code as the iOS cancel, but a different domain.
    expect(
      shouldIgnorePageLoadError({ code: 102, domain: "NSURLErrorDomain" }),
    ).toBe(false);
  });
});

describe("classifyPageLoadError", () => {
  it("never leaks platform error text into user copy", () => {
    const inputs = [
      { code: -2, description: "net::ERR_INTERNET_DISCONNECTED" },
      { code: -1200, domain: "NSURLErrorDomain", description: "TLS blew up" },
      { code: -99, description: "net::ERR_WHATEVER" },
    ];
    for (const input of inputs) {
      const copy = classifyPageLoadError(input, "app.uniswap.org");
      const text = `${copy.title} ${copy.body}`;
      expect(text).not.toMatch(/ERR_|net::|NSURL|-\d{3,}/);
      expect(text).not.toContain(String(input.code));
    }
  });

  it("names the host when we have one and stays grammatical when we do not", () => {
    expect(
      classifyPageLoadError(
        { description: "net::ERR_NAME_NOT_RESOLVED" },
        "jup.ag",
      ).body,
    ).toContain("jup.ag");
    const noHost = classifyPageLoadError({
      description: "net::ERR_NAME_NOT_RESOLVED",
    }).body;
    expect(noHost).toContain("this site");
    expect(noHost).not.toContain("undefined");
  });

  it("does not offer a one-tap retry on a certificate failure", () => {
    const copy = classifyPageLoadError({
      description: "net::ERR_CERT_AUTHORITY_INVALID",
    });
    expect(copy.canRetry).toBe(false);
    expect(copy.severity).toBe("danger");
  });

  it("only auto-retries on reconnect for offline failures", () => {
    expect(
      classifyPageLoadError({ description: "net::ERR_INTERNET_DISCONNECTED" })
        .retryOnReconnect,
    ).toBe(true);
    expect(
      classifyPageLoadError({ description: "net::ERR_CONNECTION_REFUSED" })
        .retryOnReconnect,
    ).toBe(false);
  });

  it("keeps UI copy free of em-dashes", () => {
    const descriptions = [
      "net::ERR_INTERNET_DISCONNECTED",
      "net::ERR_NAME_NOT_RESOLVED",
      "net::ERR_CONNECTION_REFUSED",
      "net::ERR_TIMED_OUT",
      "net::ERR_CERT_DATE_INVALID",
      "net::ERR_UNKNOWN_URL_SCHEME",
      "net::ERR_MYSTERY",
    ];
    for (const description of descriptions) {
      const copy = classifyPageLoadError({ description }, "example.org");
      expect(`${copy.title} ${copy.body}`).not.toContain("—");
    }
  });
});
