/**
 * EVM clear-signing capability — task 65 (TWV-2026-066) Phases B + C.
 *
 * Two exports, both docked onto `EvmWalletKit` as the optional
 * `WalletKitAdapter` capabilities:
 *
 *   - `resolveEvmClearSigningDescriptor` — ERC-7730 wallet resolution
 *     against the bundled/pinned snapshot (`erc7730Snapshot.ts`),
 *     implementing exactly the finalized spec's algorithm: strip param
 *     names → type-only signature → keccak 4-byte selector match →
 *     decode with the canonical type vector → roundtrip fidelity gate →
 *     field interpolation (falling back to the descriptor's plain
 *     `intent` when interpolation fails). EIP-712 descriptors match by
 *     `keccak256(encodeType(typeOf(message))) === keccak256(TYPE_KEY)`.
 *     No match → `null`, never an unrelated descriptor's format.
 *
 *   - `computeEvmSigningDigest` — ERC-8213 (draft; re-checked against
 *     https://erc8213.eth.limo/#/implement and Cyfrin `clearsig`,
 *     2026-07-20) digests. BOTH flows, per the spec's "both, never
 *     one" pitfall: Flow A (EIP-712 domain/message/final digests) and
 *     Flow B (calldata digest, `keccak256(len ‖ calldata)` with a
 *     32-byte big-endian length word, chainId deliberately excluded).
 *
 * Hex case: viem's lowercase output is the pipeline's one true case —
 * nothing downstream re-cases it (pitfall 4).
 */

import {
  concat,
  getTypesForEIP712Domain,
  hashDomain,
  hashStruct,
  hashTypedData,
  keccak256,
  numberToHex,
  toBytes,
  toFunctionSelector,
} from "viem";
import {
  decodeCalldataAgainst,
  formatRawUint256,
} from "../../decoders/calldata.ts";
import type {
  ClearSigningDescriptor,
  ComputeSigningDigestArgs,
  ResolveClearSigningDescriptorArgs,
  SigningDigest,
} from "../types.ts";
import {
  ERC7730_SNAPSHOT,
  type Erc7730CalldataEntry,
  type Erc7730Eip712Entry,
  type Erc7730FieldSpec,
} from "./erc7730Snapshot.ts";

// ── Phase B — ERC-7730 descriptor resolution ─────────────────────────

/**
 * Stage-1 shape the EVM kit narrows `args.call` to. `data` is the raw
 * calldata (`EvmCalldataDecoderInspector` output carries it as `raw`);
 * the typed-data variant carries the full `signTypedData` payload.
 */
export interface EvmClearSigningCall {
  to?: string;
  chainId?: number;
  data?: `0x${string}`;
  typedData?: {
    domain?: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  };
}

function isEvmCall(call: unknown): call is EvmClearSigningCall {
  if (!call || typeof call !== "object") return false;
  const c = call as EvmClearSigningCall;
  return typeof c.data === "string" || typeof c.typedData === "object";
}

function deploymentMatches(
  deployments: Array<{ chainId: number; address: string }> | null,
  chainId: number | undefined,
  address: string | undefined,
): boolean {
  if (deployments === null) return true;
  if (chainId === undefined || !address) return false;
  const lower = address.toLowerCase();
  return deployments.some((d) => d.chainId === chainId && d.address === lower);
}

function interpolateFields(
  specs: Erc7730FieldSpec[],
  lookup: (param: string) => unknown,
): ClearSigningDescriptor["fields"] | null {
  const fields: ClearSigningDescriptor["fields"] = [];
  for (const spec of specs) {
    const value = lookup(spec.param);
    if (value === undefined) return null; // interpolation failed
    fields.push({
      label: spec.label,
      value: formatFieldValue(value, spec.encoding),
    });
  }
  return fields;
}

