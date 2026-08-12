/**
 * Blur order decoder — spec phase P.
 *
 * `signBlurOrder` in `MetaMask/test-dapp` signs an `Order` against
 * domain `Blur Exchange` v1.0 at
 * `0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5`. Struct taken verbatim
 * from the dapp's `src/signatures/utils.js`:
 *
 *   Order(uint8 assetType, address collection, uint256 expirationTime,
 *         bytes32 listingsRoot, MakerFee makerFee, uint256 nonce,
 *         uint256 numberOfListings, uint8 orderType, uint256 salt,
 *         address trader)
 *   MakerFee(address recipient, uint256 rate)
 *
 * ### Why this decodes even though Blur is not in `knownSpenders`
 *
 * §16.3 removed Blur from the address allowlist because its deployment
 * address could not be confirmed against a primary source, and a wrong
 * entry there prints a trusted marketplace name beside an address that
 * is not that marketplace — the exact attack the table defends against.
 *
 * That reasoning does not extend to a decoder, and the difference is
 * worth stating precisely. A decoder gates on `domain.name`, which is
 * self-describing: if the payload says `Blur Exchange`, reading its
 * fields as a Blur order is correct regardless of which address it
 * names, because we are describing the payload rather than vouching for
 * it. The address table makes an assertion about the world. This file
 * makes an assertion about the bytes in front of it.
 *
 * ### `listingsRoot` is a Merkle root
 *
 * One signature covers `numberOfListings` items, and the items
 * themselves are not in the payload. Like Seaport's `BulkOrder`, this
 * decoder reports the *scope* and must never imply it enumerated them.
 * Rendering a confident item list we did not verify would be worse than
 * the raw hex it replaces.
 */

import type { ClearSigningDescriptor } from "@/services/walletKit/types";
import { big, describeTime, makerMismatchWarning } from "./orderCommon";
import type { TypedDataDecoder } from "./typedDataRegistry";

/** Blur `AssetType`. */
const ASSET_TYPES = ["ERC-721", "ERC-1155"];
/** Blur `OrderType`. */
const ORDER_TYPES = ["Bid", "Ask"];

function label(list: string[], v: unknown, fallback: string): string {
  const n = big(v);
  if (n === null) return fallback;
  const i = Number(n);
  return list[i] ?? fallback;
}

export const BlurOrderTypedDataDecoder: TypedDataDecoder = {
  name: "blur-order",
  decode(typedData, ctx): ClearSigningDescriptor | null {
    const td = typedData as unknown as {
      domain?: { name?: string; verifyingContract?: string };
      primaryType?: string;
      message?: Record<string, unknown>;
    };
    if (td.domain?.name !== "Blur Exchange") return null;
    if (td.primaryType !== "Order") return null;

    const message = td.message ?? {};
    const orderType = label(ORDER_TYPES, message.orderType, "Unknown");
    const assetType = label(ASSET_TYPES, message.assetType, "Unknown");
    const count = big(message.numberOfListings);

    const fields: Array<{ label: string; value: string }> = [
      { label: "Order type", value: orderType },
      { label: "Standard", value: assetType },
      {
        label: "Collection",
        value:
          typeof message.collection === "string"
            ? message.collection
            : "Could not be read",
      },
      {
        label: "Listings covered",
        value: count === null ? "Could not be read" : count.toString(),
      },
      { label: "Expires", value: describeTime(message.expirationTime) },
    ];

    const fee = message.makerFee as
      | { recipient?: unknown; rate?: unknown }
      | undefined;
    const rate = big(fee?.rate);
    if (rate !== null && rate > 0n) {
      // Blur expresses the rate in basis points.
      fields.push({
        label: "Maker fee",
        value: `${(Number(rate) / 100).toString()}%`,
      });
    }

    const warnings: Array<{ title: string; detail: string }> = [
      {
        title: "The items are not listed here",
        detail:
          "This order refers to its items by a fingerprint rather than naming them, so we cannot show you which ones it covers. Anyone holding this signature can act on any item inside it, at any time before it expires.",
      },
    ];
    const mismatch = makerMismatchWarning(
      ctx?.signer,
      message.trader,
      "trader",
    );
    if (mismatch) warnings.push(mismatch);

    return {
      intent:
        orderType === "Bid"
          ? "Offer to buy NFTs on Blur"
          : "List NFTs for sale on Blur",
      source: "bespoke",
      target: td.domain.verifyingContract?.toLowerCase(),
      functionName: "Order",
      fields,
      warnings,
    };
  },
};
