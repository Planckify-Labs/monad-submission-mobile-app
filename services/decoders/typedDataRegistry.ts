/**
 * Typed-data decoder dock.
 *
 * `clearSigning.ts` used to probe a hardcoded chain of decoders
 * (`tryDecodeErc2612`, then `tryDecodePermit2`) and build each one's
 * descriptor inline. Every new EIP-712 standard meant editing that
 * function, so the cost of supporting one grew with the number already
 * supported.
 *
 * Decoders dock here instead. A decoder inspects the typed data, claims
 * it or returns `null`, and emits a `ClearSigningDescriptor` — the same
 * shape adapter-resolved descriptors use, so the sheet renders all of
 * them identically. Adding a standard is one file plus one
 * `registerTypedDataDecoder` call.
 *
 * Ordering is registration order, first match wins. Decoders must be
 * *specific*: gate on `domain.name` plus `primaryType`, not on the
 * presence of a few field names, or a permissive decoder registered
 * early will swallow payloads meant for a later one.
 */

import type { TypedDataDefinition } from "viem";
import type { ClearSigningDescriptor } from "@/services/walletKit/types";
import { validateTypedData } from "./typedDataValidate";

/**
 * What a decoder knows beyond the payload itself. Everything here is
 * wallet-side truth; nothing in it comes from the dApp.
 */
export interface TypedDataDecodeContext {
  /**
   * The address that will sign, from `intent.wallet`. A decoder must
   * use this, not a `from`/`offerer`/`maker` field inside the message,
   * whenever it asks "is this for me" — those fields are attacker-set.
   */
  signer?: string;
}

export interface TypedDataDecoder {
  /** Stable identifier, used for dev logging and replacement. */
  name: string;
  decode(
    typedData: TypedDataDefinition,
    ctx?: TypedDataDecodeContext,
  ): ClearSigningDescriptor | null;
}

const decoders: TypedDataDecoder[] = [];

/** Dock a decoder. Re-registering the same name replaces it in place. */
export function registerTypedDataDecoder(d: TypedDataDecoder): void {
  const i = decoders.findIndex((x) => x.name === d.name);
  if (i >= 0) decoders[i] = d;
  else decoders.push(d);
}

/** Test seam. */
export function __resetTypedDataDecoders(): void {
  decoders.length = 0;
}

/**
 * First decoder that claims the payload wins. A decoder that throws is
 * skipped rather than failing the resolution — an unrecognised payload
 * must fall through to the honest raw render, not to an error state.
 */
export function decodeTypedData(
  typedData: TypedDataDefinition | null | undefined,
  ctx?: TypedDataDecodeContext,
): ClearSigningDescriptor | null {
  if (!typedData) return null;
  // Phase O — normalise once, here, so every decoder (current and
  // future) sees `address`-declared fields as checksummed hex and a
  // numeric `chainId`. Without this, each decoder would have to
  // re-implement the decimal-address coercion, and the one that forgets
  // is the one that renders a 48-digit number where USDC belongs.
  //
  // The EVM adapter already validates before raising an intent; this
  // pass is idempotent and covers the other callers of the dock.
  const validated = validateTypedData(typedData);
  const input = validated.ok
    ? (validated.value as unknown as TypedDataDefinition)
    : typedData;
  for (const d of decoders) {
    try {
      const result = d.decode(input, ctx);
      if (result) return result;
    } catch (err) {
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn(`[typedData] decoder "${d.name}" failed`, err);
      }
    }
  }
  return null;
}
