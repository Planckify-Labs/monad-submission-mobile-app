/**
 * Stellar clear-signing capability — task 65 (TWV-2026-066) Phases B + C.
 *
 * Phase B — `resolveStellarClearSigningDescriptor`: the one call
 * `StellarXdrDecoderInspector` flags as opaque (`invokeHostFunction`,
 * Soroban) has a native fix: every Soroban contract embeds its spec
 * (an ABI equivalent, consecutive `ScSpecEntry` XDR frames) in the
 * deployed WASM's `contractspecv0` custom section. Resolution is a
 * pinned two-hop `getLedgerEntries` read against the chain itself
 * (contract instance → wasm hash → wasm code) — the trust category
 * `reproducible-signer-ui.md` §3 allows, not a third-party decode
 * service. Classic (non-Soroban) operations are already fully legible
 * at Stage 1 and never reach this resolver.
 *
 * Phase C — `computeStellarSigningDigest`: Stellar's native tx hash —
 * `SHA-256(TransactionSignaturePayload)` — is exactly the "calldata
 * digest" concept ERC-8213 had to invent for EVM. `stellar-base`'s own
 * `tx.hash()` computes it; this surfaces it BEFORE signing. The value
 * byte-matches what stellar.expert shows post-broadcast.
 */

// Namespace-imported and resolved lazily: the package ships THREE
// builds and the export shape differs per resolver. Metro/Hermes picks
// the ESM `module`/`browser` build (named exports, NO default — a
// default import is `undefined` and crashed `bootWalletKits` at app
// start); Node's test runner picks the CJS `main` build, whose named
// exports the ESM lexer can't statically detect (only `.default`
// carries them). The dual lookup below handles both, and it runs
// inside the resolver — a shape surprise degrades to a `null`
// descriptor, never a module-load throw.
import * as jsXdrModule from "@stellar/js-xdr";
import {
  Address,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-base";
import type {
  ClearSigningDescriptor,
  ComputeSigningDigestArgs,
  ResolveClearSigningDescriptorArgs,
  SigningDigest,
} from "../types.ts";

type XdrReaderCtor = new (
  source: Buffer | Uint8Array,
) => {
  readonly eof: boolean;
};

function resolveXdrReader(): XdrReaderCtor | null {
  const mod = jsXdrModule as unknown as {
    XdrReader?: XdrReaderCtor;
    default?: { XdrReader?: XdrReaderCtor };
  };
  return mod.XdrReader ?? mod.default?.XdrReader ?? null;
}

// ── Phase B — Soroban contract-spec resolution ────────────────────────

interface StellarInvokeCall {
  kind: "invokeHostFunction";
  contractId?: string;
  function?: string;
  argsXdr?: string[];
}

function isInvokeCall(call: unknown): call is StellarInvokeCall {
  return (
    !!call &&
    typeof call === "object" &&
    (call as StellarInvokeCall).kind === "invokeHostFunction"
  );
}

/** ULEB128 decode — returns [value, bytesRead] or null on truncation. */
function readUleb(bytes: Uint8Array, offset: number): [number, number] | null {
  let value = 0;
  let size = 0;
  for (;;) {
    const b = bytes[offset + size];
    if (b === undefined || size > 4) return null;
    value |= (b & 0x7f) << (size * 7);
    size += 1;
    if ((b & 0x80) === 0) break;
  }
  return [value, size];
}

/**
 * Extracts a named custom section from a WASM binary. WASM layout:
 * 4-byte magic + 4-byte version, then sections of
 * `id(1) ‖ uleb(size) ‖ payload`; custom sections (id 0) prefix their
 * payload with `uleb(nameLen) ‖ name`.
 */
export function extractWasmCustomSection(
  wasm: Uint8Array,
  sectionName: string,
): Uint8Array | null {
  if (wasm.length < 8) return null;
  // \0asm magic.
  if (
    wasm[0] !== 0 ||
    wasm[1] !== 0x61 ||
    wasm[2] !== 0x73 ||
    wasm[3] !== 0x6d
  ) {
    return null;
  }
  let offset = 8;
  while (offset < wasm.length) {
    const id = wasm[offset];
    offset += 1;
    const size = readUleb(wasm, offset);
    if (!size) return null;
    offset += size[1];
    const end = offset + size[0];
    if (end > wasm.length) return null;
    if (id === 0) {
      const nameLen = readUleb(wasm, offset);
      if (!nameLen) return null;
      const nameStart = offset + nameLen[1];
      const name = new TextDecoder().decode(
        wasm.subarray(nameStart, nameStart + nameLen[0]),
      );
      if (name === sectionName) {
        return wasm.subarray(nameStart + nameLen[0], end);
      }
    }
    offset = end;
  }
  return null;
}

function xdrText(value: string | Buffer | Uint8Array): string {
  if (typeof value === "string") return value;
  return new TextDecoder().decode(new Uint8Array(value));
}

/** `ScSpecTypeDef` → readable type label for the parameter fields. */
export function formatScSpecType(t: xdr.ScSpecTypeDef): string {
  const name = t.switch().name;
  const simple: Record<string, string> = {
    scSpecTypeVal: "val",
    scSpecTypeBool: "bool",
    scSpecTypeVoid: "void",
    scSpecTypeError: "error",
    scSpecTypeU32: "u32",
    scSpecTypeI32: "i32",
    scSpecTypeU64: "u64",
    scSpecTypeI64: "i64",
    scSpecTypeTimepoint: "timepoint",
    scSpecTypeDuration: "duration",
    scSpecTypeU128: "u128",
    scSpecTypeI128: "i128",
    scSpecTypeU256: "u256",
    scSpecTypeI256: "i256",
    scSpecTypeBytes: "bytes",
    scSpecTypeString: "string",
    scSpecTypeSymbol: "symbol",
    scSpecTypeAddress: "address",
    scSpecTypeMuxedAddress: "muxed address",
  };
  if (simple[name]) return simple[name];
  try {
    switch (name) {
      case "scSpecTypeOption":
        return `option<${formatScSpecType(t.option().valueType())}>`;
      case "scSpecTypeVec":
        return `vec<${formatScSpecType(t.vec().elementType())}>`;
      case "scSpecTypeMap":
        return `map<${formatScSpecType(t.map().keyType())}, ${formatScSpecType(t.map().valueType())}>`;
      case "scSpecTypeBytesN":
        return `bytes${t.bytesN().n()}`;
      case "scSpecTypeUdt":
        return xdrText(t.udt().name());
      default:
        return name.replace(/^scSpecType/, "").toLowerCase();
    }
  } catch {
    return "unknown";
  }
}

/** Human-friendly render of one invocation argument (base64 ScVal). */
function formatScValBase64(argXdrBase64: string): string {
  try {
    const scVal = xdr.ScVal.fromXDR(argXdrBase64, "base64");
    const native = scValToNative(scVal);
    if (typeof native === "bigint") return native.toString();
    if (native instanceof Uint8Array) {
      return `0x${[...native].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    }
    if (typeof native === "object" && native !== null) {
      return JSON.stringify(native, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      );
    }
    return String(native);
  } catch {
    return argXdrBase64; // undecodable — show the raw base64, never throw
  }
}

function humanizeSnakeCase(name: string): string {
  const spaced = name.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Pure WASM → descriptor resolution — exported for unit tests; the kit
 * method feeds it the fetched code. Streams the `contractspecv0`
 * custom section's consecutive `ScSpecEntry` frames and binds the
 * entry whose name matches the invoked function.
 */
export function resolveStellarDescriptorFromWasm(
  wasm: Uint8Array,
  call: StellarInvokeCall,
): ClearSigningDescriptor | null {
  if (!call.function || !call.contractId) return null;
  const section = extractWasmCustomSection(wasm, "contractspecv0");
  if (!section) return null;
  const XdrReader = resolveXdrReader();
  if (!XdrReader) return null; // unexpected build shape — raw fallback
  let fnSpec: xdr.ScSpecFunctionV0 | null = null;
  try {
    const reader = new XdrReader(Buffer.from(section));
    while (!reader.eof) {
      // stellar-base's .d.ts types `read` as taking a Buffer, but the
      // js-xdr runtime contract is an XdrReader — the only way to
      // stream consecutive frames without re-slicing.
      const entry = xdr.ScSpecEntry.read(reader as unknown as Buffer);
      if (entry.switch().name !== "scSpecEntryFunctionV0") continue;
      const fn = entry.functionV0();
      if (xdrText(fn.name()) === call.function) {
        fnSpec = fn;
        break;
      }
    }
  } catch {
    return null; // malformed spec stream — raw fallback
  }
  if (!fnSpec) return null;

  const inputs = fnSpec.inputs();
  const args = call.argsXdr ?? [];
  const fields: ClearSigningDescriptor["fields"] = [];
  // Pair spec params with invocation args by position. A count
  // mismatch means we can't truthfully label values — fall back to an
  // intent-only descriptor (the function-name match itself is exact).
  if (inputs.length === args.length) {
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      fields.push({
        label: `${humanizeSnakeCase(xdrText(input.name()))} (${formatScSpecType(input.type())})`,
        value: formatScValBase64(args[i]),
      });
    }
  }
  return {
    intent: humanizeSnakeCase(call.function),
    source: "soroban-spec",
    target: call.contractId,
    functionName: call.function,
    fields,
  };
}

/** WASM fetch seam — the kit binds the two-hop ledger read; tests stub it. */
export type StellarWasmFetcher = (
  contractId: string,
) => Promise<Uint8Array | null>;

export async function resolveStellarClearSigningDescriptor(
  args: ResolveClearSigningDescriptorArgs,
  fetchWasm: StellarWasmFetcher,
): Promise<ClearSigningDescriptor | null> {
  if (!isInvokeCall(args.call)) return null;
  const call = args.call;
  if (!call.contractId || !call.function) return null;
  try {
    const wasm = await fetchWasm(call.contractId);
    if (!wasm) return null;
    return resolveStellarDescriptorFromWasm(wasm, call);
  } catch {
    return null; // RPC unavailable → raw fallback, never a block
  }
}

// ── Default WASM fetcher: pinned getLedgerEntries reads ──────────────

interface GetLedgerEntriesResponse {
  entries?: Array<{ xdr?: string }>;
}

async function sorobanGetLedgerEntries(
  rpcUrl: string,
  keysBase64: string[],
): Promise<GetLedgerEntriesResponse> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getLedgerEntries",
      params: { keys: keysBase64 },
    }),
  });
  if (!res.ok) throw new Error("getLedgerEntries failed");
  const json = (await res.json()) as { result?: GetLedgerEntriesResponse };
  return json.result ?? {};
}

/**
 * Two-hop pinned read against the chain: contract instance →
 * executable wasm hash → contract code. Both hops address the deployed
 * contract itself; nothing here consults an external registry.
 */
export async function fetchSorobanContractWasm(
  rpcUrl: string,
  contractId: string,
): Promise<Uint8Array | null> {
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  ).toXDR("base64");
  const instanceRes = await sorobanGetLedgerEntries(rpcUrl, [instanceKey]);
  const instanceXdr = instanceRes.entries?.[0]?.xdr;
  if (!instanceXdr) return null;
  const instanceData = xdr.LedgerEntryData.fromXDR(instanceXdr, "base64");
  const executable = instanceData.contractData().val().instance().executable();
  if (executable.switch().name !== "contractExecutableWasm") {
    return null; // built-in (SAC) executable — no WASM spec to read
  }
  const codeKey = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: executable.wasmHash() }),
  ).toXDR("base64");
  const codeRes = await sorobanGetLedgerEntries(rpcUrl, [codeKey]);
  const codeXdr = codeRes.entries?.[0]?.xdr;
  if (!codeXdr) return null;
  const codeData = xdr.LedgerEntryData.fromXDR(codeXdr, "base64");
  return new Uint8Array(codeData.contractCode().code());
}

// ── Phase C — native tx hash, pre-signature ───────────────────────────

/**
 * `SHA-256(TransactionSignaturePayload)` via stellar-base's own
 * `tx.hash()` — the exact hash the network assigns and every explorer
 * displays. Needs the network passphrase (it is part of the signature
 * payload preimage — same tx bytes hash differently per network, by
 * design).
 */
export function stellarTransactionHash(
  envelopeXdrBase64: string,
  networkPassphrase: string,
): `0x${string}` {
  const tx = TransactionBuilder.fromXDR(envelopeXdrBase64, networkPassphrase);
  const hash = tx.hash();
  return `0x${[...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

export async function computeStellarSigningDigest(
  args: ComputeSigningDigestArgs,
): Promise<SigningDigest | null> {
  if (args.kind === "transaction" && args.networkPassphrase) {
    return {
      scheme: "stellar-tx-hash",
      values: [
        {
          label: "Transaction hash",
          value: stellarTransactionHash(
            args.transaction,
            args.networkPassphrase,
          ),
          encoding: "hex",
        },
      ],
    };
  }
  // SEP-43 message signing has no network-defined digest — a real,
  // documented gap (same posture as EVM personal_sign under ERC-8213).
  return null;
}
