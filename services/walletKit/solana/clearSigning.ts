/**
 * Solana clear-signing capability — task 65 (TWV-2026-066) Phases B + C.
 *
 * Phase B — `resolveSolanaClearSigningDescriptor`:
 *   - Already-decoded well-known-program instructions (the Stage-1
 *     `SolanaProgramDecoderInspector` output for System / SPL Token /
 *     ComputeBudget / Memo / …) map straight into the chain-agnostic
 *     descriptor — that's the "small bundled well-known-program map"
 *     leg.
 *   - Unknown programs go through the on-chain Anchor IDL account
 *     (what `@coral-xyz/anchor`'s `Program.fetchIdl` reads): a pinned
 *     RPC `getAccountInfo` against the IDL PDA of the program itself —
 *     the same trust category as EVM on-chain-bytecode decoding, NOT a
 *     third-party decode service. The account layout is
 *     `8-byte discriminator ‖ 32-byte authority ‖ u32 len ‖ zlib(json)`.
 *   - Decoded args are re-encoded (Borsh) and byte-compared against
 *     the original instruction data — the same roundtrip fidelity gate
 *     Phase A applies to EVM calldata. No roundtrip → intent-only
 *     descriptor (the discriminator match itself is exact), bad
 *     discriminator → `null`.
 *
 * Phase C — `computeSolanaSigningDigest`: SHA-256 of the serialized
 * transaction *message* (the byte range every signer actually signs),
 * independently reproducible from the same base64 with any sha256
 * tool. Personal messages digest the raw message bytes.
 */

import { sha256 } from "@noble/hashes/sha2";
import { PublicKey } from "@solana/web3.js";
import { unzlibSync } from "fflate";
import type {
  ClearSigningDescriptor,
  ComputeSigningDigestArgs,
  ResolveClearSigningDescriptorArgs,
  SigningDigest,
} from "../types.ts";

// ── Shared byte helpers (no Buffer — Hermes-safe, see
// feedback_hermes_ambient_buffer_base64_bug) ──────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  // Node test harness fallback.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Uint8Array((globalThis as any).Buffer.from(b64, "base64"));
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return `0x${out}`;
}

// ── Phase B — descriptor resolution ──────────────────────────────────

/** Stage-1 decoded instruction (well-known-program map leg). */
interface DecodedWellKnownCall {
  program: string;
  kind?: string;
  programName?: string;
  data?: unknown;
}

/** Raw instruction (IDL leg) — programId + data bytes are required. */
interface RawIxCall {
  programId: string;
  data: Uint8Array | string;
  accounts?: string[];
}

const WELL_KNOWN_PROGRAM_LABELS: Record<string, string> = {
  system: "System Program",
  "spl-token": "SPL Token",
  "token-2022": "Token-2022",
  "compute-budget": "Compute Budget",
  memo: "Memo",
};

