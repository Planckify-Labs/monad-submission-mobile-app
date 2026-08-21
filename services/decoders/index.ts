import type { TypedDataDefinition } from "viem";
import { type DecodedPermit, tryDecodeErc2612 } from "./erc2612";
import { isKnownSpender, type KnownSpender } from "./knownSpenders";
import { type DecodedPermit2, tryDecodePermit2 } from "./permit2";

export { tryDecodeErc2612, tryDecodePermit2 };
export { approveRiskSummary, decodeCalldata } from "./calldata";
export { tryParseSiwe } from "./siwe";
export { isKnownSpender };
export type { DecodedPermit, DecodedPermit2, KnownSpender };
export type {
  ApproveRiskSummary,
  DecodedArg,
  DecodedCalldata,
} from "./calldata";
export type { ParsedSiwe } from "./siwe";

export type TypedDataDecoded = DecodedPermit | DecodedPermit2 | null;

export function decodeTypedData(
  typedData: TypedDataDefinition | null | undefined,
): TypedDataDecoded {
  return tryDecodeErc2612(typedData) ?? tryDecodePermit2(typedData) ?? null;
}
