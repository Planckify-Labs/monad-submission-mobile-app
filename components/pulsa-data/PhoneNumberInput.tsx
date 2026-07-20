import { Contact } from "lucide-react-native";
import React, { memo } from "react";
import { Controller } from "react-hook-form";
import { Text, TextInput, TouchableOpacity, View } from "react-native";
import OptimizedImage from "@/components/common/OptimizedImage";
import { ContactPickerModal } from "@/components/pulsa-data/ContactPickerModal";
import { RecentNumbers } from "@/components/pulsa-data/RecentNumbers";
import { formatPhoneNumber } from "@/constants/ISP-list";
import { usePhoneNumber, usePhoneNumberForm } from "@/hooks/pulsa-data";
import { useContactPicker } from "@/hooks/pulsa-data/useContactPicker";

const MAX_PHONE_LENGTH = 12;

export const PhoneNumberInput = memo(function PhoneNumberInput() {
  const { productDetail, showMinLengthError } = usePhoneNumber();
  const { control, setPhoneFromContact } = usePhoneNumberForm();

  const {
    pickContact,
    closePicker,
    handleSelect,
    visible,
    isLoading,
    contacts,
  } = useContactPicker({
    onPhoneSelected: setPhoneFromContact,
  });

  return (
    <View className="bg-light rounded-xl p-5 shadow-xs">
      <Text className="text-light-matte-black/70 mb-2">Phone Number</Text>
      <View className="flex-row items-center justify-center">
        <View className="flex-1 flex-row items-center border-2 border-light-matte-black bg-light-main-container p-4 rounded-xl mr-2">
          {productDetail?.imageUrl && (
            <View className="mr-3 overflow-hidden rounded-md">
              <OptimizedImage
                source={{ uri: productDetail.imageUrl }}
                style={{ width: 32, height: 32 }}
                contentFit="contain"
              />
            </View>
          )}
          <Controller
            control={control}
            name="phoneNumber"
            render={({ field: { onChange, value } }) => (
              <TextInput
                value={formatPhoneNumber(value)}
                onChangeText={(text) => {
                  const cleaned = text.replace(/\D/g, "");
                  if (cleaned.length <= MAX_PHONE_LENGTH) {
                    onChange(cleaned);
                  }
                }}
                placeholder="0812-3456-7890"
                keyboardType="phone-pad"
                className="text-light-matte-black font-medium text-lg flex-1"
                maxLength={14}
              />
            )}
          />
        </View>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={pickContact}
          className="bg-light-primary-red/10 p-4 rounded-xl"
        >
          <Contact size={24} color="#c71c4b" />
        </TouchableOpacity>
      </View>

      {showMinLengthError && (
        <Text className="text-light-error text-xs mt-2">
          Phone number must be at least 11 digits
        </Text>
      )}

      <RecentNumbers onSelect={setPhoneFromContact} />

      <ContactPickerModal
        visible={visible}
        contacts={contacts}
        isLoading={isLoading}
        onClose={closePicker}
        onSelect={handleSelect}
      />
    </View>
  );
});