function humanizeKind(kind: string): string {
  const spaced = kind
    .replace(/[_-]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function formatValue(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function descriptorFromWellKnown(
  call: DecodedWellKnownCall,
): ClearSigningDescriptor | null {
  const label = WELL_KNOWN_PROGRAM_LABELS[call.program];
  if (!label || !call.kind || call.kind === "unknown") return null;
  const fields: ClearSigningDescriptor["fields"] = [];
  if (call.data && typeof call.data === "object") {
    for (const [k, v] of Object.entries(call.data as Record<string, unknown>)) {
      fields.push({ label: humanizeKind(k), value: formatValue(v) });
    }
  }
  return {
    intent: humanizeKind(call.kind),
    source: "bespoke",
    target: label,
    functionName: call.kind,
    fields,
  };
}

// ── Anchor on-chain IDL ───────────────────────────────────────────────

/**
 * The IDL account address `anchor idl init` writes to — the same
 * derivation `Program.fetchIdl` performs: seedless PDA of the program,
 * then `createWithSeed(base, "anchor:idl", programId)`.
 */
export async function deriveIdlAddress(programId: string): Promise<string> {
  const program = new PublicKey(programId);
  const [base] = PublicKey.findProgramAddressSync([], program);
  const idl = await PublicKey.createWithSeed(base, "anchor:idl", program);
  return idl.toBase58();
}

/** Minimal slice of the Anchor IDL JSON this resolver consumes. */
export interface AnchorIdlInstruction {
  name: string;
  discriminator?: number[];
  args?: Array<{ name: string; type: unknown }>;
}

export interface AnchorIdl {
  name?: string;
  metadata?: { name?: string };
  instructions?: AnchorIdlInstruction[];
}

/**
 * Parses the raw IDL account bytes (`getAccountInfo` data) into the
 * IDL JSON: `8-byte discriminator ‖ 32-byte authority ‖ u32 LE len ‖
 * zlib-deflated JSON`.
 */
export function parseIdlAccountData(bytes: Uint8Array): AnchorIdl | null {
  if (bytes.length < 44) return null;
  const len =
    (bytes[40] ?? 0) |
    ((bytes[41] ?? 0) << 8) |
    ((bytes[42] ?? 0) << 16) |
    ((bytes[43] ?? 0) << 24);
  if (len <= 0 || 44 + len > bytes.length) return null;
  try {
    const inflated = unzlibSync(bytes.subarray(44, 44 + len));
    return JSON.parse(new TextDecoder().decode(inflated)) as AnchorIdl;
  } catch {
    return null;
  }
}

function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function legacyDiscriminator(name: string): Uint8Array {
  const preimage = `global:${snakeCase(name)}`;
  return sha256(new TextEncoder().encode(preimage)).subarray(0, 8);
}

function discriminatorMatches(
  ix: AnchorIdlInstruction,
  data: Uint8Array,
): boolean {
  if (data.length < 8) return false;
  const expected = ix.discriminator?.length
    ? Uint8Array.from(ix.discriminator)
    : legacyDiscriminator(ix.name);
  for (let i = 0; i < 8; i++) {
    if (data[i] !== expected[i]) return false;
  }
  return true;
}

// ── Borsh primitive codec (decode + re-encode for the roundtrip gate) ─

interface BorshCursor {
  bytes: Uint8Array;
  offset: number;
}

function readUint(c: BorshCursor, size: number): bigint | null {
  if (c.offset + size > c.bytes.length) return null;
  let v = 0n;
  for (let i = 0; i < size; i++) {
    v |= BigInt(c.bytes[c.offset + i] ?? 0) << BigInt(i * 8);
  }
  c.offset += size;
  return v;
}

function decodeBorshValue(c: BorshCursor, type: unknown): unknown {
  if (typeof type === "string") {
    switch (type) {
      case "bool": {
        const v = readUint(c, 1);
        return v === null ? undefined : v === 1n;
      }
      case "u8":
        return readUint(c, 1);
      case "u16":
        return readUint(c, 2);
      case "u32":
        return readUint(c, 4);
      case "u64":
        return readUint(c, 8);
      case "u128":
        return readUint(c, 16);
      case "i8":
      case "i16":
      case "i32":
      case "i64":
      case "i128": {
        const size =
          type === "i8"
            ? 1
            : type === "i16"
              ? 2
              : type === "i32"
                ? 4
                : type === "i64"
                  ? 8
                  : 16;
        const raw = readUint(c, size);
        if (raw === null) return undefined;
        const bits = BigInt(size * 8);
        const signBit = 1n << (bits - 1n);
        return raw >= signBit ? raw - (1n << bits) : raw;
      }
      case "string": {
        const len = readUint(c, 4);
        if (len === null) return undefined;
        const n = Number(len);
        if (c.offset + n > c.bytes.length) return undefined;
        const s = new TextDecoder().decode(
          c.bytes.subarray(c.offset, c.offset + n),
        );
        c.offset += n;
        return s;
      }
      case "bytes": {
        const len = readUint(c, 4);
        if (len === null) return undefined;
        const n = Number(len);
        if (c.offset + n > c.bytes.length) return undefined;
        const b = c.bytes.slice(c.offset, c.offset + n);
        c.offset += n;
        return b;
      }
      case "pubkey":
      case "publicKey": {
        if (c.offset + 32 > c.bytes.length) return undefined;
        const key = new PublicKey(
          c.bytes.subarray(c.offset, c.offset + 32),
        ).toBase58();
        c.offset += 32;
        return key;
      }
      default:
        return undefined; // unsupported primitive — bail
    }
  }
  if (type && typeof type === "object" && "option" in type) {
    const flag = readUint(c, 1);
    if (flag === null) return undefined;
    if (flag === 0n) return null;
    return decodeBorshValue(c, (type as { option: unknown }).option);
  }
  return undefined; // vec / array / defined / enum — out of scope, bail
}

function encodeUint(v: bigint, size: number): number[] {
  const out: number[] = [];
  let x = v;
  for (let i = 0; i < size; i++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return out;
}

function encodeBorshValue(value: unknown, type: unknown): number[] | null {
  if (typeof type === "string") {
    switch (type) {
      case "bool":
        return [value === true ? 1 : 0];
      case "u8":
        return encodeUint(value as bigint, 1);
      case "u16":
        return encodeUint(value as bigint, 2);
      case "u32":
        return encodeUint(value as bigint, 4);
      case "u64":
        return encodeUint(value as bigint, 8);
      case "u128":
        return encodeUint(value as bigint, 16);
      case "i8":
      case "i16":
      case "i32":
      case "i64":
      case "i128": {
        const size =
          type === "i8"
            ? 1
            : type === "i16"
              ? 2
              : type === "i32"
                ? 4
                : type === "i64"
                  ? 8
                  : 16;
        const bits = BigInt(size * 8);
        let raw = value as bigint;
        if (raw < 0n) raw += 1n << bits;
        return encodeUint(raw, size);
      }
      case "string": {
        const encoded = new TextEncoder().encode(value as string);
        return [...encodeUint(BigInt(encoded.length), 4), ...encoded];
      }
      case "bytes": {
        const b = value as Uint8Array;
        return [...encodeUint(BigInt(b.length), 4), ...b];
      }
      case "pubkey":
      case "publicKey":
        return [...new PublicKey(value as string).toBytes()];
      default:
        return null;
    }
  }
  if (type && typeof type === "object" && "option" in type) {
    if (value === null) return [0];
    const inner = encodeBorshValue(value, (type as { option: unknown }).option);
    return inner === null ? null : [1, ...inner];
  }
  return null;
}

/**
 * Pure IDL → descriptor resolution — exported for unit tests; the kit
 * method feeds it the fetched IDL. Discriminator match is exact; arg
 * decoding is trusted only when the Borsh re-encoding reproduces the
 * instruction data byte-for-byte (intent-only descriptor otherwise).
 */
export function resolveSolanaDescriptorFromIdl(
  idl: AnchorIdl,
  programId: string,
  data: Uint8Array,
): ClearSigningDescriptor | null {
  const ix = (idl.instructions ?? []).find((i) =>
    discriminatorMatches(i, data),
  );
  if (!ix) return null;
  const programName = idl.metadata?.name ?? idl.name ?? programId;
  const base: ClearSigningDescriptor = {
    intent: humanizeKind(ix.name),
    source: "onchain-idl",
    target: programId,
    functionName: ix.name,
    fields: [],
  };
  const args = ix.args ?? [];
  const cursor: BorshCursor = { bytes: data, offset: 8 };
  const decoded: Array<{ name: string; type: unknown; value: unknown }> = [];
  for (const arg of args) {
    const value = decodeBorshValue(cursor, arg.type);
    if (value === undefined) return base; // unsupported type — intent only
    decoded.push({ name: arg.name, type: arg.type, value });
  }
  if (cursor.offset !== data.length) return base; // trailing bytes — no trust
  // Roundtrip gate: re-encode and byte-compare against data[8..].
  const reencoded: number[] = [];
  for (const d of decoded) {
    const enc = encodeBorshValue(d.value, d.type);
    if (enc === null) return base;
    reencoded.push(...enc);
  }
  if (reencoded.length !== data.length - 8) return base;
  for (let i = 0; i < reencoded.length; i++) {
    if (reencoded[i] !== data[8 + i]) return base;
  }
  return {
    ...base,
    target: programId,
    fields: [
      { label: "Program", value: programName },
      ...decoded.map((d) => ({
        label: humanizeKind(d.name),
        value: formatValue(d.value),
      })),
    ],
  };
}

/** RPC seam — the kit binds this to the chain's RPC; tests stub it. */
export type SolanaAccountFetcher = (
  address: string,
) => Promise<Uint8Array | null>;

/** Default fetcher: pinned `getAccountInfo` read via plain JSON-RPC. */
export async function fetchSolanaAccountData(
  rpcUrl: string,
  address: string,
): Promise<Uint8Array | null> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "base64" }],
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    result?: { value?: { data?: unknown } | null };
  };
  const data = json.result?.value?.data;
  const b64 = Array.isArray(data)
    ? (data[0] as string)
    : typeof data === "string"
      ? data
      : null;
  return b64 ? base64ToBytes(b64) : null;
}

