import { ChevronRight, Plus, ShieldCheck } from "lucide-react-native";
import React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { BaseModal, ModalHeader } from "@/components/common/BaseModal";

interface NewDeviceSheetProps {
  visible: boolean;
  onClose: () => void;
  onImportSeedPhrase: () => void;
  onCreateNew: () => void;
}

/**
 * Shown after Google + OTP when this device holds no wallet **and** the
 * account has no Drive backup.
 *
 * The screen exists because the previous behavior — silently minting a fresh
 * mnemonic — is indistinguishable, from the user's side, from "my money
 * vanished". A returning user on a new phone lands here and is told plainly
 * that a new wallet is a *different* wallet.
 */
export default function NewDeviceSheet({
  visible,
  onClose,
  onImportSeedPhrase,
  onCreateNew,
}: NewDeviceSheetProps) {
  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      height="auto"
      contentClassName="px-5"
    >
      <ModalHeader title="Set up your wallet" />

      <View className="pb-2">
        <Text className="text-light-matte-black/70 text-sm leading-5 mb-6">
          We couldn&apos;t find a wallet on this device or a backup in your
          Google Drive. If you already have a wallet, restore it with your seed
          phrase. Creating a new one gives you a different, empty wallet.
        </Text>

        <TouchableOpacity
          activeOpacity={0.7}
          className="bg-light border border-light-matte-black/10 py-4 px-5 rounded-xl flex-row items-center justify-between mb-3"
          onPress={onImportSeedPhrase}
        >
          <View className="flex-row items-center flex-1">
            <View className="w-11 h-11 bg-light-primary-red/10 rounded-full items-center justify-center mr-3">
              <ShieldCheck color="#c71c4b" size={20} />
            </View>
            <View className="flex-1">
              <Text className="text-light-matte-black font-medium">
                I have a seed phrase
              </Text>
              <Text className="text-light-matte-black/50 text-xs">
                Restore your existing wallet
              </Text>
            </View>
          </View>
          <ChevronRight color="#20222c" size={18} />
        </TouchableOpacity>

        <TouchableOpacity
          activeOpacity={0.7}
          className="bg-light-primary-red py-4 px-5 rounded-xl flex-row items-center justify-between"
          onPress={onCreateNew}
        >
          <View className="flex-row items-center flex-1">
            <View className="w-11 h-11 bg-light/20 rounded-full items-center justify-center mr-3">
              <Plus color="#ffffff" size={20} />
            </View>
            <View className="flex-1">
              <Text className="text-light font-semibold">
                Create a new wallet
              </Text>
              <Text className="text-light/70 text-xs">
                Starts empty, with a new seed phrase
              </Text>
            </View>
          </View>
          <ChevronRight color="#ffffff" size={18} />
        </TouchableOpacity>
      </View>
    </BaseModal>
  );
}
