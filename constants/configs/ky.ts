import type { NormalizedOptions } from "ky";
import ky from "ky";
import { ApiConflictError } from "@/api/types/errors";
import {
  clearTokens,
  getAccessToken,
  getAccessTokenForWallet,
  getAuthenticatedWalletAddress,
  getRefreshToken,
  getRefreshTokenForWallet,
} from "@/hooks/queries/useAuth";
import { storage } from "@/lib/storage/mmkv";
import { walletSecureSet } from "@/services/security/walletSecureStore";
import * as walletService from "@/services/walletService";

interface ApiError {
  message?: string;
  // Structured error code from the API (see jwt.strategy.ts / auth.service.ts)
  code?: string;
  // The strategies/DeFi endpoints answer `{ error: "defi_<code>" }` instead
  // (api/src/strategies/errors/defi-error.ts) — a curated code, never raw text.
  error?: string;
}

/**
 * Structured error thrown on 401 when silent refresh failed. Attaches
 * the HTTP response metadata so executor catch blocks — specifically
 * `classifyPointsError()` in `services/agent-executors/utils.ts` — can
 * read `err.response.status === 401` and return the canonical
 * `"authentication_required"` reason that triggers the agent's
 * `request_authentication` flow (protocol v1.1 §13). Previously the
 * handler threw a plain `Error("Authentication expired. Please sign in
 * again.")` which was unclassifiable downstream.
 */
class ApiHttpError extends Error {
  public readonly response: { status: number; data: ApiError };
  constructor(status: number, data: ApiError, message?: string) {
    super(message ?? data.message ?? `HTTP ${status}`);
    this.name = "ApiHttpError";
    this.response = { status, data };
  }
}

// Guard to prevent parallel 401s from each calling `clearTokens()` +
// firing a notify storm. Once a 401 has wiped tokens, subsequent
// in-flight 401s are no-ops until reset (after a successful sign-in
// or refresh). Without the guard, a screen with N concurrent
// authed queries would do N SecureStore wipes + N re-check cascades
// in every `useIsAuthenticated()` consumer on the tree.
let isHandling401 = false;
const reset401Guard = () => {
  isHandling401 = false;
};
export { reset401Guard };

const API_CONFIG = {
  url: process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, ""),
  key: process.env.EXPO_PUBLIC_API_KEY,
  timeout: 30000,
  retryLimit: 2,
} as const;

console.log("API URL:", API_CONFIG.url);
console.log("API Key available:", !!API_CONFIG.key);

export const debugApiConfig = () => {
  console.log("=== API Configuration Debug ===");
  console.log("API URL:", API_CONFIG.url);
  console.log("API Key available:", !!API_CONFIG.key);
  console.log("API Key length:", API_CONFIG.key?.length || 0);
  console.log("Environment variables:");
  console.log("- EXPO_PUBLIC_API_URL:", process.env.EXPO_PUBLIC_API_URL);
  console.log(
    "- EXPO_PUBLIC_API_KEY available:",
    !!process.env.EXPO_PUBLIC_API_KEY,
  );
  console.log("===============================");
};

const createBaseConfig = () => ({
  prefixUrl: API_CONFIG.url,
  timeout: API_CONFIG.timeout,
  retry: {
    limit: API_CONFIG.retryLimit,
    methods: ["get"],
  },
  fetch: (input: RequestInfo | URL, init?: RequestInit) => {
    if (
      init?.signal &&
      typeof (init.signal as AbortSignal & { throwIfAborted?: () => void })
        .throwIfAborted !== "function"
    ) {
      const { signal: _signal, ...restInit } = init;
      return fetch(input, restInit);
    }
    return fetch(input, init);
  },
});

// Key names duplicated here (rather than exported from useAuth.ts) to
// avoid circular dependency when we write back the refreshed access
// token. Kept in sync with `useAuth.ts`.
const ACCESS_TOKEN_KEY = "takumipay_access_token";
const accessKeyFor = (address: string) =>
  `${ACCESS_TOKEN_KEY}_${address.toLowerCase()}`;

/**
 * Shared in-flight silent refresh promise. When multiple 401s race
 * (several parallel points reads, say), they all await the same
 * refresh attempt instead of each firing their own — otherwise the
 * backend sees a storm of refresh requests and usually invalidates
 * the refresh token after the first success.
 */
let refreshInFlight: Promise<string | null> | null = null;

/**
 * Attempt a silent JWT refresh using the refresh token stored for the
 * currently active wallet. Returns the new access token on success or
 * `null` if no refresh token is available / the refresh request was
 * rejected / the refresh request threw.
 *
 * IMPORTANT: this function must never itself trigger `handleApiResponse`
 * — we use a bare `fetch` and parse the body manually. Reusing the `api`
 * ky instance would recurse on 401.
 */