export async function resolveSolanaClearSigningDescriptor(
  args: ResolveClearSigningDescriptorArgs,
  fetchAccountData: SolanaAccountFetcher,
): Promise<ClearSigningDescriptor | null> {
  const call = args.call;
  if (!call || typeof call !== "object") return null;

  // Leg 1 — Stage-1 already decoded a well-known program.
  if ("program" in call) {
    return descriptorFromWellKnown(call as DecodedWellKnownCall);
  }

  // Leg 2 — unknown program: read the on-chain Anchor IDL account.
  if (!("programId" in call) || !("data" in call)) return null;
  const raw = call as RawIxCall;
  const data =
    raw.data instanceof Uint8Array ? raw.data : base64ToBytes(raw.data);
  if (data.length < 8) return null;
  try {
    const idlAddress = await deriveIdlAddress(raw.programId);
    const accountData = await fetchAccountData(idlAddress);
    if (!accountData) return null;
    const idl = parseIdlAccountData(accountData);
    if (!idl) return null;
    return resolveSolanaDescriptorFromIdl(idl, raw.programId, data);
  } catch {
    return null; // no IDL account / RPC failure → raw fallback
  }
}

// ── Phase C — signing digest ──────────────────────────────────────────

/** Compact-u16 (shortvec) decode — returns [value, bytesRead]. */
function readShortVecLength(bytes: Uint8Array): [number, number] | null {
  let len = 0;
  let size = 0;
  for (;;) {
    const b = bytes[size];
    if (b === undefined) return null;
    len |= (b & 0x7f) << (size * 7);
    size += 1;
    if ((b & 0x80) === 0) break;
    if (size > 3) return null;
  }
  return [len, size];
}

