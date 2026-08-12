/**
 * Address plus, when one is safe to show, its ENS name — spec phase R.
 *
 * We have shipped ENS since before this spec: `services/ens/resolver.ts`
 * does forward, reverse, avatar and CCIP-read with a 24h cache, and the
 * address book uses it. The dApp approval sheets did not. So a user
 * sending to a saved contact saw a name, while the same user approving a
 * dApp transaction to the same address saw 42 hex characters. The screen
 * with the higher stakes carried the less legible label.
 *
 * ### This is not a free win, and the constraints are the feature
 *
 * Anyone can register an ENS name. Putting `uniswap-app.eth` beside an
 * attacker's address is a trusted-looking label on the exact screen
 * where consent is given — the same failure mode that got Blur removed
 * from `knownSpenders` in §16.3, except here the attacker supplies the
 * name themselves for the price of a registration. Five rules contain
 * it, and none of them are decoration:
 *
 *   1. **Additive, never a replacement.** The full address stays on
 *      screen, always. A sheet showing only a name is worse than one
 *      showing only an address, and this is also what makes the
 *      same-script confusable class (`rn` vs `m`) survivable: there is
 *      always something exact to check against.
 *   2. **Reverse only.** The name is resolved *from the address we are
 *      about to sign for*. A name arriving inside a dApp payload is
 *      never rendered here, at any point, for any reason.
 *   3. **Script-gated.** See `services/ens/displaySafety.ts`.
 *   4. **Beautified**, so the rendered form is canonical.
 *   5. **No trust vocabulary.** No check mark, no "verified", no green,
 *      no badge. An ENS name means somebody paid a registration fee and
 *      it means nothing else. This is the constraint most likely to be
 *      softened later by someone who reads the label as a feature, so:
 *      it is not a feature, it is a legibility aid, and the moment it
 *      implies endorsement it is worse than the hex it replaced.
 *
 * Resolution is best-effort and off the approval path. A slow or failed
 * lookup renders the address and never delays the sheet.
 */

import React from "react";
import { Text, View } from "react-native";
import { useENSName } from "@/hooks/queries/useENS";
import { ensDisplaySafety } from "@/services/ens/displaySafety";

interface Props {
  /**
   * The counterparty being signed for. Comes from the call under
   * review, never from a dApp-supplied name field.
   */
  address: `0x${string}` | undefined;
  /** Shown in place of the address for a contract creation. */
  fallbackLabel?: string;
}

export function CounterpartyLabel({
  address,
  fallbackLabel,
}: Props): React.ReactElement {
  const { data: name } = useENSName(address);
  const safety = ensDisplaySafety(name);

  if (!address) {
    return (
      <Text className="text-sm text-gray-900">
        {fallbackLabel ?? "Not set"}
      </Text>
    );
  }

  return (
    <View>
      {safety.render && (
        // Deliberately plain: same weight as the surrounding body text,
        // no icon, no accent colour. It reads as a nickname, which is
        // exactly what it is.
        <Text className="text-sm text-gray-700" numberOfLines={1}>
          {safety.display}
        </Text>
      )}
      <Text className="text-sm text-gray-900" selectable>
        {address}
      </Text>
    </View>
  );
}
