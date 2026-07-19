/**
 * Unit tests for `authorizeToolCall` — the single authorization gate
 * (deny-layer spec §6.1). Run under Node's `node:test` with type
 * stripping (same harness as the other agent tests):
 *
 *   node --test --experimental-strip-types \
 *       --import ./services/walletKit/evm/_test-resolver.mjs \
 *       services/agentSession/authorizeToolCall.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type GrantStorageAdapter,
  PermissionGrantStore,
} from "../permissionGrantStore.ts";
import {
  type ConnectedWallet,
  HOT_WALLET_POLICY,
  WATCH_ONLY_POLICY,
} from "../resolveUxTreatment.ts";
import { authorizeToolCall } from "./authorizeToolCall.ts";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const SESSION_ID = "session-authz";

function memAdapter(): GrantStorageAdapter {
  const map = new Map<string, string>();
  return {
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => {
      map.set(k, v);
    },
    deleteItem: async (k) => {
      map.delete(k);
    },
  };
}

function hotWallet(): ConnectedWallet {
  return {
    address: WALLET,
    approvalPolicy: HOT_WALLET_POLICY,
    grantStore: PermissionGrantStore.conservative(WALLET, memAdapter()),
  };
}

function watchOnlyWallet(): ConnectedWallet {
  return {
    address: WALLET,
    approvalPolicy: WATCH_ONLY_POLICY,
    grantStore: PermissionGrantStore.conservative(WALLET, memAdapter()),
  };
}

function authorize(
  wallet: ConnectedWallet,
  overrides: Partial<Parameters<typeof authorizeToolCall>[0]> = {},
) {
  return authorizeToolCall({
    capability: "write",
    toolName: "send_native_token",
    wallet,
    sessionId: SESSION_ID,
    interactive: true,
    ...overrides,
  });
}

describe("authorizeToolCall — decision matrix", () => {
  it("read → authorized + silent", () => {
    const r = authorize(hotWallet(), {
      capability: "read",
      toolName: "get_balance",
    });
    assert.equal(r.decision, "authorized");
    assert.equal(r.treatment, "silent");
  });

  it("write with no grant (HOT policy) → ask", () => {
    const r = authorize(hotWallet());
    assert.equal(r.decision, "ask");
    assert.equal(r.treatment, "ask");
  });

  it("authorized write shows a RUN-DOWN, never silent (§D-1)", () => {
    const w = hotWallet();
    w.grantStore.add({
      scope: { kind: "global" },
      lifetime: { type: "permanent" }, // Full auto
      wallet_address: WALLET,
      granted_at: Date.now(),
    });
    const r = authorize(w);
    assert.equal(r.decision, "authorized");
    assert.equal(r.treatment, "rundown");
  });

  it("watch-only write → deny(watch_only)", () => {
    const r = authorize(watchOnlyWallet());
    assert.equal(r.decision, "deny");
    assert.equal(r.reason, "watch_only");
  });

  it("headless + would-be-ask write → deny(approval_unavailable)", () => {
    const r = authorize(hotWallet(), { interactive: false });
    assert.equal(r.decision, "deny");
    assert.equal(r.reason, "approval_unavailable");
  });

  it("headless authorized write still runs (down) — not denied", () => {
    const w = hotWallet();
    w.grantStore.add({
      scope: { kind: "global" },
      lifetime: { type: "permanent" },
      wallet_address: WALLET,
      granted_at: Date.now(),
    });
    const r = authorize(w, { interactive: false });
    assert.equal(r.decision, "authorized");
    assert.equal(r.treatment, "rundown");
  });

  it("deliberately-silent override (x402) stays silent when authorized", () => {
    const r = authorize(hotWallet(), { toolName: "x402_fetch" });
    // x402_fetch is a HOT_WALLET_POLICY tool_override → silent.
    assert.equal(r.decision, "authorized");
    assert.equal(r.treatment, "silent");
  });
});

describe("authorizeToolCall — the Never rule (deny-overrides-allow)", () => {
  it("tool → Never forces deny(policy_denied)", () => {
    const w = hotWallet();
    w.grantStore.add({
      scope: { kind: "tool", key: "send_native_token" },
      lifetime: { type: "always_deny" },
      wallet_address: WALLET,
      granted_at: Date.now(),
    });
    const r = authorize(w);
    assert.equal(r.decision, "deny");
    assert.equal(r.reason, "policy_denied");
  });

  it("Write → Never beats a per-tool Auto grant (un-bypassable)", () => {
    const w = hotWallet();
    // Per-tool Auto…
    w.grantStore.add({
      scope: { kind: "tool", key: "send_native_token" },
      lifetime: { type: "permanent" },
      wallet_address: WALLET,
      granted_at: Date.now(),
    });
    // …but Write capability is blocked.
    w.grantStore.add({
      scope: { kind: "capability", key: "write" },
      lifetime: { type: "always_deny" },
      wallet_address: WALLET,
      granted_at: Date.now(),
    });
    const r = authorize(w);
    assert.equal(r.decision, "deny", "deny-overrides-allow");
    assert.equal(r.reason, "policy_denied");
  });
});

describe("authorizeToolCall — write-capability cross-check (fund safety)", () => {
  it("known-write tool labeled read on the wire is NOT run silently", () => {
    // A tampered / drifted stream claims `send_token` (a real write) is a
    // read. Without the cross-check this would authorize+silent (no card).
    const r = authorize(hotWallet(), {
      capability: "read",
      toolName: "send_token",
    });
    // Coerced to write → with a HOT wallet and no grant that means `ask`.
    assert.equal(r.decision, "ask");
    assert.equal(r.treatment, "ask");
  });

  it("known-write labeled read still honors an active write grant (rundown, not silent)", () => {
    const w = hotWallet();
    w.grantStore.add({
      scope: { kind: "global" },
      lifetime: { type: "permanent" },
      wallet_address: WALLET,
      granted_at: Date.now(),
    });
    const r = authorize(w, { capability: "read", toolName: "send_native" });
    // Authorized because the user pre-granted — but a WRITE, so run-down, not
    // the silent path a mislabeled "read" would have taken.
    assert.equal(r.decision, "authorized");
    assert.equal(r.treatment, "rundown");
  });

  it("a genuine read tool is unaffected by the cross-check", () => {
    const r = authorize(hotWallet(), {
      capability: "read",
      toolName: "get_balance",
    });
    assert.equal(r.decision, "authorized");
    assert.equal(r.treatment, "silent");
  });
});

describe("authorizeToolCall — INV-1", () => {
  it("treatment 'rundown' is only ever produced for an authorized decision", () => {
    // Sweep the representative cases; rundown ⟹ authorized must hold.
    const cases = [
      authorize(hotWallet()), // ask
      authorize(watchOnlyWallet()), // deny
      authorize(hotWallet(), { interactive: false }), // deny
      authorize(hotWallet(), { capability: "read", toolName: "get_balance" }),
    ];
    for (const r of cases) {
      if (r.treatment === "rundown") {
        assert.equal(r.decision, "authorized");
      }
    }
  });

  it("always mints a token", () => {
    assert.ok(authorize(hotWallet()).token, "ask path mints a token");
    assert.ok(authorize(watchOnlyWallet()).token, "deny path mints a token");
  });
});
