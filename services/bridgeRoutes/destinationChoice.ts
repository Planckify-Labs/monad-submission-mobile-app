/**
 * The destination wallet the USER explicitly picked for a bridge.
 *
 * Spec: docs/bridge-capability-spec.md §7.4.
 *
 * A cross-namespace bridge lands at an address the user has never seen in
 * this context (Base → Solana is a different address from the same seed),
 * so `BridgeQuoteCard` lets them change it via the wallet switcher. That
 * choice has to outlive the card render, because the thing that eventually
 * SIGNS is a separate `bridge_execute` tool call whose arguments come from
 * the MODEL, not from the card. Without a record of the choice, this
 * happens:
 *
 *   1. card re-quotes locally and shows the NEW address
 *   2. the already-pending `bridge_execute` still carries the OLD one
 *   3. its approval summary renders no address at all, so the mismatch is
 *      invisible
 *   4. Approve → funds land in the wrong wallet
 *
 * So this store is a SAFETY INTERLOCK, not a convenience cache:
 *
 *   - `bridge_quote` uses the choice as its destination default.
 *   - `bridge_execute` FAILS CLOSED (`stale_precondition`) when its
 *     `to_address` disagrees with the choice, so a stale destination is
 *     re-quoted rather than signed.
 *   - `BridgeProgressCard` hides the approval gate on a call whose
 *     `to_address` disagrees, so the stale approval can't even be tapped.
 *
 * Deliberately IN-MEMORY and NOT persisted: it is scoped to the bridge the
 * user is looking at right now. Surviving an app restart would turn a
 * one-off pick into a silent standing override of the auto-resolved
 * destination, which is the opposite of the intent. Cleared once the
 * bridge it was chosen for actually executes.
 *
 * Keyed by destination CAIP-2: a bridge is identified for this purpose by
 * where it lands, and two concurrent bridges to the SAME chain with
 * different destination wallets is not a real flow.
 */

type Listener = () => void;

/**
 * What the user actually accepted on the re-priced card.
 *
 * The address alone is not enough. Changing the destination re-prices the
 * WHOLE route — minimum received, fees, slippage, even the provider — so
 * the protection number the user approved against belongs to the same
 * decision as the address they picked. Carrying only the address would
 * leave `bridge_execute` enforcing a floor from the pre-switch quote:
 * either failing a transfer the user already accepted, or guaranteeing
 * less than the figure printed on the card they read.
 */
export interface BridgeDestinationChoice {
  address: string;
  /**
   * `toAmountMinRaw` of the quote the user saw, in the DESTINATION
   * token's smallest units. Absent when the pick was recorded without a
   * successful re-price (the card shows no number to honour in that case).
   */
  minReceiveRaw?: string;
}

const choices = new Map<string, BridgeDestinationChoice>();
const listeners = new Set<Listener>();

/**
 * Bumped on every mutation. `useSyncExternalStore` needs a snapshot that is
 * referentially stable between emits — returning a fresh object (or a
 * `Map`) would loop forever, so subscribers read this counter and then
 * pull the value they care about with `getChosenDestination`.
 */
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      // One broken subscriber must not stop the rest from being notified.
      if (__DEV__) {
        console.warn(`[destinationChoice] listener threw: ${String(err)}`);
      }
    }
  }
}

export const bridgeDestinationChoice = {
  /**
   * Record the wallet the user picked for bridges landing on `toChain`.
   *
   * Called the moment they tap a wallet, BEFORE the re-price returns, so
   * the interlock is armed even if the network is slow or the re-quote
   * fails — a pick must never be silently ignored just because pricing it
   * did not finish.
   */
  set(toChain: string, address: string): void {
    const existing = choices.get(toChain);
    if (existing?.address === address && existing.minReceiveRaw === undefined) {
      return;
    }
    // A new address invalidates any protection number carried from the
    // previous pick — that figure belonged to a different route.
    choices.set(toChain, { address });
    emit();
  },

  /**
   * Attach the minimum-received figure once the re-price lands, so the
   * number the user reads is the number `bridge_execute` enforces.
   *
   * Ignored if the pick has moved on in the meantime: a re-quote that
   * resolves after the user has already switched again belongs to an
   * abandoned route, and letting it land would enforce a floor for a
   * destination nobody is looking at (the classic async race).
   */
  setMinReceive(toChain: string, address: string, minReceiveRaw: string): void {
    const existing = choices.get(toChain);
    if (!existing || existing.address !== address) return;
    if (existing.minReceiveRaw === minReceiveRaw) return;
    choices.set(toChain, { address, minReceiveRaw });
    emit();
  },

  /** The user's explicit pick for `toChain`, or `null` if they never chose. */
  get(toChain: string | undefined): string | null {
    if (!toChain) return null;
    return choices.get(toChain)?.address ?? null;
  },

  /** The full pick, including the protection number it was made against. */
  getChoice(toChain: string | undefined): BridgeDestinationChoice | null {
    if (!toChain) return null;
    return choices.get(toChain) ?? null;
  },

  /**
   * Drop the choice once the bridge it was made for has been submitted.
   *
   * Without this the interlock would outlive its bridge: a LATER bridge to
   * the same chain would be measured against a stale pick and could fail
   * closed against a perfectly good auto-resolved address.
   */
  clear(toChain: string | undefined): void {
    if (!toChain) return;
    if (!choices.delete(toChain)) return;
    emit();
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** Referentially stable between mutations — safe for useSyncExternalStore. */
  getVersion(): number {
    return version;
  },

  /** Test-only: drop all state and subscribers. */
  __resetForTests(): void {
    choices.clear();
    listeners.clear();
    version = 0;
  },
};
