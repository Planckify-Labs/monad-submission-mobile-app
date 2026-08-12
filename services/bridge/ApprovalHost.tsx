import React, { useEffect, useState } from "react";
import type { ApprovalIntent } from "./approval";
import { getDappBridge } from "./DappBridge";
import { pendingIntentsStore } from "./pendingIntents";
import { getRenderers } from "./renderers";

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
  return (
    <Component
      key={intent.id}
      intent={intent}
      onDecision={(d) => {
        const bridge = getDappBridge();
        bridge?.resolve(intent.id, d);
      }}
    />
  );
}
