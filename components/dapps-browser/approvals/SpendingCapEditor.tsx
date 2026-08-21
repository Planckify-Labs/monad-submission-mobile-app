/**
 * Editable spending cap — the wallet-side answer to "the dApp asked for
 * unlimited, I only want to approve six".
 *
 * `approve(spender, value)` is an ordinary token write: the token
 * contract enforces whatever `value` is in the *signed* calldata and
 * has no idea what the dApp originally requested. So the wallet can
 * offer a smaller number, re-encode, and sign that instead. Same
 * feature as MetaMask's editable spending cap and Rabby's "edit
 * permission"; the amount here is the one that reaches the chain.
 *
 * The editor only ever changes the amount. The spender comes from the
 * dApp's own unedited call and is never editable, so this can never
 * retarget an approval, only shrink it.
 */

import { Pencil } from "lucide-react-native";
import React, { useState } from "react";
import { Image, Pressable, Text, TextInput, View } from "react-native";
import {
  groupDigits,
  parseSpendingCapInput,
  spendingCapError,
} from "./spendingCapInput";

interface Props {
  /** Rendered when the editor is closed: the cap as it stands now. */
  display: string;
  /**
   * The token's scale. Required: the editor is only rendered once a scale is
   * known, so the field always speaks in whole tokens ("5.19", "100") and
   * never in base units.
   */
  decimals: number;
  /** Token symbol shown next to the value, when one is known. */
  symbol?: string | null;
  /** Token icon URL, when one is known. Absent renders text only. */
  logo?: string | null;
  /**
   * The cap is unbounded. Colours the headline brand-red — the one case
   * where the number itself is the warning, so it should not read with the
   * same weight as "10 USDT".
   */
  unlimited?: boolean;
  /** True once the user has replaced the dApp's requested value. */
  custom: boolean;
  onChange: (raw: bigint) => void;
  onReset: () => void;
}

/**
 * The headline amount: icon, value, symbol, optional trailing action.
 *
 * Shared so the read-only case — a token whose scale we could not resolve —
 * renders exactly like the editable one rather than becoming a visually
 * different, second-class row.
 */
export function SpendingCapAmount({
  display,
  symbol,
  logo,
  unlimited = false,
  action,
}: {
  display: string;
  symbol?: string | null;
  logo?: string | null;
  unlimited?: boolean;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <View className="flex-row items-center gap-3">
      {logo && (
        <Image
          source={{ uri: logo }}
          className="w-8 h-8 rounded-full"
          accessibilityIgnoresInvertColors
        />
      )}
      {/*
        The headline. This number is the entire decision, so it is sized like
        one: "Unlimited" and "10 USDT" both have to land at a glance, without
        the reader parsing a row of same-sized text to find which value
        mattered.
      */}
      <Text
        className={`text-2xl font-bold flex-1 ${
          unlimited ? "text-light-primary-red" : "text-light-matte-black"
        }`}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
        selectable
      >
        {display}
        {symbol ? ` ${symbol}` : ""}
      </Text>
      {action}
    </View>
  );
}

export function SpendingCapEditor({
  display,
  decimals,
  symbol,
  logo,
  unlimited = false,
  custom,
  onChange,
  onReset,
}: Props): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <View>
        <SpendingCapAmount
          display={display}
          symbol={symbol}
          logo={logo}
          unlimited={unlimited}
          action={
            <Pressable
              onPress={() => {
                setText("");
                setError(null);
                setEditing(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="edit-spending-cap"
              hitSlop={10}
              className="bg-light-primary-red/10 p-2 rounded-xl"
            >
              <Pencil size={16} color="#c71c4b" />
            </Pressable>
          }
        />
        {custom && (
          <Pressable onPress={onReset} hitSlop={8} className="mt-2">
            <Text className="text-[11px] text-light-primary-red underline">
              Reset to the site's request
            </Text>
          </Pressable>
        )}
      </View>
    );
  }

  const parsed = parseSpendingCapInput(text, decimals);

  return (
    <View className="w-full">
      <View className="flex-row items-center gap-2">
        <TextInput
          value={text}
          onChangeText={(t) => {
            setText(t);
            setError(null);
          }}
          autoFocus
          keyboardType="decimal-pad"
          placeholder="0"
          placeholderTextColor="#20222c66"
          className="flex-1 border border-light-matte-black/15 rounded-xl px-3 py-2.5 text-xl font-bold text-light-matte-black bg-white"
        />
        {symbol && (
          <Text className="text-base font-semibold text-light-matte-black/60">
            {symbol}
          </Text>
        )}
      </View>
      {/*
        The number typed here is scaled before it is encoded, and the scale is
        invisible: "6" becomes 6000000 on a six-decimal token. Showing the
        encoded integer live is what makes that step checkable rather than
        something the user has to trust, and it is the same value that appears
        under "Cap (raw units)" in the sheet's technical drawer.
      */}
      {parsed.ok && (
        <Text className="text-[11px] text-light-matte-black/50 mt-1.5">
          Approves {groupDigits(parsed.value)} raw units
        </Text>
      )}
      {error && (
        <Text className="text-[11px] text-light-primary-red mt-1.5">
          {error}
        </Text>
      )}
      <View className="flex-row gap-2 mt-2">
        <Pressable
          onPress={() => {
            setEditing(false);
            setError(null);
          }}
          className="px-3 py-1.5 rounded-xl bg-light-matte-black/5"
        >
          <Text className="text-xs font-semibold text-light-matte-black">
            Cancel
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            if (!parsed.ok) {
              setError(spendingCapError(parsed.reason, decimals));
              return;
            }
            onChange(parsed.value);
            setEditing(false);
          }}
          className="px-3 py-1.5 rounded-xl bg-light-primary-red"
        >
          <Text className="text-xs font-semibold text-white">Save</Text>
        </Pressable>
      </View>
    </View>
  );
}
