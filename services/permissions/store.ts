import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import type { Namespace } from "@/services/chains/types";
import {
  addressesEqual,
  canonicalizeAddress,
} from "@/services/walletKit/chainInfo";
import { originKey } from "./caip";

// Stored in AsyncStorage, not SecureStore. Grants are (origin, wallet
// address, chainId, timestamp) — NOT secret material. SecureStore's
// ~2 KB per-value cap silently drops state once a user connects to
// ~10+ dApps, which makes every reconnect look like a fresh session.
// AsyncStorage has no practical size cap for this workload.
const STORAGE_KEY = "dapp_bridge.permissions";
// One-shot migration tag: if we find grants in the legacy SecureStore
// slot on boot, we move them to AsyncStorage and clear the legacy key.
const LEGACY_SECURE_STORAGE_KEY = "dapp_bridge.permissions";

export type PermissionCaveat = {
  type: "restrictReturnedAccounts";
  value: string[];
};

/**
 * Per solana-adapter-spec.md §4.5: Solana grants key by CAIP-2 cluster
 * identifier (`"solana:mainnet"` / `"solana:devnet"` / `"solana:testnet"`)
 * rather than numeric chainId. EVM still passes numbers.
 */
export type ChainKey = number | string;

export type PermissionGrant = {
  origin: string;
  walletAddress: string;
  chainId: ChainKey;
  caveats: PermissionCaveat[];
  grantedAt: number;
};

/**
 * Derive the chain namespace of a stored grant from its `chainId`.
 *
 * Grants don't persist `namespace` explicitly — it's recoverable from the
 * `chainId` shape each adapter writes: EVM grants store a numeric chainId
 * (`EvmAdapter`), Solana stores CAIP-2 `"solana:<cluster>"`
 * (`clusterToChain`), Sui stores `"sui:<network>"` (`networkToChain`).
 *
 * Lives here (a `services/` module, outside the `check:chains` guard) so
 * the bridge can route a disconnect to the right injected provider helper
 * and shared UI can label a grant's chain without branching on namespace
 * strings itself.
 */
export function namespaceForChainKey(chainId: ChainKey): Namespace {
  if (typeof chainId === "number") return "eip155";
  if (chainId.startsWith("solana")) return "solana";
  if (chainId.startsWith("sui")) return "sui";
  if (chainId.startsWith("stellar")) return "stellar";
  return "eip155";
}

type Store = { grants: PermissionGrant[] };

type Listener = () => void;

const listeners = new Set<Listener>();
let cache: Store = { grants: [] };
let hydrated = false;
let hydratePromise: Promise<void> | null = null;

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      if (__DEV__) console.warn("[permissions] listener threw", e);
    }
  }
}

async function persist(): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch (e) {
    if (__DEV__) console.warn("[permissions] persist failed", e);
  }
}

