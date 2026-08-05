/**
 * CAIP parsing + the registry seam.
 *
 * Spec: docs/bridge-capability-spec.md §5.1, §5.2.
 *
 * These are the pure parts — no wallet kits, no network. The
 * kit-dependent constructors (`chainToCaip2`, `assetToCaip19`) are
 * exercised through the registry so the space-docking contract is
 * verified rather than assumed.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  assetContractFromCaip19,
  chainOfAsset,
  parseCaip2,
  parseCaip19,
} from "./caip";
import {
  getBridgeAdapter,
  listBridgeAdapters,
  registerBridgeAdapter,
  resetBridgeAdapters,
  resolveBridgeAdapters,
} from "./registry";
import type { BridgeRouteAdapter } from "./types";

describe("parseCaip2", () => {
  it("parses an EVM chain id", () => {
    expect(parseCaip2("eip155:8453")).toEqual({
      namespace: "eip155",
      reference: "8453",
    });
  });

  it("parses NON-NUMERIC references, which the old @IsInt() DTO could not", () => {
    expect(parseCaip2("sui:mainnet")).toEqual({
      namespace: "sui",
      reference: "mainnet",
    });
    // CAIP-28 says `pubnet`, NOT `mainnet` — this is the one namespace
    // where the wire reference diverges from our internal network name.
    expect(parseCaip2("stellar:pubnet")).toEqual({
      namespace: "stellar",
      reference: "pubnet",
    });
    expect(parseCaip2("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toEqual({
      namespace: "solana",
      reference: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    });
  });

  it("rejects malformed ids", () => {
    expect(parseCaip2("eip155")).toBeNull();
    expect(parseCaip2("")).toBeNull();
    expect(parseCaip2("EIP155:1")).toBeNull();
  });
});

describe("parseCaip19", () => {
  it("parses an ERC-20 asset", () => {
    expect(
      parseCaip19(
        "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      ),
    ).toEqual({
      chain: "eip155:8453",
      chainNamespace: "eip155",
      chainReference: "8453",
      assetNamespace: "erc20",
      assetReference: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    });
  });

  it("parses a Sui coin type, colons and all", () => {
    const parsed = parseCaip19("sui:mainnet/coin:0x2::sui::SUI");
    expect(parsed?.assetNamespace).toBe("coin");
    expect(parsed?.assetReference).toBe("0x2::sui::SUI");
  });

  it("parses a Stellar classic asset without folding case", () => {
    const asset =
      "stellar:pubnet/asset:USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const parsed = parseCaip19(asset);
    expect(parsed?.assetNamespace).toBe("asset");
    // Strkeys are case-SIGNIFICANT; the parser must not touch them.
    expect(parsed?.assetReference).toBe(
      "USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    );
  });

  it("rejects an asset namespace that breaks the CAIP-19 grammar", () => {
    // `asset_namespace` is `[-a-z0-9]{3,8}` per the CAIP-19 spec, so the
    // descriptive `credit_alphanum4` (underscore, 15 chars) is NOT legal.
    // Accepting it would let us emit ids that fail their own spec.
    expect(parseCaip19("stellar:pubnet/credit_alphanum4:USDC-GA5Z")).toBeNull();
  });

  it("parses a parameterless native asset", () => {
    const parsed = parseCaip19("stellar:pubnet/native");
    expect(parsed?.assetNamespace).toBe("native");
    expect(parsed?.assetReference).toBe("");
  });

  it("recovers the owning chain", () => {
    expect(chainOfAsset("eip155:1/slip44:60")).toBe("eip155:1");
    expect(chainOfAsset("nonsense")).toBeNull();
  });
});

describe("assetContractFromCaip19", () => {
  it("returns null for native assets across namespaces", () => {
    expect(assetContractFromCaip19("eip155:1/slip44:60")).toBeNull();
    expect(
      assetContractFromCaip19(
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501",
      ),
    ).toBeNull();
    expect(assetContractFromCaip19("stellar:pubnet/native")).toBeNull();
    // Sui models its gas token as an ordinary coin type, so the asset
    // namespace alone cannot tell us it is native.
    expect(
      assetContractFromCaip19("sui:mainnet/coin:0x2::sui::SUI"),
    ).toBeNull();
  });

  it("returns the chain-native identifier verbatim for non-native assets", () => {
    expect(
      assetContractFromCaip19(
        "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      ),
    ).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");

    // Base58 is case-SENSITIVE — a folded mint is a different, valid
    // looking key that points at nothing.
    const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    expect(
      assetContractFromCaip19(
        `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:${mint}`,
      ),
    ).toBe(mint);
  });
});

describe("bridge adapter registry (§5.2 seam)", () => {
  const makeAdapter = (
    key: string,
    supports: (from: string, to: string) => boolean,
  ): BridgeRouteAdapter =>
    ({
      key,
      supports,
      toProviderChainId: () => null,
      toProviderAsset: () => null,
      quote: async () => ({ routable: false, reason: "no_route_found" }),
      execute: async () => {
        throw new Error("not used");
      },
      status: async () => ({ outcome: null, phase: "pending_source" }),
      checkDestinationReadiness: async () => [],
    }) as unknown as BridgeRouteAdapter;

  beforeEach(() => {
    resetBridgeAdapters();
  });

  it("registers and looks up by key", () => {
    registerBridgeAdapter(makeAdapter("lifi", () => true));
    expect(getBridgeAdapter("lifi")?.key).toBe("lifi");
    expect(getBridgeAdapter("nope")).toBeNull();
    expect(listBridgeAdapters()).toHaveLength(1);
  });

  it("resolves a route through supports() with NO central switch", () => {
    // The generalist misses Stellar; the Stellar-only adapter covers
    // exactly what it cannot. That non-overlap is the §10.5 decision.
    // Mirrors the real adapter: LI.FI has no Stellar path AT ALL, so it
    // must reject Stellar on EITHER side, not just as a destination.
    registerBridgeAdapter(
      makeAdapter(
        "lifi",
        (from, to) =>
          !from.startsWith("stellar:") && !to.startsWith("stellar:"),
      ),
    );
    registerBridgeAdapter(
      makeAdapter(
        "cctp",
        (from, to) => to.startsWith("stellar:") && from.startsWith("eip155:"),
      ),
    );

    expect(
      resolveBridgeAdapters("eip155:8453", "eip155:42161").map((a) => a.key),
    ).toEqual(["lifi"]);
    expect(
      resolveBridgeAdapters("eip155:8453", "stellar:pubnet").map((a) => a.key),
    ).toEqual(["cctp"]);
    // Stellar as a SOURCE is unsupported on purpose: the Soroban burn
    // layout is unverified, so it reports a capability boundary (§7.6)
    // rather than a broken path.
    expect(resolveBridgeAdapters("stellar:pubnet", "eip155:8453")).toHaveLength(
      0,
    );
  });

  it("adding a provider needs no edit to the resolver", () => {
    registerBridgeAdapter(makeAdapter("lifi", () => false));
    expect(resolveBridgeAdapters("bip122:x", "eip155:1")).toHaveLength(0);
    registerBridgeAdapter(
      makeAdapter("btc", (from) => from.startsWith("bip122:")),
    );
    expect(
      resolveBridgeAdapters("bip122:x", "eip155:1").map((a) => a.key),
    ).toEqual(["btc"]);
  });
});
