/**
 * Executes a held deep-link intent after the user's Continue — the
 * non-React half of `app/link-inbox.tsx` (spec §4.2 lower half).
 *
 * Every branch ends in one of: a navigation the screen performs, a
 * terminal message the screen shows, or a typed rejection the screen
 * maps to copy. Nothing here signs: Class A/B drafts go through
 * `DappBridge.submitExternalIntent` and render the chain's own sheet;
 * Class C hands the link to its transport.
 */

import { Linking } from "react-native";
import type { TBlockchain } from "@/api/types/blockchain";
import type { TWallet } from "@/constants/types/walletTypes";
import { track } from "@/services/analytics/posthog";
import { getDappBridge } from "@/services/bridge/DappBridge";
import { switchToScannedTarget } from "@/services/paymentIntent/switchToScannedTarget";
import { encryptedLinkTransport } from "@/services/transports/encryptedLink";
import { walletConnectTransport } from "@/services/transports/walletconnect";
import { formatChainLabel } from "@/services/walletKit/chainInfo";
import { walletKitRegistry } from "@/services/walletKit/registry";
import { chainRefOfTarget, resolveChainConfig } from "./chainResolve";
import { INTERSTITIAL_COPY } from "./copy";
import type { InboxItem } from "./inbox";
import { markConsumed } from "./ledger";
import { safeFetch } from "./safeFetch";
import {
  DeepLinkBuildError,
  type DeepLinkRejectCode,
  type ExternalApprovalDraft,
  type ReturnChannel,
} from "./types";

export type ExecuteOutcome =
  | {
      kind: "navigate";
      href: string;
      params?: Record<string, string | undefined>;
    }
  | {
      kind: "done";
      title: string;
      body: string;
      explorerUrl?: string;
      returnTo?: { label: string; url: string };
    }
  | {
      kind: "rejected";
      code: DeepLinkRejectCode;
      domain?: string;
      chain?: string;
      asset?: string;
      /** Recovery data (e.g. `{ domain, newKey }` for `signing_key_changed`). */
      data?: Record<string, unknown>;
    }
  | { kind: "user-rejected" }
  /** The transport will present its own sheets; the interstitial can close. */
  | { kind: "handed-off" };

export interface ExecuteDeps {
  chainRows: () => TBlockchain[] | null;
  fetch?: typeof fetch;
}

function chainLabelFor(namespace: string): string {
  try {
    return walletKitRegistry.get(namespace as never).displayName ?? namespace;
  } catch {
    return namespace;
  }
}

function rejectFromError(e: unknown): ExecuteOutcome {
  if (e instanceof DeepLinkBuildError) {
    return {
      kind: "rejected",
      code: e.code,
      domain: e.domain,
      asset: e.asset,
      data: e.data,
    };
  }
  if (__DEV__) console.warn("[deeplinks/execute] build failed", e);
  return { kind: "rejected", code: "malformed" };
}

