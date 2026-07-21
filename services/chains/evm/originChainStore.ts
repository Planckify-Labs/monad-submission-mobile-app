import { storage } from "@/lib/storage/mmkv";

/**
 * Per-origin EVM chain selection for the dApp browser (Phase 2, full
 * isolation). Which chain a dApp is on is scoped to its origin and kept
 * OUT of the home-screen active-chain state: a dApp can never read or move
 * the wallet's system chain. Persisted in MMKV (non-secret, cache-like) so
 * reopening a dApp restores its chain without a fresh switch.
 *
 * Values are numeric EVM chainIds; the chain itself is resolved elsewhere
 * (registered → backend feed / project RPC; custom → `UserChainStore` /
 * dApp RPC). See docs/design-notes/chain-switch-ux.md.
 */
const STORAGE_KEY = "dapp_bridge.origin_chain_selection";

// origin url -> selected chainId
let selection: Record<string, number> = {};
let hydrated = false;

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = storage.getString(STORAGE_KEY);
    if (raw) selection = JSON.parse(raw) as Record<string, number>;
  } catch {
    selection = {};
  }
}

function persist(): void {
  try {
    storage.set(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // best effort — a failed cache write just means the dApp re-switches
    // next session; never surfaced to the user.
  }
}

export const OriginChainStore = {
  getSelected(origin: string): number | null {
    hydrate();
    return selection[origin] ?? null;
  },
  setSelected(origin: string, chainId: number): void {
    hydrate();
    selection[origin] = chainId;
    persist();
  },
  clearSelected(origin: string): void {
    hydrate();
    if (origin in selection) {
      delete selection[origin];
      persist();
    }
  },
};
