/**
 * Counterparties the user has EXPLICITLY confirmed for a wallet.
 *
 * Deny-layer spec §4.0 extension: the "known destination" envelope.
 *
 * A grant answers *"may the agent run this tool without asking?"*. It does
 * NOT answer *"do I accept this particular destination?"* — those are
 * different questions, and conflating them is how a standing permission
 * turns into "the agent may send my funds anywhere". So an authorized
 * write whose counterparty the user has never confirmed is escalated back
 * to `ask` (see `authorizeToolCall`), no matter how broad the grant is.
 *
 * This is the banking "new payee" rule: what is guarded is NOVELTY, not
 * the transaction type. Escalating every cross-chain bridge would make a
 * grant worthless for the case it exists to serve; escalating only the
 * first send to a given address costs the user one approval and then gets
 * out of the way.
 *
 * ## What counts as confirmation
 *
 * ONLY an explicit tap on the approval sheet that actually DISPLAYED the
 * address. The 6 s run-down auto-confirm must never record anything:
 * inaction is not evidence the user saw an address, and a store fed by
 * inaction would launder timeouts into standing permission — strictly
 * worse than having no envelope at all.
 *
 * ## Why MMKV and not SecureStore
 *
 * `authorizeToolCall` is a PURE, SYNCHRONOUS gate (deny-layer §6.1) and
 * its whole test matrix depends on staying that way. MMKV reads are
 * synchronous; SecureStore is async and would force the gate to become a
 * promise. Nothing here is a secret — it is a list of addresses the user
 * already chose to send to, and the private keys it protects are
 * elsewhere. Integrity matters, confidentiality does not.
 *
 * Scoped per wallet: confirming a destination while using one wallet must
 * not silently authorize it for another.
 */

import { storage } from "@/lib/storage/mmkv";
import type { Namespace } from "@/services/chains/types";
import { canonicalizeAddress } from "@/services/walletKit/chainInfo";

const KEY_PREFIX = "agent_confirmed_counterparties";

export interface ConfirmedCounterparty {
  /** Stored canonicalised; compare via `isCounterpartyConfirmed`. */
  address: string;
  namespace: Namespace;
  /** Unix ms — lets the settings list show "confirmed on …". */
  confirmed_at: number;
  /** Tool that prompted the confirmation, for display only. */
  tool_name?: string;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let version = 0;

function keyFor(walletAddress: string): string {
  return `${KEY_PREFIX}:${walletAddress.toLowerCase()}`;
}

function emit(): void {
  version += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn(`[confirmedCounterparty] listener threw: ${String(err)}`);
      }
    }
  }
}

function read(walletAddress: string): ConfirmedCounterparty[] {
  const raw = storage.getString(keyFor(walletAddress));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ConfirmedCounterparty[]) : [];
  } catch {
    // A corrupt blob must fail CLOSED: an unreadable list means "nothing is
    // confirmed", which escalates to `ask`. Treating it as "everything is
    // confirmed" would turn a parse bug into silent authorization.
    return [];
  }
}

function write(walletAddress: string, entries: ConfirmedCounterparty[]): void {
  storage.set(keyFor(walletAddress), JSON.stringify(entries));
  emit();
}

/**
 * Address equality is per-encoding (`feedback_address_case_per_encoding`):
 * EVM/Sui fold case, Solana/Stellar are verbatim. Canonicalising both
 * sides via the owning wallet kit is what keeps a checksummed EVM address
 * from reading as "unknown" and re-prompting forever.
 */
function sameAddress(namespace: Namespace, a: string, b: string): boolean {
  return (
    canonicalizeAddress(namespace, a) === canonicalizeAddress(namespace, b)
  );
}

export const confirmedCounterpartyStore = {
  list(walletAddress: string): ConfirmedCounterparty[] {
    return read(walletAddress);
  },

  /** Sync by design — `authorizeToolCall` calls this inside a pure gate. */
  isConfirmed(
    walletAddress: string,
    namespace: Namespace,
    address: string,
  ): boolean {
    return read(walletAddress).some(
      (entry) =>
        entry.namespace === namespace &&
        sameAddress(namespace, entry.address, address),
    );
  },

  /**
   * Record a confirmation. Call ONLY from the explicit approval path.
   * Idempotent: re-confirming refreshes the timestamp rather than adding
   * a duplicate row to the settings list.
   */
  confirm(
    walletAddress: string,
    entry: Omit<ConfirmedCounterparty, "confirmed_at"> & {
      confirmed_at?: number;
    },
  ): void {
    const existing = read(walletAddress);
    const next = existing.filter(
      (e) =>
        !(
          e.namespace === entry.namespace &&
          sameAddress(entry.namespace, e.address, entry.address)
        ),
    );
    next.push({
      address: canonicalizeAddress(entry.namespace, entry.address),
      namespace: entry.namespace,
      tool_name: entry.tool_name,
      confirmed_at: entry.confirmed_at ?? Date.now(),
    });
    write(walletAddress, next);
  },

  /**
   * The destination this wallet most recently ESTABLISHED on `namespace`
   * — i.e. the one a completed write actually went to.
   *
   * This is what makes the envelope pay for itself rather than just add
   * friction: the first bridge to a chain asks the user to pick, and that
   * choice then becomes the standing default for that chain, so every
   * later bridge there runs under the grant with no prompt. Recency wins
   * because switching destination is itself a deliberate act — the wallet
   * the user moved to last is the one they meant.
   */
  mostRecentFor(
    walletAddress: string,
    namespace: Namespace,
  ): ConfirmedCounterparty | null {
    let best: ConfirmedCounterparty | null = null;
    for (const entry of read(walletAddress)) {
      if (entry.namespace !== namespace) continue;
      if (!best || entry.confirmed_at > best.confirmed_at) best = entry;
    }
    return best;
  },

  /** Revoke one destination from the settings list. */
  revoke(walletAddress: string, namespace: Namespace, address: string): void {
    const existing = read(walletAddress);
    const next = existing.filter(
      (e) =>
        !(
          e.namespace === namespace &&
          sameAddress(namespace, e.address, address)
        ),
    );
    if (next.length === existing.length) return;
    write(walletAddress, next);
  },

  revokeAll(walletAddress: string): void {
    if (read(walletAddress).length === 0) return;
    write(walletAddress, []);
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** Referentially stable between writes — safe for useSyncExternalStore. */
  getVersion(): number {
    return version;
  },

  __resetForTests(walletAddress?: string): void {
    if (walletAddress) storage.remove(keyFor(walletAddress));
    listeners.clear();
    version = 0;
  },
};
