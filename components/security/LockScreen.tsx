/**
 * `<LockScreen />` — full-screen overlay gating wallet access. Rendered
 * above the Stack so it covers every route + blocks touch through to
 * the home content behind it.
 *
 * Uses a native `Modal` instead of an inline SafeAreaView so:
 *   - It renders above the expo-router Stack (the previous inline
 *     SafeAreaView let users still interact with the screen behind
 *     it — see screenshot in the review).
 *   - It participates in the OS's modal z-stack, which keeps the
 *     platform biometric sheet anchored correctly on Android.
 *
 * Visual: `BlurView` (expo-blur) with `experimentalBlurMethod` so
 * Android uses the same Gaussian blur implementation as iOS. A thin
 * tint layer on top in the app's existing `bg-light-main-container`
 * colour preserves readability without pulling in the red primary
 * surface colour (the card surfaces behind the blur keep their
 * accent).
 *
 * No sign-out / reset button by design — self-custodial recovery is
 * the user's seed phrase, not an in-app "forget device" button.
 *
 * Contract with the rest of the app:
 *   - The parent (`InitializeApp`) flips `locked=true` whenever
 *     `hasStoredWallets() === true && !didUnlockThisSession`.
 *   - `onUnlocked` runs after a successful `LocalAuthentication` call
 *     + wallet bundle load; the parent is responsible for flipping
 *     the session unlock flag and invalidating the wallets query.
 */

import { BlurView } from "expo-blur";
import * as LocalAuthentication from "expo-local-authentication";
import { Fingerprint } from "lucide-react-native";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { queryClient } from "@/app/_layout";
import QKEY_Wallets from "@/constants/queryKeys/walletQueryKeys";
import type { TWallet } from "@/constants/types/walletTypes";
import { primeAuthState } from "@/hooks/queries/useAuth";
import { warmWalletSigner } from "@/hooks/useWallet";
import { groupWalletsIntoAccounts } from "@/hooks/useWallet.helpers";
import { storage } from "@/lib/storage/mmkv";
import type { Namespace } from "@/services/chains/types";
import { isNoCredentialError } from "@/services/security/deviceSecurityLevel";
import { deriveWalletsFromMnemonic } from "@/services/walletKit/deriveAll";
import { walletKitRegistry } from "@/services/walletKit/registry";
import {
  clearAccountCache,
  clearWalletCache,
  getSeedPhraseForWallet,
  loadWalletsFromStorage,
  saveWalletsToStorage,
} from "@/services/walletService";

type Props = {
  /**
   * Parent may return a promise — the LockScreen awaits it before
   * flipping `isUnlocking` back off, so the spinner stays visible
   * during the two-phase-unlock settle window (see `AppShell.
   * handleUnlocked` in `app/_layout.tsx`).
   */
  onUnlocked: () => void | Promise<void>;
};

