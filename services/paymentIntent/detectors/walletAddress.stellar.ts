/**
 * Stellar wallet-address detector — see `docs/stellar-chain-support-spec.md`
 * §1.2 / §3.2 and the chain-extension discipline in
 * `feedback_chain_extension_discipline.md`.
 *
 * Matches a raw canonical Stellar account address only: a StrKey `G…`
 * ed25519 public key (56 chars, base32 + CRC16 checksum). Validation is
 * delegated to `isValidStellarAddress` (thin wrapper over
 * `@stellar/stellar-base`'s `StrKey`) rather than a shape-only regex, so a
 * mistyped / truncated `G…` string fails the checksum here instead of
 * being handed to `/send` as a "valid" recipient.
 *
 * Lives in its own file (rather than alongside the EVM/Solana shapes in
 * `walletAddress.ts`) per the discipline note in that file's header:
 * "Adding a new bare-address shape … is a new detector file, not a new
 * `if` here." This mirrors `walletAddress.sui.ts`.
 *
 * Priority 50 — peer to `walletAddressDetector` / `walletAddressSuiDetector`.
 * The `G…` base32 shape doesn't overlap the EVM `0x{40}`, Sui `0x{64}`, or
 * Solana base58 (32-44 char) shapes, so registration order between the
 * bare-address detectors doesn't matter.
 *
 * Purity: no React, no network. Returns the raw address as-is so the
 * /send screen remains the single authority on canonicalisation.
 */

import { isValidStellarAddress } from "@/services/chains/stellar/strkey.ts";
import { type Detector, register } from "../detectorRegistry.ts";
import type { PaymentIntent, RawScan } from "../types.ts";

export const walletAddressStellarDetector: Detector = {
  name: "walletAddressStellar",
  priority: 50,
  detect: (raw: RawScan): PaymentIntent | null => {
    const trimmed = raw.trim();
    if (!isValidStellarAddress(trimmed)) return null;

    return {
      source: "qr",
      channel: {
        kind: "wallet",
        namespace: "stellar",
        address: trimmed,
        target: undefined,
      },
      rawScan: raw,
    };
  },
};

register(walletAddressStellarDetector);
