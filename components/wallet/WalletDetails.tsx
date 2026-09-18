import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  CloudUpload,
  Coins,
  KeyRound,
  Shield,
  Sparkles,
} from "lucide-react-native";
import React, { lazy, Suspense, useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Chip from "@/components/common/Chip";
import LoadinngSpinnerPopup from "@/components/common/LoadinngSpinnerPopup";
import PinConfirmationModal from "@/components/common/PinConfirmationModal";
import { usePerformance } from "@/components/providers/PerformanceProvider";
import AddressDisplay from "@/components/wallet/AddressDisplay";
import UpgradeConfirmationSheet from "@/components/wallet/UpgradeConfirmationSheet";
import type { TWallet } from "@/constants/types/walletTypes";
import { useWallet } from "@/hooks/useWallet";
import { chainCacheKey } from "@/hooks/useWallet.helpers";
import { storage } from "@/lib/storage/mmkv";
import { filterSupportedWallets } from "@/services/walletKit/chainSupport";
import { walletKitRegistry } from "@/services/walletKit/registry";
import { authenticateUser } from "@/utils/authUtils";
import { copyToClipboard } from "@/utils/helperUtils";

const LazyWalletInfoDisplay = lazy(
  () => import("@/components/wallet/WalletInfoDisplay"),
);

const LazyLoadingPlaceholder = () => (
  <View className="py-8 items-center justify-center">
    <ActivityIndicator size="small" color="#c71c4b" />
  </View>
);

type TWalletDetails = {
  wallet: TWallet;
  showWalletInfo: boolean;
  setShowWalletInfo: (show: boolean) => void;
  animatedStyle?: object;
  /** Opens the Google Drive backup sheet. Backup lives here, next to the seed
   * phrase, rather than as a separate settings row. */
  onBackup?: () => void;
  /** Live backup status, e.g. "Back up to Google Drive" / "Backed up today". */
  backupLabel?: string;
};

export default function WalletDetails({
  wallet,
  showWalletInfo,
  setShowWalletInfo,
  animatedStyle,
  onBackup,
  backupLabel,
}: TWalletDetails) {
  const { deferredTask } = usePerformance();

  // §6.2: resolve the kit for the active wallet once; every balance +
  // formatting call flows through it so this component stays
  // namespace-agnostic.
  const { wallets, activeChain, getActiveWalletKit } = useWallet();
  const kit = useMemo(
    () => (wallet?.namespace ? getActiveWalletKit() : null),
    [getActiveWalletKit, wallet?.namespace],
  );

  // Paired wallets = rows sharing the same seedPhrase as the active
  // wallet. One account = N derived wallets (EVM + Solana today), so
  // we show every paired address here. Fall back to just this wallet
  // when seedPhrase is absent (imported private-key row).
  const pairedWallets = useMemo(() => {
    if (!wallet) return [] as TWallet[];
    const seedGroup = wallet.seedGroupId;
    if (typeof seedGroup !== "string" || seedGroup.length === 0) {
      return [wallet];
    }
    const group = filterSupportedWallets(
      wallets.filter((w) => w.seedGroupId === seedGroup),
    );
    return group.length > 0 ? group : [wallet];
  }, [wallet, wallets]);

  const displayNameForNamespace = useCallback((ns: string | undefined) => {
    if (!ns) return "";
    try {
      const k = walletKitRegistry.get(ns as never);
      if (k.displayName) return k.displayName;
    } catch {
      // kit missing — fall through
    }
    return ns === "eip155"
      ? "Ethereum"
      : ns.charAt(0).toUpperCase() + ns.slice(1);
  }, []);

  // Balance is only meaningful when the active chain's namespace
  // matches the active wallet's namespace (e.g. wallet is Solana,
  // chain is Solana). Otherwise we skip the fetch — the UI renders a
  // dash so no namespace branch is needed in the display layer.
  const chainForWallet =
    wallet?.namespace && activeChain.namespace === wallet.namespace
      ? activeChain
      : null;

  const queryClient = useQueryClient();
  const [showUpgradeSheet, setShowUpgradeSheet] = useState(false);
  const [showPinModal, setShowPinModal] = useState(false);
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [upgradeError, setUpgradeError] = useState("");

  const pendingKey = useMemo(() => {
    return chainForWallet && chainForWallet.namespace === "eip155"
      ? `eip7702-upgrade-pending:${wallet.address}:${chainForWallet.chain.id}`
      : "";
  }, [wallet.address, chainForWallet]);

  const [isUpgradePendingConfirmation, setIsUpgradePendingConfirmation] =
    useState(() => {
      return pendingKey ? storage.getBoolean(pendingKey) || false : false;
    });

  const { data: isSmartAccountActive } = useQuery({
    queryKey: [
      "wallet-smart-account-active",
      wallet?.address,
      wallet?.namespace,
      chainCacheKey(activeChain),
    ],
    queryFn: async () => {
      if (!kit || !kit.isSmartAccountActive || !wallet || !chainForWallet)
        return false;
      const isActive = await kit.isSmartAccountActive(wallet, chainForWallet);
      if (isActive && pendingKey) {
        storage.remove(pendingKey);
        setIsUpgradePendingConfirmation(false);
      }
      return isActive;
    },
    enabled:
      !!kit &&
      !!wallet &&
      !!chainForWallet &&
      typeof kit.isSmartAccountActive === "function",
  });

  const handleUpgradeConfirm = () => {
    setShowUpgradeSheet(false);
    setShowPinModal(true);
  };

  const handlePinConfirm = async (pin: string) => {
    setShowPinModal(false);
    setIsUpgrading(true);
    setUpgradeError("");

    try {
      if (!kit || !kit.upgradeToSmartAccount || !chainForWallet) {
        setUpgradeError("Smart account upgrade isn't supported on this chain.");
        return;
      }

      await kit.upgradeToSmartAccount({
        wallet,
        chain: chainForWallet,
      });

      // 1. Mark as pending confirmation in MMKV and update state
      if (pendingKey) {
        storage.set(pendingKey, true);
        setIsUpgradePendingConfirmation(true);
      }

      // 2. Refetch the query to update badge status in background
      await queryClient.invalidateQueries({
        queryKey: ["wallet-smart-account-active"],
      });
    } catch (err) {
      // Raw upgrade errors (viem/RPC strings carrying node URLs, etc.)
      // must never reach the UI — log under __DEV__, show fixed copy.
      if (__DEV__) {
        console.error("Smart Account Upgrade error:", err);
      }
      setUpgradeError("We couldn't upgrade this wallet. Please try again.");
    } finally {
      setIsUpgrading(false);
    }
  };

  const { data: balance } = useQuery({
    queryKey: [
      "wallet-details-native-balance",
      wallet?.address,
      wallet?.namespace,
      chainCacheKey(activeChain),
    ],
    queryFn: async () => {
      if (!kit || !chainForWallet || !wallet?.address) return null;
      return await kit.getNativeBalance(wallet.address, chainForWallet);
    },
    enabled: !!kit && !!chainForWallet && !!wallet?.address,
  });

  const formattedBalance = useMemo(() => {
    if (!kit || !chainForWallet) return "—";
    if (balance === null || balance === undefined) return "…";
    return kit.formatNativeAmount(balance, chainForWallet);
  }, [balance, chainForWallet, kit]);

  const handleToggleWalletInfo = useCallback(async () => {
    if (!showWalletInfo) {
      const isAuthenticated = await deferredTask(() =>
        authenticateUser("Authenticate to view wallet information"),
      );
      if (isAuthenticated) {
        setShowWalletInfo(true);
      }
    } else {
      setShowWalletInfo(false);
    }
  }, [showWalletInfo, deferredTask, setShowWalletInfo]);

  return (
    <Animated.View
      className="bg-light rounded-3xl overflow-hidden mx-4"
      style={[
        {
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.04,
          shadowRadius: 4,
          elevation: 1,
        },
        animatedStyle,
      ]}
    >
      <View className="px-5 pt-5 pb-4">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center">
            <View className="w-10 h-10 rounded-2xl bg-light-primary-red/10 items-center justify-center mr-3">
              <KeyRound size={20} color="#c71c4b" />
            </View>
            <View>
              <Text className="text-light-matte-black font-bold text-base">
                Wallet Details
              </Text>
              <Text className="text-light-matte-black/50 text-xs mt-0.5">
                {wallet.name || "My Wallet"}
              </Text>
            </View>
          </View>
          <View className="flex-row items-center gap-2">
            {isSmartAccountActive && (
              <Chip
                label="Smart Account"
                size="small"
                color="#0f9f6e"
                backgroundColor="rgba(15, 159, 110, 0.1)"
              />
            )}
            <Chip label={wallet.source} size="small" />
          </View>
        </View>
      </View>

      <View className="h-px bg-light-matte-black/5 mx-5" />

      <View className="px-5 py-4">
        <View className="mb-4">
          <View className="flex-row items-center mb-2">
            <Coins size={12} color="#c71c4b" />
            <Text className="text-light-matte-black/50 text-xs font-medium ml-1 uppercase tracking-wide">
              Native Balance
            </Text>
          </View>
          <View className="bg-light-main-container/50 p-4 rounded-2xl">
            <Text className="text-light-matte-black font-semibold text-base">
              {formattedBalance}
            </Text>
          </View>
        </View>

        {pairedWallets.map((w) => (
          <AddressDisplay
            key={`${w.namespace}-${w.address}`}
            address={w.address}
            chainLabel={displayNameForNamespace(w.namespace)}
            onCopy={() =>
              copyToClipboard(
                w.address,
                `${displayNameForNamespace(w.namespace)} Address`,
              )
            }
          />
        ))}

        <Suspense fallback={<LazyLoadingPlaceholder />}>
          <LazyWalletInfoDisplay
            wallet={wallet}
            showWalletInfo={showWalletInfo}
            onToggleVisibility={handleToggleWalletInfo}
            onCopy={copyToClipboard}
          />
        </Suspense>

        {/* Backup sits right by the seed phrase — same recovery concern. Only
            for wallets that actually have a mnemonic to encrypt.
            `seedGroupId` is the non-secret presence signal: it is assigned
            only to mnemonic-derived rows (TWV-2026-057 Tier 1). */}
        {wallet.seedGroupId && onBackup ? (
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={onBackup}
            accessibilityRole="button"
            accessibilityLabel="Google Drive Backup"
            accessibilityHint="Encrypt your seed phrase and store it in your own Google Drive"
            className="flex-row items-center mt-2 justify-between bg-light-main-container/50 rounded-2xl p-4 mb-4"
          >
            <View className="flex-row items-center flex-1 mr-3">
              <View className="w-9 h-9 rounded-xl bg-light-primary-red/10 items-center justify-center mr-3">
                <CloudUpload size={16} color="#c71c4b" />
              </View>
              <View className="flex-1">
                <Text className="text-light-matte-black font-semibold text-sm">
                  {backupLabel ?? "Back up to Google Drive"}
                </Text>
                <Text className="text-light-matte-black/50 text-xs mt-0.5">
                  Encrypt your seed phrase to your own Drive
                </Text>
              </View>
            </View>
            <ChevronRight size={16} color="#c71c4b" />
          </TouchableOpacity>
        ) : null}

        {/* A passkey wallet has no seed phrase to put in Drive, by design:
            the passkey itself is what the OS syncs, and the Passkey block
            above already says so (Recovery row). Nothing extra here. */}

        {upgradeError ? (
          <View className="bg-light-primary-red/10 p-3 rounded-2xl mb-4">
            <Text className="text-light-primary-red text-xs font-semibold">
              Upgrade Failed: {upgradeError}
            </Text>
          </View>
        ) : null}

        {typeof kit?.upgradeToSmartAccount === "function" &&
          isSmartAccountActive === false &&
          (isUpgradePendingConfirmation ? (
            <View className="bg-light-matte-black/[0.03] border border-light-matte-black/10 rounded-2xl p-4 mb-4 flex-row items-center justify-between">
              <View className="flex-1">
                <View className="flex-row items-center mb-1">
                  <ActivityIndicator size="small" color="#c71c4b" />
                  <Text className="text-light-matte-black font-semibold text-sm ml-2">
                    Upgrade Pending Confirmation
                  </Text>
                </View>
                <Text className="text-light-matte-black/50 text-xs leading-4 mt-1">
                  Your smart account upgrade is processing. Waiting for block
                  confirmation... Pull to refresh to check status.
                </Text>
              </View>
            </View>
          ) : (
            <View className="bg-light-primary-red/5 border border-light-primary-red/10 rounded-2xl p-4 mb-4 flex-row items-center justify-between">
              <View className="flex-1 mr-3">
                <View className="flex-row items-center mb-1">
                  <Sparkles size={14} color="#c71c4b" />
                  <Text className="text-light-matte-black font-semibold text-sm ml-1">
                    Smart Account Upgrade Available
                  </Text>
                </View>
                <Text className="text-light-matte-black/50 text-xs leading-4">
                  Pay fees in USDC, batch actions atomically, and enable secure
                  AI agent micropayments.
                </Text>
              </View>
              <TouchableOpacity
                activeOpacity={0.8}
                className="bg-light-primary-red py-2 px-4 rounded-full"
                onPress={() => setShowUpgradeSheet(true)}
              >
                <Text className="text-white font-bold text-xs">Upgrade</Text>
              </TouchableOpacity>
            </View>
          ))}
      </View>

      {wallet.type !== "Social" && (
        <View className="bg-light-main-container/60 px-5 py-4">
          <View className="flex-row items-center">
            <View className="w-8 h-8 rounded-xl bg-light-primary-red/10 items-center justify-center mr-3">
              <Shield size={14} color="#c71c4b" />
            </View>
            <Text className="text-light-matte-black/60 text-xs flex-1 leading-4">
              Never share your private key or seed phrase. TakumiPay will never
              ask for this information.
            </Text>
          </View>
        </View>
      )}

      <UpgradeConfirmationSheet
        visible={showUpgradeSheet}
        onClose={() => setShowUpgradeSheet(false)}
        onConfirm={handleUpgradeConfirm}
      />

      <PinConfirmationModal
        visible={showPinModal}
        onClose={() => setShowPinModal(false)}
        onConfirm={handlePinConfirm}
        title="Upgrade Confirmation"
      />

      <LoadinngSpinnerPopup
        visible={isUpgrading}
        title="Upgrading Account"
        message="Executing secure EIP-7702 upgrade transaction. Please wait for on-chain block confirmation (this may take up to a minute)..."
      />
    </Animated.View>
  );
}
