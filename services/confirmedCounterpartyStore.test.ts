import { beforeEach, describe, expect, it } from "vitest";
import { confirmedCounterpartyStore } from "./confirmedCounterpartyStore";

const WALLET = "0x1111111111111111111111111111111111111111";
const EXTERNAL = "0x2222222222222222222222222222222222222222";
const MY_SOLANA = "9YTiQ3afuodm26rhUqzaUsnk2ryyEhXdJ3gXX2beELij";
const MY_OTHER_SOLANA = "EYAdZY7Kq4TFuNs2ZQY6kMbVmXpNyF3aVQjmDcJ8SujWu8";

describe("confirmedCounterpartyStore", () => {
  beforeEach(() => {
    confirmedCounterpartyStore.__resetForTests(WALLET);
  });

  it("reports nothing confirmed on a fresh wallet", () => {
    expect(
      confirmedCounterpartyStore.isConfirmed(WALLET, "eip155", EXTERNAL),
    ).toBe(false);
    expect(confirmedCounterpartyStore.list(WALLET)).toEqual([]);
  });

  it("records and reports a confirmation", () => {
    confirmedCounterpartyStore.confirm(WALLET, {
      address: EXTERNAL,
      namespace: "eip155",
      tool_name: "send_native_token",
    });
    expect(
      confirmedCounterpartyStore.isConfirmed(WALLET, "eip155", EXTERNAL),
    ).toBe(true);
    expect(confirmedCounterpartyStore.list(WALLET)).toHaveLength(1);
  });

  it("scopes confirmations per wallet", () => {
    const other = "0x9999999999999999999999999999999999999999";
    confirmedCounterpartyStore.__resetForTests(other);
    confirmedCounterpartyStore.confirm(WALLET, {
      address: EXTERNAL,
      namespace: "eip155",
    });
    expect(
      confirmedCounterpartyStore.isConfirmed(other, "eip155", EXTERNAL),
    ).toBe(false);
  });

  it("does not confirm the same address under a different namespace", () => {
    confirmedCounterpartyStore.confirm(WALLET, {
      address: EXTERNAL,
      namespace: "eip155",
    });
    expect(
      confirmedCounterpartyStore.isConfirmed(WALLET, "sui", EXTERNAL),
    ).toBe(false);
  });

  it("re-confirming does not duplicate the entry", () => {
    confirmedCounterpartyStore.confirm(WALLET, {
      address: EXTERNAL,
      namespace: "eip155",
    });
    confirmedCounterpartyStore.confirm(WALLET, {
      address: EXTERNAL,
      namespace: "eip155",
    });
    expect(confirmedCounterpartyStore.list(WALLET)).toHaveLength(1);
  });

  it("revoking makes the address unknown again", () => {
    confirmedCounterpartyStore.confirm(WALLET, {
      address: EXTERNAL,
      namespace: "eip155",
    });
    confirmedCounterpartyStore.revoke(WALLET, "eip155", EXTERNAL);
    expect(
      confirmedCounterpartyStore.isConfirmed(WALLET, "eip155", EXTERNAL),
    ).toBe(false);
  });

  it("notifies subscribers when the list changes", () => {
    let calls = 0;
    confirmedCounterpartyStore.subscribe(() => {
      calls += 1;
    });
    confirmedCounterpartyStore.confirm(WALLET, {
      address: EXTERNAL,
      namespace: "eip155",
    });
    expect(calls).toBe(1);
  });
});

/**
 * `mostRecentFor` is what turns the envelope from pure friction into a
 * default: the first bridge to a chain asks the user to pick, and that
 * pick then serves every later bridge to the same chain with no prompt.
 */
describe("confirmedCounterpartyStore.mostRecentFor", () => {
  beforeEach(() => {
    confirmedCounterpartyStore.__resetForTests(WALLET);
  });

  it("returns null before anything has been established", () => {
    expect(
      confirmedCounterpartyStore.mostRecentFor(WALLET, "solana"),
    ).toBeNull();
  });

  it("returns the established destination for that namespace", () => {
    confirmedCounterpartyStore.confirm(WALLET, {
      address: MY_SOLANA,
      namespace: "solana",
    });
    expect(
      confirmedCounterpartyStore.mostRecentFor(WALLET, "solana")?.address,
    ).toBe(MY_SOLANA);
  });

  // Switching destination is a deliberate act that costs an approval, so
  // the one the user moved to LAST is the one they meant.
  it("prefers the most recently established when several exist", () => {
    confirmedCounterpartyStore.confirm(WALLET, {
      address: MY_SOLANA,
      namespace: "solana",
      confirmed_at: 1_000,
    });
    confirmedCounterpartyStore.confirm(WALLET, {
      address: MY_OTHER_SOLANA,
      namespace: "solana",
      confirmed_at: 2_000,
    });
    expect(
      confirmedCounterpartyStore.mostRecentFor(WALLET, "solana")?.address,
    ).toBe(MY_OTHER_SOLANA);
  });

  it("never leaks a destination from another namespace", () => {
    confirmedCounterpartyStore.confirm(WALLET, {
      address: EXTERNAL,
      namespace: "eip155",
    });
    expect(
      confirmedCounterpartyStore.mostRecentFor(WALLET, "solana"),
    ).toBeNull();
  });

  it("stops defaulting once the destination is revoked", () => {
    confirmedCounterpartyStore.confirm(WALLET, {
      address: MY_SOLANA,
      namespace: "solana",
    });
    confirmedCounterpartyStore.revoke(WALLET, "solana", MY_SOLANA);
    expect(
      confirmedCounterpartyStore.mostRecentFor(WALLET, "solana"),
    ).toBeNull();
  });
});
