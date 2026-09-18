/**
 * `services/auth/activeWalletSession.ts` — which wallet is active, and
 * whether the app holds an access token for it.
 *
 * The authenticated `api` client (`constants/configs/ky.ts`) attaches the
 * ACTIVE wallet's bearer on every request, so "can I make an authed call
 * right now?" is a question about the active wallet, not about whether
 * any wallet has ever signed in. Every caller that used to answer it with
 * its own copy of this lookup (`api/endpoints/transactions.ts`, the
 * transfer-record outbox) reads it from here instead.
 */

import {
  getAccessToken,
  getAccessTokenForWallet,
  getAuthenticatedWalletAddress,
} from "@/hooks/queries/useAuth";
import { storage } from "@/lib/storage/mmkv";
import * as walletService from "@/services/walletService";

/**
 * Address of the wallet the UI is currently acting as, or null before any
 * wallet exists. Reads `active_wallet_index` from MMKV — the same key the
 * ky `beforeRequest` hook uses — so this and the bearer selection can never
 * disagree about which wallet is "active".
 */
export async function getActiveWalletAddress(): Promise<string | null> {
  try {
    const indexStr = storage.getString("active_wallet_index");
    const idx = indexStr ? parseInt(indexStr, 10) : 0;
    const wallets = await walletService.loadWalletsFromStorage();
    return wallets?.[idx]?.address ?? null;
  } catch {
    return null;
  }
}

/** True when an access token exists for `address` (per-wallet or legacy slot). */
export async function isAuthenticatedForWallet(
  address: string,
): Promise<boolean> {
  try {
    const lower = address.toLowerCase();
    let token = await getAccessTokenForWallet(lower);
    if (!token) {
      const authedWallet =
        (await getAuthenticatedWalletAddress())?.toLowerCase() || null;
      if (authedWallet && authedWallet === lower) {
        token = await getAccessToken();
      }
    }
    return !!token;
  } catch {
    return false;
  }
}

/** True when the active wallet can make authenticated API calls right now. */
export async function isAuthenticatedForActiveWallet(): Promise<boolean> {
  const active = await getActiveWalletAddress();
  return active ? isAuthenticatedForWallet(active) : false;
}
