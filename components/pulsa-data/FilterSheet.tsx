import React, { memo, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import type { TProductVariant } from "@/api/types/product";
import { BaseModal } from "@/components/common/BaseModal";
import {
  applyFacetFilter,
  emptySelection,
  type PpobFacetSection,
  type PpobFilterSelection,
  toggleFacetOption,
} from "@/services/ppob";

interface FilterSheetProps {
  visible: boolean;
  onClose: () => void;
  sections: PpobFacetSection[];
  /** Variants of the active tab — used for the live result count. */
  variants: TProductVariant[];
  /** Currently committed selection (the sheet edits a draft copy). */
  selection: PpobFilterSelection;
  onApply: (selection: PpobFilterSelection) => void;
}

/**
 * Filter bottom-sheet for the Pulsa & Data catalog. Chip sections are
 * provider-derived (via `buildFacetSections`); the user edits a draft,
 * sees a live result count on the Apply button, and commits with Apply or
 * resets with Clear filter. Mirrors the reference "Filter" sheet.
 */
export const FilterSheet = memo(function FilterSheet({
  visible,
  onClose,
  sections,
  variants,
  selection,
  onApply,
}: FilterSheetProps) {
  const [draft, setDraft] = useState<PpobFilterSelection>(selection);

  // Sync the draft from the committed selection each time the sheet opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sync on open only
  useEffect(() => {
    if (visible) setDraft(selection);
  }, [visible]);

  const previewCount = useMemo(
    () => applyFacetFilter(variants, draft).length,
    [variants, draft],
  );

  const toggle = (kind: PpobFacetSection["kind"], id: string) =>
    setDraft((prev) => toggleFacetOption(prev, kind, id));

  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      height="85%"
      showCloseButton={false}
      contentClassName="flex-1 px-5 pt-1"
    >
      <View className="flex-1">
        <View className="flex-row items-center justify-between mb-1">
          <Text className="text-xl font-bold text-light-matte-black">
            Filter
          </Text>
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => setDraft(emptySelection())}
            className="border-2 border-light-primary-red rounded-full px-4 py-2"
          >
            <Text className="text-light-primary-red font-bold text-sm">
              Clear filter
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          className="flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 12 }}
        >
          {sections.map((section) => (
            <View key={section.kind} className="mt-5">
              <Text className="text-light-matte-black font-bold text-base mb-3">
                {section.title}
              </Text>
              <View className="flex-row flex-wrap -m-1">
                {section.options.map((opt) => {
                  const selected = draft[section.kind].includes(opt.id);
                  return (
                    <TouchableOpacity
                      key={opt.id}
                      activeOpacity={0.7}
                      onPress={() => toggle(section.kind, opt.id)}
                      className={`m-1 px-4 py-2.5 rounded-full border ${
                        selected
                          ? "bg-light-primary-red border-light-primary-red"
                          : "bg-light border-light-matte-black/15"
                      }`}
                    >
                      <Text
                        className={`font-medium text-sm ${
                          selected ? "text-white" : "text-light-matte-black"
                        }`}
                      >
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ))}
        </ScrollView>

        <TouchableOpacity
          activeOpacity={0.8}
          onPress={() => {
            onApply(draft);
            onClose();
          }}
          className="bg-light-primary-red rounded-2xl py-4 items-center mt-3"
        >
          <Text className="text-white font-bold text-base">
            {previewCount === variants.length
              ? "Show all packages"
              : `Apply (${previewCount})`}
          </Text>
        </TouchableOpacity>
      </View>
    </BaseModal>
  );
});
