/**
 * Payment-intent types — see `docs/umkm-usdc-payout-spec.md` §4.2.
 *
 * These types are the normalised shape every scanned / pasted / deep-linked
 * payment payload collapses into before the router decides which screen to
 * show. They are **chain-agnostic at the classifier layer** (per memory
 * `feedback_chain_extension_discipline.md`); any per-chain logic lives
 * inside an individual `Detector` (see `detectorRegistry.ts`), never as
 * `if (namespace === "X")` branches in shared code.
 */

export type PayChannel =
  | {
      kind: "wallet";
      namespace: "eip155" | "solana" | "sui" | "stellar";
      address: string;
      /**
       * Specific target chain when the payload carries one:
       *  - EIP-681 `ethereum:0x…@137` → `{ namespace: "eip155", chainId: 137 }`
       *  - `solana:<addr>` (no cluster) → `{ namespace: "solana", cluster: "mainnet-beta" }`
       *  - raw Sui address (no network info) → `undefined` (scanner keeps
       *    the current Sui activeChain; only the namespace is guaranteed
       *    to switch). A future `sui:` URI scheme would emit
       *    `{ namespace: "sui", network }`.
       *  - raw `0x…` 40-hex address (no chain info) → `undefined` (scanner
       *    keeps the current EVM activeChain; only the namespace is
       *    guaranteed to switch).
       *  - raw Stellar `G…` strkey (no network info) → `undefined` (scanner
       *    keeps the current Stellar activeChain; only the namespace is
       *    guaranteed to switch).
       */
      target?:
        | { namespace: "eip155"; chainId: number }
        | { namespace: "solana"; cluster: "mainnet-beta" | "devnet" }
        | { namespace: "sui"; network: "mainnet" | "testnet" | "devnet" };
      amount?: bigint;
      /** ERC-20 / SPL token address when the URI specifies one. */
      token?: string;
    }
  | {
      kind: "merchant";
      provider:
        | "takumipay"
        | "xendit_qris"
        | "xendit_promptpay"
        | "xendit_paynow"
        | "xendit_duitnow"
        | "xendit_vietqr";
      merchantId: string;
      amountMinor?: number;
      currency?: "IDR" | "PHP" | "THB" | "MYR" | "VND";
      rawPayload: string;
      /** Display name from the QR payload (JWS `merchantName` or QRIS tag 59). */
      merchantName?: string;
      /** City from the QR payload (QRIS tag 60). */
      merchantCity?: string;
      /**
       * QRIS-specific decoded metadata. Only populated when
       * `provider === "xendit_qris"`. The server (task 27) uses these
       * fields to resolve a merchant against the Bank Indonesia registry
       * and to enforce first-claim-wins on `qrisPan` in
       * `MerchantQrisClaim`. Absent for non-QRIS providers.
       *
       * Acquirer vs national:
       *   - A QRIS sticker typically carries two merchant-info blocks.
       *     Tag 26-50: acquirer's block (GoPay / DANA / OVO / Shopee /
       *     bank), used for payment routing.
       *     Tag 51: the QRIS national registry block (GUI
       *     `ID.CO.QRIS.WWW`), used for merchant lookup.
       *   - Simple stickers where the acquirer is also the national
       *     QRIS registry (GUI `ID.CO.QRIS.WWW` on tag 26) collapse the
       *     two: `acquirerGui === "ID.CO.QRIS.WWW"` and
       *     `nationalNmid === acquirerNmid`.
       */
      qris?: {
        /** Sub-tag 01 of the primary (acquirer) merchant-info block. */
        pan: string;
        /** Sub-tag 00 of the primary block — reverse-DNS acquirer label. */
        acquirerGui: string;
        /** Sub-tag 02 of the primary block — acquirer-internal NMID. */
        acquirerNmid?: string;
        /**
         * Sub-tag 02 of the block whose GUI is `ID.CO.QRIS.WWW` — the
         * National Merchant Identifier under the QRIS national rails.
         * Stable across acquirers; preferred key for server-side
         * merchant resolution.
         */
        nationalNmid?: string;
        /** Tag 59 — merchant display name. */
        merchantName?: string;
        /** Tag 60 — merchant city. */
        merchantCity?: string;
        /** Tag 52 — Merchant Category Code (ISO 18245). */
        merchantCategoryCode?: string;
        /** Tag 61 — merchant postal code. */
        postalCode?: string;
      };
    }
  | { kind: "x402"; resourceUrl: string };

export interface PaymentIntent {
  source: "qr" | "deeplink" | "paste";
  channel: PayChannel;
  rawScan: string;
}

/**
 * The opaque string the barcode reader / deep-link handler / paste buffer
 * hands us. `classify()` is the only function allowed to parse it.
 */
export type RawScan = string;
