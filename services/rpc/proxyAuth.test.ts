import { describe, expect, it, beforeEach } from "vitest";
import {
  chainRpcUrl,
  isProxyUrl,
  proxyAuthHeaders,
  registerProxyOrigin,
  rpcFetchOptions,
} from "./proxyAuth";

const KEY = "rpcp_testkey";
const PROXY = "http://192.168.1.173:8787/evm/42161";
const ALCHEMY = "https://arb-mainnet.g.alchemy.com/v2/abc123";

describe("proxyAuth", () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_RPC_PROXY_API_KEY = KEY;
    // The backend feed is what tells us which origin is ours.
    registerProxyOrigin(PROXY);
  });

  it("recognises the origin the backend handed us, by origin not full URL", () => {
    expect(isProxyUrl(PROXY)).toBe(true);
    // Same origin, different chain route — still ours.
    expect(isProxyUrl("http://192.168.1.173:8787/solana/mainnet")).toBe(true);
    // Same host, different port — not ours.
    expect(isProxyUrl("http://192.168.1.173:9999/evm/1")).toBe(false);
  });

  it("attaches the bearer to the proxy", () => {
    expect(proxyAuthHeaders(PROXY)).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it("never attaches the bearer to a third-party provider", () => {
    // Load-bearing: an unexpected bearer makes Alchemy answer 401, so a blanket
    // header would break every direct-to-provider call and leak the key.
    expect(proxyAuthHeaders(ALCHEMY)).toEqual({});
    expect(proxyAuthHeaders("https://arb1.arbitrum.io/rpc")).toEqual({});
    expect(rpcFetchOptions(ALCHEMY)).toBeUndefined();
  });

  it("adds nothing when no key is configured (proxy auth disabled)", () => {
    delete process.env.EXPO_PUBLIC_RPC_PROXY_API_KEY;
    expect(proxyAuthHeaders(PROXY)).toEqual({});
    expect(rpcFetchOptions(PROXY)).toBeUndefined();
  });

  it("tolerates junk and missing urls", () => {
    expect(isProxyUrl(undefined)).toBe(false);
    expect(isProxyUrl("not-a-url")).toBe(false);
    expect(proxyAuthHeaders(undefined)).toEqual({});
  });

  it("reads the url a viem chain will actually call", () => {
    expect(chainRpcUrl({ rpcUrls: { default: { http: [PROXY] } } })).toBe(PROXY);
    expect(chainRpcUrl({} as never)).toBeUndefined();
  });

  it("wraps headers in the shape viem's http() expects", () => {
    expect(rpcFetchOptions(PROXY)).toEqual({
      fetchOptions: { headers: { Authorization: `Bearer ${KEY}` } },
    });
  });
});
