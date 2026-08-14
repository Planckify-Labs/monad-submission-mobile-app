import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { InteractionManager } from "react-native";
import { useAppLocked } from "@/app/_layout";
import { publicApi, reset401Guard } from "@/constants/configs/ky";
import { useWallet } from "@/hooks/useWallet";
import { clearChatStateForWallet } from "@/lib/storage/chatKeys";
import { storage } from "@/lib/storage/mmkv";
import { activeConvRegistry } from "@/services/activeConvRegistry";
import { pendingTxStore } from "@/services/pendingTxStore";
import {
  walletSecureDelete,
  walletSecureGet,
  walletSecureSet,
} from "@/services/security/walletSecureStore";
import * as walletService from "@/services/walletService";

interface TNonceResponse {
  nonce: string;
  message: string;
}

interface TVerifyRequest {
  message: string;
  signature: string;
}

interface TVerifySignatureResponse {
  access_token: string;
  refresh_token: string;
  user: {
    id: string;
    walletAddress: string;
  };
}

interface TRefreshTokenResponse {
  access_token: string;
}

const ACCESS_TOKEN_KEY = "takumipay_access_token";
const REFRESH_TOKEN_KEY = "takumipay_refresh_token";
const AUTH_WALLET_ADDRESS_KEY = "takumipay_auth_wallet_address";

// Cross-component auth-state pub/sub. `clearTokens()` and
// `storeTokens()` fire `notifyAuthStateChanged()`; every mounted
// `useIsAuthenticated()` consumer subscribes and re-runs its
// SecureStore check on the signal. This is what lets a 401 in
// `ky.ts` flip the home screen's ActivitySection / the address-book
// screen / the activities tab from "authenticated" to their inline
// sign-in CTAs without a navigation event — the previous global
// `router.replace("/auth")` redirect happened precisely because
// there was no other way to broadcast the state change.
type AuthChangeListener = () => void;
const authChangeListeners = new Set<AuthChangeListener>();
function notifyAuthStateChanged(): void {
  authChangeListeners.forEach((listener) => {
    try {
      listener();
    } catch (e) {
      console.warn("auth-state listener threw:", e);
    }
  });
}
function subscribeAuthStateChanged(listener: AuthChangeListener): () => void {
  authChangeListeners.add(listener);
  return () => {
    authChangeListeners.delete(listener);
  };
}

const accessKeyFor = (address: string) =>
  `${ACCESS_TOKEN_KEY}_${address.toLowerCase()}`;
const refreshKeyFor = (address: string) =>
  `${REFRESH_TOKEN_KEY}_${address.toLowerCase()}`;

