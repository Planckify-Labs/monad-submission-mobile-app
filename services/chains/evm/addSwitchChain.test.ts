/**
 * Unit tests for the EIP-3085 (`wallet_addEthereumChain`) and EIP-3326
 * (`wallet_switchEthereumChain`) handler branches.
 *
 * Invariant under test (see docs/design-notes/chain-switch-ux.md):
 *   - A chain present in the backend `/blockchains` feed is first-class:
 *     add → no-op success (no sheet, no dApp-RPC persisted); switch → the
 *     chain is "known" and never 4902.
 *   - A chain absent from the feed and not user-added is unknown: add →
 *     approval sheet (custom network); switch → 4902 so the dApp calls
 *     addEthereumChain first.
 *   - Switching to the already-active chain is a null no-op.
 *
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *     --import ./services/walletKit/evm/_test-resolver.mjs \
 *     services/chains/evm/addSwitchChain.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Chain } from "viem";
import type { ApprovalIntent } from "../../bridge/approval.ts";
import type { AdapterContext, ChainRequest } from "../types.ts";
import { UserChainStore } from "./chainStore.ts";
import { createEvmAdapter } from "./EvmAdapter.ts";
import { OriginChainStore } from "./originChainStore.ts";

function chain(id: number, name: string): { chain: Chain; rpcUrl: string } {
  const c = {
    id,
    name,
    nativeCurrency: {
      name,
      symbol: name.slice(0, 3).toUpperCase(),
      decimals: 18,
    },
    rpcUrls: { default: { http: [`https://project-rpc.example/${id}`] } },
  } as unknown as Chain;
  return { chain: c, rpcUrl: `https://project-rpc.example/${id}` };
}

const CTX: AdapterContext = {
  activeWallet: null,
  wallets: [],
  getAccount: () => null,
};

function req(method: string, params: unknown): ChainRequest {
  return {
    namespace: "eip155",
    method,
    params,
    origin: { url: "https://app.aave.com" },
    id: "1",
  };
}

// Active chain = Polygon(137). Feed supports mainnet(1) + Polygon(137).
function makeAdapter() {
  return createEvmAdapter({
    resolveChainConfig: () => chain(137, "Polygon"),
    resolveDefaultChain: () => chain(137, "Polygon"),
    resolveSupportedChain: (id) =>
      id === 1
        ? chain(1, "Ethereum")
        : id === 137
          ? chain(137, "Polygon")
          : null,
  });
}

const ETH_ADD_PARAMS = {
  chainId: "0x1",
  chainName: "Ethereum",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://eth.merkle.io"],
  blockExplorerUrls: ["https://etherscan.io"],
};

describe("wallet_addEthereumChain", () => {
  it("no-ops (null) for a chain already in the backend feed", async () => {
    const a = makeAdapter();
    const r = await a.handleRequest(
      req("wallet_addEthereumChain", [ETH_ADD_PARAMS]),
      CTX,
    );
    assert.equal(r.status, "resolved");
    assert.equal((r as { value: unknown }).value, null);
  });

  it("routes an unregistered chain to an approval sheet", async () => {
    const a = makeAdapter();
    const custom = {
      ...ETH_ADD_PARAMS,
      chainId: "0x14a34",
      chainName: "Base Sepolia",
    };
    const r = await a.handleRequest(
      req("wallet_addEthereumChain", [custom]),
      CTX,
    );
    assert.equal(r.status, "needs-approval");
    assert.equal((r as { intent: { kind: string } }).intent.kind, "addChain");
  });

  it("rejects malformed params with invalid-params", async () => {
    const a = makeAdapter();
    const r = await a.handleRequest(
      req("wallet_addEthereumChain", [{ chainId: "0x1" }]),
      CTX,
    );
    assert.equal(r.status, "error");
    assert.equal((r as { code: number }).code, -32602);
  });
});

describe("wallet_switchEthereumChain", () => {
  it("returns 4902 for a chain unknown to the wallet", async () => {
    const a = makeAdapter();
    const r = await a.handleRequest(
      req("wallet_switchEthereumChain", [{ chainId: "0xabc123" }]),
      CTX,
    );
    assert.equal(r.status, "error");
    assert.equal((r as { code: number }).code, 4902);
  });

  it("prompts approval when switching to a supported, non-active chain", async () => {
    const a = makeAdapter();
    const r = await a.handleRequest(
      req("wallet_switchEthereumChain", [{ chainId: "0x1" }]),
      CTX,
    );
    assert.equal(r.status, "needs-approval");
    const intent = (
      r as { intent: { kind: string; payload: { chainId: number } } }
    ).intent;
    assert.equal(intent.kind, "switchChain");
    assert.equal(intent.payload.chainId, 1);
  });

  it("no-ops (null) when the target is already the active chain", async () => {
    const a = makeAdapter();
    const r = await a.handleRequest(
      req("wallet_switchEthereumChain", [{ chainId: "0x89" }]),
      CTX,
    );
    assert.equal(r.status, "resolved");
    assert.equal((r as { value: unknown }).value, null);
  });

  it("rejects a non-hex chainId with invalid-params", async () => {
    const a = makeAdapter();
    const r = await a.handleRequest(
      req("wallet_switchEthereumChain", [{ chainId: 1 }]),
      CTX,
    );
    assert.equal(r.status, "error");
    assert.equal((r as { code: number }).code, -32602);
  });
});

describe("custom-chain scoping (per-origin)", () => {
  const ORIGIN_A = "https://app.aave.com";
  const ORIGIN_B = "https://evil.example";
  const CUSTOM_ID = 84532; // 0x14a34, absent from the feed {1,137}

  async function seedCustom() {
    await UserChainStore.add({
      chainId: CUSTOM_ID,
      chainName: "Base Sepolia",
      origin: ORIGIN_A,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://sepolia.base.org"],
      addedAt: Date.now(),
    });
  }

  it("switch to a custom chain is known only to the origin that added it", async () => {
    await seedCustom();
    const a = makeAdapter();

    const same = await a.handleRequest(
      {
        ...req("wallet_switchEthereumChain", [{ chainId: "0x14a34" }]),
        origin: { url: ORIGIN_A },
      },
      CTX,
    );
    assert.equal(same.status, "needs-approval");
    const intent = (
      same as {
        intent: { payload: { toIsCustom?: boolean; toChainName?: string } };
      }
    ).intent;
    assert.equal(intent.payload.toIsCustom, true);
    assert.equal(intent.payload.toChainName, "Base Sepolia");

    const other = await a.handleRequest(
      {
        ...req("wallet_switchEthereumChain", [{ chainId: "0x14a34" }]),
        origin: { url: ORIGIN_B },
      },
      CTX,
    );
    assert.equal(other.status, "error");
    assert.equal((other as { code: number }).code, 4902);

    await UserChainStore.remove(CUSTOM_ID);
  });
});

describe("execSwitchChain (Phase 2: per-origin, no home mutation)", () => {
  const ORIGIN = "https://app.aave.com";

  function switchIntent(chainId: number): ApprovalIntent {
    return {
      id: "s1",
      namespace: "eip155",
      kind: "switchChain",
      origin: { url: ORIGIN },
      wallet: null,
      payload: { chainId },
      annotations: [],
      createdAt: Date.now(),
    };
  }

  it("records a registered switch as the origin's selection (no probe, no home change)", async () => {
    const a = makeAdapter();
    const out = await a.executeApproval(
      switchIntent(1),
      { id: "s1", outcome: "approve" },
      CTX,
    );
    assert.equal(out, null);
    assert.equal(OriginChainStore.getSelected(ORIGIN), 1);
    OriginChainStore.clearSelected(ORIGIN);
  });

  it("throws 4902 for a custom chain whose RPC is unreachable (reachability gate)", async () => {
    // Unreachable RPC → probe fails → switch fails cleanly, no selection set.
    await UserChainStore.add({
      chainId: 987654,
      chainName: "Dead Net",
      origin: ORIGIN,
      nativeCurrency: { name: "Dead", symbol: "DED", decimals: 18 },
      rpcUrls: ["http://127.0.0.1:1/rpc"],
      addedAt: Date.now(),
    });
    const a = makeAdapter();
    await assert.rejects(
      () =>
        a.executeApproval(
          switchIntent(987654),
          { id: "s1", outcome: "approve" },
          CTX,
        ),
      (e: unknown) => (e as { code?: number }).code === 4902,
    );
    assert.equal(OriginChainStore.getSelected(ORIGIN), null);
    await UserChainStore.remove(987654);
  });
});
