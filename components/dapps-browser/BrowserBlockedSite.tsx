import { Compass, ShieldX } from "lucide-react-native";
import React, { memo } from "react";
import { Alert } from "react-native";
import BrowserNoticePage, { type NoticeAction } from "./BrowserNoticePage";

type BrowserBlockedSiteProps = {
  /** Bare hostname that was blocked, from our own URL parse. */
  host: string;
  /** Leaves for the hub. The safe path, so it gets the filled button. */
  onLeave: () => void;
  /**
   * Load it anyway for the rest of this browser session. Omit to make the
   * block absolute.
   */
  onProceed?: () => void;
};

/**
 * Shown instead of a site the scam-domain feed has flagged.
 *
 * This is the error page a wallet is actually judged on. Wallet-browser
 * page failures are dominated by deliberate blocks, not broken servers:
 * Permit2 / setApprovalForAll drainers live on lookalike claim domains,
 * and the interstitial is the last thing between a user and a signature
 * that empties their token approvals.
 *
 * Three deliberate choices, matching what MetaMask, Coinbase Wallet and
 * Phantom converged on:
 *
 *   1. **It does not look like the network-error page.** Red, not grey,
 *      and the hostname is spelled out large. Lookalike domains only work
 *      while nobody reads them.
 *   2. **Leaving is the filled button.** "Continue" is a ghost link at the
 *      bottom behind a second confirmation, so nobody taps through by
 *      reflex on the way to a claim page.
 *   3. **Continuing does not unlock signing.** The bridge blocks
 *      signature-producing methods on a flagged origin regardless of what
 *      was chosen here (`DappBridge.dispatch` / `enqueue`), because feeds
 *      false-positive on browsing but the cost of a wrong signature is
 *      the whole wallet. Browsing is a preference; signing is not.
 */
const BrowserBlockedSite = memo<BrowserBlockedSiteProps>(
  function BrowserBlockedSite({ host, onLeave, onProceed }) {
    const actions: NoticeAction[] = [
      { label: "Back to safety", onPress: onLeave, variant: "primary" },
    ];

    if (onProceed) {
      actions.push({
        label: "Continue anyway",
        variant: "ghost",
        icon: Compass,
        onPress: () =>
          Alert.alert(
            "Continue to a flagged site?",
            "This site is on a known scam list. TakumiPay will still refuse to sign anything for it, and any funds you move could be stolen.",
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Continue",
                style: "destructive",
                onPress: onProceed,
              },
            ],
          ),
      });
    }

    return (
      <BrowserNoticePage
        icon={ShieldX}
        tone="critical"
        title="Deceptive site ahead"
        host={host}
        body="This site is on a known scam list. Sites like this imitate real apps to get you to approve a transaction that drains your wallet."
        actions={actions}
      />
    );
  },
);

export default BrowserBlockedSite;
