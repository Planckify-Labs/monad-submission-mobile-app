import { beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeDestinationChoice } from "./destinationChoice";

const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const WALLET_A = "9YTiQ3afuodm26rhUqzaUsnk2ryyEhXdJ3gXX2beELij";
const WALLET_B = "EYAdZY7Kq4TFuNs2ZQY6kMbVmXpNyF3aVQjmDcJ8SujWu8";

describe("bridgeDestinationChoice", () => {
  beforeEach(() => {
    bridgeDestinationChoice.__resetForTests();
  });

  it("returns null before the user has picked anything", () => {
    expect(bridgeDestinationChoice.get(SOLANA)).toBeNull();
    expect(bridgeDestinationChoice.getChoice(SOLANA)).toBeNull();
  });

  it("records and returns the user's pick per destination chain", () => {
    bridgeDestinationChoice.set(SOLANA, WALLET_A);
    expect(bridgeDestinationChoice.get(SOLANA)).toBe(WALLET_A);
    // Scoped to the chain it was chosen for.
    expect(bridgeDestinationChoice.get("sui:mainnet")).toBeNull();
  });

  it("treats a later pick as the current one", () => {
    bridgeDestinationChoice.set(SOLANA, WALLET_A);
    bridgeDestinationChoice.set(SOLANA, WALLET_B);
    expect(bridgeDestinationChoice.get(SOLANA)).toBe(WALLET_B);
  });

  it("is null-safe for an unknown / missing chain", () => {
    expect(bridgeDestinationChoice.get(undefined)).toBeNull();
    expect(() => bridgeDestinationChoice.clear(undefined)).not.toThrow();
  });

  // The interlock must not outlive its bridge: a later bridge to the same
  // chain would otherwise be measured against a stale pick and fail closed
  // on a perfectly good auto-resolved address.
  it("clears the pick once its bridge has been submitted", () => {
    bridgeDestinationChoice.set(SOLANA, WALLET_A);
    bridgeDestinationChoice.clear(SOLANA);
    expect(bridgeDestinationChoice.get(SOLANA)).toBeNull();
  });

  /**
   * Changing destination re-prices the whole route, so the protection
   * number the user approved against belongs to the same decision as the
   * address. Without this binding `bridge_execute` falls back to the
   * model's argument, which still carries the PRE-switch floor: either
   * rejecting a transfer the user already accepted, or guaranteeing less
   * than the figure printed on the card they read.
   */
  describe("minimum-received binding", () => {
    it("has no floor until the re-price lands", () => {
      bridgeDestinationChoice.set(SOLANA, WALLET_A);
      expect(
        bridgeDestinationChoice.getChoice(SOLANA)?.minReceiveRaw,
      ).toBeUndefined();
    });

    it("binds the floor to the pick it was priced for", () => {
      bridgeDestinationChoice.set(SOLANA, WALLET_A);
      bridgeDestinationChoice.setMinReceive(SOLANA, WALLET_A, "4807815");
      expect(bridgeDestinationChoice.getChoice(SOLANA)).toEqual({
        address: WALLET_A,
        minReceiveRaw: "4807815",
      });
    });

    // The classic async race: the user switches again while the first
    // re-quote is still in flight. Letting the late reply land would
    // enforce a floor for a destination nobody is looking at.
    it("ignores a floor from a superseded pick", () => {
      bridgeDestinationChoice.set(SOLANA, WALLET_A);
      bridgeDestinationChoice.set(SOLANA, WALLET_B);
      bridgeDestinationChoice.setMinReceive(SOLANA, WALLET_A, "4807815");
      expect(bridgeDestinationChoice.getChoice(SOLANA)).toEqual({
        address: WALLET_B,
      });
    });

    // A new address invalidates the previous route's number outright —
    // carrying it over would guarantee an amount from a different quote.
    it("drops the floor when the pick moves to another wallet", () => {
      bridgeDestinationChoice.set(SOLANA, WALLET_A);
      bridgeDestinationChoice.setMinReceive(SOLANA, WALLET_A, "4807815");
      bridgeDestinationChoice.set(SOLANA, WALLET_B);
      expect(
        bridgeDestinationChoice.getChoice(SOLANA)?.minReceiveRaw,
      ).toBeUndefined();
    });

    it("ignores a floor for a chain with no pick at all", () => {
      bridgeDestinationChoice.setMinReceive(SOLANA, WALLET_A, "4807815");
      expect(bridgeDestinationChoice.getChoice(SOLANA)).toBeNull();
    });

    it("clears the floor along with the pick", () => {
      bridgeDestinationChoice.set(SOLANA, WALLET_A);
      bridgeDestinationChoice.setMinReceive(SOLANA, WALLET_A, "4807815");
      bridgeDestinationChoice.clear(SOLANA);
      expect(bridgeDestinationChoice.getChoice(SOLANA)).toBeNull();
    });
  });

  describe("subscription", () => {
    it("notifies subscribers and advances the version on a real change", () => {
      const listener = vi.fn();
      bridgeDestinationChoice.subscribe(listener);
      const before = bridgeDestinationChoice.getVersion();

      bridgeDestinationChoice.set(SOLANA, WALLET_A);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(bridgeDestinationChoice.getVersion()).toBeGreaterThan(before);
    });

    // useSyncExternalStore re-renders on every version bump, so a no-op
    // write must stay silent or a card would re-render on each render.
    it("stays silent when the pick is unchanged", () => {
      bridgeDestinationChoice.set(SOLANA, WALLET_A);
      const listener = vi.fn();
      bridgeDestinationChoice.subscribe(listener);
      const before = bridgeDestinationChoice.getVersion();

      bridgeDestinationChoice.set(SOLANA, WALLET_A);

      expect(listener).not.toHaveBeenCalled();
      expect(bridgeDestinationChoice.getVersion()).toBe(before);
    });

    it("stays silent when clearing a chain that was never chosen", () => {
      const listener = vi.fn();
      bridgeDestinationChoice.subscribe(listener);

      bridgeDestinationChoice.clear(SOLANA);

      expect(listener).not.toHaveBeenCalled();
    });

    it("stops notifying after unsubscribe", () => {
      const listener = vi.fn();
      const unsubscribe = bridgeDestinationChoice.subscribe(listener);
      unsubscribe();

      bridgeDestinationChoice.set(SOLANA, WALLET_A);

      expect(listener).not.toHaveBeenCalled();
    });

    it("keeps notifying the remaining subscribers when one throws", () => {
      const healthy = vi.fn();
      bridgeDestinationChoice.subscribe(() => {
        throw new Error("boom");
      });
      bridgeDestinationChoice.subscribe(healthy);

      expect(() => bridgeDestinationChoice.set(SOLANA, WALLET_A)).not.toThrow();
      expect(healthy).toHaveBeenCalledTimes(1);
    });
  });
});
