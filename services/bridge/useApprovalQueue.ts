/**
 * Approval-queue state for the sheet chrome — spec phase Q.
 *
 * A sheet used to render with no idea anything was behind it. The user
 * saw one request, and the next one appeared in the same place the
 * instant they dealt with it, with no signal that a queue existed at
 * all. That is fine when the queue is one deep and actively harmful when
 * it is not:
 *
 *   - **Depth** turns "another sheet appeared" into "2 of 3", which is
 *     the difference between confusion and information.
 *   - **Reject all** makes the escape one tap instead of N. Without it,
 *     the cheapest way out of a ten-deep queue is ten taps in exactly
 *     the spot where the tenth sheet's approve button will be.
 *   - **The input lock** is the one that matters. The attack here is a
 *     mis-tap, not a crash: the reject button of sheet *n* sits under
 *     the finger that is about to approve sheet *n+1*. Nine rejections
 *     build the muscle memory and the tenth is a drain.
 *
 * The lock is deliberately narrow. It arms only while the queue is
 * draining, so the ordinary single-approval path is untouched — a
 * blanket delay on every sheet would tax every honest interaction to
 * defend against one that needs a queue to exist.
 */

import { useCallback, useEffect, useState } from "react";
import type { ApprovalIntent } from "./approval";
import { getDappBridge } from "./DappBridge";
import { pendingIntentsStore, QUEUE_INPUT_LOCK_MS } from "./pendingIntents";

export interface ApprovalQueueState {
  /** Total pending approvals, including the one on screen. */
  depth: number;
  /** 1-based position of the sheet on screen. */
  position: number;
  /** True while a newly-presented sheet must not accept an approve tap. */
  locked: boolean;
  /** Reject everything still queued, including the sheet on screen. */
  rejectAll: () => void;
}

export function useApprovalQueue(
  intentId: string | undefined,
): ApprovalQueueState {
  const [intents, setIntents] = useState<ApprovalIntent[]>(() =>
    pendingIntentsStore.snapshot.slice(),
  );
  useEffect(() => pendingIntentsStore.subscribe(setIntents), []);

  const [locked, setLocked] = useState(false);
  useEffect(() => {
    if (!intentId) return;
    // Arm only when this sheet is replacing one the user just dismissed.
    // A sheet the user opened themselves, with nothing behind it, gets
    // no delay.
    if (!pendingIntentsStore.isDraining()) {
      setLocked(false);
      return;
    }
    setLocked(true);
    const t = setTimeout(() => setLocked(false), QUEUE_INPUT_LOCK_MS);
    return () => clearTimeout(t);
  }, [intentId]);

  const rejectAll = useCallback(() => {
    const bridge = getDappBridge();
    // Snapshot first: resolving mutates the store as we go.
    for (const i of pendingIntentsStore.snapshot) {
      bridge?.resolve(i.id, { id: i.id, outcome: "reject" });
    }
  }, []);

  const index = intentId ? intents.findIndex((i) => i.id === intentId) : -1;
  return {
    depth: intents.length,
    position: index >= 0 ? index + 1 : 1,
    locked,
    rejectAll,
  };
}

/**
 * The input lock on its own, for the shared action bar.
 *
 * Keyed on mount rather than on an intent id so no sheet has to
 * remember to pass anything: `ApprovalHost` keys each sheet by
 * `intent.id`, so a new request is a new mount, and a new mount re-arms
 * this. A control every sheet must opt into is a control some sheet
 * eventually will not.
 */
export function useQueueInputLock(): boolean {
  const [locked, setLocked] = useState(() => pendingIntentsStore.isDraining());
  useEffect(() => {
    if (!locked) return;
    const t = setTimeout(() => setLocked(false), QUEUE_INPUT_LOCK_MS);
    return () => clearTimeout(t);
    // Runs once per mount: `locked` is only ever set false from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return locked;
}
