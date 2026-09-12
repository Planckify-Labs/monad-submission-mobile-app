/**
 * External-transport entry points of the bridge — deep-link spec §4.6:
 *   - `submitExternalIntent` stamps id/createdAt and the `link_provenance`
 *     annotation (S-3) and settles its promise with the terminal result,
 *   - `dispatchExternal` skips the WebView-only checks, forces
 *     `ctx.activeWallet === null` (S-4) and settles with the adapter's
 *     resolved value or error,
 *   - `submitAgentIntent`'s promise now settles (it never did before).
 *
 * Runs under `node:test` through the resolver hook; `__DEV__` is defined
 * up front because the bridge logs under it.
 */

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { ChainAdapterRegistry } from "@/services/chains/registry";
import type {
  AdapterContext,
  ChainAdapter,
  ChainRequest,
} from "@/services/chains/types";
import type { Provenance } from "@/services/deeplinks/types";
import { DappBridge, provenanceAnnotation } from "./DappBridge.ts";
import { pendingIntentsStore } from "./pendingIntents.ts";

const provenance: Provenance = {
  verification: { kind: "wc-verify", validation: "UNKNOWN", isScam: false },
  firstSeen: true,
  transport: "walletconnect",
  claimedOrigin: "https://dapp.example",
};

const wallet = {
  name: "w",
  address: "0x1111111111111111111111111111111111111111",
  balance: "0",
  source: "seed",
  type: "evm",
  namespace: "eip155" as const,
  account: null,
};

function fakeAdapter(seenCtx: AdapterContext[]): ChainAdapter {
  return {
    namespace: "eip155",
    getInjectedScript: () => "",
    async handleRequest(req: ChainRequest, ctx: AdapterContext) {
      seenCtx.push(ctx);
      if (req.method === "eth_chainId")
        return { status: "resolved", value: "0x1" };
      if (req.method === "boom")
        return { status: "error", code: -32000, message: "nope" };
      return {
        status: "needs-approval",
        intent: {
          id: req.id,
          namespace: "eip155",
          kind: "signMessage",
          origin: req.origin,
          wallet,
          payload: { message: "hi" },
          annotations: [],
          createdAt: Date.now(),
        },
      };
    },
    async executeApproval(intent) {
      return `signed:${intent.id}`;
    },
  };
}

// One bridge for the whole file, exactly like the app's singleton: every
// instance subscribes to `pendingIntentsStore.onResolve`, so a second one
// would race the first on every decision.
const bridge = new DappBridge({
  getContext: () => ({
    activeWallet: wallet,
    wallets: [wallet],
    getAccount: () => null,
  }),
  getWebView: () => null,
});

describe("DappBridge external entry", () => {
  let seen: AdapterContext[];
  beforeEach(() => {
    seen = [];
    pendingIntentsStore.__resetForTest();
    ChainAdapterRegistry.register(fakeAdapter(seen));
  });

  it("dispatchExternal resolves reads without a sheet and never exposes the active wallet", async () => {
    const r = await bridge.dispatchExternal({
      namespace: "eip155",
      method: "eth_chainId",
      params: [],
      origin: {
        url: "wc+unverified://topic1",
        displayUrl: "https://dapp.example",
      },
      via: "walletconnect",
    });
    assert.deepEqual(r, { result: "0x1" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].activeWallet, null);
  });

  it("dispatchExternal surfaces adapter errors and hard-rejects eth_sign", async () => {
    const e = await bridge.dispatchExternal({
      namespace: "eip155",
      method: "boom",
      params: [],
      origin: { url: "wc+unverified://t" },
      via: "walletconnect",
    });
    assert.deepEqual(e, { error: { code: -32000, message: "nope" } });
    const hard = await bridge.dispatchExternal({
      namespace: "eip155",
      method: "eth_sign",
      params: [],
      origin: { url: "wc+unverified://t" },
      via: "walletconnect",
    });
    assert.equal(hard.error?.code, 4200);
  });

  it("dispatchExternal enqueues a needs-approval intent carrying the provenance annotation and settles on decision", async () => {
    const p = bridge.dispatchExternal({
      namespace: "eip155",
      method: "personal_sign",
      params: [],
      origin: {
        url: "wc+unverified://topic2",
        displayUrl: "https://dapp.example",
        via: "walletconnect",
      },
      via: "walletconnect",
      id: "wc-42",
      provenance,
    });
    await new Promise((r) => setTimeout(r, 20));
    const queued = pendingIntentsStore.snapshot.find((i) => i.id === "wc-42");
    assert.ok(queued, "intent queued");
    assert.equal(queued.origin.via, "walletconnect");
    const ann = queued.annotations.find((a) => a.code === "link_provenance");
    assert.ok(ann);
    assert.equal(ann.severity, "warn");
    assert.deepEqual(ann.data, provenance);
    bridge.resolve("wc-42", { id: "wc-42", outcome: "approve" });
    assert.deepEqual(await p, { result: "signed:wc-42" });
    assert.equal(pendingIntentsStore.snapshot.length, 0);
  });

  it("submitExternalIntent stamps id/createdAt/provenance and settles on reject", async () => {
    const p = bridge.submitExternalIntent(
      {
        namespace: "eip155",
        kind: "signMessage",
        origin: { url: "link://sep7" },
        wallet,
        payload: { message: "x" },
        provenance: {
          verification: { kind: "none" },
          firstSeen: false,
          transport: "os-link",
          source: "cold",
        },
      },
      "deeplink",
    );
    await new Promise((r) => setTimeout(r, 20));
    const queued = pendingIntentsStore.snapshot[0];
    assert.ok(queued?.id);
    assert.ok(queued.createdAt > 0);
    assert.equal(queued.origin.via, "deeplink");
    assert.equal(queued.annotations[0]?.code, "link_provenance");
    assert.equal(queued.annotations[0]?.title, "Unverified sender");
    bridge.resolve(queued.id, { id: queued.id, outcome: "reject" });
    const r = await p;
    assert.equal(r.error?.code, 4001);
  });

  it("submitAgentIntent settles its promise", async () => {
    const p = bridge.submitAgentIntent({
      id: "agent-1",
      namespace: "eip155",
      kind: "signMessage",
      origin: { url: "wallet://approvals" },
      wallet,
      payload: {},
      createdAt: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 20));
    bridge.resolve("agent-1", { id: "agent-1", outcome: "approve" });
    assert.deepEqual(await p, { result: "signed:agent-1" });
  });

  it("provenanceAnnotation grades the verification tiers", () => {
    assert.equal(
      provenanceAnnotation({
        verification: { kind: "wc-verify", validation: "VALID", isScam: false },
        firstSeen: false,
        transport: "walletconnect",
      }).severity,
      "info",
    );
    assert.equal(
      provenanceAnnotation({
        verification: {
          kind: "wc-verify",
          validation: "INVALID",
          isScam: false,
        },
        firstSeen: false,
        transport: "walletconnect",
      }).severity,
      "danger",
    );
    assert.equal(
      provenanceAnnotation({
        verification: {
          kind: "wc-verify",
          validation: "UNKNOWN",
          isScam: true,
        },
        firstSeen: false,
        transport: "walletconnect",
      }).title,
      "Flagged as malicious",
    );
    assert.equal(
      provenanceAnnotation({
        verification: {
          kind: "sep7-signature",
          domain: "shop.example",
          keyPinned: true,
        },
        firstSeen: true,
        transport: "os-link",
      }).detail,
      "First time connecting to this sender.",
    );
  });
});
