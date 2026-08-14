import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storage } from "@/lib/storage/mmkv";
import {
  chainRpcUrl,
  isProxyUrl,
  proxyAuthHeaders,
  registerProxyOrigin,
  rpcFetchOptions,
} from "./proxyAuth";
import { __resetProxyTokensForTest, ensureProxyToken } from "./proxyToken";

const KEY = "rpcd_testtoken";
const PROXY = "http://192.168.1.173:8787/evm/42161";
const PROXY_ORIGIN = "http://192.168.1.173:8787";
const ALCHEMY = "https://arb-mainnet.g.alchemy.com/v2/abc123";

/** Stands in for `POST {origin}/token`. */
function mockMint(token = KEY, expiresIn = 604800) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ token, expiresIn }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("proxyAuth", () => {
  beforeEach(async () => {
    __resetProxyTokensForTest();
    storage.clearAll();
    mockMint();
    // The backend feed is what tells us which origin is ours. Registering also
    // kicks off the mint, so awaiting it here mirrors the steady state the app
    // reaches a moment after boot.
    registerProxyOrigin(PROXY);
    await ensureProxyToken(PROXY_ORIGIN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognises the origin the backend handed us, by origin not full URL", () => {
    expect(isProxyUrl(PROXY)).toBe(true);
    // Same origin, different chain route — still ours.
    expect(isProxyUrl("http://192.168.1.173:8787/solana/mainnet")).toBe(true);
    // Same host, different port — not ours.
    expect(isProxyUrl("http://192.168.1.173:9999/evm/1")).toBe(false);
  });

  it("attaches the minted token to the proxy", () => {
    expect(proxyAuthHeaders(PROXY)).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it("never attaches the bearer to a third-party provider", () => {
    // Load-bearing: an unexpected bearer makes Alchemy answer 401, so a blanket
    // header would break every direct-to-provider call and leak the key.
    expect(proxyAuthHeaders(ALCHEMY)).toEqual({});
    expect(proxyAuthHeaders("https://arb1.arbitrum.io/rpc")).toEqual({});
    expect(rpcFetchOptions(ALCHEMY)).toBeUndefined();
  });

  it("adds nothing before a token has been minted", () => {
    // The window on a fresh install between learning the origin and the mint
    // landing. Requests go out unauthenticated and the proxy answers 401,
    // which is recoverable; attaching a stale or invented bearer would not be.
    __resetProxyTokensForTest();
    storage.clearAll();
    expect(proxyAuthHeaders(PROXY)).toEqual({});
    expect(rpcFetchOptions(PROXY)).toBeUndefined();
  });

  it("stops presenting a token once it has expired", async () => {
    __resetProxyTokensForTest();
    storage.clearAll();
    mockMint("rpcd_expired", -1);
    await ensureProxyToken(PROXY_ORIGIN);
    expect(proxyAuthHeaders(PROXY)).toEqual({});
  });

  it("survives a restart by rehydrating the token from storage", async () => {
    // Only the in-memory map is cleared, as on a cold start. Rehydration has
    // to be synchronous: `proxyAuthHeaders` is called from transport
    // constructors that cannot await, so an async-only cache would hand out
    // empty headers for the first RPC calls of every launch.
    __resetProxyTokensForTest();
    expect(proxyAuthHeaders(PROXY)).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it("mints once when several chains register the same origin at boot", async () => {
    __resetProxyTokensForTest();
    storage.clearAll();
    const fetchMock = mockMint();
    // EVM, Solana and Sui all resolve from the same `/blockchains` feed.
    await Promise.all([
      ensureProxyToken(PROXY_ORIGIN),
      ensureProxyToken(PROXY_ORIGIN),
      ensureProxyToken(PROXY_ORIGIN),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not throw when minting fails", async () => {
    __resetProxyTokensForTest();
    storage.clearAll();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream exploded", { status: 500 })),
    );
    await expect(ensureProxyToken(PROXY_ORIGIN)).resolves.toBeUndefined();
    expect(proxyAuthHeaders(PROXY)).toEqual({});
  });

  it("tolerates junk and missing urls", () => {
    expect(isProxyUrl(undefined)).toBe(false);
    expect(isProxyUrl("not-a-url")).toBe(false);
    expect(proxyAuthHeaders(undefined)).toEqual({});
  });

  it("reads the url a viem chain will actually call", () => {
    expect(chainRpcUrl({ rpcUrls: { default: { http: [PROXY] } } })).toBe(
      PROXY,
    );
    expect(chainRpcUrl({} as never)).toBeUndefined();
  });

  it("wraps headers in the shape viem's http() expects", () => {
    expect(rpcFetchOptions(PROXY)).toEqual({
      fetchOptions: { headers: { Authorization: `Bearer ${KEY}` } },
    });
  });
});

// ---------------------------------------------------------------------
// 2026-08-12 — the dApp bridge read through an unauthenticated transport
// and every proxied read came back 401. Locally-answered methods
// (`eth_chainId`) hid it, so connecting and signing looked fine while
// contract deployment and NFT minting failed: ethers polls
// `eth_blockNumber`, `eth_estimateGas` and `eth_getTransactionReceipt`
// around a deploy, and all three went to the proxy.
//
// Asserted structurally because the defect was a *missing* call at a
// transport construction site, and no behavioural test of the adapter
// would have caught a header that was never attached.
// ---------------------------------------------------------------------
describe("every RPC transport attaches proxy auth", () => {
  const repoRoot = join(__dirname, "..", "..");
  const sites: Array<[string, string]> = [
    // The dApp bridge's own EVM clients — the ones that produced the 401.
    ["services/chains/evm/EvmAdapter.ts", "proxyAuthHeaders"],
    // Pre-sign simulation on both EVM approval sheets.
    [
      "components/dapps-browser/approvals/EvmTransactionSheet.tsx",
      "rpcFetchOptions",
    ],
    [
      "components/dapps-browser/approvals/EvmBatchCallsSheet.tsx",
      "rpcFetchOptions",
    ],
    // Non-EVM adapters build their own transports and had the same gap.
    ["services/chains/stellar/horizonClient.ts", "proxyAuthHeaders"],
    ["services/chains/stellar/sorobanRpcClient.ts", "proxyAuthHeaders"],
    ["services/rpc/solanaRpcPool.ts", "proxyAuthHeaders"],
    ["services/bridge/boot.ts", "proxyAuthHeaders"],
  ];

  it.each(sites)("%s routes headers through proxyAuth", (rel, symbol) => {
    const src = readFileSync(join(repoRoot, rel), "utf8");
    expect(src).toContain(symbol);
  });

  it("still refuses to send the bearer to an unregistered origin", () => {
    // The reason this is origin-gated rather than a blanket header: a
    // provider that receives an unexpected bearer rejects the request
    // (Alchemy answers 401), and our token would land in third-party
    // logs. A dApp-added custom RPC must never receive it.
    expect(proxyAuthHeaders("https://mainnet.infura.io/v3/abc")).toEqual({});
    expect(proxyAuthHeaders("https://api.mainnet-beta.solana.com")).toEqual({});
    expect(proxyAuthHeaders(undefined)).toEqual({});
  });
});
