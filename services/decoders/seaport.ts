/**
 * Seaport order decoder — spec phase F.
 *
 * This is the most consequential surface in the hardening spec, and the
 * reason is structural rather than about volume. An order signature is
 * not a transaction: there is no calldata to decode, no simulation to
 * run, and nothing appears on-chain until a counterparty submits it.
 * The user's signature *is* the authorisation to move the asset, and a
 * malicious order signed today can be executed days later. Every other
 * safety net in the wallet — revert simulation, balance deltas, the
 * revoke screen — is downstream of a transaction that does not exist
 * here.
 *
 * Seaport is OpenSea's protocol and the template most EVM NFT
 * marketplaces mirror, so decoding `OrderComponents` covers the bulk of
 * order traffic.
 *
 * Note this decoder rests on phase H: it renders an order in detail,
 * which implies a verification the domain check is what actually
 * performs. Without the `domain.chainId` refusal, a perfectly decoded
 * order could still be signed for the wrong deployment — a richer
 * render on an unverified domain is worse than no render at all.
 */

import type { TypedDataDefinition } from "viem";
import type { ClearSigningDescriptor } from "@/services/walletKit/types";
import { isKnownSpender } from "./knownSpenders";
import {
  big,
  describeTime,
  makerMismatchWarning,
  sameAddress,
} from "./orderCommon";
import type { TypedDataDecoder } from "./typedDataRegistry";

/** Seaport `ItemType`. */
const ITEM_TYPES = [
  "Native",
  "ERC20",
  "ERC721",
  "ERC1155",
  "ERC721 (criteria)",
  "ERC1155 (criteria)",
];

interface SeaportItem {
  itemType?: string | number;
  token?: string;
  identifierOrCriteria?: string | number | bigint;
  startAmount?: string | number | bigint;
  endAmount?: string | number | bigint;
  recipient?: string;
}

function itemTypeLabel(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) && ITEM_TYPES[n] ? ITEM_TYPES[n] : "Unknown";
}

function describeItem(item: SeaportItem): string {
  const type = itemTypeLabel(item.itemType);
  const amount = big(item.startAmount);
  const id = big(item.identifierOrCriteria);
  const parts: string[] = [type];
  if (id !== null && id !== 0n) parts.push(`#${id.toString()}`);
  if (amount !== null && amount !== 1n) parts.push(`x${amount.toString()}`);
  if (
    item.token &&
    item.token !== "0x0000000000000000000000000000000000000000"
  ) {
    parts.push(item.token);
  }
  return parts.join(" ");
}

export const SeaportTypedDataDecoder: TypedDataDecoder = {
  name: "seaport",
  decode(typedData: TypedDataDefinition, ctx): ClearSigningDescriptor | null {
    const td = typedData as unknown as {
      domain?: { name?: string; verifyingContract?: string; chainId?: unknown };
      primaryType?: string;
      message?: Record<string, unknown>;
    };
    if (td.domain?.name !== "Seaport") return null;

    const primaryType = td.primaryType;
    if (primaryType !== "OrderComponents" && primaryType !== "BulkOrder") {
      return null;
    }

    const verifying = td.domain.verifyingContract;
    const known = verifying
      ? isKnownSpender(verifying, Number(td.domain.chainId) || undefined)
      : null;

    // A BulkOrder is a Merkle tree of orders behind one signature. The
    // leaves are often not all present in the payload, so report the
    // count rather than pretending to enumerate them — a single
    // signature covering an unbounded set is itself the thing worth
    // surfacing.
    if (primaryType === "BulkOrder") {
      const tree = td.message?.tree;
      const count = Array.isArray(tree) ? tree.length : null;
      return {
        intent: "Sign several marketplace orders at once",
        source: "bespoke",
        target: verifying?.toLowerCase(),
        functionName: "BulkOrder",
        fields: [
          {
            label: "Marketplace",
            value: known?.name ?? verifying ?? "Unknown",
          },
          {
            label: "Orders covered",
            value: count === null ? "Could not be read" : String(count),
          },
        ],
        warnings: [
          {
            title: "One signature, many orders",
            detail:
              "This single signature authorises a batch of marketplace orders. Anyone holding it can execute any of them later.",
          },
        ],
      };
    }

    const message = td.message ?? {};
    const offer = Array.isArray(message.offer)
      ? (message.offer as SeaportItem[])
      : [];
    const consideration = Array.isArray(message.consideration)
      ? (message.consideration as SeaportItem[])
      : [];
    const offerer =
      typeof message.offerer === "string" ? message.offerer : undefined;

    // Phase P — the address the payoff is measured against.
    //
    // This used to be `offerer`, which is the bug. `offerer` arrives
    // from the dApp, so an attacker sets it to an address they control,
    // lists that same address among the consideration recipients, and
    // the "nothing comes back to you" check is satisfied while the
    // person signing receives nothing at all. The only address worth
    // comparing against is the one that will actually sign.
    //
    // When the caller did not tell us who signs, fall back to `offerer`
    // rather than dropping the check: a weakened warning beats none.
    const payee = ctx?.signer ?? offerer;

    const fields = [
      { label: "Marketplace", value: known?.name ?? verifying ?? "Unknown" },
      {
        label: "You give",
        value: offer.length
          ? offer.map(describeItem).join("\n")
          : "Nothing listed",
      },
      {
        label: "You get",
        value: consideration.length
          ? consideration
              .map((c) => {
                const who = sameAddress(c.recipient, payee)
                  ? "to you"
                  : `to ${c.recipient ?? "unknown"}`;
                return `${describeItem(c)} ${who}`;
              })
              .join("\n")
          : "Nothing listed",
      },
      { label: "Valid from", value: describeTime(message.startTime) },
      { label: "Valid until", value: describeTime(message.endTime) },
    ];

    if (typeof message.zone === "string") {
      fields.push({ label: "Executable by", value: message.zone });
    }

    const warnings: Array<{ title: string; detail: string }> = [];

    // An order whose offerer is not the signer is worth saying out loud
    // on its own, before any payoff arithmetic. It is the shape of the
    // test-dapp's `maliciousSeaport`, whose offerer is an address the
    // user has never seen.
    const mismatch = makerMismatchWarning(ctx?.signer, offerer, "offerer");
    if (mismatch) warnings.push(mismatch);

    // The recipients are the tell. A legitimate sale sends the bulk of
    // the consideration back to the person signing; a drain order sends
    // it somewhere else while the offer still leaves the wallet.
    const returnsToSigner =
      payee !== undefined &&
      consideration.some((c) => sameAddress(c.recipient, payee));
    if (offer.length > 0 && !returnsToSigner) {
      warnings.push({
        title: "Nothing comes back to you",
        detail:
          "This order sends your items out but pays you nothing. That is what a theft order looks like. Do not sign it unless you are certain it is a gift or a transfer you intended.",
      });
    }

    // Zero or near-zero payment for a real offer is the same attack with
    // a token amount attached to look legitimate.
    const totalIn = consideration.reduce((sum, c) => {
      if (sameAddress(c.recipient, payee)) {
        return sum + (big(c.startAmount) ?? 0n);
      }
      return sum;
    }, 0n);
    if (offer.length > 0 && returnsToSigner && totalIn === 0n) {
      warnings.push({
        title: "You are being paid nothing",
        detail:
          "The payment on this order is zero. Your items would leave your wallet for free.",
      });
    }

    return {
      intent: "Sign a marketplace order",
      source: "bespoke",
      target: verifying?.toLowerCase(),
      functionName: "OrderComponents",
      fields,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  },
};
