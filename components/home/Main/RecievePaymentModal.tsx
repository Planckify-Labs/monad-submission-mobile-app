import { router } from "expo-router";
import { Copy } from "lucide-react-native";
import { memo, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import QRCodeStyled from "react-native-qrcode-styled";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { takumipayLogoBase64 } from "@/constants/takumipay";
import type { TWallet } from "@/constants/types/walletTypes";
import { useWallet } from "@/hooks/useWallet";
import { prefetchQRMatrix } from "@/services/qrMatrixCache";
import { copyToClipboard } from "@/utils/helperUtils";
import Chip from "../../common/Chip";

// Module-scope styling so `React.memo` below can compare QR props by
// reference. Inlining these objects in JSX re-created a fresh identity
// on every modal render, breaking memoization and forcing the SVG to
// reconcile even when the address hadn't changed.
const QR_SVG_STYLE = { backgroundColor: "rgb(245 246 249 / 0.5)" } as const;
const QR_GRADIENT = {
  type: "linear" as const,
  options: {
    colors: ["#c71c4b", "#20222c"],
    start: [0, 0] as [number, number],
    end: [1, 1] as [number, number],
  },
};
const QR_OUTER_EYES = {
  topLeft: { borderRadius: 15, color: "#c71c4b" },
  topRight: { borderRadius: 15, color: "#c71c4b" },
  bottomLeft: { borderRadius: 15, color: "#c71c4b" },
};
const QR_INNER_EYES = { borderRadius: 8, color: "#20222c" };
const QR_LOGO_BASE = {
  href: takumipayLogoBase64,
  padding: 2,
};

// Per-namespace scale to compensate for `useQRCodeLogoSize` snapping the
// logo to an odd multiple of `pieceSize`. Solana addresses encode in byte
// mode (vs EVM hex/alphanumeric), producing a denser matrix and a smaller
// `pieceSize` that snaps the logo to a visibly larger bucket at the same
// scale. Sui addresses are 66-char lowercase hex, also byte-mode, so they
// share Solana's smaller scale to keep the logo from overlapping enough
// modules to break scanning. Tune these to keep the visual size
// consistent across tabs.
const QR_LOGO_SCALE_BY_NAMESPACE: Record<string, number> = {
  eip155: 1.2,
  solana: 1.0,
  sui: 1.0,
};
const QR_LOGO_SCALE_DEFAULT = 1.2;

const MemoQRCode = memo(function MemoQRCode({
  data,
  logoScale,
}: {
  data: string;
  logoScale: number;
}) {
  const logo = useMemo(
    () => ({ ...QR_LOGO_BASE, scale: logoScale }),
    [logoScale],
  );
  return (
    <QRCodeStyled
      data={data}
      style={QR_SVG_STYLE}
      padding={0}
      className="w-full h-full"
      size={205}
      pieceBorderRadius={3.5}
      isPiecesGlued={true}
      color="#20222c"
      gradient={QR_GRADIENT}
      outerEyesOptions={QR_OUTER_EYES}
      innerEyesOptions={QR_INNER_EYES}
      logo={logo}
    />
  );
});

type ReceivePaymentModalProps = {
  modalVisible: boolean;
  closeModal: () => void;
  activeWallet: TWallet;
  activeChain: ChainConfig;
};

export default function RecievePaymentModal({
  modalVisible,
  closeModal,
  activeWallet,
  activeChain,
}: ReceivePaymentModalProps) {
  // Gate the QR render until the sheet has finished sliding up, so the
  // native-SVG matrix layout never competes with the open animation.
  const [isModalAnimationComplete, setIsModalAnimationComplete] =
    useState(false);

  // The Receive modal is account-scoped, not chain-scoped: if the
  // active wallet shares a `seedGroupId` with other rows (EVM + Solana
  // pair) we surface all of them as tabs so the user can flip the QR
  // without leaving the sheet. Imported private-key rows collapse to a
  // single tab since they live on one chain only.
  const { wallets } = useWallet();
  const pairedWallets = useMemo<TWallet[]>(() => {
    const seedGroup = activeWallet.seedGroupId;
    if (typeof seedGroup !== "string" || seedGroup.length === 0) {
      return [activeWallet];
    }
    const group = wallets.filter((w) => w.seedGroupId === seedGroup);
    return group.length > 0 ? group : [activeWallet];
  }, [activeWallet, wallets]);

  const [tabNamespace, setTabNamespace] = useState<string>(
    activeChain.namespace,
  );

  // Keep the tab in sync with the paired set: if the active chain's
  // namespace has a paired wallet, default to it; otherwise fall back
  // to the first paired wallet's namespace.
  useEffect(() => {
    const match = pairedWallets.find(
      (w) => w.namespace === activeChain.namespace,
    );
    setTabNamespace(
      match
        ? activeChain.namespace
        : (pairedWallets[0]?.namespace ?? activeChain.namespace),
    );
  }, [activeChain.namespace, pairedWallets]);

  const displayWallet: TWallet =
    pairedWallets.find((w) => w.namespace === tabNamespace) ??
    pairedWallets[0] ??
    activeWallet;

  // The QR render is gated on `isModalAnimationComplete` so the
  // slide-up never has to compete with native-SVG layout for the
  // piece matrix — mounting it mid-animation makes the sheet look
  // like it "jumps" to its resting position. The MMKV matrix cache
  // still helps: when the QR finally mounts after the animation, it
  // skips the ~1–3 ms Reed-Solomon compute and the paint lands sooner.
  // `useQRPrefetch` on home warms the cache ahead of time; the
  // effect below is a belt-and-braces synchronous warm that also
  // covers tab switches between paired EVM / Solana addresses.
  const qrAddress = displayWallet.address;
  const qrLogoScale =
    QR_LOGO_SCALE_BY_NAMESPACE[displayWallet.namespace] ??
    QR_LOGO_SCALE_DEFAULT;
  useEffect(() => {
    if (!qrAddress) return;
    prefetchQRMatrix(qrAddress, { errorCorrectionLevel: "M" });
  }, [qrAddress]);

  const tabLabelFor = (ns?: string): string => {
    if (!ns) return "Wallet";
    return ns === "eip155"
      ? "Ethereum"
      : ns === "solana"
        ? "Solana"
        : ns === "sui"
          ? "Sui"
          : ns.charAt(0).toUpperCase() + ns.slice(1);
  };

  const suiNetworkLabel = (n: "mainnet" | "testnet" | "devnet"): string =>
    n === "mainnet" ? "Mainnet" : n === "testnet" ? "Testnet" : "Devnet";

  const chainPillLabel =
    displayWallet.namespace === "eip155"
      ? activeChain.namespace === "eip155"
        ? activeChain.chain.name
        : "Ethereum"
      : displayWallet.namespace === "solana"
        ? activeChain.namespace === "solana"
          ? `Solana ${activeChain.cluster === "devnet" ? "Devnet" : "Mainnet"}`
          : "Solana"
        : displayWallet.namespace === "sui"
          ? activeChain.namespace === "sui"
            ? `Sui ${suiNetworkLabel(activeChain.network)}`
            : "Sui"
          : tabLabelFor(displayWallet.namespace);
  return (
    <BaseModal
      visible={modalVisible}
      onClose={closeModal}
      onOpened={() => setIsModalAnimationComplete(true)}
      onClosed={() => setIsModalAnimationComplete(false)}
      borderRadius={28}
      contentClassName="px-6"
    >
      <ModalHeader title="Receive Funds" />

      <View>
        {pairedWallets.length > 1 && (
          <View className="flex-row bg-light-main-container rounded-full p-1 mb-4">
            {pairedWallets.map((w) => {
              const active = w.namespace === tabNamespace;
              return (
                <Pressable
                  key={w.namespace}
                  onPress={() => setTabNamespace(w.namespace)}
                  accessibilityRole="button"
                  accessibilityLabel={`${tabLabelFor(w.namespace)} address`}
                  accessibilityState={{ selected: active }}
                  className={`flex-1 py-2 items-center rounded-full ${
                    active ? "bg-light" : ""
                  }`}
                >
                  <Text
                    className={`text-sm font-semibold ${
                      active
                        ? "text-light-primary-red"
                        : "text-light-matte-black/60"
                    }`}
                  >
                    {tabLabelFor(w.namespace)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}

        <View className="bg-white rounded-3xl p-6 shadow-sm mb-5">
          <View className="items-center mb-6 h-64">
            <View className="bg-light-main-container/50 p-4 rounded-2xl aspect-square grow">
              {isModalAnimationComplete && (
                <MemoQRCode data={qrAddress} logoScale={qrLogoScale} />
              )}
            </View>
          </View>

          <View className="items-center mb-4">
            <View className="bg-light-primary-red/10 px-3 py-1 rounded-full mb-2">
              <Text className="text-light-primary-red text-xs font-medium">
                {chainPillLabel}
              </Text>
            </View>
            <Text className="text-light-matte-black font-medium text-base">
              {displayWallet.name || activeWallet.name || "My Wallet"}
            </Text>
          </View>

          <View className="bg-light-main-container p-4 rounded-xl w-full">
            <View className="flex-row items-center justify-between mb-1">
              <Text className="text-light-matte-black/70 text-xs font-medium">
                WALLET ADDRESS
              </Text>
              <Chip label={displayWallet?.source} size="small" />
            </View>
            <Text
              className="text-light-matte-black text-sm font-medium"
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {displayWallet.address}
            </Text>
          </View>
        </View>

        <View className="flex-row gap-4">
          <Pressable
            className="flex-1 bg-light-main-container p-4 rounded-xl"
            onPress={() => copyToClipboard(displayWallet.address, "Address")}
          >
            <View className="flex-row items-center justify-center gap-2">
              <Copy size={18} color="#c71c4b" className="mr-2" />
              <Text className="text-light-matte-black font-medium">
                Copy Address
              </Text>
            </View>
          </Pressable>

          <Pressable
            className="flex-1 bg-light-primary-red p-4 rounded-xl"
            onPress={() => {
              router.push("/scan-to-pay");
            }}
          >
            <Text className="text-white font-bold text-center">Scan QR</Text>
          </Pressable>
        </View>
      </View>
    </BaseModal>
  );
}
