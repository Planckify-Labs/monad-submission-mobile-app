import { Image } from "expo-image";
import React, { memo } from "react";
import { View } from "react-native";

/**
 * The dApps browser's brand object: the Takumi mark inside a miniature of
 * the browser frame.
 *
 * The dApp viewport on this screen is a thick matte-black rounded
 * rectangle. This tile is that same frame at 88px, so every screen where
 * there is no page to show ("loading", "failed", "blocked") reads as the
 * browser window itself, empty, holding our mark. That is the whole idea:
 * one recognisable object in several states, rather than a different
 * stock glyph per situation.
 *
 * A logo dropped in the middle of a spinner is what every app does. This
 * is cheap to render, uses no new assets, and is unmistakably this
 * product's screen even in a screenshot with the text cropped out.
 */

export type IconComponent = React.ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
}>;

type BrandMarkTileProps = {
  size?: number;
  /** Small state glyph clipped to the tile's lower-right corner. */
  badgeIcon?: IconComponent;
  badgeColor?: string;
  /**
   * Fades the mark. Used when the wallet is idle rather than acting (a
   * network fault is not a brand moment; a refused drainer is).
   */
  dim?: boolean;
};

const BrandMarkTile = memo<BrandMarkTileProps>(function BrandMarkTile({
  // Sized to be the clear hero of the screen, the way MetaMask's fox and
  // Bitget's illustration are. A small mark above a wall of text reads as
  // an icon; at this size the brand is the first thing you see and the
  // copy is what you read second.
  size = 112,
  badgeIcon: BadgeIcon,
  badgeColor,
  dim = false,
}) {
  const badgeSize = Math.round(size * 0.36);

  return (
    <View style={{ width: size, height: size }}>
      <View
        className="flex-1 items-center justify-center bg-light border-light-matte-black"
        style={{
          // Matches the viewport frame's proportions: border and radius
          // both scale with the tile so it stays the same object.
          borderWidth: Math.max(3, Math.round(size * 0.045)),
          borderRadius: Math.round(size * 0.29),
        }}
      >
        <Image
          source={require("@/assets/images/takumipay-no-bg.png")}
          style={{
            width: Math.round(size * 0.44),
            height: Math.round(size * 0.44),
            opacity: dim ? 0.35 : 1,
          }}
          contentFit="contain"
        />
      </View>

      {BadgeIcon ? (
        <View
          className="absolute items-center justify-center rounded-full bg-light"
          style={{
            width: badgeSize,
            height: badgeSize,
            right: -badgeSize * 0.3,
            bottom: -badgeSize * 0.3,
            // Cut out of the page background rather than outlined, so the
            // badge reads as sitting in front of the frame.
            borderWidth: 3,
            borderColor: "#f5f6f9",
          }}
        >
          <BadgeIcon
            size={Math.round(badgeSize * 0.55)}
            color={badgeColor}
            strokeWidth={2.5}
          />
        </View>
      ) : null}
    </View>
  );
});

export default BrandMarkTile;