function explorerFor(
  draft: ExternalApprovalDraft,
  result: unknown,
  rows: TBlockchain[] | null,
): string | undefined {
  const hash = extractHash(result);
  if (!hash) return undefined;
  try {
    const kit = walletKitRegistry.get(draft.namespace);
    const cfg = resolveChainConfig(
      { namespace: draft.namespace, ref: null },
      rows,
    );
    return cfg ? (kit.buildTxExplorerUrl?.(hash, cfg) ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort hash / signature / digest extraction from adapter results. */
export function extractHash(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return extractHash(result[0]);
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    for (const key of ["hash", "signature", "digest", "txHash", "tx_hash"]) {
      if (typeof r[key] === "string") return r[key] as string;
    }
  }
  return null;
}

async function deliverReturnChannel(
  channel: ReturnChannel | undefined,
  result: unknown,
  deps: ExecuteDeps,
): Promise<ExecuteOutcome | null> {
  if (!channel || channel.kind !== "http-callback") return null;
  const r = (result ?? {}) as { signedTransaction?: string };
  const signed =
    typeof r.signedTransaction === "string" ? r.signedTransaction : null;
  let domain = channel.url;
  try {
    domain = new URL(channel.url).hostname;
  } catch {
    // keep raw
  }
  if (!signed) {
    return {
      kind: "done",
      title: "Signed",
      body: INTERSTITIAL_COPY.callbackFailed.replace("{domain}", domain),
    };
  }
  try {
    // SEP-0007: POST `xdr=<urlencoded signed envelope>` as a form body,
    // query parameters on the callback URL preserved. The signed XDR is
    // never opened as an OS URL (S-14).
    const res = await safeFetch(channel.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `xdr=${encodeURIComponent(signed)}`,
      fetchImpl: deps.fetch,
    });
    if (!res.ok) throw new Error("callback status");
    return {
      kind: "done",
      title: "Sent",
      body: INTERSTITIAL_COPY.callbackDelivered.replace("{domain}", domain),
    };
  } catch (e) {
    if (__DEV__)
      console.warn("[deeplinks/execute] callback delivery failed", e);
    return {
      kind: "done",
      title: "Not delivered",
      body: INTERSTITIAL_COPY.callbackFailed.replace("{domain}", domain),
    };
  }
}

async function submitDraft(
  draft: ExternalApprovalDraft,
  deps: ExecuteDeps,
  cls: "payment" | "signing",
): Promise<ExecuteOutcome> {
  const bridge = getDappBridge();
  if (!bridge) return { kind: "rejected", code: "malformed" };
  const outcome = await bridge.submitExternalIntent(draft, "deeplink");
  if (outcome.error) {
    if (outcome.error.code === 4001) return { kind: "user-rejected" };
    if (__DEV__)
      console.warn("[deeplinks/execute] bridge error", outcome.error);
    return { kind: "rejected", code: "malformed" };
  }
  track("deeplink_approved", {
    class: cls,
    transport: draft.provenance.transport,
  });
  const delivered = await deliverReturnChannel(
    draft.returnChannel,
    outcome.result,
    deps,
  );
  if (delivered) return delivered;
  return {
    kind: "done",
    title: cls === "payment" ? "Payment sent" : "Signed and sent",
    body: "Your request was completed.",
    explorerUrl: explorerFor(draft, outcome.result, deps.chainRows()),
  };
}

export async function executeHeldIntent(args: {
  item: InboxItem;
  /** Bound wallet (§4.7). `null` only for Class C / navigation kinds. */
  wallet: TWallet | null;
  deps: ExecuteDeps;
}): Promise<ExecuteOutcome> {
  const { item, wallet, deps } = args;
  const intent = item.intent;
  markConsumed(item.envelope.raw, Date.now());

  switch (intent.kind) {
    case "navigate":
      return { kind: "navigate", href: intent.href };
    case "open-dapp":
      return {
        kind: "navigate",
        href: "/dapps-browser",
        params: { url: intent.url },
      };
    case "reject":
      return { kind: "rejected", code: intent.code, domain: intent.domain };

    case "payment": {
      if (!wallet)
        return {
          kind: "rejected",
          code: "no_wallet_for_namespace",
          chain: chainLabelFor(intent.namespace),
        };
      const kit = walletKitRegistry.get(intent.namespace);
      const channel = intent.intent.channel;
      if (channel.kind !== "wallet")
        return { kind: "rejected", code: "malformed" };
      // A request without an amount ("the wallet must prompt the user")
      // is answered by the send screen, which is the amount prompt.
      const hasAmount =
        channel.amount !== undefined || channel.amountDecimal !== undefined;
      if (kit.buildPaymentRequest && hasAmount) {
        const chain = resolveChainConfig(
          chainRefOfTarget(intent.namespace, channel.target),
          deps.chainRows(),
        );
        if (!chain) return { kind: "rejected", code: "unsupported_chain" };
        try {
          const draft = await kit.buildPaymentRequest({
            wallet,
            chain,
            payment: intent.intent,
            provenance: intent.provenance,
          });
          return await submitDraft(draft, deps, "payment");
        } catch (e) {
          return rejectFromError(e);
        }
      }
      // No kit builder: the existing send screen owns this family. Source
      // and provenance ride along so it renders the banner (S-3).
      const next = switchToScannedTarget(intent.intent);
      if (next.kind !== "navigate")
        return { kind: "rejected", code: "unsupported_operation" };
      return {
        kind: "navigate",
        href: next.route,
        params: {
          ...next.params,
          source: "deeplink",
          linkVerification: intent.provenance.verification.kind,
          linkOrigin: intent.provenance.claimedOrigin,
        },
      };
    }

    case "signing": {
      if (!wallet)
        return {
          kind: "rejected",
          code: "no_wallet_for_namespace",
          chain: chainLabelFor(intent.namespace),
        };
      try {
        const draft = await intent.build(wallet, {
          chainRows: deps.chainRows,
          fetch: deps.fetch ?? fetch,
        });
        return await submitDraft(
          {
            ...draft,
            returnChannel: draft.returnChannel ?? intent.returnChannel,
          },
          deps,
          "signing",
        );
      } catch (e) {
        return rejectFromError(e);
      }
    }

    case "pair": {
      // Only an OS-delivered link sends the user back to the dApp after
      // the decision (§7.3 step 4); a scan, a paste or the in-app browser
      // (`internal`) keeps them here.
      const r = await walletConnectTransport.pair(intent.uri, {
        fromDeepLink:
          item.envelope.source !== "scan" &&
          item.envelope.source !== "paste" &&
          item.envelope.source !== "internal",
      });
      if (!r.ok) return { kind: "rejected", code: r.code };
      return { kind: "handed-off" };
    }

    // A wake never reaches the inbox (`intake` answers it inline); if one
    // does, there is nothing to run.
    case "wake":
      return { kind: "handed-off" };

    case "associate": {
      // The dedicated MWA activity owns association on Android; handing
      // the URI back to the OS routes it there. Failure is a fixed line.
      try {
        await Linking.openURL(intent.uri);
        return { kind: "handed-off" };
      } catch {
        return { kind: "rejected", code: "not_enabled" };
      }
    }

    case "encrypted-link": {
      const r = await encryptedLinkTransport.handle(intent, {
        wallet,
        chainRows: deps.chainRows,
        fetch: deps.fetch ?? fetch,
      });
      return r;
    }
  }
}

export function chainLabelForNamespace(namespace: string): string {
  return chainLabelFor(namespace);
}

export { formatChainLabel };
