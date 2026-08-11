/**
 * The button a failure card renders when the failure is "you have no
 * wallet on that chain".
 *
 * Agent failure cards were text-only: `agentErrorCopy` returned a
 * sentence and that was the whole surface. For most failures that is
 * right (a stale quote just needs a retry), but the missing-wallet family
 * is the one class the user can clear immediately, and telling them to
 * "add one, then try again" without a way to add one is a dead end.
 *
 * Renders nothing when there is no action, so a card can drop it in
 * unconditionally next to its error text.
 */

import { Plus } from "lucide-react-native";
import { memo } from "react";
import { Pressable, Text } from "react-native";
import { missingWalletCopy } from "@/components/wallet/missingWalletCopy";
import { useAddWalletPrompt } from "@/hooks/useAddWalletPrompt";
import type { Namespace } from "@/services/chains/types";
import { agentErrorAction } from "../agentErrorCopy";

type Props = {
  error: string | undefined;
  reason: string | undefined;
  /**
   * For failures whose chain lives in the tool payload rather than the
   * reason string (a bridge knows its `to_chain`; the reason
   * `no_wallet_on_destination_chain` does not).
   */
  destinationNamespace?: Namespace;
};

const AddWalletErrorAction = memo(function AddWalletErrorAction({
  error,
  reason,
  destinationNamespace,
}: Props) {
  const { promptFor, sheet } = useAddWalletPrompt();
  const action = agentErrorAction(error, reason, destinationNamespace);

  if (!action) return null;

  const copy = missingWalletCopy(action.namespace);
  return (
    <>
      <Pressable
        onPress={() => promptFor(action.namespace)}
        accessibilityRole="button"
        accessibilityLabel={copy.cta}
        className="mt-2 flex-row items-center self-start rounded-full border border-light-primary-red/30 bg-light-primary-red/5 px-3 py-1.5 active:opacity-70"
      >
        <Plus size={12} color="#c71c4b" strokeWidth={2.5} />
        <Text className="ml-1 text-xs font-semibold text-light-primary-red">
          {copy.cta}
        </Text>
      </Pressable>
      {sheet}
    </>
  );
});

export default AddWalletErrorAction;
export { AddWalletErrorAction };
