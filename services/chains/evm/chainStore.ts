import { storage } from "@/lib/storage/mmkv";

// Persisted in MMKV per-origin (Phase 2): custom chains are non-secret,
// cache-like data, so reopening a dApp restores its network without a fresh
// `wallet_addEthereumChain`. (Previously SecureStore; the key is new, so any
// pre-migration entries are simply re-added on next use.)
const STORAGE_KEY = "dapp_bridge.user_chains";

export interface UserChain {
  chainId: number;
  chainName: string;
  /**
   * Origin (dApp URL) that added this network. Custom chains are
   * second-class and scoped to the site that added them: a network added
   * by `app.foo.com` is NOT offered to `app.bar.com`. Legacy entries
   * persisted before this field existed have `origin === undefined` and
   * match any origin (back-compat). A custom chain is inherently
   * unverified — it lives here precisely because it is absent from the
   * backend `/blockchains` feed; consumer UI must treat it as untrusted.
   */
  origin?: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
  /**
   * TWV-2026-049 — `"verified"` when every stored `blockExplorerUrls`
   * entry matches the pinned allowlist for this chainId. `"unverified"`
   * otherwise — consumer UI MUST require long-press + in-app WebView
   * when rendering an unverified explorer link.
   */
  explorerTrust?: "verified" | "unverified";
  iconUrls?: string[];
  addedAt: number;
  /** Best-effort capability flags filled during add-chain health check. */
  supportsTypes?: { t0?: boolean; t1?: boolean; t2?: boolean };
}

let chains: Record<number, UserChain> = {};
let hydrated = false;
const listeners = new Set<() => void>();

async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = storage.getString(STORAGE_KEY);
    if (raw) chains = JSON.parse(raw) as Record<number, UserChain>;
  } catch {
    chains = {};
  }
}

async function persist(): Promise<void> {
  try {
    storage.set(STORAGE_KEY, JSON.stringify(chains));
  } catch {
    // best effort
  }
}

// A stored chain is visible to an origin when it was added by that origin
// or predates per-origin scoping (legacy entry, no recorded origin).
function matchesOrigin(c: UserChain, origin: string): boolean {
  return c.origin === undefined || c.origin === origin;
}

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      // swallow
    }
  }
}

// TWV-2026-016 — signing-chainId invariant lives in
// `./signingChainId.ts` (kept dep-free so it's unit-testable under plain
// Node). Re-export for back-compat and grep proximity to chainStore.
export { getSigningChainId, verifyRpcChainId } from "./signingChainId";

export const UserChainStore = {
  hydrate,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /**
   * Look up a stored custom chain. When `origin` is passed, the entry only
   * matches if it was added by that origin (or is a legacy entry with no
   * recorded origin). Omitting `origin` matches any — use that only for
   * display-name reads, never to authorize serving a chain to a dApp.
   */
  get(chainId: number, origin?: string): UserChain | null {
    const c = chains[chainId];
    if (!c) return null;
    if (origin === undefined) return c;
    return matchesOrigin(c, origin) ? c : null;
  },
  has(chainId: number, origin?: string): boolean {
    return this.get(chainId, origin) !== null;
  },
  list(origin?: string): UserChain[] {
    const all = Object.values(chains);
    if (origin === undefined) return all;
    return all.filter((c) => matchesOrigin(c, origin));
  },
  async add(chain: UserChain): Promise<void> {
    await hydrate();
    chains[chain.chainId] = chain;
    await persist();
    notify();
  },
  async remove(chainId: number): Promise<void> {
    await hydrate();
    if (!chains[chainId]) return;
    delete chains[chainId];
    await persist();
    notify();
  },
};