function formatFieldValue(value: unknown, encoding?: "readable"): string {
  if (typeof value === "bigint") {
    if (encoding === "readable") return formatRawUint256(value);
    return value.toString();
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return `[${value.length} items]`;
  return String(value);
}

function resolveCalldataDescriptor(
  call: EvmClearSigningCall,
): ClearSigningDescriptor | null {
  const data = call.data;
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();
  for (const entry of ERC7730_SNAPSHOT) {
    if (entry.kind !== "calldata") continue;
    const e = entry as Erc7730CalldataEntry;
    // Steps 1–3: names stripped → type-only signature → keccak[:4].
    // viem's toFunctionSelector normalizes the named fragment.
    if (toFunctionSelector(`function ${e.format}`) !== selector) continue;
    if (!deploymentMatches(e.deployments, call.chainId, call.to)) continue;
    // Step 4 + Phase A gate: decode with the canonical type vector and
    // only trust a byte-exact roundtrip.
    const decoded = decodeCalldataAgainst(data, [`function ${e.format}`]);
    if (!decoded?.roundtripVerified || !decoded.args) return null;
    const fields = interpolateFields(e.fields, (param) => {
      return decoded.args?.find((a) => a.name === param)?.value;
    });
    return {
      intent: e.intent,
      source: "erc7730",
      target: call.to?.toLowerCase(),
      functionName: decoded.functionName,
      // Rule 7: interpolation failure on a matched descriptor falls
      // back to the plain `intent`, never a half-rendered field list.
      fields: fields ?? [],
    };
  }
  return null;
}

/**
 * EIP-712 `encodeType` per the standard: primary type first, then the
 * transitively-referenced struct types sorted by name. Used for the
 * ERC-7730 TYPE_KEY match.
 */
export function encodeEip712Type(
  types: Record<string, unknown>,
  primaryType: string,
): string | null {
  const defs = types as Record<
    string,
    Array<{ name: string; type: string }> | undefined
  >;
  const referenced = new Set<string>();
  const visit = (name: string): void => {
    const base = name.replace(/\[.*\]$/, "");
    if (referenced.has(base) || !defs[base]) return;
    referenced.add(base);
    for (const field of defs[base] ?? []) visit(field.type);
  };
  visit(primaryType);
  if (!referenced.has(primaryType)) return null;
  const encodeOne = (name: string): string =>
    `${name}(${(defs[name] ?? [])
      .map((f) => `${f.type} ${f.name}`)
      .join(",")})`;
  const deps = [...referenced].filter((t) => t !== primaryType).sort();
  return [primaryType, ...deps].map(encodeOne).join("");
}

function resolveTypedDataDescriptor(
  call: EvmClearSigningCall,
): ClearSigningDescriptor | null {
  const td = call.typedData;
  if (!td) return null;
  const encoded = encodeEip712Type(td.types, td.primaryType);
  if (!encoded) return null;
  const typeHash = keccak256(toBytes(encoded));
  const domain = (td.domain ?? {}) as {
    verifyingContract?: string;
    chainId?: number | bigint;
  };
  for (const entry of ERC7730_SNAPSHOT) {
    if (entry.kind !== "eip712") continue;
    const e = entry as Erc7730Eip712Entry;
    if (keccak256(toBytes(e.typeKey)) !== typeHash) continue;
    if (
      !deploymentMatches(
        e.deployments,
        domain.chainId === undefined ? undefined : Number(domain.chainId),
        domain.verifyingContract,
      )
    ) {
      continue;
    }
    const fields = interpolateFields(e.fields, (param) => td.message[param]);
    return {
      intent: e.intent,
      source: "erc7730",
      target: domain.verifyingContract?.toLowerCase(),
      functionName: td.primaryType,
      fields: fields ?? [],
    };
  }
  return null;
}

export async function resolveEvmClearSigningDescriptor(
  args: ResolveClearSigningDescriptorArgs,
): Promise<ClearSigningDescriptor | null> {
  if (!isEvmCall(args.call)) return null;
  const call = args.call;
  if (call.typedData) return resolveTypedDataDescriptor(call);
  return resolveCalldataDescriptor(call);
}

// ── Phase C — ERC-8213 digests ───────────────────────────────────────

/**
 * Flow B: `keccak256(len(calldata) ‖ calldata)`. The length prefix is
 * a 32-byte big-endian `uint256` — not a varint, not the hex-string
 * length (pitfall 2). `chainId` is deliberately NOT mixed in: same
 * calldata, same digest, across forks (pitfall 3 — do not "fix" this).
 */
export function calldataDigest(calldata: `0x${string}`): `0x${string}` {
  const bytes = toBytes(calldata);
  const lenWord = numberToHex(bytes.length, { size: 32 });
  return keccak256(concat([toBytes(lenWord), bytes]));
}

/**
 * Flow A: ERC-8213 EIP-712 digests. `EIP712Domain` is stripped from
 * `types` before the message `hashStruct` (pitfall 1); the domain hash
 * uses the payload's own `EIP712Domain` type when supplied and viem's
 * derived one otherwise (same rule `eth_signTypedData_v4` applies).
 */
export function eip712Digests(
  typedData: Extract<
    ComputeSigningDigestArgs,
    { kind: "typedData" }
  >["typedData"],
): {
  domainHash: `0x${string}`;
  messageHash: `0x${string}`;
  digest: `0x${string}`;
} {
  const { domain, types, primaryType, message } = typedData;
  const { EIP712Domain: suppliedDomainType, ...messageTypes } = types as Record<
    string,
    unknown
  >;
  const domainTypes = {
    EIP712Domain:
      suppliedDomainType ??
      getTypesForEIP712Domain({
        domain: domain as Parameters<
          typeof getTypesForEIP712Domain
        >[0]["domain"],
      }),
  };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const domainHash = hashDomain({
    domain: domain as any,
    types: domainTypes as any,
  });
  const messageHash = hashStruct({
    data: message as any,
    primaryType,
    types: messageTypes as any,
  });
  const digest = hashTypedData({
    domain: domain as any,
    types: messageTypes as any,
    primaryType,
    message: message as any,
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { domainHash, messageHash, digest };
}

export async function computeEvmSigningDigest(
  args: ComputeSigningDigestArgs,
): Promise<SigningDigest | null> {
  if (args.kind === "calldata") {
    return {
      scheme: "erc8213-calldata",
      values: [
        {
          label: "Calldata digest",
          value: calldataDigest(args.calldata),
          encoding: "hex",
        },
      ],
    };
  }
  if (args.kind === "typedData") {
    const { domainHash, messageHash, digest } = eip712Digests(args.typedData);
    return {
      scheme: "erc8213-eip712",
      values: [
        { label: "Domain hash", value: domainHash, encoding: "hex" },
        { label: "Message hash", value: messageHash, encoding: "hex" },
        { label: "EIP-712 digest", value: digest, encoding: "hex" },
      ],
    };
  }
  // A raw wire transaction is not an EVM signing shape; ERC-8213
  // defines nothing for it here.
  return null;
}
