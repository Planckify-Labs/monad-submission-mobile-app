/**
 * `switchToScannedTarget` — see `docs/umkm-usdc-payout-spec.md` §4.6 and
 * task 07.
 *
 * Pure function that maps a classified `PaymentIntent` onto a navigation
 * descriptor ({ route, params }). The scan-to-pay screen (and any future
 * paste-to-pay entrypoint the spec mentions) consumes this to drive
 * `router.replace(...)` — the helper itself knows nothing about
 * `expo-router`, React, or `useWallet`, so it is trivially testable in
 * a Node harness with no RN shims.
 *
 * Chain-extension discipline (memory
 * `feedback_chain_extension_discipline.md`): dispatch is on
 * `channel.kind` (and `channel.provider` inside the merchant branch), NOT
 * on `namespace === "X"`. Namespace-specific activation (switching the
 * active wallet / chain so the `/send` screen renders against the right
 * network) is a render-time concern for the send flow — keeping it out
 * of this helper is what makes the helper pure.
 *
 * M1 scope (§4.6 orchestration):
 *   - `"wallet"`   → `/send` with recipient + optional amount / token / chain hints.
 *   - `"merchant"` → `/pay-merchant` with a `raw` payload (JWS or QRIS
 *                    string). Task 23 (M2 backend) supersedes this with
 *                    a server-minted `intentId`.
 *   - `"x402"`     → `/pay-x402` with the resolved resource URL. Task 39
 *                    (Path C M5) wired this up — the screen runs the raw
 *                    402 → sign → submit flow against the merchant's own
 *                    server (NOT our intent backend, per §5.3).
 */

import type { PaymentIntent } from "./types.ts";

/**
 * Params are flat string maps because `expo-router`'s `router.replace`
 * serialises everything to query-string values. Keeping the type narrow
 * (string | undefined) means the router callsite never has to guard
 * against `bigint` / `number` leaking through.
 */
export type NavParams = Record<string, string | undefined>;

export type SwitchToScannedTargetResult =
  | {
      kind: "navigate";
      route: "/send" | "/pay-merchant" | "/pay-x402";
      params: NavParams;
    }
  | {
      /** WalletConnect pairing QR: hand the URI to the session transport. */
      kind: "pair";
      uri: string;
    }
  | {
      kind: "unsupported";
      reason: string;
    };

export const switchToScannedTarget = (
  intent: PaymentIntent,
): SwitchToScannedTargetResult => {
  const { channel } = intent;

  switch (channel.kind) {
    case "wallet": {
      const params: NavParams = {
        recipientAddress: channel.address,
        namespace: channel.namespace,
        amount:
          channel.amount !== undefined ? channel.amount.toString() : undefined,
        token: channel.token,
      };
      // Surface `target` so the send screen can pre-switch chain / cluster
      // / network without re-parsing the raw URI. We flatten here to keep
      // `params` a plain string map (see `NavParams` doc above).
      if (channel.target) {
        if (channel.target.namespace === "eip155") {
          params.chainId = channel.target.chainId.toString();
        } else if (channel.target.namespace === "solana") {
          params.cluster = channel.target.cluster;
        } else {
          params.network = channel.target.network;
        }
      }
      return { kind: "navigate", route: "/send", params };
    }
    case "merchant": {
      // M1 stub — we pass the raw payload (JWS for takumipay, full EMVCo
      // string for xendit_qris) through to /pay-merchant. Task 23 (M2)
      // replaces this with a server-minted intentId once the backend
      // mint-endpoint lands; at that point the router call becomes
      // `{ intentId: <id> }` and `raw` is dropped.
      return {
        kind: "navigate",
        route: "/pay-merchant",
        params: {
          provider: channel.provider,
          raw: channel.rawPayload,
          merchantName: channel.merchantName ?? channel.qris?.merchantName,
        },
      };
    }
    case "wc": {
      // Deep-link spec D-10: a scanned pairing QR goes straight to the
      // ConnectSheet (the sheet is the consent), never to a form.
      return { kind: "pair", uri: channel.uri };
    }
    case "x402": {
      // Task 39 / Path C M5: hand the raw resource URL to the dedicated
      // `/pay-x402` screen. That screen owns the 402 handshake + signed
      // `x402-payment` submit flow against the merchant's own server
      // — NOT our intent backend (three-role separation, §5.3).
      return {
        kind: "navigate",
        route: "/pay-x402",
        params: {
          resourceUrl: channel.resourceUrl,
        },
      };
    }
  }
};
