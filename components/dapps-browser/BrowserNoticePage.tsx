import React, { memo } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { COLORS } from "../../constants/dapps-browser";
import BrandMarkTile, { type IconComponent } from "./BrandMarkTile";

/**
 * Shared full-bleed page shown in place of a dApp: network failures
 * (`BrowserPageError`) and blocked sites (`BrowserBlockedSite`).
 *
 * One shell for both on purpose. A wallet browser's two "this page is not
 * loading" screens have to be instantly distinguishable in tone yet
 * identical in structure, so a user learns the layout once and only has to
 * read the colour and the headline to know which situation they are in.
 */

export type NoticeTone = "neutral" | "warning" | "critical";

export type NoticeAction = {
  label: string;
  onPress: () => void;
  /**
   * `primary` is the filled button and must be the safe choice on a
   * critical page. `ghost` is for the action we do not want a user
   * tapping by reflex.
   */
  variant: "primary" | "outline" | "ghost";
  icon?: IconComponent;
};

const TONE_ACCENT: Record<NoticeTone, string> = {
  neutral: COLORS.PRIMARY_RED,
  warning: COLORS.AMBER,
  critical: COLORS.PRIMARY_RED,
};

// The lucide glyph is demoted to a badge on the brand tile rather than
// being the hero. Every browser ships the same grey warning triangle;
// a wallet's failure screens are one of the few moments a user actually
// stops and reads, which is why MetaMask's fox is on theirs. The mark
// leads, the glyph only says *which* failure this is.
//
// Dimmed on `neutral`: a network fault is the wallet idling, not the
// wallet acting. Full strength on `warning` / `critical`, where it
// actively refused and should look like it.

type BrowserNoticePageProps = {
  icon: IconComponent;
  tone: NoticeTone;
  title: string;
  /** Rendered between title and body, for the hostname in question. */
  host?: string;
  body: string;
  actions: NoticeAction[];
  /** `__DEV__` diagnostics or a fine-print line. */
  footnote?: string;
};

const BrowserNoticePage = memo<BrowserNoticePageProps>(
  function BrowserNoticePage({
    icon: Icon,
    tone,
    title,
    host,
    body,
    actions,
    footnote,
  }) {
    const accent = TONE_ACCENT[tone];

    return (
      <View className="absolute inset-0 bg-light-main-container items-center justify-center px-8">
        <BrandMarkTile
          badgeIcon={Icon}
          badgeColor={accent}
          dim={tone === "neutral"}
        />

        <Text
          className="mt-7 text-light-matte-black text-xl font-bold text-center"
          // Only the critical page tints its headline: on a drainer
          // warning the colour is doing as much work as the words.
          style={tone === "critical" ? { color: accent } : undefined}
        >
          {title}
        </Text>

        {host ? (
          <Text
            className="mt-1.5 text-light-matte-black text-base font-semibold text-center"
            numberOfLines={2}
          >
            {host}
          </Text>
        ) : null}

        <Text className="mt-2.5 text-light-matte-black/60 text-sm leading-5 text-center max-w-[290px]">
          {body}
        </Text>

        <View className="mt-8 w-full max-w-[280px] gap-2">
          {actions.map((action) => {
            const isPrimary = action.variant === "primary";
            const isGhost = action.variant === "ghost";
            const ActionIcon = action.icon;
            return (
              <TouchableOpacity
                key={action.label}
                onPress={action.onPress}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                className={
                  isPrimary
                    ? "bg-light-primary-red rounded-2xl py-3.5 flex-row items-center justify-center"
                    : isGhost
                      ? "py-3 flex-row items-center justify-center"
                      : "border border-light-matte-black/10 rounded-2xl py-3.5 flex-row items-center justify-center"
                }
              >
                {ActionIcon ? (
                  <ActionIcon
                    size={16}
                    color={
                      isPrimary
                        ? COLORS.WHITE
                        : isGhost
                          ? COLORS.GRAY_600
                          : COLORS.PRIMARY_RED
                    }
                    strokeWidth={2.5}
                  />
                ) : null}
                <Text
                  className={`font-semibold text-sm ${ActionIcon ? "ml-2" : ""} ${
                    isPrimary
                      ? "text-white"
                      : isGhost
                        ? "text-light-matte-black/60 font-medium"
                        : "text-light-matte-black"
                  }`}
                >
                  {action.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {footnote ? (
          <Text className="mt-6 text-light-matte-black/30 text-[10px] text-center">
            {footnote}
          </Text>
        ) : null}
      </View>
    );
  },
);

export default BrowserNoticePage;
