/**
 * 0x Protocol NFT order decoder — spec phase P.
 *
 * `maliciousTradeOrder` in `MetaMask/test-dapp` signs an `ERC721Order`
 * against domain `ZeroEx` v1.0.0 at
 * `0xdef1c0ded9bec7f1a1670819833240f027b25eff`. Before this decoder it
 * rendered as raw typed data: the user was shown a `direction` of `0`,
 * a 78-digit nonce, and two hex addresses, and asked to agree.
 *
 * Structs taken verbatim from the test-dapp payload (`ppom/transactions.js`),
 * which is the authoritative statement of what we have to decode:
 *
 *   ERC721Order(uint8 direction, address maker, address taker,
 *               uint256 expiry, uint256 nonce, address erc20Token,
 *               uint256 erc20TokenAmount, Fee[] fees,
 *               address erc721Token, uint256 erc721TokenId,
 *               Property[] erc721TokenProperties)
 *
 * `ERC1155Order` is the same shape with `erc1155Token` /
 * `erc1155TokenId` / `erc1155TokenAmount`.
 *
 * The signature *is* the authorisation: nothing appears on-chain until a
 * counterparty fills the order, and a malicious order signed today can
 * be filled days later. Simulation, revert-checking and the revoke
 * screen are all downstream of a transaction that does not exist here,
 * so rendering is the only control there is.
 *
 * Deliberately no `knownSpenders` entry for the ZeroEx address. This
 * decoder gates on `domain.name`, which is self-describing and needs no
 * trust: if the domain says `ZeroEx`, decoding it as a 0x order is
 * correct whatever address it names. An entry in the address table makes
 * the opposite, stronger claim — "this address *is* 0x" — and that is
 * what §16.3 requires a verified source for.
 */

import type { TypedDataDefinition } from "viem";
import type { ClearSigningDescriptor } from "@/services/walletKit/types";
import {
  big,
  describeTime,
  isZeroAddress,
  makerMismatchWarning,
} from "./orderCommon";
import type { TypedDataDecoder } from "./typedDataRegistry";

/** 0x `TradeDirection`. */
const SELL_NFT = 0;

function fieldsFor(
  message: Record<string, unknown>,
  standard: "ERC-721" | "ERC-1155",
): Array<{ label: string; value: string }> {
  const prefix = standard === "ERC-721" ? "erc721" : "erc1155";
  const token = message[`${prefix}Token`];
  const tokenId = big(message[`${prefix}TokenId`]);
  const quantity = big(message[`${prefix}TokenAmount`]);

  const item =
    tokenId === null
      ? String(token ?? "Unknown")
      : `${standard} #${tokenId.toString()}${
          quantity !== null && quantity !== 1n ? ` x${quantity.toString()}` : ""
        }`;

  const fields: Array<{ label: string; value: string }> = [
    { label: "Item", value: item },
  ];
  if (typeof token === "string") {
    fields.push({ label: "Collection", value: token });
  }
  return fields;
}

function decodeOrder(
  typedData: TypedDataDefinition,
  ctx: { signer?: string } | undefined,
  standard: "ERC-721" | "ERC-1155",
): ClearSigningDescriptor | null {
  const td = typedData as unknown as {
    domain?: { name?: string; verifyingContract?: string };
    message?: Record<string, unknown>;
  };
  const message = td.message ?? {};
  const direction = big(message.direction);
  const isSelling = direction === null || Number(direction) === SELL_NFT;

  const price = big(message.erc20TokenAmount);
  const fields = [
    ...fieldsFor(message, standard),
    {
      // Raw units: the ERC-20's decimals are not in the payload and this
      // decoder does not reach the network. A number labelled honestly
      // beats a number scaled by a guess.
      label: isSelling ? "You receive (raw units)" : "You pay (raw units)",
      value: price === null ? "Could not be read" : price.toString(),
    },
  ];
  if (typeof message.erc20Token === "string") {
    fields.push({ label: "Paid in", value: message.erc20Token });
  }
  fields.push({ label: "Expires", value: describeTime(message.expiry) });

  // A named taker means only that address can fill the order. That is a
  // normal private sale and also how a targeted theft is addressed, so
  // it is stated rather than judged.
  if (typeof message.taker === "string" && !isZeroAddress(message.taker)) {
    fields.push({ label: "Only fillable by", value: message.taker });
  }

  const fees = Array.isArray(message.fees) ? message.fees : [];
  if (fees.length > 0) {
    fields.push({ label: "Extra fees", value: String(fees.length) });
  }

  const warnings: Array<{ title: string; detail: string }> = [];
  const mismatch = makerMismatchWarning(ctx?.signer, message.maker, "maker");
  if (mismatch) warnings.push(mismatch);

  if (isSelling && price !== null && price === 0n) {
    warnings.push({
      title: "You are being paid nothing",
      detail:
        "This order hands over the item for zero payment. Do not sign it unless you meant to give the item away.",
    });
  }

  // Criteria-based orders match a *set* of token ids rather than one, so
  // the item shown above is not the whole story.
  const properties =
    message[
      standard === "ERC-721"
        ? "erc721TokenProperties"
        : "erc1155TokenProperties"
    ];
  if (Array.isArray(properties) && properties.length > 0) {
    warnings.push({
      title: "This order is not limited to one item",
      detail:
        "It uses a rule to decide which items it covers, so more than the item shown above may be taken. Only continue if you understand exactly what the rule matches.",
    });
  }

  return {
    intent: isSelling ? "Sell an NFT on 0x" : "Offer to buy an NFT on 0x",
    source: "bespoke",
    target: td.domain?.verifyingContract?.toLowerCase(),
    functionName: standard === "ERC-721" ? "ERC721Order" : "ERC1155Order",
    fields,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export const ZeroExOrderTypedDataDecoder: TypedDataDecoder = {
  name: "zeroex-order",
  decode(typedData, ctx) {
    const td = typedData as unknown as {
      domain?: { name?: string };
      primaryType?: string;
    };
    if (td.domain?.name !== "ZeroEx") return null;
    if (td.primaryType === "ERC721Order") {
      return decodeOrder(typedData, ctx, "ERC-721");
    }
    if (td.primaryType === "ERC1155Order") {
      return decodeOrder(typedData, ctx, "ERC-1155");
    }
    return null;
  },
};