export const PermissionStore = {
  async hydrate(): Promise<void> {
    if (hydrated) return;
    if (hydratePromise) return hydratePromise;
    hydratePromise = (async () => {
      try {
        let raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) {
          // Migration: pull any grants that were previously persisted
          // in SecureStore (pre-2 KB-limit fix). Move them once and
          // clear the legacy slot so the next boot reads only
          // AsyncStorage.
          try {
            const legacy = await SecureStore.getItemAsync(
              LEGACY_SECURE_STORAGE_KEY,
            );
            if (legacy) {
              raw = legacy;
              await AsyncStorage.setItem(STORAGE_KEY, legacy);
              await SecureStore.deleteItemAsync(LEGACY_SECURE_STORAGE_KEY);
            }
          } catch {
            // Legacy read/delete is best-effort; ignore.
          }
        }
        if (raw) {
          const parsed = JSON.parse(raw) as Store;
          if (parsed?.grants && Array.isArray(parsed.grants)) {
            cache = parsed;
          }
        }
      } catch (e) {
        if (__DEV__) console.warn("[permissions] hydrate failed", e);
      } finally {
        hydrated = true;
      }
    })();
    return hydratePromise;
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  async grant(args: {
    origin: string;
    walletAddress: string;
    chainId: ChainKey;
  }): Promise<void> {
    const key = originKey(args.origin);
    // Store the address in its chain's canonical form (checksummed EVM /
    // verbatim Solana+Stellar) so grants survive a case-sensitive compare
    // against a real wallet address (StellarAdapter/SolanaAdapter match
    // `w.address` verbatim). The namespace comes from the grant's chainId.
    const namespace = namespaceForChainKey(args.chainId);
    const canonical = canonicalizeAddress(namespace, args.walletAddress);
    const filtered = cache.grants.filter(
      (g) =>
        !(
          g.origin === key &&
          addressesEqual(namespace, g.walletAddress, args.walletAddress) &&
          g.chainId === args.chainId
        ),
    );
    filtered.push({
      origin: key,
      walletAddress: canonical,
      chainId: args.chainId,
      caveats: [{ type: "restrictReturnedAccounts", value: [canonical] }],
      grantedAt: Date.now(),
    });
    cache = { grants: filtered };
    notify();
    await persist();
  },

  async revoke(args: {
    origin: string;
    walletAddress?: string;
  }): Promise<void> {
    const key = originKey(args.origin);
    const before = cache.grants.length;
    cache = {
      grants: cache.grants.filter((g) => {
        if (g.origin !== key) return true;
        if (!args.walletAddress) return false;
        return !addressesEqual(
          namespaceForChainKey(g.chainId),
          g.walletAddress,
          args.walletAddress,
        );
      }),
    };
    if (cache.grants.length !== before) {
      notify();
      await persist();
    }
  },

  listByOrigin(origin: string): PermissionGrant[] {
    const key = originKey(origin);
    return cache.grants.filter((g) => g.origin === key);
  },

  /**
   * Grants this origin holds inside one chain family, regardless of which
   * chain within that family they were granted on.
   *
   * Account access is an ORIGIN capability, not a per-chain one — EIP-2255
   * scopes `eth_accounts` to the site, and the chain a site is looking at
   * is separately approved (`wallet_switchEthereumChain`). Callers that
   * asked `isGranted(origin, addr, chainId)` were re-deriving "is this site
   * connected" from a tuple that a later chain switch invalidates, so an
   * approved switch silently read back as a disconnect.
   */
  listByOriginForNamespace(
    origin: string,
    namespace: Namespace,
  ): PermissionGrant[] {
    const key = originKey(origin);
    return cache.grants.filter(
      (g) => g.origin === key && namespaceForChainKey(g.chainId) === namespace,
    );
  },

  /**
   * Chain-independent account-access check: has `origin` been granted
   * `walletAddress` anywhere in this chain family? Use this for "is the
   * site connected"; keep `isGranted` for the genuinely chain-scoped
   * questions (a Solana cluster grant, a Stellar network grant).
   */
  isGrantedForNamespace(
    origin: string,
    walletAddress: string,
    namespace: Namespace,
  ): boolean {
    return this.listByOriginForNamespace(origin, namespace).some((g) =>
      addressesEqual(namespace, g.walletAddress, walletAddress),
    );
  },

  listAll(): PermissionGrant[] {
    return [...cache.grants];
  },

  isGranted(origin: string, walletAddress: string, chainId: ChainKey): boolean {
    const key = originKey(origin);
    const namespace = namespaceForChainKey(chainId);
    return cache.grants.some(
      (g) =>
        g.origin === key &&
        addressesEqual(namespace, g.walletAddress, walletAddress) &&
        g.chainId === chainId,
    );
  },

  asEip2255(origin: string): Array<{
    parentCapability: string;
    id: string;
    date: number;
    caveats: PermissionCaveat[];
  }> {
    const list = this.listByOrigin(origin);
    if (list.length === 0) return [];
    const accounts = [
      ...new Set(list.flatMap((g) => g.caveats.flatMap((c) => c.value))),
    ];
    return [
      {
        parentCapability: "eth_accounts",
        id: `${list[0].origin}-${list[0].grantedAt}`,
        date: list[0].grantedAt,
        caveats: [{ type: "restrictReturnedAccounts", value: accounts }],
      },
    ];
  },
};
