import React, { useEffect, useState } from "react";
import { Modal, Text, TouchableOpacity, View } from "react-native";
import type { ApprovalIntent } from "./approval";
import { getDappBridge } from "./DappBridge";
import { pendingIntentsStore } from "./pendingIntents";
import { getRenderers } from "./renderers";

/**
 * Render failures inside an approval sheet must not reach the app root.
 *
 * A sheet renders attacker-influenced data — calldata, decoded
 * arguments, token symbols, simulation output — supplied by whatever
 * page the user happened to open. With no boundary (and this app had
 * none anywhere), a single throw on that path unmounts the entire tree,
 * which makes a malformed dApp payload an app-wide denial of service.
 *
 * Failing closed means rejecting: the request gets an answer, the queue
 * advances, and the user is never left looking at a half-rendered sheet
 * to approve. The reject is deferred out of the commit phase because it
 * writes to the store this component subscribes to.
 *
 * This is not hypothetical: the tower.exchange force-close was a
 * `TypeError` thrown from this subtree's simulation effect, and with no
 * boundary it took the process down. A boundary would have turned it
 * into one rejected request.
 *
 * It must also be *visible*. The first version of this rendered `null`
 * on failure, and on device that was its own hazard: the user asked
 * tower.exchange for a swap, the ERC-20 `approve` sheet threw while
 * mounting, and the sheet simply never appeared while the dApp carried
 * on to the next step. The request was rejected correctly
 * (`handleDecision` returns on `outcome: "reject"` before
 * `executeApproval`, so nothing was ever signed), but from the outside a
 * silent rejection and a silent approval look identical — and the user
 * reasonably read it as the wallet approving spend without asking. Never
 * let an approval surface fail into nothing.
 *
 * Caveat: JS throws only. A failure that lands in native code (a bad
 * shadow-tree node, a crashing native module) aborts below the JS layer
 * where no boundary can intervene.
 */
class ApprovalSheetBoundary extends React.Component<
  { intentId: string; children: React.ReactNode },
  { failed: boolean; dismissed: boolean }
> {
  state = { failed: false, dismissed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    if (__DEV__) console.error("[ApprovalHost] sheet render failed", error);
    const { intentId } = this.props;
    setTimeout(() => {
      getDappBridge()?.resolve(intentId, { id: intentId, outcome: "reject" });
      // Safety net: `resolve` only fans the decision out, and the
      // decision handler is what normally removes the intent. Drop it
      // here too so the queue can never stall on a sheet that cannot
      // render — that stall is what a dApp would be aiming for.
      pendingIntentsStore.remove(intentId);
    }, 0);
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.state.dismissed) return null;
    // Fixed copy, no error text — the underlying failure is dApp-supplied
    // and goes to __DEV__ logs only (CLAUDE.md user-facing-errors rule).
    // "Declined" is stated plainly so the outcome is never ambiguous.
    return (
      <Modal visible transparent animationType="fade">
        <View className="flex-1 bg-black/40 items-center justify-center px-8">
          <View className="bg-white rounded-2xl p-5 w-full">
            <Text className="text-base font-bold text-light-matte-black">
              Request declined
            </Text>
            <Text className="text-sm text-light-matte-black/70 mt-2">
              We could not display this request safely, so it was declined and
              nothing was signed. You can try again from the site.
            </Text>
            <TouchableOpacity
              onPress={() => this.setState({ dismissed: true })}
              className="mt-4 py-3 rounded-2xl bg-light-primary-red items-center"
              accessibilityLabel="dismiss-failed-approval"
            >
              <Text className="text-white font-bold">Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  }
}

export function ApprovalHost(): React.ReactElement | null {
  const [intents, setIntents] = useState<ApprovalIntent[]>([]);

  useEffect(() => {
    const unsub = pendingIntentsStore.subscribe(setIntents);
    void pendingIntentsStore.hydrate();
    return unsub;
  }, []);

  if (intents.length === 0) return null;
  // Oldest first, one active sheet.
  const intent = intents[0];
  const renderers = getRenderers();
  const match = renderers.find((r) => {
    try {
      return r.canHandle(intent);
    } catch {
      return false;
    }
  });

  if (!match) {
    // No renderer matched — dev-time bug. Auto-reject after 100ms so the dApp
    // isn't left hanging.
    setTimeout(() => {
      const bridge = getDappBridge();
      bridge?.resolve(intent.id, { id: intent.id, outcome: "reject" });
    }, 100);
    if (__DEV__) {
      console.warn(
        "[ApprovalHost] no renderer for intent",
        intent.namespace,
        intent.kind,
      );
    }
    return null;
  }

  const Component = match.Component;
  // `key` is load-bearing, not tidiness (spec phase Q). Two consecutive
  // requests of the same kind render the same element type in the same
  // position, so without a key React reuses the instance and the new
  // sheet inherits the previous one's state: the last transaction's
  // simulated asset movement, an expanded raw-data panel, a half-armed
  // biometric prompt. Keying by intent id makes every request a fresh
  // mount, which is also what re-arms the queue input lock.
  // The key sits on the boundary so it remounts with the sheet: a fresh
  // request must get a fresh boundary, or one failed sheet would leave
  // every later request in this position rendering as null.
  return (
    <ApprovalSheetBoundary key={intent.id} intentId={intent.id}>
      <Component
        intent={intent}
        onDecision={(d) => {
          const bridge = getDappBridge();
          bridge?.resolve(intent.id, d);
        }}
      />
    </ApprovalSheetBoundary>
  );
}
