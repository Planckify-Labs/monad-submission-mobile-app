import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
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