export default function LockScreen({ onUnlocked }: Props) {
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string>("Unlock");

  const attempt = useCallback(async () => {
    if (isUnlocking) return;
    setIsUnlocking(true);
    setStatusLabel("Unlocking…");
    // Yield so React commits the spinner + "Unlocking…" state BEFORE
    // the native biometric sheet starts mounting. On some Android
    // devices the biometric prompt takes 100–200 ms to appear; without
    // the yield + spinner the button just looks dead while the OS is
    // busy, and the user often double-taps. 100 ms lets React paint
    // the spinner state, then we call into the OS auth sheet.
    await new Promise((r) => setTimeout(r, 100));
    try {
      // App-level auth gate. `disableDeviceFallback: false` gives the
      // user a "Use passcode" / "Use pattern" link on the native sheet
      // so the flow survives a missing / unenrolled biometric. This
      // prompt is the single source of truth — we never re-auth at
      // the SecureStore layer afterwards.
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock TakumiPay",
        disableDeviceFallback: false,
        cancelLabel: "Cancel",
      });
      // A device with no screen lock at all never gets this far: the
      // boot check in `InitializeApp` skips the LockScreen for it. The
      // one race left is a screen lock removed between that check and
      // this tap. The OS then returns `not_enrolled` / `passcode_not_set`
      // without showing a sheet, so treat it like the boot path would
      // and continue the unlock; the per-action PIN is the gate on such
      // a device (`services/security/deviceSecurityLevel.ts`).
      if (!result.success && !isNoCredentialError(result.error)) return;

      // One frame is enough for React to commit + paint the label —
      // `loadWalletsFromStorage` is native async so it doesn't block
      // the JS thread anyway.
      setStatusLabel("Loading wallet…");
      await new Promise((r) => requestAnimationFrame(r));

      // Load wallets. The bundle read is no longer OS-auth-gated (see
      // `walletSecureStore.ts`). Legacy entries saved under the old
      // `requireAuthentication: true` flag may still trigger ONE final
      // OS prompt at the keystore level; the next save rewrites them
      // without that flag so this is a one-time upgrade cost.
      // TWV-2026-057 Tier 1 — drop BOTH in-memory homes of key material
      // before reloading. `clearWalletCache` wipes the wallet cache and
      // the secret vault; `clearAccountCache` wipes the DERIVED signers,
      // which independently hold key material (viem accounts close over
      // the private key, and the Sui / Stellar keypairs hold the raw
      // secret). Until this change `clearAccountCache` had no live
      // caller at all, so those signers survived every lock.
      clearWalletCache();
      clearAccountCache();
      let wallets = await loadWalletsFromStorage();
      if (wallets.length === 0) return;

      // Push the loaded wallets directly into React Query's cache. Home
      // mounts BEHIND the LockScreen Modal, so every `useWallet()`
      // consumer's `useQuery` already ran its `initialData()` before
      // we got here — at that point `cachedWallets` was null, so
      // `initialData` returned undefined, and `wallets` for those
      // consumers defaulted to `[]`. That's the root of the returning
      // Activity skeleton: empty `wallets` → empty `activeWallet` →
      // null `walletKey` → `useIsAuthenticated`'s cache read misses
      // → `isLoading: true` → skeleton shows until the queryFn
      // eventually resolves.
      //
      // Setting the data directly on the query cache notifies all
      // subscribers (useWallet consumers) immediately — they
      // re-render BEHIND the lock with real `wallets`, so by the
      // time `isLocked` flips to false, every downstream hook has
      // the correct `walletKey` on first render.
      queryClient.setQueryData([QKEY_Wallets.wallets], wallets);

      // Identify the active wallet + its full account (paired EVM +
      // Solana rows). Pre-warming the whole account, not just the
      // active row, means a subsequent chain switch within the account
      // hits warm caches too. Still cheap — typical account is 2 rows.
      const storedIndex = storage.getString("active_wallet_index");
      const activeIdx = storedIndex ? parseInt(storedIndex, 10) : 0;
      const activeWallet = wallets[activeIdx] ?? wallets[0];

      // One-time Phantom-style backfill: if any mnemonic-backed wallet
      // is missing a pair for a registered kit (pre-Solana users post-
      // upgrade), derive the missing rows NOW inside the spinner. This
      // used to run behind the lock via a `useEffect` in `useWallet`,
      // which meant the ~200–500 ms derivation cost landed on the
      // render thread right after dismiss. Running it here keeps the
      // wait on the "Syncing chains…" screen the user already expects.
      try {
        // TWV-2026-057 Tier 1 — `wallets` is stripped, so the mnemonic
        // comes from the wallet service's vault. Grouping still keys on
        // the non-secret `seedGroupId`; the plaintext is fetched once
        // per group, only for the groups that actually need deriving.
        const bySeed = new Map<string, Set<Namespace>>();
        const seedForGroup = new Map<string, string>();
        for (const w of wallets) {
          const groupId = w.seedGroupId;
          if (typeof groupId !== "string" || groupId.length === 0) continue;
          const set = bySeed.get(groupId) ?? new Set<Namespace>();
          set.add(w.namespace);
          bySeed.set(groupId, set);
          if (!seedForGroup.has(groupId)) {
            const seed = getSeedPhraseForWallet(w);
            if (seed) seedForGroup.set(groupId, seed);
          }
        }
        const registered = walletKitRegistry
          .getAll()
          .map((kit) => kit.namespace);
        const toDerive: Array<{ seed: string; missing: Namespace[] }> = [];
        for (const [groupId, have] of bySeed) {
          const missing = registered.filter((ns) => !have.has(ns));
          if (missing.length === 0) continue;
          const seed = seedForGroup.get(groupId);
          if (!seed) continue;
          toDerive.push({ seed, missing });
        }
        if (toDerive.length > 0) {
          setStatusLabel("Syncing chains…");
          await new Promise((r) => requestAnimationFrame(r));
          const minted: TWallet[] = [];
          for (const { seed, missing } of toDerive) {
            const pairs = await deriveWalletsFromMnemonic(seed, missing);
            minted.push(...pairs);
          }
          if (minted.length > 0) {
            const seenAddrs = new Set(wallets.map((w) => w.address));
            const additions = minted.filter((w) => !seenAddrs.has(w.address));
            if (additions.length > 0) {
              wallets = [...wallets, ...additions];
              await saveWalletsToStorage(wallets);
              // Re-push into the query cache so useWallet consumers
              // see the derived pair too (e.g. a pre-Solana user's
              // newly-added Solana wallet shows up without a
              // post-dismiss refetch).
              queryClient.setQueryData([QKEY_Wallets.wallets], wallets);
            }
          }
        }
      } catch {
        // Best-effort — if backfill fails, user's existing wallets
        // still unlock fine; pairing can retry post-dismiss.
      }

      // CRITICAL — warm the active account's signers BEFORE dismissing
      // the LockScreen. Without this, `isLocked` flips to `false` and
      // every gated hook in the tree fires simultaneously (useWallet
      // pre-warm, useDepositPrefetch, AgentMode pre-mount, etc.). The
      // AgentMode mount in particular calls `getAccountForWallet`
      // synchronously in a useMemo, triggering BIP-32 derivation on
      // the render thread — that's the freeze users felt right after
      // unlock. Warming here pays the tax while the user is still
      // looking at the spinner.
      setStatusLabel("Preparing wallet…");
      await new Promise((r) => requestAnimationFrame(r));
      try {
        // Warm ONLY the active wallet — NOT the full account pair.
        // BIP-32 via @scure/bip32 runs in pure JS (not accelerated by
        // react-native-quick-crypto, which only intercepts libs that
        // use Node's `crypto` module / `globalThis.crypto.subtle`).
        // In dev mode each derivation costs ~1–2 s, so warming every
        // paired wallet turned a 0.3 s unlock into a 5 s one.
        //
        // The paired wallet (the other-namespace row in this account)
        // warms lazily the first time the user switches chain — that
        // switch already flows through `handleAccountSwitch` /
        // `changeActiveChainInternal` which wrap the derivation in
        // the chain-switch overlay, so the cost lands there, not here.
        if (activeWallet) {
          await warmWalletSigner(activeWallet);
        }
      } catch {
        // Warming is best-effort — if it fails, downstream hooks will
        // warm lazily on first use. Never block unlock on this.
      }

      // Prime the auth-state cache (in-memory + MMKV hint) for the
      // active wallet so home's `useIsAuthenticated` consumers see
      // `isLoading: false` on first render — no "Activities" skeleton
      // flash. Runs fast (5 parallel SecureStore reads).
      const activeAddrLower = activeWallet?.address?.toLowerCase() ?? null;
      if (activeAddrLower) {
        await primeAuthState(activeAddrLower);
      }

      // Removed the home-screen query prefetch pass — with
      // `useTokens` + `useBlockchainsWithStorage` + the wallet
      // queries all seeded via `initialData` from sync MMKV reads,
      // home renders without waiting on network-backed queries.
      // The prefetch was adding 200–1500 ms to the unlock wait for
      // no perceptible benefit.

      // Flip the app state. Signer caches are hot, auth state is
      // primed, wallet-index + chain resolved synchronously from
      // MMKV. Home mounts with everything ready.
      await onUnlocked();
    } catch {
      // Swallow — user can tap Unlock again. No state-change copy
      // because the OS sheet already surfaced the error.
    } finally {
      setIsUnlocking(false);
      setStatusLabel("Unlock");
    }
  }, [isUnlocking, onUnlocked]);

  return (
    <Modal
      visible
      transparent
      statusBarTranslucent
      animationType="fade"
      // Intercept the hardware back button on Android — we don't want
      // the user silently backing out to an interactable home screen.
      onRequestClose={() => {}}
    >
      <StatusBar barStyle="dark-content" />
      <BlurView
        intensity={18}
        tint="light"
        experimentalBlurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFill}
      >
        {/* Tint layer — a light wash in the app's neutral surface so
            whatever renders behind stays recognisable through the
            glass while remaining non-interactive. */}
        <View
          style={StyleSheet.absoluteFill}
          className="bg-light-main-container/40"
          pointerEvents="none"
        />
        <SafeAreaView className="flex-1" edges={["top", "bottom"]}>
          <View className="flex-1 items-center justify-center px-8">
            <View className="w-20 h-20 rounded-full bg-light-primary-red/10 items-center justify-center mb-6">
              <Fingerprint size={40} color="#c71c4b" />
            </View>

            <Text className="text-light-matte-black text-2xl font-bold text-center mb-2">
              Welcome back
            </Text>
            <Text className="text-light-matte-black/60 text-center text-sm leading-5 mb-8">
              Tap Unlock to continue.
            </Text>

            <TouchableOpacity
              activeOpacity={0.85}
              onPress={attempt}
              disabled={isUnlocking}
              accessibilityRole="button"
              accessibilityLabel="Unlock wallet"
              className={`w-full flex-row items-center justify-center py-4 px-6 rounded-2xl ${
                isUnlocking ? "bg-light-primary-red/60" : "bg-light-primary-red"
              }`}
            >
              {isUnlocking ? (
                <>
                  <ActivityIndicator color="#ffffff" />
                  <Text className="text-white font-semibold ml-2">
                    {statusLabel}
                  </Text>
                </>
              ) : (
                <>
                  <Fingerprint size={20} color="#ffffff" />
                  <Text className="text-white font-semibold ml-2">
                    {statusLabel}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </BlurView>
    </Modal>
  );
}