export const storeTokens = async (
  accessToken: string,
  refreshToken: string,
  walletAddress?: string,
): Promise<void> => {
  try {
    await walletSecureSet(ACCESS_TOKEN_KEY, accessToken);
    await walletSecureSet(REFRESH_TOKEN_KEY, refreshToken);
    if (walletAddress) {
      await walletSecureSet(
        AUTH_WALLET_ADDRESS_KEY,
        walletAddress.toLowerCase(),
      );
      await walletSecureSet(accessKeyFor(walletAddress), accessToken);
      await walletSecureSet(refreshKeyFor(walletAddress), refreshToken);
    }
    notifyAuthStateChanged();
  } catch (error) {
    console.error("Failed to store tokens:", error);
    throw new Error("Failed to store authentication tokens");
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  try {
    return await walletSecureGet(ACCESS_TOKEN_KEY);
  } catch (error) {
    console.error("Failed to get access token:", error);
    return null;
  }
};

export const getRefreshToken = async (): Promise<string | null> => {
  try {
    return await walletSecureGet(REFRESH_TOKEN_KEY);
  } catch (error) {
    console.error("Failed to get refresh token:", error);
    return null;
  }
};

export const getAccessTokenForWallet = async (
  walletAddress?: string | null,
): Promise<string | null> => {
  if (!walletAddress) return null;
  try {
    const token = await walletSecureGet(accessKeyFor(walletAddress));
    return token || null;
  } catch (error) {
    console.error("Failed to get access token for wallet:", error);
    return null;
  }
};

export const getRefreshTokenForWallet = async (
  walletAddress?: string | null,
): Promise<string | null> => {
  if (!walletAddress) return null;
  try {
    const token = await walletSecureGet(refreshKeyFor(walletAddress));
    return token || null;
  } catch (error) {
    console.error("Failed to get refresh token for wallet:", error);
    return null;
  }
};

export const clearTokens = async (): Promise<void> => {
  try {
    // Resolve every wallet address whose per-wallet token slot might be
    // stale. The lazy migration below (checkAuthentication) copies
    // tokens into `accessKeyFor(address)`/`refreshKeyFor(address)` as
    // soon as a wallet is used — after that point those per-wallet
    // slots (not the legacy ACCESS_TOKEN_KEY/REFRESH_TOKEN_KEY below)
    // are what `beforeRequest` and `checkAuthentication` actually read.
    // Deleting only the legacy slot left the real, invalid token
    // sitting in the per-wallet slot: every 401 wiped nothing that
    // mattered, `useIsAuthenticated` kept finding a "valid" token and
    // reporting `isAuthenticated: true`, and every screen kept firing
    // authenticated requests that 401'd again — an infinite loop with
    // no inline sign-in CTA ever appearing. Wiping app data was the
    // only way out because that's the only thing that removed these
    // per-wallet keys.
    const addressesToClear = new Set<string>();
    const legacyAuthedAddress = await walletSecureGet(AUTH_WALLET_ADDRESS_KEY);
    if (legacyAuthedAddress) {
      addressesToClear.add(legacyAuthedAddress.toLowerCase());
    }
    try {
      const indexStr = storage.getString("active_wallet_index");
      const idx = indexStr ? parseInt(indexStr, 10) : 0;
      const wallets = await walletService.loadWalletsFromStorage();
      const activeAddr = wallets?.[idx]?.address;
      if (activeAddr) addressesToClear.add(activeAddr.toLowerCase());
    } catch {
      // Best-effort — the legacy-address clear above still covers the
      // common case where a token was ever minted for this device.
    }

    await Promise.all([
      walletSecureDelete(ACCESS_TOKEN_KEY),
      walletSecureDelete(REFRESH_TOKEN_KEY),
      walletSecureDelete(AUTH_WALLET_ADDRESS_KEY),
      ...Array.from(addressesToClear).flatMap((address) => [
        walletSecureDelete(accessKeyFor(address)),
        walletSecureDelete(refreshKeyFor(address)),
      ]),
    ]);
    // The per-wallet auth-state cache holds the previous `isAuthenticated:
    // true` — wipe it so the next `useIsAuthenticated` run doesn't flash
    // an authenticated state for a wallet that just lost its tokens.
    authStateCache.clear();
    // Also wipe the MMKV cold-boot hints. Without this, the next
    // cold-start would seed `isAuthenticated = true` from the stale
    // hint, show authed UI for a moment, then flip to false when the
    // SecureStore check completes.
    clearAuthHints();
    // Poke every mounted consumer of `useIsAuthenticated()` so the
    // 401 -> inline sign-in CTA transition happens immediately
    // instead of waiting for a wallet switch / screen remount.
    notifyAuthStateChanged();
  } catch (error) {
    console.error("Failed to clear tokens:", error);
  }
};

export const getAuthenticatedWalletAddress = async (): Promise<
  string | null
> => {
  try {
    const addr = await walletSecureGet(AUTH_WALLET_ADDRESS_KEY);
    return addr;
  } catch (error) {
    console.error("Failed to get authenticated wallet address:", error);
    return null;
  }
};

export interface UseNonceOptions {
  chainId?: number;
  chainSlug?: string;
}

export const useNonce = (
  walletAddress?: string,
  optsOrChainId: UseNonceOptions | number = {},
) => {
  // Legacy call sites passed a raw number — accept both shapes during rollout.
  const opts: UseNonceOptions =
    typeof optsOrChainId === "number"
      ? { chainId: optsOrChainId }
      : optsOrChainId;
  const { chainId, chainSlug } = opts;

  if (chainId !== undefined && chainSlug !== undefined) {
    // Both set is a caller bug — server would 400, but fail fast here.
    throw new Error("useNonce: chainId and chainSlug are mutually exclusive");
  }

  const selector = chainSlug ?? chainId ?? null;

  return useQuery<TNonceResponse>({
    queryKey: ["auth", "nonce", walletAddress, selector],
    queryFn: async () => {
      if (!walletAddress) throw new Error("Wallet address is required");

      let query = "";
      if (chainSlug) {
        query = `?chainSlug=${encodeURIComponent(chainSlug)}`;
      } else if (chainId !== undefined) {
        query = `?chainId=${chainId}`;
      }
      // Solana base58 addresses are case-sensitive — do not lowercase here.
      const endpoint = `auth/nonce/${walletAddress}${query}`;

      try {
        const response = await publicApi.get(endpoint).json<TNonceResponse>();
        return response;
      } catch (error) {
        console.error("Failed to fetch nonce:", error);
        throw error;
      }
    },
    enabled: !!walletAddress,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
};

export const useVerifySignature = () => {
  return useMutation<TVerifySignatureResponse, Error, TVerifyRequest>({
    mutationFn: async ({ message, signature }) => {
      try {
        const response = await publicApi
          .post("auth/verify", {
            json: {
              message,
              signature,
            },
          })
          .json<TVerifySignatureResponse>();

        await storeTokens(
          response.access_token,
          response.refresh_token,
          (response as any).user?.walletAddress ||
            (response as any).walletAddress,
        );

        // Allow future 401s to trigger redirect again now that we have fresh tokens
        reset401Guard();

        return response;
      } catch (error) {
        console.error("Failed to verify signature:", error);
        throw error;
      }
    },
  });
};

export const useRefreshToken = () => {
  const queryClient = useQueryClient();
  const { activeWallet } = useWallet();

  const refreshTokenMutation = useMutation<TRefreshTokenResponse, Error>({
    mutationFn: async () => {
      const currentWallet = activeWallet?.address?.toLowerCase() || null;

      let refreshToken: string | null = null;
      if (currentWallet) {
        refreshToken = await getRefreshTokenForWallet(currentWallet);
      }

      if (!refreshToken) {
        const legacyRefresh = await getRefreshToken();
        const authedWallet =
          (await getAuthenticatedWalletAddress())?.toLowerCase() || null;
        if (legacyRefresh && currentWallet && authedWallet === currentWallet) {
          refreshToken = legacyRefresh;
        }
      }

      if (!refreshToken) {
        throw new Error("No refresh token available");
      }

      try {
        const response = await publicApi
          .post("auth/refresh", {
            json: {
              refresh_token: refreshToken,
            },
          })
          .json<TRefreshTokenResponse>();

        const walletToPersist = activeWallet?.address;
        if (walletToPersist) {
          await walletSecureSet(
            accessKeyFor(walletToPersist),
            response.access_token,
          );
          await walletSecureSet(ACCESS_TOKEN_KEY, response.access_token);
        } else {
          await walletSecureSet(ACCESS_TOKEN_KEY, response.access_token);
        }

        // Fresh access token obtained — allow future 401s to trigger redirect again
        reset401Guard();

        return response;
      } catch (error: any) {
        console.error("Failed to refresh token:", error);
        // Only clear tokens if the server explicitly rejected the refresh token (401/403).
        // Network errors or 5xx responses mean the API is temporarily unavailable —
        // keep tokens so the user stays authenticated when the server comes back.
        const status = error?.response?.status;
        if (status === 401 || status === 403) {
          await clearTokens();
        }
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth"] });
    },
  });

  const refreshAccessToken = useCallback(async () => {
    try {
      await refreshTokenMutation.mutateAsync();
      return true;
    } catch (error) {
      console.error("Failed to refresh token:", error);
      return false;
    }
  }, [refreshTokenMutation]);

  // Like refreshAccessToken but throws so callers can inspect the error type.
  const refreshAccessTokenOrThrow = useCallback(async () => {
    await refreshTokenMutation.mutateAsync();
  }, [refreshTokenMutation]);

  return {
    refreshAccessToken,
    refreshAccessTokenOrThrow,
    isRefreshing: refreshTokenMutation.isPending,
    error: refreshTokenMutation.error,
  };
};

// Per-wallet auth-state cache shared across every `useIsAuthenticated`
// consumer in the tree. Switching wallets after the first check returns
// synchronously from this cache (module-level so it survives unmount /
// remount cycles), and the background re-check silently updates it.
//
// Without this, every namespace switch fired 5 sequential SecureStore
// reads (25–75ms) PLUS a potential refresh mutation — run across every
// consumer on screen. That was the bulk of the cross-namespace lag
// (intra-EVM didn't change `activeWallet.address`, so this effect never
// ran on chain-only switches).
type AuthCacheEntry = {
  isAuthenticated: boolean;
  hadPreviousSession: boolean;
};
const authStateCache = new Map<string, AuthCacheEntry>();

// MMKV mirror of the auth-state cache — survives cold boots. NOT the
// actual tokens (those stay in SecureStore). This is a hint: "on last
// check, wallet X was authenticated". Lets the first render on cold
// boot skip the `isLoading: true` skeleton + kicks downstream hooks
// (ActivitySection etc.) straight into their authenticated branch, so
// taps on nav aren't queued behind a busy main thread running the
// SecureStore cascade. A background re-check on every mount corrects
// the hint if tokens were revoked / expired out-of-band.
const AUTH_HINT_PREFIX = "auth_has_tokens_v1_";
function hintKey(walletKey: string): string {
  return `${AUTH_HINT_PREFIX}${walletKey}`;
}
function readAuthHint(walletKey: string): AuthCacheEntry | null {
  try {
    const raw = storage.getString(hintKey(walletKey));
    if (!raw) return null;
    const hint = JSON.parse(raw) as AuthCacheEntry;
    return {
      isAuthenticated: !!hint.isAuthenticated,
      hadPreviousSession: !!hint.hadPreviousSession,
    };
  } catch {
    return null;
  }
}
function writeAuthHint(walletKey: string, entry: AuthCacheEntry): void {
  try {
    storage.set(hintKey(walletKey), JSON.stringify(entry));
  } catch {
    // Non-fatal; the in-memory cache still works.
  }
}
function clearAuthHints(): void {
  try {
    const all = storage.getAllKeys();
    for (const k of all) {
      if (k.startsWith(AUTH_HINT_PREFIX)) storage.remove(k);
    }
  } catch {
    // Non-fatal.
  }
}

/**
 * Primes the auth-state caches (in-memory + MMKV hint) for the given
 * wallet by reading SecureStore BEFORE any consumer renders. Used by
 * `LockScreen.attempt` so that by the time the lock dismisses, every
 * `useIsAuthenticated()` consumer on home seeds `isLoading: false` and
 * the correct `isAuthenticated` — eliminating the "skeleton → swap to
 * real content → queries refire" cascade that caused the perceived
 * post-unlock freeze.
 *
 * No-op if `walletKey` is missing. Errors are swallowed — if priming
 * fails, `useIsAuthenticated` falls back to its normal
 * `InteractionManager.runAfterInteractions` background check path.
 */
export async function primeAuthState(
  walletKey: string | null | undefined,
): Promise<void> {
  if (!walletKey) return;
  try {
    const [
      perWalletAccess,
      perWalletRefresh,
      legacyAccess,
      legacyRefresh,
      authedWalletRaw,
    ] = await Promise.all([
      getAccessTokenForWallet(walletKey),
      getRefreshTokenForWallet(walletKey),
      getAccessToken(),
      getRefreshToken(),
      getAuthenticatedWalletAddress(),
    ]);

    const authedWallet = authedWalletRaw?.toLowerCase() || null;
    let accessToken = perWalletAccess;
    let refreshToken = perWalletRefresh;
    if (!accessToken && legacyAccess && authedWallet === walletKey) {
      accessToken = legacyAccess;
    }
    if (!refreshToken && legacyRefresh && authedWallet === walletKey) {
      refreshToken = legacyRefresh;
    }

    // Mirror the decision tree `useIsAuthenticated.checkAuthentication`
    // uses: access token OR refresh token present = had-session.
    // Access token present = authenticated for this session's first
    // paint (the hook's background check runs a full refresh if only
    // a refresh token was found, but for the first-paint prime the
    // presence of either is enough to avoid the skeleton flash).
    const hadSession = !!(accessToken || refreshToken);
    const isAuthenticated = !!accessToken;

    const entry: AuthCacheEntry = {
      isAuthenticated,
      hadPreviousSession: hadSession,
    };
    authStateCache.set(walletKey, entry);
    writeAuthHint(walletKey, entry);
  } catch {
    // Best-effort; fall back to the background check in the hook.
  }
}

export const useIsAuthenticated = () => {
  const { activeWallet } = useWallet();
  const isLocked = useAppLocked();
  const walletKey = activeWallet?.address?.toLowerCase() || null;
  // In-memory cache wins when present (most accurate, set by the last
  // background check). MMKV hint is the cold-boot fallback — lets the
  // first paint show authenticated UI without waiting on SecureStore.
  const memCached = walletKey ? authStateCache.get(walletKey) : undefined;
  const mmkvCached = walletKey && !memCached ? readAuthHint(walletKey) : null;
  const cached = memCached ?? mmkvCached;

  // Seed from cache so consumers see the last-known auth state instantly
  // on switch OR cold boot — no null/loading flash. Fresh background
  // check follows (and may revert to `false` if tokens were revoked).
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(
    cached?.isAuthenticated ?? null,
  );
  const [isLoading, setIsLoading] = useState(!cached);
  const [hadPreviousSession, setHadPreviousSession] = useState(
    cached?.hadPreviousSession ?? false,
  );
  // Bumped by `notifyAuthStateChanged()` (fired from `clearTokens` /
  // `storeTokens`). Listed as a dep on the auth-check effect below so
  // a 401 in `ky.ts` -> `clearTokens()` re-runs the SecureStore probe
  // and commits the new {false, false} state to this consumer
  // immediately, without waiting for a wallet switch / unmount cycle.
  const [authChangeVersion, setAuthChangeVersion] = useState(0);
  useEffect(() => {
    return subscribeAuthStateChanged(() => {
      setAuthChangeVersion((v) => v + 1);
    });
  }, []);
  const { refreshAccessTokenOrThrow } = useRefreshToken();
  const refreshAccessTokenRef = useRef(refreshAccessTokenOrThrow);

  useEffect(() => {
    refreshAccessTokenRef.current = refreshAccessTokenOrThrow;
  }, [refreshAccessTokenOrThrow]);

  useEffect(() => {
    // Lock gate — skip every SecureStore read + refresh mutation while
    // the LockScreen is floating. The blurred home behind the lock has
    // no business running auth chains; running them there was the bulk
    // of the "tap to unlock is delayed" + post-unlock navigation lag.
    // Freeze state in the loading posture so consumers render their
    // loading branches (sign-in prompt, skeletons) without firing work.
    if (isLocked) {
      return;
    }

    // Seed synchronously from cache for this specific wallet so the
    // effect's own post-mount snapshot doesn't trip the "authing…"
    // branches in consumers while the async re-check runs.
    const cachedForWallet = walletKey ? authStateCache.get(walletKey) : null;
    if (cachedForWallet) {
      setIsAuthenticated(cachedForWallet.isAuthenticated);
      setHadPreviousSession(cachedForWallet.hadPreviousSession);
      setIsLoading(false);
    } else {
      setIsAuthenticated(null);
      setHadPreviousSession(false);
      setIsLoading(true);
    }

    let cancelled = false;

    const commit = (next: AuthCacheEntry) => {
      if (cancelled) return;
      if (walletKey) {
        authStateCache.set(walletKey, next);
        // Persist the hint so the next cold boot skips the "authing…"
        // skeleton on first paint. NOT the token itself — just a flag
        // saying "last time we looked, this wallet had valid tokens".
        writeAuthHint(walletKey, next);
      }
      setIsAuthenticated(next.isAuthenticated);
      setHadPreviousSession(next.hadPreviousSession);
      setIsLoading(false);
    };

    const checkAuthentication = async () => {
      if (!walletKey) return;

      try {
        // Parallelize all five SecureStore reads. Each is an OS-level
        // keychain round-trip (5–15ms on iOS); chained sequentially that
        // was ~25–75ms of blocking work per switch. Promise.all keeps the
        // total at the slowest single read.
        const [
          perWalletAccess,
          perWalletRefresh,
          legacyAccess,
          legacyRefresh,
          authedWalletRaw,
        ] = await Promise.all([
          getAccessTokenForWallet(walletKey),
          getRefreshTokenForWallet(walletKey),
          getAccessToken(),
          getRefreshToken(),
          getAuthenticatedWalletAddress(),
        ]);
        if (cancelled) return;

        const authedWallet = authedWalletRaw?.toLowerCase() || null;
        let accessToken = perWalletAccess;
        let refreshToken = perWalletRefresh;
        if (!accessToken && legacyAccess && authedWallet === walletKey) {
          accessToken = legacyAccess;
        }
        if (!refreshToken && legacyRefresh && authedWallet === walletKey) {
          refreshToken = legacyRefresh;
        }

        // Lazy legacy-to-per-wallet migration. Fire-and-forget — the
        // auth decision below doesn't depend on this succeeding.
        if (
          authedWallet === walletKey &&
          (accessToken || refreshToken) &&
          !perWalletAccess &&
          !perWalletRefresh
        ) {
          const migrationWrites: Promise<unknown>[] = [];
          if (accessToken) {
            migrationWrites.push(
              walletSecureSet(accessKeyFor(walletKey), accessToken),
            );
          }
          if (refreshToken) {
            migrationWrites.push(
              walletSecureSet(refreshKeyFor(walletKey), refreshToken),
            );
          }
          void Promise.all(migrationWrites).catch((e) =>
            console.warn(
              "Failed to persist legacy tokens to per-wallet storage",
              e,
            ),
          );
        }

        const hadSession = !!(accessToken || refreshToken);

        if (!accessToken && !refreshToken) {
          commit({ isAuthenticated: false, hadPreviousSession: hadSession });
          return;
        }

        if (!accessToken && refreshToken) {
          try {
            await refreshAccessTokenRef.current();
            if (cancelled) return;
            commit({ isAuthenticated: true, hadPreviousSession: hadSession });
          } catch (refreshError: any) {
            if (cancelled) return;
            const status = refreshError?.response?.status;
            if (status === 401 || status === 403) {
              commit({
                isAuthenticated: false,
                hadPreviousSession: hadSession,
              });
            } else {
              console.warn(
                "Refresh failed (network/server error), keeping authenticated state:",
                refreshError,
              );
              commit({
                isAuthenticated: true,
                hadPreviousSession: hadSession,
              });
            }
          }
          return;
        }

        if (accessToken) {
          if (perWalletAccess) {
            commit({ isAuthenticated: true, hadPreviousSession: hadSession });
            return;
          }
          if (authedWallet !== walletKey) {
            commit({ isAuthenticated: false, hadPreviousSession: hadSession });
            return;
          }
        }

        commit({ isAuthenticated: true, hadPreviousSession: hadSession });
      } catch (error: any) {
        if (cancelled) return;
        console.error("Error checking authentication:", error);
        const status = error?.response?.status;
        commit({
          isAuthenticated: !(status === 401 || status === 403),
          hadPreviousSession: cached?.hadPreviousSession ?? false,
        });
      }
    };

    // Defer the SecureStore cascade to after interactions so taps on
    // nav buttons (address book, wallet, etc.) don't compete with
    // auth-check work for main-thread frames. The UI already has its
    // seeded state from the in-memory cache or MMKV hint — the
    // background check just confirms / corrects it.
    const task = InteractionManager.runAfterInteractions(() => {
      if (cancelled) return;
      void checkAuthentication();
    });
    return () => {
      cancelled = true;
      if (typeof task === "object" && task && "cancel" in task) {
        (task as { cancel: () => void }).cancel();
      }
    };
    // `cached` intentionally excluded — we only want re-check on wallet
    // change OR an explicit `notifyAuthStateChanged()` (the
    // `authChangeVersion` bump fires the same effect path).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletKey, isLocked, authChangeVersion]);

  const queryClient = useQueryClient();
  const logout = useCallback(async () => {
    await clearTokens();
    // Drop in-memory pending-tx cards so a subsequent sign-in can't see
    // the previous user's in-flight transaction hashes.
    pendingTxStore.clear();
    // Drop the in-memory active-conversation registry for the same
    // reason — a re-login (different user, same device) must start
    // from nothing.
    activeConvRegistry.clearAll();
    // Purge this wallet's chat caches (list + active pointer + every
    // cached conversation) so no messages from the signed-out session
    // remain on disk.
    const addr = activeWallet?.address;
    if (addr) {
      clearChatStateForWallet(storage, addr);
    }
    // Evict the TanStack Query cache for conversations — otherwise the
    // old wallet's list stays in memory and leaks into the next
    // authenticated session.
    queryClient.removeQueries({ queryKey: ["conversations"] });
    setIsAuthenticated(false);
  }, [activeWallet?.address, queryClient]);

  return {
    isAuthenticated,
    isLoading,
    hadPreviousSession,
    logout,
  };
};
