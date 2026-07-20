/**
 * Emoji-hash verification grid — TWV-2026-066 (ERC-8213 companion view).
 *
 * A deterministic pictogram fingerprint of a signing digest. The mapping
 * is APP-SPECIFIC: ERC-8213 mentions emoji digests only as a non-normative
 * "further consideration" and standardises no palette or algorithm, so two
 * devices render the same grid for the same digest ONLY when both run this
 * app. It is therefore a fast, human-friendly comparison aid within our own
 * ecosystem plus an anti-habituation nudge — NOT a cross-wallet check. The
 * interoperable, standard artifact for verifying against a hardware wallet
 * or a different wallet is the Hex digest (keccak256 is universal; the
 * emoji palette is ours alone).
 *
 * One row is highlighted as an active spot-check; "Check another row" moves
 * the highlight so an attacker can never predict which row gets scrutinized.
 *
 * Presentational only. The highlighted-row state is owned by the parent
 * (`ClearSigningSection`) so it survives the Hex<->Emoji toggle — the
 * emoji grid itself is a pure function of `value` and never changes for a
 * given transaction. Like the hex digest, this never gates approve/reject.
 */

import React, { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import {
  EMOJI_HASH_COLUMNS,
  EMOJI_HASH_COUNT,
  emojiHash,
  toEmojiGrid,
} from "@/services/security/emojiHash";

interface Props {
  /** The canonical digest value to fingerprint (hex or base58). */
  value: string;
  /** Label of the digest this grid represents, e.g. "EIP-712 digest". */
  label: string;
  /** Row index the parent is spot-checking (highlighted red). */
  activeRow: number;
  /** Move the highlight to a different row for another spot-check. */
  onCheckAnotherRow: () => void;
}

export function EmojiHashGrid({
  value,
  label,
  activeRow,
  onCheckAnotherRow,
}: Props): React.ReactElement {
  const rows = useMemo(
    () => toEmojiGrid(emojiHash(value, EMOJI_HASH_COUNT), EMOJI_HASH_COLUMNS),
    [value],
  );
  const rowCount = rows.length || 1;
  const highlighted = ((activeRow % rowCount) + rowCount) % rowCount;

  return (
    <View>
      <Text className="text-[10px] text-gray-500 mb-2">{label}</Text>
      <View className="gap-1">
        {rows.map((row, r) => {
          const isActive = r === highlighted;
          return (
            <View
              key={`emoji-row-${r}`}
              className={`flex-row items-center justify-between px-2 py-1.5 rounded-md ${
                isActive
                  ? "bg-red-50 border border-red-300"
                  : "border border-transparent"
              }`}
            >
              {row.map((emoji, c) => (
                <Text
                  key={`emoji-${r}-${c}`}
                  className={`text-2xl ${isActive ? "" : "opacity-90"}`}
                >
                  {emoji}
                </Text>
              ))}
            </View>
          );
        })}
      </View>
      <View className="flex-row items-center justify-between mt-2">
        <Text className="text-[10px] text-red-700 flex-1 pr-2">
          Confirm the highlighted row matches another device running this app.
        </Text>
        <Pressable
          onPress={onCheckAnotherRow}
          className="px-2.5 py-1 rounded-md bg-gray-200"
          hitSlop={8}
        >
          <Text className="text-[11px] font-semibold text-gray-700">
            Check another row
          </Text>
        </Pressable>
      </View>
      <Text className="text-[10px] text-gray-400 mt-2">
        This emoji fingerprint only matches another device running this app. To
        verify against a hardware wallet or a different wallet, compare the Hex
        digest instead.
      </Text>
    </View>
  );
}
