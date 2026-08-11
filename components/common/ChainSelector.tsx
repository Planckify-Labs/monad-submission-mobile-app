/**
 * The home-screen network pill: the active chain's icon + label, which
 * opens the shared `ChainSelectorSheet`.
 *
 * This file is now ONLY a trigger. Everything about which networks are
 * listed, how they're grouped and searched, and what happens for a
 * namespace the user holds no wallet on lives in the sheet, so the
 * agent's conversation-list picker (and any future entry point) shows
 * exactly the same thing. They used to be two separate implementations,
 * which is how one of them ended up still offering Sui to a private-key
 * EVM user after the other was fixed.
 */

import { ChevronDown } from "lucide-react-native";
import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useState,
} from "react";
import { Image, Pressable, Text } from "react-native";
import { ChainSelectorSheet } from "@/components/common/ChainSelectorSheet";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { useWallet } from "@/hooks/useWallet";
import { track } from "@/services/analytics/posthog";

export interface ChainSelectorRef {
  open: () => void;
}

/**
 * App-bar "active network" label. Exhaustive switch (not a nested
 * ternary chain) so a future 5th namespace fails loud at compile time
 * instead of silently falling into a hard-coded catch-all label — the
 * bug that showed "Sui Mainnet" for an active Stellar wallet (the old
 * final branch always rendered `Sui ${...}` for anything that wasn't
 * eip155/solana).
 */
function formatActiveLabel(chain: ChainConfig): string {
  switch (chain.namespace) {
    case "eip155":
      return chain.chain.name;
    case "solana":
      return `Solana ${chain.cluster === "devnet" ? "Devnet" : "Mainnet"}`;
    case "sui":
      return `Sui ${
        chain.network === "mainnet"
          ? "Mainnet"
          : chain.network === "testnet"
            ? "Testnet"
            : "Devnet"
      }`;
    case "stellar":
      return `Stellar ${chain.network === "mainnet" ? "Mainnet" : "Testnet"}`;
    default: {
      const _exhaustive: never = chain;
      throw new Error(
        `ChainSelector: unhandled chain namespace ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

const ChainSelectorBase = forwardRef<ChainSelectorRef>((_, ref) => {
  const { activeChain } = useWallet();
  const [modalVisible, setModalVisible] = useState(false);

  const openModal = useCallback(() => {
    track("feature_opened", { feature: "chain_selector" });
    setModalVisible(true);
  }, []);
  const closeModal = useCallback(() => setModalVisible(false), []);

  useImperativeHandle(ref, () => ({ open: openModal }), [openModal]);

  return (
    <>
      <Pressable
        onPress={openModal}
        className="flex-row items-center bg-light-main-container px-3 py-2 rounded-full"
      >
        <Image
          source={{ uri: activeChain.iconUrl }}
          style={{ width: 20, height: 20 }}
          className="mr-2 rounded-full bg-light-matte-black/5"
          defaultSource={require("@/assets/images/takumipay-logo.png")}
        />
        <Text className="text-light-matte-black text-xs font-medium mr-2">
          {formatActiveLabel(activeChain)}
        </Text>
        <ChevronDown size={16} color="#c71c4b" />
      </Pressable>

      <ChainSelectorSheet visible={modalVisible} onClose={closeModal} />
    </>
  );
});

ChainSelectorBase.displayName = "ChainSelector";

const ChainSelector = memo(ChainSelectorBase);

export default ChainSelector;