/**
 * Extracts the message byte range from a base64 wire transaction
 * (signature-count shortvec + 64-byte signatures stripped). This is
 * the exact preimage every required signer signs.
 */
export function extractMessageBytes(wireTxBase64: string): Uint8Array | null {
  const bytes = base64ToBytes(wireTxBase64);
  const header = readShortVecLength(bytes);
  if (!header) return null;
  const [numSigs, headerLen] = header;
  const start = headerLen + numSigs * 64;
  if (start >= bytes.length) return null;
  return bytes.subarray(start);
}

export async function computeSolanaSigningDigest(
  args: ComputeSigningDigestArgs,
): Promise<SigningDigest | null> {
  if (args.kind === "transaction") {
    const message = extractMessageBytes(args.transaction);
    if (!message) return null;
    return {
      scheme: "solana-message-sha256",
      values: [
        {
          label: "Message SHA-256",
          value: bytesToHex(sha256(message)),
          encoding: "hex",
        },
      ],
    };
  }
  if (args.kind === "personalMessage") {
    const bytes = base64ToBytes(args.messageBase64);
    return {
      scheme: "solana-message-sha256",
      values: [
        {
          label: "Message SHA-256",
          value: bytesToHex(sha256(bytes)),
          encoding: "hex",
        },
      ],
    };
  }
  return null;
}
