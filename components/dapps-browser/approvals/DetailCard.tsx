/**
 * Shared layout primitives for the approval sheets.
 *
 * The visual language is lifted from the activity-detail cards
 * (`components/activity-detail/render-activity-detail-cards/`), which is
 * where this app's card design actually lives: a white `rounded-2xl` card,
 * a tinted brand-red icon chip beside a bold title with a short accent bar
 * under it, and — the load-bearing part — **values sitting in filled
 * `light-main-container` panels rather than being separated by hairlines**.
 *
 * That last point is the whole reason these exist. Grouping by fill reads as
 * one designed surface; grouping by grey rules reads as a table someone ran
 * out of time on, and a sheet with eight divider lines gives every row the
 * same weight when the whole job here is making one number the loudest thing
 * on screen.
 */

import { ChevronDown, ChevronUp, Copy } from "lucide-react-native";
import React, { useState } from "react";
import { Pressable, Text, TouchableOpacity, View } from "react-native";
import { copyToClipboard } from "@/utils/helperUtils";

/** White grouped card. One concern per card, stacked with `mb-3`. */
export function DetailCard({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <View
      className={`bg-white rounded-2xl p-5 border border-gray-100 mb-3 ${className}`}
    >
      {children}
    </View>
  );
}

/**
 * Card heading: tinted icon chip, bold title, short brand accent bar.
 * `icon` is a lucide element already sized/coloured by the caller.
 */
export function DetailCardTitle({
  children,
  icon,
  accessory,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  accessory?: React.ReactNode;
}): React.ReactElement {
  return (
    <View className="flex-row items-center justify-between mb-4">
      <View className="flex-row items-center gap-3 flex-1">
        {icon && (
          <View className="bg-light-primary-red/10 p-3 rounded-2xl">
            {icon}
          </View>
        )}
        <View className="flex-1">
          <Text className="text-light-matte-black font-bold text-lg tracking-tight">
            {children}
          </Text>
          <View className="h-1 bg-light-primary-red/20 rounded-full mt-1 w-16" />
        </View>
      </View>
      {accessory}
    </View>
  );
}

/** Small uppercase eyebrow for a group inside a card. */
export function DetailEyebrow({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Text className="text-light-matte-black/40 text-xs font-semibold uppercase tracking-wider mb-2">
      {children}
    </Text>
  );
}

/**
 * Filled inset that holds a value. This is what replaces divider lines:
 * the fill is the grouping, so rows sit apart without a rule between them.
 */
export function DetailPanel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <View className={`bg-light-main-container rounded-xl p-3.5 ${className}`}>
      {children}
    </View>
  );
}

/**
 * Label above, value in a filled panel below, with an optional copy action.
 *
 * For values a side-by-side row would squeeze: a full address, an ENS name
 * stacked over its address, anything monospace. `CounterpartyLabel` is
 * required to keep the entire address on screen, so it gets a full line
 * rather than the right half of one.
 */
export function DetailStack({
  label,
  children,
  copyValue,
  copyLabel,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  /** When set, a brand-red copy button sits at the right of the panel. */
  copyValue?: string;
  copyLabel?: string;
  className?: string;
}): React.ReactElement {
  return (
    <View className={className}>
      <Text className="text-light-matte-black font-semibold text-sm mb-2">
        {label}
      </Text>
      <DetailPanel>
        <View className="flex-row items-center gap-2">
          <View className="flex-1">{children}</View>
          {copyValue && (
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => copyToClipboard(copyValue, copyLabel ?? label)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`copy-${label.toLowerCase()}`}
            >
              <Copy size={16} color="#c71c4b" />
            </TouchableOpacity>
          )}
        </View>
      </DetailPanel>
    </View>
  );
}

/**
 * Plain label-left / value-right row, for the compact facts at the foot of a
 * card (network, fee, type). No rule between rows: spacing does that job.
 */
export function DetailRow({
  label,
  value,
  children,
  mono = false,
}: {
  label: string;
  value?: string;
  children?: React.ReactNode;
  mono?: boolean;
}): React.ReactElement {
  return (
    <View className="flex-row items-start justify-between gap-3 py-1.5">
      <Text className="text-light-matte-black font-medium text-sm shrink-0">
        {label}
      </Text>
      <View className="flex-1 items-end">
        {children ?? (
          <Text
            className={`text-light-matte-black/70 text-right ${
              mono ? "text-xs font-mono" : "text-sm"
            }`}
            selectable
          >
            {value}
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * Collapsed-by-default disclosure for the technical layer: raw calldata,
 * decoded arguments, signing digests.
 *
 * `defaultOpen` exists for the case that inverts the default. When the wallet
 * could not decode what a call does, the raw material stops being an advanced
 * extra and becomes the only evidence there is, so the sheet opens this
 * section rather than tucking the evidence behind a tap.
 */
export function CollapsibleCard({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View className="bg-white rounded-2xl border border-gray-100 px-5 mb-3">
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="flex-row items-center py-4"
      >
        <Text className="text-light-matte-black font-semibold text-sm flex-1">
          {title}
        </Text>
        {open ? (
          <ChevronUp size={18} color="#c71c4b" />
        ) : (
          <ChevronDown size={18} color="#c71c4b" />
        )}
      </Pressable>
      {open && <View className="pb-4 gap-3">{children}</View>}
    </View>
  );
}
