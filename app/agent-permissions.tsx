/**
 * Agent Permissions settings screen.
 *
 * Spec: `AGENT_PROTOCOL.md` §6 "App Settings: Managing Active Grants"
 *       and §6 "Default Permission Mode".
 *
 * Lets the user inspect and revoke the permission grants that the AI
 * agent is currently allowed to act on, switch between the three
 * default-permission modes ("Always ask", "Agent decides", "Full auto"),
 * and switch between connected wallets (grants are wallet-scoped).
 *
 * All non-UI logic lives in `services/agentPermissionsHelpers.ts` and is
 * unit-tested from there; this file is deliberately a thin renderer on
 * top of those helpers and the `PermissionGrantStore` public API.
 */

import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Eye,
  Shield,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Trash2,
} from "lucide-react-native";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import AgentAllowanceSheet, {
  type SelectedAllowanceToken,
} from "@/components/agent/AgentAllowanceSheet";
import LoadinngSpinnerPopup from "@/components/common/LoadinngSpinnerPopup";
import PinConfirmationModal from "@/components/common/PinConfirmationModal";
import { findEvmChainById } from "@/constants/configs/chainConfig";
import { useWallet } from "@/hooks/useWallet";
import {
  type AllowanceLifetime,
  buildErc20AllowanceConfig,
  formatTokenAmountDisplay,
  parseTokenAmount,
  randomDelegationSalt,
} from "@/services/agentDelegationMapping";
import {
  computeCurrentMode,
  type DefaultPermissionMode,
  formatLifetimeLabel,
  formatScopeLabel,
  groupDelegationGrantsByChain,
  isCapabilityAsk,
  isCapabilityDenied,
  listRenderableGrants,
  partitionGrants,
} from "@/services/agentPermissionsHelpers";
import type { Namespace } from "@/services/chains/types";
import { confirmedCounterpartyStore } from "@/services/confirmedCounterpartyStore";
import {
  type DelegationMeta,
  type GrantLifetime,
  getPermissionGrantStore,
  type PermissionGrant,
} from "@/services/permissionGrantStore";
import {
  chainBadgeLabel,
  formatChainLabel,
} from "@/services/walletKit/chainInfo";
import type { DelegationStruct } from "@/services/walletKit/types";
import { truncateAddress } from "@/utils/walletUtils";

// --- Mode metadata ---------------------------------------------------------

interface ModeMeta {
  id: DefaultPermissionMode;
  label: string;
  subtitle: string;
  accessibilityHint: string;
}

const MODES: ModeMeta[] = [
  {
    id: "always_ask",
    label: "Always ask",
    subtitle: "Every action needs your explicit tap.",
    accessibilityHint: "Every agent action will require explicit confirmation.",
  },
  {
    id: "agent_decides",
    label: "Agent decides",
    subtitle:
      "Writes you haven't pre-approved show a proposal card you confirm.",
    accessibilityHint:
      "Unapproved writes ask first via a proposal card, then an approval sheet.",
  },
  {
    id: "full_auto",
    label: "Full auto",
    subtitle: "Writes auto-approve after a 6-second run-down you can veto.",
    accessibilityHint:
      "The agent submits writes after a 6 second countdown you can cancel; nothing executes silently.",
  },
];

// --- Capability auto-approve metadata --------------------------------------

/**
 * "Always allow" toggles surfaced as a separate section. These map onto
 * capability-scoped permanent grants in `PermissionGrantStore` and are
 * orthogonal to the global mode selector — a user can be in
 * "Agent decides" AND have read actions auto-approved.
 *
 * Write is intentionally NOT exposed here. Auto-approving every write
 * is exactly what "Full auto" mode does, and that path warrants the
 * existing destructive confirmation dialog. Splitting it across two
 * controls would invite users to bypass the warning.
 */
interface CapabilityMeta {
  capability: "read";
  label: string;
  subtitle: string;
  icon: typeof Eye;
  accessibilityHint: string;
}

const AUTO_APPROVE_CAPABILITIES: CapabilityMeta[] = [
  {
    capability: "read",
    label: "Auto-approve read actions",
    subtitle: "Agent reads balances, history, and prices without asking.",
    icon: Eye,
    accessibilityHint:
      "When on, the agent can perform read-only actions without prompting.",
  },
];

// --- Helpers ---------------------------------------------------------------