async function attemptSilentRefresh(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      // Resolve the currently active wallet address to key the
      // refresh against — matches the logic in `useRefreshToken`
      // (see useAuth.ts).
      const indexStr = storage.getString("active_wallet_index");
      const idx = indexStr ? parseInt(indexStr, 10) : 0;
      const wallets = await walletService.loadWalletsFromStorage();
      const activeAddr = wallets?.[idx]?.address || null;
      const activeAddrLower = activeAddr?.toLowerCase() || null;

      let refreshToken: string | null = null;
      if (activeAddrLower) {
        refreshToken = await getRefreshTokenForWallet(activeAddrLower);
      }
      if (!refreshToken) {
        const legacyRefresh = await getRefreshToken();
        const authedWallet =
          (await getAuthenticatedWalletAddress())?.toLowerCase() || null;
        if (
          legacyRefresh &&
          activeAddrLower &&
          authedWallet === activeAddrLower
        ) {
          refreshToken = legacyRefresh;
        }
      }

      if (!refreshToken || !API_CONFIG.url) return null;

      const refreshResponse = await fetch(`${API_CONFIG.url}/auth/refresh`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(API_CONFIG.key ? { "X-API-Key": API_CONFIG.key } : {}),
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (!refreshResponse.ok) {
        console.warn(
          "[ky] silent refresh rejected with status",
          refreshResponse.status,
        );
        return null;
      }

      const parsed = (await refreshResponse.json()) as {
        access_token?: string;
      };
      if (!parsed.access_token) return null;

      // Persist the new token (per-wallet + legacy slot) so
      // subsequent `beforeRequest` hooks read it.
      if (activeAddr) {
        await walletSecureSet(accessKeyFor(activeAddr), parsed.access_token);
      }
      await walletSecureSet(ACCESS_TOKEN_KEY, parsed.access_token);

      // Re-open the 401 guard so future stale tokens get another
      // refresh attempt / redirect.
      reset401Guard();

      return parsed.access_token;
    } catch (err) {
      console.warn("[ky] silent refresh threw:", err);
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * Custom Request header used by `handleApiResponse` to mark a request
 * that has already been retried once after a silent refresh. Prevents
 * an infinite refresh/retry loop when the refresh succeeded but the
 * server still rejects the new token.
 */
const RETRIED_HEADER = "x-silent-refresh-retried";

const handleApiResponse = async (
  request: Request,
  _options: NormalizedOptions,
  response: Response,
): Promise<Response | void> => {
  if (!response.ok) {
    // Parse the body separately so our status-code throws below are never
    // accidentally swallowed by a catch that was only meant for JSON failures.
    let error: ApiError = {};
    try {
      error = (await response.json()) as ApiError;
      console.error(`API Error Response for ${request.url}:`, error);
    } catch {
      console.error(`Failed to parse error body for ${request.url}`);
    }

    if (response.status === 401) {
      const alreadyRetried = request.headers.get(RETRIED_HEADER) === "1";
      // USER_NOT_FOUND: JWT is cryptographically valid but the user row was deleted
      // (e.g. DB reset). The user needs to re-sign to recreate their account.
      const isUserDeleted = error.code === "USER_NOT_FOUND";

      // Attempt a one-shot silent refresh on the first 401 for this
      // request — protocol v1.1 §13 requires "try refresh before
      // surfacing authentication_required to the agent". We skip
      // silent refresh for USER_NOT_FOUND because there's no user
      // row to refresh against.
      if (!alreadyRetried && !isUserDeleted) {
        const newAccessToken = await attemptSilentRefresh();
        if (newAccessToken) {
          // Build a retry request with the new bearer + the guard
          // header. We return the retry response back to ky, which
          // will surface it to the caller as if the original
          // succeeded — no recursion, handleApiResponse will run
          // once more on the new response.
          const retried = new Request(request.url, {
            method: request.method,
            headers: new Headers(request.headers),
            body: request.body,
            redirect: request.redirect,
            credentials: request.credentials,
            mode: request.mode,
          });
          retried.headers.set("Authorization", `Bearer ${newAccessToken}`);
          retried.headers.set(RETRIED_HEADER, "1");
          try {
            return await fetch(retried);
          } catch (retryErr) {
            console.warn("[ky] silent-refresh retry fetch threw:", retryErr);
            // Fall through to the existing clear-tokens path below.
          }
        }
      }

      if (!isHandling401) {
        isHandling401 = true;

        // No more global redirect to /auth — that produced a
        // jarring screen swap (and a spurious "GO_BACK was not
        // handled" warning when the dispatched replace landed on
        // a stack with nothing behind it). Instead we wipe tokens
        // and let `clearTokens()` -> `notifyAuthStateChanged()`
        // poke every `useIsAuthenticated()` consumer to re-check;
        // they then render their existing inline sign-in CTAs
        // (ActivitySection on home, address-book, activities tab,
        // etc.) without a navigation event.
        //
        // USER_NOT_FOUND is treated the same way as any other 401
        // here even though the JWT was technically valid — the
        // user row is gone, so the only path forward is re-sign,
        // and clearing tokens is what flips `hadPreviousSession`
        // off in every consumer's auth-state cache (the gate the
        // inline CTAs key off).
        console.log(
          isUserDeleted
            ? "401 USER_NOT_FOUND - clearing tokens; consumers will switch to inline sign-in CTAs"
            : "401 Unauthorized - clearing tokens; consumers will switch to inline sign-in CTAs",
        );

        await clearTokens();
      }

      // Throw a structured error so agent executors can classify the
      // 401 via `err.response.status` and return
      // `authentication_required`, which in turn drives the
      // `request_authentication` flow on the next agent turn.
      throw new ApiHttpError(
        401,
        error,
        "Authentication expired. Please sign in again.",
      );
    } else if (response.status === 403) {
      throw new ApiHttpError(
        403,
        error,
        "Access forbidden. You don't have permission for this resource.",
      );
    } else if (response.status === 404) {
      throw new ApiHttpError(404, error, "Resource not found.");
    } else if (response.status === 409) {
      throw new ApiConflictError();
    } else {
      // Log something that identifies the failure. Not every API shapes its
      // body as `{ message }` — the strategies endpoints answer
      // `{ error: "defi_<code>" }` — and printing only `.message` turned every
      // one of those into "API error: undefined", which names neither the
      // endpoint nor the reason. Dev-only; the user still sees fixed copy.
      console.error(
        `API error ${response.status} for ${request.url}:`,
        error.message ?? error.code ?? error.error ?? "(no code in body)",
      );
      throw new ApiHttpError(
        response.status,
        error,
        "Something went wrong. Please try again.",
      );
    }
  }
  console.log(`API Response Status for ${request.url}:`, response.status);
};

const setupBaseHeaders = (request: Request, requestType: string) => {
  console.log(`Making ${requestType} request to:`, request.url);
  request.headers.set("Accept", "application/json");

  if (API_CONFIG.key) {
    request.headers.set("X-API-Key", API_CONFIG.key);
    console.log("API Key set for request");
  } else {
    console.warn("No API key found in environment variables");
  }
};

export const api = ky.create({
  ...createBaseConfig(),
  hooks: {
    beforeRequest: [
      async (request) => {
        setupBaseHeaders(request, "authenticated API");

        try {
          const indexStr = storage.getString("active_wallet_index");
          const idx = indexStr ? parseInt(indexStr, 10) : 0;
          const wallets = await walletService.loadWalletsFromStorage();
          const activeAddr = wallets?.[idx]?.address?.toLowerCase() || null;

          let token: string | null = null;
          if (activeAddr) {
            token = await getAccessTokenForWallet(activeAddr);
          }

          if (!token) {
            const authedWallet =
              (await getAuthenticatedWalletAddress())?.toLowerCase() || null;
            if (authedWallet && authedWallet === activeAddr) {
              token = await getAccessToken();
            }
          }

          if (token) {
            request.headers.set("Authorization", `Bearer ${token}`);
            console.log("Authorization token set for request");
          } else {
            console.warn(
              "No suitable access token for the current active wallet; blocking authenticated request",
            );
            throw new Error("Not authenticated for current wallet");
          }
        } catch (error) {
          console.warn("Failed to get access token:", error);
          throw error;
        }
      },
    ],
    afterResponse: [handleApiResponse],
  },
});

export const optionalAuthApi = ky.create({
  ...createBaseConfig(),
  hooks: {
    beforeRequest: [
      async (request) => {
        setupBaseHeaders(request, "optional-auth API");
        try {
          const indexStr = storage.getString("active_wallet_index");
          const idx = indexStr ? parseInt(indexStr, 10) : 0;
          const wallets = await walletService.loadWalletsFromStorage();
          const activeAddr = wallets?.[idx]?.address?.toLowerCase() || null;

          let token: string | null = null;
          if (activeAddr) {
            token = await getAccessTokenForWallet(activeAddr);
          }
          if (!token) {
            const authedWallet =
              (await getAuthenticatedWalletAddress())?.toLowerCase() || null;
            if (authedWallet && authedWallet === activeAddr) {
              token = await getAccessToken();
            }
          }
          if (token) {
            request.headers.set("Authorization", `Bearer ${token}`);
          }
        } catch {
          // Silently continue without auth — endpoint degrades gracefully
        }
      },
    ],
    afterResponse: [handleApiResponse],
  },
});

/**
 * Creates a ky instance authenticated with a specific wallet's stored
 * token. Used by isolated flows (payment, etc.) that pick a wallet
 * independently of the global `activeWallet` so they never mutate
 * shared state. Throws if no token exists for the given address —
 * callers must ensure the wallet is signed in before using this.
 */
export const createApiForWallet = (walletAddress: string) =>
  ky.create({
    ...createBaseConfig(),
    hooks: {
      beforeRequest: [
        async (request) => {
          setupBaseHeaders(request, "wallet-scoped API");
          const token = await getAccessTokenForWallet(
            walletAddress.toLowerCase(),
          );
          if (!token) {
            throw new Error(
              `No access token for wallet ${walletAddress.slice(0, 8)}…`,
            );
          }
          request.headers.set("Authorization", `Bearer ${token}`);
        },
      ],
      afterResponse: [handleApiResponse],
    },
  });

export const publicApi = ky.create({
  ...createBaseConfig(),
  hooks: {
    beforeRequest: [
      async (request) => {
        setupBaseHeaders(request, "public API");
      },
    ],
    afterResponse: [handleApiResponse],
  },
});
