/**
 * Registration point for typed-data decoders.
 *
 * Order matters: first claim wins, so the most specific shapes register
 * first. ERC-4494 and ERC-2612 both use `primaryType: "Permit"` and are
 * separated by the presence of `value` (ERC-2612) versus `tokenId`
 * (ERC-4494); registering 4494 first, plus each decoder's own field
 * check, keeps them disjoint in both directions.
 */

import type { ClearSigningDescriptor } from "@/services/walletKit/types";
import { BlurOrderTypedDataDecoder } from "./blurOrder";
import { tryDecodeErc2612 } from "./erc2612";
import { Erc4494TypedDataDecoder } from "./erc4494";
import { tryDecodePermit2 } from "./permit2";
import { SeaportTypedDataDecoder } from "./seaport";
import { registerTypedDataDecoder } from "./typedDataRegistry";
import { ZeroExOrderTypedDataDecoder } from "./zeroExOrder";

registerTypedDataDecoder(SeaportTypedDataDecoder);
// Spec phase P, and the first real test of the dock from §16.1: each
// gates on its own `domain.name`, so registration order between them is
// irrelevant and adding a fourth marketplace is one new file plus one
// line here, with no edit to any shared decoder.
registerTypedDataDecoder(ZeroExOrderTypedDataDecoder);
registerTypedDataDecoder(BlurOrderTypedDataDecoder);
registerTypedDataDecoder(Erc4494TypedDataDecoder);

// The two pre-existing decoders, adapted to the dock. Their detection
// logic is untouched — only the descriptor construction moved here from
// `clearSigning.ts#bespokeFallback`.
registerTypedDataDecoder({
  name: "erc2612",
  decode(typedData): ClearSigningDescriptor | null {
    const permit = tryDecodeErc2612(typedData);
    if (!permit) return null;
    return {
      intent: "Permit token spending",
      source: "bespoke",
      target: permit.token.toLowerCase(),
      functionName: "Permit",
      fields: [
        { label: "Owner", value: permit.owner },
        { label: "Spender", value: permit.spender },
        {
          label: "Allowance (raw units)",
          value: permit.isUnlimited ? "Unlimited" : permit.amount.toString(),
        },
        { label: "Deadline (unix)", value: permit.deadline.toString() },
      ],
      warnings: permit.isUnlimited
        ? [
            {
              title: "Unlimited spending",
              detail:
                "This lets the spender move an unlimited amount of this token from your wallet until you revoke it.",
            },
          ]
        : undefined,
    };
  },
});

registerTypedDataDecoder({
  name: "permit2",
  decode(typedData): ClearSigningDescriptor | null {
    const permit2 = tryDecodePermit2(typedData);
    if (!permit2) return null;
    return {
      intent: "Permit2 approval",
      source: "bespoke",
      target: permit2.verifyingContract.toLowerCase(),
      functionName: "Permit2",
      fields: [
        { label: "Spender", value: permit2.spender },
        ...permit2.tokens.flatMap((t, i) => [
          { label: `Token ${i + 1}`, value: t.address },
          {
            label: `Amount ${i + 1} (raw units)`,
            value: t.amount.toString(),
          },
        ]),
      ],
    };
  },
});