function grantKey(grant: PermissionGrant): string {
  const scopeKey =
    grant.scope.kind === "global"
      ? "global"
      : `${grant.scope.kind}:${(grant.scope as { key: string }).key}`;
  return `${scopeKey}|${grant.lifetime.type}`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// --- Screen ----------------------------------------------------------------

export default function AgentPermissionsScreen() {
  const {
    wallets,
    activeWallet,
    activeWalletIndex,
    setActiveWallet,
    activeChain,
    getKitForWallet,
  } = useWallet();
  const { bottom } = useSafeAreaInsets();

  const [selectedWalletIndex, setSelectedWalletIndex] =
    useState<number>(activeWalletIndex);
  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const [renderKey, forceRender] = useState(0);
  const [showAllowanceSheet, setShowAllowanceSheet] = useState(false);
  const [signingAllowance, setSigningAllowance] = useState(false);
  const [allowanceError, setAllowanceError] = useState("");
  // Allowance params captured from the sheet, held while the PIN modal
  // gates the onchain signature (mirrors the EIP-7702 upgrade flow).
  const [pendingAllowance, setPendingAllowance] = useState<{
    token: SelectedAllowanceToken;
    amountText: string;
    lifetime: AllowanceLifetime;
  } | null>(null);
  const [showAllowancePin, setShowAllowancePin] = useState(false);

  // If the tab-level active wallet changes, follow it.
  useEffect(() => {
    setSelectedWalletIndex(activeWalletIndex);
  }, [activeWalletIndex]);

  const selectedWallet = wallets[selectedWalletIndex] ?? activeWallet;
  const address = (selectedWallet?.address ?? "") as `0x${string}`;

  // Destinations this wallet has confirmed (deny-layer §4.0 extension).
  // Re-read on every store mutation so a confirmation installed by a live
  // approval sheet shows up here without a remount, mirroring how the
  // grant list above stays in sync.
  useSyncExternalStore(
    confirmedCounterpartyStore.subscribe,
    confirmedCounterpartyStore.getVersion,
  );
  const knownDestinations = address
    ? confirmedCounterpartyStore.list(address)
    : [];

  /**
   * Forgetting a destination does not undo anything already sent — it
   * only means the agent must ask again next time, so the copy promises
   * exactly that and nothing more.
   */
  const handleForgetDestination = useCallback(
    (entry: { address: string; namespace: Namespace }) => {
      Alert.alert(
        "Forget this destination?",
        "The agent will ask you to confirm the next time it sends here. Anything already sent is not affected.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Forget",
            style: "destructive",
            onPress: () => {
              confirmedCounterpartyStore.revoke(
                address,
                entry.namespace,
                entry.address,
              );
            },
          },
        ],
      );
    },
    [address],
  );

  // The SHARED per-wallet grant store (spec §6.7 P0). Settings, the live
  // agent session, and the approval flow all read/write this same instance
  // via `getPermissionGrantStore`, so an edit here takes effect on the
  // next tool call without a remount.
  const store = useMemo(() => {
    if (!address) return null;
    return getPermissionGrantStore(address);
  }, [address]);

  // Re-render when the store changes from ANY surface (e.g. a grant the
  // approval flow installed mid-session) so the list stays in sync.
  useEffect(() => {
    if (!store) return;
    return store.subscribe(() => forceRender((n) => n + 1));
  }, [store]);

  // Prune expired timed grants on mount / wallet change.
  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    store.whenLoaded().then(() => {
      if (cancelled) return;
      store.prune();
      forceRender((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [store]);

  const grants = useMemo(() => {
    if (!store || !address) return [];
    return listRenderableGrants(store.list(address));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- renderKey triggers recalc after store mutations
  }, [store, address, renderKey]);

  const currentMode = useMemo(() => computeCurrentMode(grants), [grants]);

  // Split local-policy grants (rendered in "Active grants") from onchain
  // ERC-7710 delegation grants (rendered in the dedicated allowance
  // section below).
  const { local: localGrants, delegations: delegationGrants } = useMemo(
    () => partitionGrants(grants),
    [grants],
  );

  const refresh = useCallback(() => {
    forceRender((n) => n + 1);
  }, []);

  // --- Onchain delegation (ERC-7710) --------------------------------------
  //
  // Space-docking: the allowance section only appears when the selected
  // wallet's kit implements the delegation capability AND the active
  // chain belongs to the same namespace as the wallet. Non-EVM wallets
  // (Solana / Sui) leave these methods undefined, so the whole section
  // self-hides without any namespace branch.
  const kit = useMemo(
    () => (selectedWallet ? getKitForWallet(selectedWallet) : null),
    [selectedWallet, getKitForWallet],
  );

  const delegationSupported =
    typeof kit?.createDelegation === "function" &&
    typeof kit?.signDelegation === "function";

  // The delegation needs a chain that matches the wallet's namespace.
  const chainForWallet =
    selectedWallet?.namespace &&
    activeChain.namespace === selectedWallet.namespace
      ? activeChain
      : null;

  const chainId = useMemo(() => {
    if (!kit || !chainForWallet || !kit.getChainId) return null;
    const id = kit.getChainId(chainForWallet);
    return typeof id === "number" ? id : null;
  }, [kit, chainForWallet]);

  const { data: smartAccountActive } = useQuery({
    queryKey: ["agent-permissions-smart-account-active", address, chainId],
    queryFn: async () => {
      if (!kit?.isSmartAccountActive || !selectedWallet || !chainForWallet) {
        return false;
      }
      return kit.isSmartAccountActive(selectedWallet, chainForWallet);
    },
    enabled:
      delegationSupported &&
      typeof kit?.isSmartAccountActive === "function" &&
      !!chainForWallet &&
      chainId !== null,
  });

  // The "Authorize" affordance targets the *active* chain, so it's only
  // available when the kit supports delegation and the active chain is an
  // EVM chain (chainId resolves to a number).
  const canAuthorizeOnActiveChain = delegationSupported && chainId !== null;

  // Existing allowances grouped by the chain they were signed on. Sourced
  // from the grants themselves, so only chains the user has executed an
  // allowance on appear (and a chain drops off when its last allowance is
  // revoked) — no separate per-chain store to keep in sync.
  const delegationGroups = useMemo(
    () =>
      groupDelegationGrantsByChain(delegationGrants, (id) => {
        const cfg = findEvmChainById(id);
        return cfg ? formatChainLabel(cfg) : undefined;
      }),
    [delegationGrants],
  );

  // Whole section shows if there's something to authorize on this chain
  // OR there are existing allowances from any chain to display/revoke.
  const showAllowanceCard =
    canAuthorizeOnActiveChain || delegationGroups.length > 0;

  // Step 1: the sheet collected token + amount + duration. Stash it and
  // hand off to the PIN modal — signing an onchain delegation is a write,
  // so it's gated by the same PIN confirmation the EIP-7702 upgrade uses
  // (not a silent biometric).
  const handleAuthorizeAllowance = useCallback(
    (args: {
      token: SelectedAllowanceToken;
      amountText: string;
      lifetime: AllowanceLifetime;
    }) => {
      if (parseTokenAmount(args.amountText, args.token.decimals) <= 0n) return;
      setAllowanceError("");
      setPendingAllowance(args);
      setShowAllowanceSheet(false);
      setShowAllowancePin(true);
    },
    [],
  );

  // Step 2: PIN verified → build, sign, and persist the delegation.
  const handleAllowancePinConfirm = useCallback(async () => {
    setShowAllowancePin(false);
    const args = pendingAllowance;
    setPendingAllowance(null);
    if (!args || !store || !address || !kit || !chainForWallet) return;
    if (chainId === null) return;
    if (
      typeof kit.createDelegation !== "function" ||
      typeof kit.signDelegation !== "function"
    ) {
      return;
    }
    const { token, amountText, lifetime } = args;
    const maxAmount = parseTokenAmount(amountText, token.decimals);
    if (maxAmount <= 0n) return;

    setSigningAllowance(true);
    try {
      const tokenAddress = token.contractAddress;

      const { scope, caveats } = buildErc20AllowanceConfig({
        tokenAddress,
        maxAmount,
        lifetime,
      });

      // SI-4: the delegation `delegate` MUST equal the relayer's
      // redemption `targetAddress` — the address that actually redeems the
      // delegation at settle time. We resolve it LIVE from
      // `relayer_getCapabilities` and there is NO hardcoded fallback: a
      // wrong/guessed delegate produces a grant the relayer rejects later
      // ("delegate must be the relayer Target wallet"), so we fail loudly
      // here instead of signing a dead allowance.
      let delegate: `0x${string}`;
      try {
        const caps = await kit.getRelayerCapabilities?.({
          chain: chainForWallet,
        });
        const target = caps?.[chainId]?.targetAddress;
        if (!target || !/^0x[0-9a-fA-F]{40}$/.test(target)) {
          throw new Error("relayer returned no targetAddress");
        }
        delegate = target.toLowerCase() as `0x${string}`;
      } catch (capErr) {
        if (__DEV__) {
          console.error(
            "[agent-permissions] could not resolve relayer delegate — refusing to sign a hardcoded one",
            capErr,
          );
        }
        setAllowanceError(
          "We couldn't reach the relayer to set up the allowance. Please try again.",
        );
        return;
      }

      const unsigned = await kit.createDelegation({
        wallet: selectedWallet,
        chain: chainForWallet,
        delegate,
        scope,
        caveats,
        salt: randomDelegationSalt(),
      });

      const signature = await kit.signDelegation({
        wallet: selectedWallet,
        chain: chainForWallet,
        delegation: unsigned,
      });

      const signed: DelegationStruct = { ...unsigned, signature };

      const grantLifetime: GrantLifetime =
        lifetime.type === "timed"
          ? { type: "timed", expires_at: lifetime.expiresAtMs }
          : { type: "permanent" };

      const meta: DelegationMeta = {
        delegate,
        chainId,
        chainName: formatChainLabel(chainForWallet),
        tokenAddress,
        tokenSymbol: token.symbol,
        tokenDecimals: token.decimals,
        maxAmount: maxAmount.toString(),
      };

      store.add({
        // Key is chain + token so allowances for the same token on
        // different chains coexist instead of overwriting each other.
        scope: {
          kind: "delegation",
          key: `${chainId}:${tokenAddress.toLowerCase()}`,
        },
        lifetime: grantLifetime,
        wallet_address: address,
        granted_at: Date.now(),
        delegation: signed,
        delegationMeta: meta,
      });

      refresh();
    } catch (err) {
      if (__DEV__) {
        console.warn("agent-permissions: allowance signing failed", err);
      }
      setAllowanceError(
        "We couldn't authorize the onchain allowance. Please try again.",
      );
    } finally {
      setSigningAllowance(false);
    }
  }, [
    pendingAllowance,
    store,
    address,
    kit,
    chainForWallet,
    selectedWallet,
    chainId,
    refresh,
  ]);

  // --- Mutations ----------------------------------------------------------

  const handleRevoke = useCallback(
    (grant: PermissionGrant) => {
      if (!store) return;
      const label = formatScopeLabel(grant.scope);
      Alert.alert(
        "Revoke permission",
        `Revoke the "${label}" grant? The agent will need to ask again on its next matching action.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Revoke",
            style: "destructive",
            onPress: () => {
              store.remove(grant);
              refresh();
            },
          },
        ],
      );
    },
    [store, refresh],
  );

  // "Reset to defaults" (deny-layer spec §D-4). A *maintenance* action
  // that clears every override (Auto / Ask / Never grants) and returns to
  // the Default rule. Renamed from "Revoke all" so it no longer reads like
  // a second "block" action next to the Write→Never rule.
  const handleResetToDefaults = useCallback(() => {
    if (!store || !address) return;
    Alert.alert(
      "Reset to defaults",
      "This clears every permission override for this wallet (including any blocks) and returns to the default rule. The agent will ask for approval on writes until you set new rules.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: () => {
            store.revokeAll(address);
            refresh();
          },
        },
      ],
    );
  }, [store, address, refresh]);

  const applyMode = useCallback(
    (mode: DefaultPermissionMode) => {
      if (!store || !address) return;
      const now = Date.now();
      if (mode === "always_ask") {
        store.add({
          scope: { kind: "global" },
          lifetime: { type: "always_ask" },
          wallet_address: address,
          granted_at: now,
        });
      } else if (mode === "agent_decides") {
        // Clear ONLY the global-scope grant — capability/tool grants
        // are user-managed via the auto-approve section and the active
        // grants list, and shouldn't disappear because the user moved
        // the global default. Mirrors `revokeAll` semantics but
        // narrowed to scope: global.
        store.remove({
          scope: { kind: "global" },
          lifetime: { type: "permanent" },
          wallet_address: address,
          granted_at: now,
        });
        store.remove({
          scope: { kind: "global" },
          lifetime: { type: "always_ask" },
          wallet_address: address,
          granted_at: now,
        });
      } else {
        // full_auto
        store.add({
          scope: { kind: "global" },
          lifetime: { type: "permanent" },
          wallet_address: address,
          granted_at: now,
        });
      }
      refresh();
    },
    [store, address, refresh],
  );

  // Reads are auto-approved by DEFAULT (the wallet policy treats reads as
  // silent). So the toggle is ON unless the user has explicitly pinned
  // reads to "ask" (a capability:read always_ask grant) or blocked them.
  // This is why a fresh wallet shows the toggle ON even with no grants —
  // it reflects the real default, not just an explicit grant.
  const readAutoApproved = useMemo(
    () =>
      !isCapabilityAsk(grants, "read") && !isCapabilityDenied(grants, "read"),
    [grants],
  );

  const applyReadAutoApprove = useCallback(
    (enabled: boolean) => {
      if (!store || !address) return;
      if (enabled) {
        // Back to the Auto default: clear any read restriction grant.
        // `remove` matches by scope, so this drops an always_ask/deny/
        // permanent read grant whatever its lifetime.
        store.remove({
          scope: { kind: "capability", key: "read" },
          lifetime: { type: "always_ask" },
          wallet_address: address,
          granted_at: 0,
        });
      } else {
        // Make reads ask before running.
        store.add({
          scope: { kind: "capability", key: "read" },
          lifetime: { type: "always_ask" },
          wallet_address: address,
          granted_at: Date.now(),
        });
      }
      refresh();
    },
    [store, address, refresh],
  );

  // "Block all writes" = `Write → Never` (deny-layer spec §D-4). Installs
  // / removes a capability-scoped `always_deny`; deny-overrides-allow then
  // blocks every write tool, un-bypassable by any per-tool Auto. This is a
  // rule value, NOT a second destructive button next to "Reset".
  const applyWriteBlock = useCallback(
    (blocked: boolean) => {
      if (!store || !address) return;
      if (blocked) {
        store.add({
          scope: { kind: "capability", key: "write" },
          lifetime: { type: "always_deny" },
          wallet_address: address,
          granted_at: Date.now(),
        });
      } else {
        store.remove({
          scope: { kind: "capability", key: "write" },
          lifetime: { type: "always_deny" },
          wallet_address: address,
          granted_at: 0,
        });
      }
      refresh();
    },
    [store, address, refresh],
  );

  const writesBlocked = useMemo(
    () => isCapabilityDenied(grants, "write"),
    [grants],
  );

  const handleSelectMode = useCallback(
    (mode: DefaultPermissionMode) => {
      if (mode === currentMode) return;
      if (mode === "full_auto") {
        Alert.alert(
          "Enable Full auto?",
          "Full auto lets the agent sign and submit transactions without asking — including sending funds out of this wallet. Only enable this if you completely trust the agent's instructions. You can switch back at any time.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Enable Full auto",
              style: "destructive",
              onPress: () => applyMode(mode),
            },
          ],
        );
        return;
      }
      if (mode === "always_ask") {
        Alert.alert(
          "Switch to Always ask?",
          "Every agent action will require your explicit confirmation. Existing grants stay on file but will be overridden.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Switch", onPress: () => applyMode(mode) },
          ],
        );
        return;
      }
      // agent_decides
      Alert.alert(
        "Switch to Agent decides?",
        "This removes the global override and falls back to your wallet's approval policy. Your auto-approve toggles and per-tool grants stay as-is.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Switch",
            onPress: () => applyMode(mode),
          },
        ],
      );
    },
    [currentMode, applyMode],
  );

  const handlePickWallet = useCallback(
    (index: number) => {
      setSelectedWalletIndex(index);
      setShowWalletPicker(false);
      // Also update the app-wide active wallet so the rest of the app
      // stays in sync with what the user is inspecting.
      setActiveWallet(index);
    },
    [setActiveWallet],
  );

  const nowMs = Date.now();

  // --- Render -------------------------------------------------------------

  return (
    <>
      <SystemBars style="dark" />
      <SafeAreaView
        className="flex-1 bg-light-main-container"
        edges={["top"]}
        style={{ paddingBottom: bottom > 0 ? bottom : 0 }}
      >
        {/* Header */}
        <View className="px-4 pt-2 pb-4">
          <View className="flex-row items-center gap-3">
            <Pressable
              onPress={() => router.back()}
              hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              className="w-9 h-9 rounded-xl bg-light items-center justify-center shadow-sm"
              accessibilityRole="button"
              accessibilityLabel="Back"
            >
              <ArrowLeft size={18} color="#c71c4b" />
            </Pressable>
            <View className="flex-1">
              <Text className="text-light-matte-black text-2xl font-bold tracking-tight">
                Agent Permissions
              </Text>
              <Text className="text-light-matte-black/50 text-xs mt-0.5">
                What the AI agent is allowed to do on your behalf.
              </Text>
            </View>
          </View>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 48 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Wallet picker */}
          <View className="mx-4 mb-4">
            <Text className="text-light-matte-black/50 text-xs uppercase tracking-wide mb-2 ml-1">
              Wallet
            </Text>
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => {
                if (wallets.length > 1) setShowWalletPicker((v) => !v);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Active wallet: ${selectedWallet?.name ?? ""}, ${shortAddress(address)}`}
              className="bg-light rounded-2xl px-4 py-3 flex-row items-center justify-between"
              style={{
                shadowColor: "#000",
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.04,
                shadowRadius: 6,
                elevation: 1,
              }}
            >
              <View className="flex-1">
                <Text
                  className="text-light-matte-black font-semibold text-base"
                  numberOfLines={1}
                >
                  {selectedWallet?.name || "Wallet"}
                </Text>
                <Text className="text-light-matte-black/50 text-xs mt-0.5">
                  {address ? shortAddress(address) : "No address"}
                </Text>
              </View>
              {wallets.length > 1 && <ChevronDown size={18} color="#c71c4b" />}
            </TouchableOpacity>

            {showWalletPicker && wallets.length > 1 && (
              <View className="bg-light rounded-2xl mt-2 overflow-hidden">
                {wallets.map((w, index) => {
                  const isSelected = index === selectedWalletIndex;
                  return (
                    <TouchableOpacity
                      key={w.address || `wallet-${index}`}
                      onPress={() => handlePickWallet(index)}
                      accessibilityRole="button"
                      accessibilityLabel={`Switch to wallet ${w.name}`}
                      className={`px-4 py-3 flex-row items-center justify-between ${index > 0 ? "border-t border-light-matte-black/5" : ""}`}
                    >
                      <View className="flex-1">
                        <Text
                          className="text-light-matte-black font-medium"
                          numberOfLines={1}
                        >
                          {w.name}
                        </Text>
                        <Text className="text-light-matte-black/50 text-xs mt-0.5">
                          {shortAddress(w.address)}
                        </Text>
                      </View>
                      {isSelected && (
                        <View className="w-2.5 h-2.5 rounded-full bg-light-primary-red" />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>

          {/* Active grants list */}
          <View className="mx-4 mb-6">
            <Text className="text-light-matte-black/50 text-xs uppercase tracking-wide mb-2 ml-1">
              Active grants
            </Text>
            <View
              className="bg-light rounded-2xl overflow-hidden"
              style={{
                shadowColor: "#000",
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.04,
                shadowRadius: 6,
                elevation: 1,
              }}
            >
              {localGrants.length === 0 ? (
                <View className="px-4 py-8 items-center">
                  <Shield size={28} color="#c71c4b" />
                  <Text className="text-light-matte-black font-semibold mt-3">
                    No active grants
                  </Text>
                  <Text className="text-light-matte-black/50 text-xs text-center mt-1 max-w-[260px]">
                    The agent will ask for approval before running any write
                    actions on this wallet.
                  </Text>
                </View>
              ) : (
                localGrants.map((grant, index) => {
                  const scopeLabel = formatScopeLabel(grant.scope);
                  const lifetime = formatLifetimeLabel(
                    grant.lifetime,
                    nowMs,
                    grant.granted_at,
                  );
                  const fullDescription = `${scopeLabel}, ${lifetime.primary}${lifetime.secondary ? `, ${lifetime.secondary}` : ""}`;
                  return (
                    <View
                      key={grantKey(grant)}
                      accessible
                      accessibilityLabel={fullDescription}
                      className={`px-4 py-3 flex-row items-center justify-between ${index > 0 ? "border-t border-light-matte-black/5" : ""}`}
                    >
                      <View className="flex-1 pr-3">
                        <Text
                          className="text-light-matte-black font-semibold"
                          numberOfLines={1}
                        >
                          {scopeLabel}
                        </Text>
                        <Text className="text-light-matte-black/60 text-xs mt-0.5">
                          {lifetime.primary}
                          {lifetime.secondary ? ` • ${lifetime.secondary}` : ""}
                        </Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => handleRevoke(grant)}
                        accessibilityRole="button"
                        accessibilityLabel={`Revoke ${scopeLabel}`}
                        hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                        className="bg-light-primary-red/10 px-3 py-1.5 rounded-xl"
                      >
                        <Text className="text-light-primary-red text-xs font-semibold">
                          Revoke
                        </Text>
                      </TouchableOpacity>
                    </View>
                  );
                })
              )}
            </View>
          </View>

          {/* Onchain agent allowance (ERC-7710) — space-docking gated.
              Allowances are grouped by the chain they were signed on. */}
          {showAllowanceCard && (
            <View className="mx-4 mb-6">
              <Text className="text-light-matte-black/50 text-xs uppercase tracking-wide mb-2 ml-1">
                Spending delegation
              </Text>

              {delegationGroups.map((group) => (
                <View key={group.chainId} className="mb-3">
                  <View className="flex-row items-center mb-1.5 ml-1">
                    <View className="w-1.5 h-1.5 rounded-full bg-light-primary-red mr-2" />
                    <Text className="text-light-matte-black/70 text-xs font-semibold">
                      {group.chainName}
                    </Text>
                  </View>
                  <View
                    className="bg-light rounded-2xl overflow-hidden"
                    style={{
                      shadowColor: "#000",
                      shadowOffset: { width: 0, height: 2 },
                      shadowOpacity: 0.04,
                      shadowRadius: 6,
                      elevation: 1,
                    }}
                  >
                    {group.grants.map((grant, index) => {
                      const meta = grant.delegationMeta;
                      const amountLabel = meta
                        ? `${formatTokenAmountDisplay(
                            BigInt(meta.maxAmount),
                            meta.tokenDecimals,
                          )} ${meta.tokenSymbol}`
                        : "Allowance";
                      const lifetime = formatLifetimeLabel(
                        grant.lifetime,
                        nowMs,
                        grant.granted_at,
                      );
                      return (
                        <View
                          key={grantKey(grant)}
                          accessible
                          accessibilityLabel={`Spending delegation on ${group.chainName}, up to ${amountLabel}, ${lifetime.primary}`}
                          className={`px-4 py-3 flex-row items-center justify-between ${index > 0 ? "border-t border-light-matte-black/5" : ""}`}
                        >
                          <View className="w-9 h-9 rounded-xl bg-light-primary-red/10 items-center justify-center mr-3">
                            <ShieldCheck size={18} color="#c71c4b" />
                          </View>
                          <View className="flex-1 pr-3">
                            <Text
                              className="text-light-matte-black font-semibold"
                              numberOfLines={1}
                            >
                              Spend up to {amountLabel}
                            </Text>
                            <Text className="text-light-matte-black/60 text-xs mt-0.5">
                              {lifetime.primary}
                              {lifetime.secondary
                                ? ` • ${lifetime.secondary}`
                                : ""}
                            </Text>
                          </View>
                          <TouchableOpacity
                            onPress={() => handleRevoke(grant)}
                            accessibilityRole="button"
                            accessibilityLabel={`Revoke spending delegation for ${amountLabel} on ${group.chainName}`}
                            hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                            className="bg-light-primary-red/10 px-3 py-1.5 rounded-xl"
                          >
                            <Text className="text-light-primary-red text-xs font-semibold">
                              Revoke
                            </Text>
                          </TouchableOpacity>
                        </View>
                      );
                    })}
                  </View>
                </View>
              ))}

              {/* Authorize / upgrade row — always targets the ACTIVE chain. */}
              {canAuthorizeOnActiveChain && (
                <View
                  className="bg-light rounded-2xl overflow-hidden"
                  style={{
                    shadowColor: "#000",
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.04,
                    shadowRadius: 6,
                    elevation: 1,
                  }}
                >
                  {smartAccountActive ? (
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => {
                        setAllowanceError("");
                        setShowAllowanceSheet(true);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Authorize a new spending delegation"
                      className="px-4 py-3 flex-row items-center"
                    >
                      <View className="w-9 h-9 rounded-xl bg-light-primary-red/10 items-center justify-center mr-3">
                        <Sparkles size={18} color="#c71c4b" />
                      </View>
                      <View className="flex-1">
                        <Text className="text-light-matte-black font-semibold">
                          Authorize spending delegation
                        </Text>
                        <Text className="text-light-matte-black/60 text-xs mt-0.5">
                          Pick a token and sign a capped delegation the agent
                          can spend within — enforced onchain.
                        </Text>
                      </View>
                      <ChevronRight size={18} color="#c71c4b" />
                    </TouchableOpacity>
                  ) : (
                    <View className="px-4 py-3 flex-row items-center">
                      <View className="w-9 h-9 rounded-xl bg-light-matte-black/5 items-center justify-center mr-3">
                        <Sparkles size={18} color="#9aa0ab" />
                      </View>
                      <View className="flex-1">
                        <Text className="text-light-matte-black font-semibold">
                          Upgrade required
                        </Text>
                        <Text className="text-light-matte-black/60 text-xs mt-0.5">
                          Upgrade this wallet to a smart account (in Wallet
                          Details) to enable spending delegations.
                        </Text>
                      </View>
                    </View>
                  )}
                </View>
              )}

              {allowanceError ? (
                <Text className="text-light-primary-red text-xs mt-2 ml-1 leading-4">
                  {allowanceError}
                </Text>
              ) : (
                <Text className="text-light-matte-black/50 text-xs mt-2 ml-1 leading-4">
                  This is a cryptographic ERC-7710 delegation — not a token
                  approval. The cap is enforced onchain — revoke any time.
                </Text>
              )}
            </View>
          )}

          {/* Auto-approve by category */}
          <View className="mx-4 mb-6">
            <Text className="text-light-matte-black/50 text-xs uppercase tracking-wide mb-2 ml-1">
              Auto-approve by category
            </Text>
            <View
              className="bg-light rounded-2xl overflow-hidden"
              style={{
                shadowColor: "#000",
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.04,
                shadowRadius: 6,
                elevation: 1,
              }}
            >
              {AUTO_APPROVE_CAPABILITIES.map((meta, index) => {
                const Icon = meta.icon;
                return (
                  <View
                    key={meta.capability}
                    accessible
                    accessibilityRole="switch"
                    accessibilityState={{ checked: readAutoApproved }}
                    accessibilityLabel={meta.label}
                    accessibilityHint={meta.accessibilityHint}
                    className={`px-4 py-3 flex-row items-center ${index > 0 ? "border-t border-light-matte-black/5" : ""}`}
                  >
                    <View className="w-9 h-9 rounded-xl bg-light-primary-red/10 items-center justify-center mr-3">
                      <Icon size={18} color="#c71c4b" />
                    </View>
                    <View className="flex-1 pr-3">
                      <Text className="text-light-matte-black font-semibold">
                        {meta.label}
                      </Text>
                      <Text className="text-light-matte-black/60 text-xs mt-0.5">
                        {meta.subtitle}
                      </Text>
                    </View>
                    <Switch
                      value={readAutoApproved}
                      onValueChange={applyReadAutoApprove}
                      trackColor={{ false: "#E5E7EB", true: "#c71c4b" }}
                      thumbColor="#fff"
                    />
                  </View>
                );
              })}
            </View>
            <Text className="text-light-matte-black/50 text-xs mt-2 ml-1 leading-4">
              Reading is on by default — the agent can check balances, prices,
              and history without asking. Turn this off to make it ask first.
            </Text>
          </View>

          {/* Write protection — the Write → Never rule (spec §D-4) */}
          <View className="mx-4 mb-6">
            <Text className="text-light-matte-black/50 text-xs uppercase tracking-wide mb-2 ml-1">
              Safety
            </Text>
            <View
              accessible
              accessibilityRole="switch"
              accessibilityState={{ checked: writesBlocked }}
              accessibilityLabel="Freeze the agent"
              accessibilityHint="When on, the agent can't send, swap, or approve anything. It can still check your balances. This overrides every auto-approve."
              className="bg-light rounded-2xl px-4 py-3 flex-row items-center"
              style={{
                shadowColor: "#000",
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.04,
                shadowRadius: 6,
                elevation: 1,
              }}
            >
              <View className="w-9 h-9 rounded-xl bg-light-primary-red/10 items-center justify-center mr-3">
                <ShieldOff size={18} color="#c71c4b" />
              </View>
              <View className="flex-1 pr-3">
                <Text className="text-light-matte-black font-semibold">
                  Freeze the agent
                </Text>
                <Text className="text-light-matte-black/60 text-xs mt-0.5">
                  Stop the agent from sending, swapping, or approving anything.
                  It can still check your balances. This overrides every
                  auto-approve.
                </Text>
              </View>
              <Switch
                value={writesBlocked}
                onValueChange={applyWriteBlock}
                trackColor={{ false: "#E5E7EB", true: "#c71c4b" }}
                thumbColor="#fff"
              />
            </View>
          </View>

          {/* Default mode selector */}
          <View className="mx-4 mb-6">
            <Text className="text-light-matte-black/50 text-xs uppercase tracking-wide mb-2 ml-1">
              Default mode
            </Text>
            <View
              className="bg-light rounded-2xl overflow-hidden"
              accessibilityRole="radiogroup"
              accessibilityLabel="Default permission mode"
              style={{
                shadowColor: "#000",
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.04,
                shadowRadius: 6,
                elevation: 1,
              }}
            >
              {MODES.map((mode, index) => {
                const isSelected = mode.id === currentMode;
                return (
                  <TouchableOpacity
                    key={mode.id}
                    onPress={() => handleSelectMode(mode.id)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={mode.label}
                    accessibilityHint={mode.accessibilityHint}
                    className={`px-4 py-3 flex-row items-start ${index > 0 ? "border-t border-light-matte-black/5" : ""}`}
                  >
                    <View
                      className={`w-5 h-5 rounded-full border-2 mr-3 mt-0.5 items-center justify-center ${isSelected ? "border-light-primary-red" : "border-light-matte-black/30"}`}
                    >
                      {isSelected && (
                        <View className="w-2.5 h-2.5 rounded-full bg-light-primary-red" />
                      )}
                    </View>
                    <View className="flex-1">
                      <Text className="text-light-matte-black font-semibold">
                        {mode.label}
                      </Text>
                      <Text className="text-light-matte-black/60 text-xs mt-0.5">
                        {mode.subtitle}
                      </Text>
                    </View>
                    {mode.id === "full_auto" && (
                      <AlertTriangle
                        size={16}
                        color="#c71c4b"
                        style={{ marginLeft: 8, marginTop: 2 }}
                      />
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
            {currentMode === "full_auto" && !writesBlocked && (
              <View className="flex-row items-start mt-3 px-1">
                <AlertTriangle size={14} color="#c71c4b" />
                <Text className="text-light-primary-red text-xs ml-2 flex-1 leading-4">
                  Full auto is enabled. The agent can move funds out of this
                  wallet without asking.
                </Text>
              </View>
            )}
            {writesBlocked && (
              <View className="flex-row items-start mt-3 px-1">
                <ShieldOff size={14} color="#c71c4b" />
                <Text className="text-light-primary-red text-xs ml-2 flex-1 leading-4">
                  The agent is frozen. It can&apos;t send, swap, or approve
                  anything until you turn off Freeze the agent above — this
                  overrides the mode here.
                </Text>
              </View>
            )}
          </View>

          {/* Known destinations (deny-layer §4.0 extension) */}
          <View className="mx-4 mb-4">
            <Text className="text-light-matte-black font-bold mb-1">
              Known destinations
            </Text>
            <Text className="text-light-matte-black/60 text-xs mb-3 leading-4">
              {knownDestinations.length > 0
                ? "Places a transfer has already completed. The agent may send here again without asking. Anywhere else, it asks first, whatever the mode above says, including your other wallets."
                : "Empty. The agent asks you to confirm the first time it sends anywhere, whatever the mode above says, and that includes your own wallets on other chains. Once a transfer completes, the address lands here and later sends there go through without asking."}
            </Text>
            {knownDestinations.map((entry) => (
              <View
                key={`${entry.namespace}:${entry.address}`}
                className="bg-light rounded-2xl px-4 py-3 mb-2 flex-row items-center"
              >
                <View className="flex-1 pr-2">
                  <Text className="text-light-matte-black font-semibold text-sm">
                    {truncateAddress({
                      address: entry.address,
                      preset: "medium",
                    })}
                  </Text>
                  <Text className="text-light-matte-black/60 text-xs mt-0.5">
                    {chainBadgeLabel(entry.namespace)}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => handleForgetDestination(entry)}
                  accessibilityRole="button"
                  accessibilityLabel={`Forget ${entry.address}`}
                  hitSlop={8}
                  className="px-3 py-1.5 rounded-xl border border-light-primary-red/30"
                >
                  <Text className="text-light-primary-red text-xs font-bold">
                    Forget
                  </Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>

          {/* Revoke all */}
          {grants.length > 0 && (
            <View className="mx-4 mb-4">
              <TouchableOpacity
                onPress={handleResetToDefaults}
                accessibilityRole="button"
                accessibilityLabel="Reset all permissions for this wallet to defaults"
                className="bg-light-primary-red/10 border border-light-primary-red/30 rounded-2xl px-4 py-3 flex-row items-center justify-center"
              >
                <Trash2 size={16} color="#c71c4b" />
                <Text className="text-light-primary-red font-bold ml-2">
                  Reset to defaults
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Live updates note */}
          <View className="mx-4 mt-2 flex-row items-start">
            <Trash2
              size={12}
              color="#666"
              style={{ marginTop: 2, opacity: 0.5 }}
            />
            <Text className="text-light-matte-black/50 text-xs ml-2 flex-1 leading-4">
              Changes apply to new actions. Active prompts are unaffected.
            </Text>
          </View>
        </ScrollView>
      </SafeAreaView>

      {showAllowanceSheet && chainId !== null && (
        <AgentAllowanceSheet
          chainId={chainId}
          busy={signingAllowance}
          onClose={() => setShowAllowanceSheet(false)}
          onConfirm={handleAuthorizeAllowance}
        />
      )}

      <PinConfirmationModal
        visible={showAllowancePin}
        title="Confirm delegation"
        onClose={() => {
          setShowAllowancePin(false);
          setPendingAllowance(null);
        }}
        onConfirm={handleAllowancePinConfirm}
      />

      <LoadinngSpinnerPopup
        visible={signingAllowance}
        title="Authorizing delegation"
        message="Signing your onchain delegation. Please wait…"
      />
    </>
  );
}
