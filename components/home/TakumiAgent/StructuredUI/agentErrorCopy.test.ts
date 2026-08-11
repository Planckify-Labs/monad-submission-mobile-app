import { describe, expect, it } from "vitest";
import { agentErrorAction, agentErrorCopy } from "./agentErrorCopy";

describe("agentErrorCopy", () => {
  it("prefers the granular reason over the coarse code", () => {
    expect(agentErrorCopy("stale_precondition", "intent_expired")).toBe(
      "That plan expired. Let me prepare a fresh one.",
    );
  });

  it("falls back to the coarse code, then to the generic line", () => {
    expect(agentErrorCopy("network_error")).toMatch(/network is busy/i);
    expect(agentErrorCopy("something_unmapped")).toMatch(
      /couldn't complete that right now/i,
    );
  });

  describe("missing-wallet reasons", () => {
    // Each of these used to fall through to its coarse code and claim the
    // network was unavailable, when the chain was fine and the user just
    // held no key on it.
    it.each([
      "wallet_not_evm",
      "wallet_not_solana",
      "wallet_not_sui",
      "wallet_not_stellar",
    ])("%s does not claim the network is unavailable", (reason) => {
      const copy = agentErrorCopy("unsupported_chain", reason);
      expect(copy).not.toMatch(/isn't available on this network/i);
      expect(copy).toMatch(/add one/i);
    });

    it("wallet_cannot_execute stops rendering as an unreadable request", () => {
      // Its coarse code is `invalid_input`, so with no entry it produced
      // "I couldn't read that request" for a missing signer.
      const copy = agentErrorCopy("invalid_input", "wallet_cannot_execute");
      expect(copy).not.toMatch(/couldn't read that request/i);
      expect(copy).toMatch(/can't sign/i);
    });
  });

  describe("interpolated route reasons", () => {
    // The capability facades build these by embedding the namespace, so
    // they can never match an exact key.
    it.each([
      "no native send route for namespace solana",
      "no token send route for namespace sui",
      "no route for namespace stellar",
    ])("%s resolves to shared copy, not the fallback", (reason) => {
      const copy = agentErrorCopy("unsupported_chain", reason);
      expect(copy).toMatch(/switch chains/i);
    });

    it("does not swallow an unrelated reason that merely mentions a route", () => {
      expect(agentErrorCopy("invalid_input", "no_swap_route")).toMatch(
        /couldn't find a swap route/i,
      );
    });
  });
});

describe("agentErrorAction", () => {
  it("offers the wallet named by the reason", () => {
    expect(agentErrorAction("unsupported_chain", "wallet_not_sui")).toEqual({
      kind: "add_wallet",
      namespace: "sui",
    });
  });

  it("uses the caller's destination namespace when the reason omits it", () => {
    expect(
      agentErrorAction(
        "invalid_input",
        "no_wallet_on_destination_chain",
        "solana",
      ),
    ).toEqual({ kind: "add_wallet", namespace: "solana" });
  });

  it("offers nothing when the destination chain is unknown", () => {
    // Better no button than one pointing at a guessed chain.
    expect(
      agentErrorAction("invalid_input", "no_wallet_on_destination_chain"),
    ).toBeNull();
  });

  it("offers nothing for failures a new wallet wouldn't fix", () => {
    expect(agentErrorAction("network_error")).toBeNull();
    expect(agentErrorAction("stale_precondition", "quote_stale")).toBeNull();
    // Ambiguous between watch-only and missing, so we don't guess a chain.
    expect(
      agentErrorAction("invalid_input", "wallet_cannot_execute"),
    ).toBeNull();
  });
});
