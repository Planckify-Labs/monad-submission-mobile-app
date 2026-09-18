import { Coins, Cpu, Layers, Sparkles } from "lucide-react-native";
import { Text, TouchableOpacity, View } from "react-native";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";

type UpgradeConfirmationSheetProps = {
  visible: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

export default function UpgradeConfirmationSheet({
  visible,
  onClose,
  onConfirm,
}: UpgradeConfirmationSheetProps) {
  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      backdropOpacity={0.4}
      borderRadius={32}
      contentClassName="px-6 pb-6"
    >
      <ModalHeader
        left={
          <View className="flex-row items-center">
            <Sparkles size={22} color="#c71c4b" />
            <Text className="text-light-matte-black text-xl font-bold ml-2">
              Smart Account Upgrade
            </Text>
          </View>
        }
      />

      <Text className="text-light-matte-black/60 text-sm leading-5 mb-6">
        Upgrade your wallet to access premium decentralized finance capabilities
        and advanced wallet features.
      </Text>

      <View className="space-y-4 mb-6">
        <View className="flex-row items-start bg-white p-4 rounded-2xl shadow-sm mb-3">
          <View className="w-10 h-10 rounded-xl bg-light-primary-red/10 items-center justify-center mr-3">
            <Coins size={20} color="#c71c4b" />
          </View>
          <View className="flex-1">
            <Text className="text-light-matte-black font-semibold text-sm">
              Pay fees in USDC
            </Text>
            <Text className="text-light-matte-black/50 text-xs mt-1 leading-4">
              Pay network fees in USDC, so you can send without keeping a
              separate balance for fees.
            </Text>
          </View>
        </View>

        <View className="flex-row items-start bg-white p-4 rounded-2xl shadow-sm mb-3">
          <View className="w-10 h-10 rounded-xl bg-light-primary-red/10 items-center justify-center mr-3">
            <Cpu size={20} color="#c71c4b" />
          </View>
          <View className="flex-1">
            <Text className="text-light-matte-black font-semibold text-sm">
              AI-Agent Micropayments
            </Text>
            <Text className="text-light-matte-black/50 text-xs mt-1 leading-4">
              Allow secure, programmatic micropayments initiated by your
              AI-agent companion.
            </Text>
          </View>
        </View>

        <View className="flex-row items-start bg-white p-4 rounded-2xl shadow-sm mb-4">
          <View className="w-10 h-10 rounded-xl bg-light-primary-red/10 items-center justify-center mr-3">
            <Layers size={20} color="#c71c4b" />
          </View>
          <View className="flex-1">
            <Text className="text-light-matte-black font-semibold text-sm">
              Batched Transactions
            </Text>
            <Text className="text-light-matte-black/50 text-xs mt-1 leading-4">
              Bundle approval and deposit actions into a single click instead of
              multiple prompts.
            </Text>
          </View>
        </View>
      </View>

      <View className="bg-light-main-container/60 p-4 rounded-2xl mb-6">
        <Text className="text-light-matte-black/60 text-xs leading-4 text-center">
          Audited & Secure: Your private keys never leave your device. Upgrades
          use canonical EIP-7702 set-code transactions.
        </Text>
      </View>

      <TouchableOpacity
        activeOpacity={0.8}
        className="bg-light-primary-red py-4 rounded-full items-center justify-center mb-3 shadow-md"
        onPress={onConfirm}
      >
        <Text className="text-white font-bold text-base">
          Upgrade to Smart Account
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        activeOpacity={0.7}
        className="py-3 items-center justify-center"
        onPress={onClose}
      >
        <Text className="text-light-matte-black/50 font-semibold text-sm">
          Maybe Later
        </Text>
      </TouchableOpacity>
    </BaseModal>
  );
}
