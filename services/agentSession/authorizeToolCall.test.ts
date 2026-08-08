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

/**
 * The known-destination envelope (§4.0 extension).
 *
 * A grant answers "may the agent act unattended?", never "do I accept
 * THIS destination?". Without this, a user who granted Full auto had no
 * protection against value being pointed at an address they had never
 * seen — and for a cross-namespace bridge that address is one the wallet
 * derives, not one the user ever typed.
 */
describe("authorizeToolCall — known-destination envelope", () => {
  /** Full-auto wallet: everything below would otherwise be `authorized`. */
  function fullAutoWallet(): ConnectedWallet {
    const w = hotWallet();
    w.grantStore.add({
      scope: { kind: "global" },
      lifetime: { type: "permanent" },
      wallet_address: WALLET,
      granted_at: Date.now(),
    });
    return w;
  }

  const sendArgs = {
    toolName: "send_native_token",
    input: { to: "0xdeadbeef" },
    walletNamespace: "eip155" as const,
  };

  /**
   * SCOPE: the envelope only ever narrows the `authorized` case. With no
   * grant the call already asks, so there is nothing to escalate and the
   * behaviour must be byte-identical to before this feature existed —
   * same decision, and NOT flagged as an escalation (it wasn't one).
   *
   * This is what keeps the feature honest: it can only ever turn Auto
   * into Ask, never Ask into Auto, and never touches the default path a
   * user without permissions is on.
   */
  it("leaves the no-grant path untouched — still a plain ask", () => {
    const r = authorize(hotWallet(), {
      ...sendArgs,
      isCounterpartyConfirmed: () => false,
    });
    assert.equal(r.decision, "ask");
    assert.equal(r.treatment, "ask");
    assert.equal(r.escalated, undefined, "a normal ask is not an escalation");
  });

  it("does not consult the confirmation store at all without a grant", () => {
    let consulted = 0;
    authorize(hotWallet(), {
      ...sendArgs,
      isCounterpartyConfirmed: () => {
        consulted += 1;
        return false;
      },
    });
    assert.equal(
      consulted,
      0,
      "no-grant path short-circuits before the envelope",
    );
  });

  it("escalates an authorized write to ask for an unconfirmed destination", () => {
    const r = authorize(fullAutoWallet(), {
      ...sendArgs,
      isCounterpartyConfirmed: () => false,
    });
    assert.equal(r.decision, "ask");
    assert.equal(r.treatment, "ask");
    assert.equal(r.escalated, "unknown_counterparty");
    assert.equal(r.counterparty?.address, "0xdeadbeef");
  });

  it("lets a confirmed destination through on the normal run-down", () => {
    const r = authorize(fullAutoWallet(), {
      ...sendArgs,
      isCounterpartyConfirmed: () => true,
    });
    assert.equal(r.decision, "authorized");
    assert.equal(r.treatment, "rundown");
    assert.equal(r.escalated, undefined);
  });

  // Escalation must never LOOSEN anything: a denied call stays denied.
  it("does not resurrect a denied call", () => {
    const w = watchOnlyWallet();
    const r = authorize(w, {
      ...sendArgs,
      isCounterpartyConfirmed: () => false,
    });
    assert.equal(r.decision, "deny");
  });

  it("fails closed to deny when headless and the destination is unknown", () => {
    const r = authorize(fullAutoWallet(), {
      ...sendArgs,
      interactive: false,
      isCounterpartyConfirmed: () => false,
    });
    assert.equal(r.decision, "deny");
    assert.equal(r.reason, "approval_unavailable");
  });

  // A store that throws must not read as "confirmed" — that would turn a
  // storage bug into silent authorization.
  it("treats a throwing lookup as unconfirmed", () => {
    const r = authorize(fullAutoWallet(), {
      ...sendArgs,
      isCounterpartyConfirmed: () => {
        throw new Error("mmkv exploded");
      },
    });
    assert.equal(r.decision, "ask");
    assert.equal(r.escalated, "unknown_counterparty");
  });

  it("does not apply to reads", () => {
    const r = authorize(fullAutoWallet(), {
      capability: "read",
      toolName: "get_balance",
      input: { to: "0xdeadbeef" },
      walletNamespace: "eip155",
      isCounterpartyConfirmed: () => false,
    });
    assert.equal(r.decision, "authorized");
    assert.equal(r.treatment, "silent");
  });

  // Exempt tools (protocol contracts, x402 allowance, first-party rails)
  // have no user-supplied counterparty to vet.
  it("does not escalate a tool with no counterparty", () => {
    const r = authorize(fullAutoWallet(), {
      toolName: "defi_deposit",
      input: { to: "0xdeadbeef" },
      walletNamespace: "eip155",
      isCounterpartyConfirmed: () => false,
    });
    assert.equal(r.decision, "authorized");
    assert.equal(r.treatment, "rundown");
  });

  // Backwards compatibility: callers that don't opt in behave exactly as
  // before, so the envelope can't silently change an untouched path.
  it("is inert when no confirmation check is supplied", () => {
    const r = authorize(fullAutoWallet(), sendArgs);
    assert.equal(r.decision, "authorized");
    assert.equal(r.treatment, "rundown");
  });

  it("is inert when the destination argument is absent", () => {
    const r = authorize(fullAutoWallet(), {
      toolName: "send_native_token",
      walletNamespace: "eip155",
      isCounterpartyConfirmed: () => false,
    });
    assert.equal(r.decision, "authorized");
  });

  it("takes a bridge destination's namespace from its to_chain", () => {
    const seen: string[] = [];
    authorize(fullAutoWallet(), {
      toolName: "bridge_execute",
      input: {
        to_address: "9YTiQ3",
        to_chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      },
      walletNamespace: "eip155",
      isCounterpartyConfirmed: (cp) => {
        seen.push(cp.namespace);
        return true;
      },
    });
    assert.deepEqual(seen, ["solana"]);
  });
});
