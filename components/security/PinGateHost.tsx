/**
 * `<PinGateHost />` renders the in-app PIN sheet for whatever request is
 * parked in `services/security/pinGate.ts`. Root-mounted in
 * `app/_layout.tsx` (after `ApprovalHost`) so a dApp approval sheet, the
 * link-inbox interstitial, or a wallet-details toggle can all reach it
 * without owning a modal of their own.
 *
 * The sheet is `PinConfirmationModal`, the same one the send / redeem /
 * sign-in flows use, so a user with no PIN yet gets the existing
 * "Security Setup" walkthrough before being asked to confirm.
 *
 * Mounted fresh per request (`key={id}`) rather than kept alive with
 * `visible=false`: `usePin` reads `hasPin` once at mount, and a long-lived
 * instance would go stale the moment another screen's modal sets the
 * PIN, then re-run setup and overwrite it.
 */

import React, { useEffect, useState, useSyncExternalStore } from "react";
import PinConfirmationModal from "@/components/common/PinConfirmationModal";
import {
  getPinGateRequest,
  type PinGateRequest,
  resolvePinGate,
  subscribePinGate,
} from "@/services/security/pinGate";

// Long enough for BaseModal's close animation to finish before the
// instance is dropped; the exact value only affects polish, not logic.
const UNMOUNT_AFTER_CLOSE_MS = 300;

export function PinGateHost() {
  const request = useSyncExternalStore(
    subscribePinGate,
    getPinGateRequest,
    getPinGateRequest,
  );
  // Lags `request` on the way out so the sheet can animate closed.
  const [shown, setShown] = useState<PinGateRequest | null>(null);

  useEffect(() => {
    if (request) {
      setShown(request);
      return;
    }
    const t = setTimeout(() => setShown(null), UNMOUNT_AFTER_CLOSE_MS);
    return () => clearTimeout(t);
  }, [request]);

  if (!shown) return null;
  return (
    <PinConfirmationModal
      key={shown.id}
      visible={request?.id === shown.id}
      title={shown.title}
      onClose={() => resolvePinGate(false)}
      onConfirm={() => resolvePinGate(true)}
    />
  );
}
