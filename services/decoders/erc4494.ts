/**
 * ERC-4494 decoder — `permit` for ERC-721, spec phase F item c.
 *
 * The NFT analogue of the ERC-2612 decoder that already ships. Same
 * gasless-approval idea, one critical difference: ERC-2612's `Permit`
 * carries a `value` (an allowance), ERC-4494's carries a `tokenId` (one
 * specific item). That single field is the discriminator, and getting it
 * backwards is exactly the ERC-20/ERC-721 confusion phase D exists to
 * fix — an "unlimited" reading of a token id is meaningless.
 *
 * Registered *before* the ERC-2612 decoder so the more specific shape
 * wins: both use `primaryType: "Permit"`, and ERC-2612's own field check
 * requires `value`, so ordering plus that check keeps them disjoint.
 */

import type { TypedDataDefinition } from "viem";
import type { ClearSigningDescriptor } from "@/services/walletKit/types";
import type { TypedDataDecoder } from "./typedDataRegistry";

function big(v: unknown): bigint | null {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(v);
    if (typeof v === "string" && v.trim() !== "") return BigInt(v);
  } catch {
    // fall through
  }
  return null;
}

export const Erc4494TypedDataDecoder: TypedDataDecoder = {
  name: "erc4494",
  decode(typedData: TypedDataDefinition): ClearSigningDescriptor | null {
    const td = typedData as unknown as {
      domain?: { name?: string; verifyingContract?: string };
      types?: Record<string, Array<{ name: string }>>;
      primaryType?: string;
      message?: Record<string, unknown>;
    };
    if (td.primaryType !== "Permit") return null;

    const fields = td.types?.Permit;
    if (!Array.isArray(fields)) return null;
    const names = fields.map((f) => f.name);

    // ERC-4494: spender + tokenId + nonce + deadline, and crucially NO
    // `value`. An ERC-2612 permit always has `value`, so requiring its
    // absence keeps the two decoders from claiming each other's payloads.
    if (names.includes("value")) return null;
    for (const required of ["spender", "tokenId", "nonce", "deadline"]) {
      if (!names.includes(required)) return null;
    }

    const message = td.message ?? {};
    const tokenId = big(message.tokenId);
    const deadline = big(message.deadline);
    const spender =
      typeof message.spender === "string" ? message.spender : "Unknown";

    return {
      intent: "Approve one NFT without a transaction",
      source: "bespoke",
      target: td.domain?.verifyingContract?.toLowerCase(),
      functionName: "Permit (ERC-4494)",
      fields: [
        { label: "Collection", value: td.domain?.name ?? "Unknown" },
        { label: "Operator", value: spender },
        {
          label: "Item",
          value: tokenId === null ? "Could not be read" : `#${tokenId}`,
        },
        {
          label: "Valid until",
          value:
            deadline === null
              ? "Not set"
              : new Date(Number(deadline) * 1000)
                  .toISOString()
                  .replace("T", " ")
                  .slice(0, 16),
        },
      ],
      warnings: [
        {
          title: "This signature works without a transaction",
          detail:
            "Signing this lets the operator take this item later without asking you again. Nothing appears on-chain until they use it.",
        },
      ],
    };
  },
};
