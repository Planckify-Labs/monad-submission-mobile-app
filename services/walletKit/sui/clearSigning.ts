/**
 * Sui clear-signing capability — task 65 (TWV-2026-066) Phases B + C.
 *
 * Phase B — `resolveSuiClearSigningDescriptor`: closes the "MoveCall
 * shows only `argumentCount`" gap natively via
 * `sui_getNormalizedMoveFunction` — the deployed package's own
 * parameter types, straight from the chain. A pinned RPC read against
 * the package itself (the trust category `reproducible-signer-ui.md`
 * §3 allows), not an external registry.
 *
 * Phase C — `computeSuiSigningDigest`: Sui already computes its tx
 * digest as part of the protocol — `blake2b-256` over the
 * intent-prefixed BCS `TransactionData` — and shows the same value on
 * every explorer. This surfaces it BEFORE signing instead of only
 * after; base58, matching the explorer encoding byte-for-byte.
 * Personal messages use the `PersonalMessage` intent scope the wallet
 * actually signs under.
 */

import { toBase58 } from "@mysten/bcs";
import { blake2b } from "@noble/hashes/blake2";
import type {
  ClearSigningDescriptor,
  ComputeSigningDigestArgs,
  ResolveClearSigningDescriptorArgs,
  SigningDigest,
} from "../types.ts";

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Uint8Array((globalThis as any).Buffer.from(b64, "base64"));
}

// ── Phase B — normalized Move function resolution ─────────────────────

interface SuiMoveCallShape {
  kind: "MoveCall";
  package: string;
  module: string;
  function: string;
  argumentCount?: number;
  typeArgumentCount?: number;
}

function isMoveCall(call: unknown): call is SuiMoveCallShape {
  if (!call || typeof call !== "object") return false;
  const c = call as SuiMoveCallShape;
  return (
    c.kind === "MoveCall" &&
    typeof c.package === "string" &&
    typeof c.module === "string" &&
    typeof c.function === "string"
  );
}

/**
 * `SuiMoveNormalizedType` → readable Move type string. The JSON-RPC
 * shape is either a primitive string ("U64", "Address", …) or a
 * one-key object (Struct / Vector / Reference / MutableReference /
 * TypeParameter).
 */
export function formatNormalizedType(t: unknown): string {
  if (typeof t === "string") return t.toLowerCase();
  if (!t || typeof t !== "object") return "unknown";
  const o = t as Record<string, unknown>;
  if ("Struct" in o) {
    const s = o.Struct as {
      address?: string;
      module?: string;
      name?: string;
      typeArguments?: unknown[];
    };
    const base = `${shortenSuiAddress(s.address ?? "?")}::${s.module}::${s.name}`;
    const targs = (s.typeArguments ?? [])
      .map((x) => formatNormalizedType(x))
      .join(", ");
    return targs ? `${base}<${targs}>` : base;
  }
  if ("Vector" in o) return `vector<${formatNormalizedType(o.Vector)}>`;
  if ("Reference" in o) return `&${formatNormalizedType(o.Reference)}`;
  if ("MutableReference" in o) {
    return `&mut ${formatNormalizedType(o.MutableReference)}`;
  }
  if ("TypeParameter" in o) return `T${String(o.TypeParameter)}`;
  return "unknown";
}

function shortenSuiAddress(addr: string): string {
  // 0x0000…0002 → 0x2 for the well-known framework packages only.
  const m = addr.match(/^0x0*([0-9a-fA-F]{1,4})$/);
  return m ? `0x${m[1].toLowerCase()}` : addr;
}

/** True for the `&mut TxContext` tail parameter every entry fn carries. */
function isTxContextParam(t: unknown): boolean {
  if (!t || typeof t !== "object") return false;
  const o = t as Record<string, unknown>;
  const inner = (o.MutableReference ?? o.Reference) as
    | Record<string, unknown>
    | undefined;
  if (!inner || typeof inner !== "object" || !("Struct" in inner)) {
    return false;
  }
  const s = inner.Struct as { module?: string; name?: string };
  return s.module === "tx_context" && s.name === "TxContext";
}

function humanizeFunctionName(fn: string): string {
  const spaced = fn.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Raw JSON-RPC seam — kit binds it to the chain RPC; tests stub it. */
export type SuiRpcCall = (
  method: string,
  params: unknown[],
) => Promise<unknown>;

/** Default seam: plain JSON-RPC POST against the bound fullnode. */
export function makeSuiRpcCall(rpcUrl: string): SuiRpcCall {
  return async (method, params) => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`sui rpc ${method} failed: ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: unknown };
    if (json.error) throw new Error(`sui rpc ${method} errored`);
    return json.result;
  };
}

export async function resolveSuiClearSigningDescriptor(
  args: ResolveClearSigningDescriptorArgs,
  rpcCall: SuiRpcCall,
): Promise<ClearSigningDescriptor | null> {
  if (!isMoveCall(args.call)) return null;
  const call = args.call;
  let normalized: unknown;
  try {
    normalized = await rpcCall("sui_getNormalizedMoveFunction", [
      call.package,
      call.module,
      call.function,
    ]);
  } catch {
    return null; // RPC unavailable → raw fallback, never a block
  }
  if (!normalized || typeof normalized !== "object") return null;
  const fn = normalized as {
    parameters?: unknown[];
    isEntry?: boolean;
    visibility?: string;
  };
  if (!Array.isArray(fn.parameters)) return null;
  const params = fn.parameters.filter((p) => !isTxContextParam(p));
  return {
    intent: humanizeFunctionName(call.function),
    source: "normalized-move",
    target: `${call.package}::${call.module}`,
    functionName: `${call.package}::${call.module}::${call.function}`,
    fields: params.map((p, i) => ({
      label: `Parameter ${i + 1}`,
      value: formatNormalizedType(p),
    })),
  };
}

// ── Phase C — native tx digest, pre-signature ─────────────────────────

/**
 * Personal-message signing intent per the Sui signing scheme:
 * [scope = PersonalMessage(3), version = V0, appId = Sui].
 */
const INTENT_PERSONAL_MESSAGE = Uint8Array.from([3, 0, 0]);

/**
 * Explorer/tx-id digest preimage tag. Verified against the pinned
 * `@mysten/sui` SDK's own `TransactionDataBuilder.getDigestFromBytes`:
 * `base58(blake2b256("TransactionData::" ‖ bcsBytes))` — the type-tag
 * form, NOT the 3-byte signing intent (that one prefixes what gets
 * *signed*, a different value from the digest explorers display).
 */
const TX_DIGEST_TYPE_TAG = new TextEncoder().encode("TransactionData::");

function ulebEncode(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}

function digestWithIntent(intent: Uint8Array, payload: Uint8Array): string {
  const preimage = new Uint8Array(intent.length + payload.length);
  preimage.set(intent, 0);
  preimage.set(payload, intent.length);
  return toBase58(blake2b(preimage, { dkLen: 32 }));
}

/**
 * The chain's own transaction digest — `blake2b-256` over the
 * type-tagged BCS `TransactionData` — computed locally before signing.
 * Byte-matches the digest every Sui explorer shows for the same
 * transaction after broadcast.
 */
export function suiTransactionDigest(txBytesBase64: string): string {
  return digestWithIntent(TX_DIGEST_TYPE_TAG, base64ToBytes(txBytesBase64));
}

/**
 * PersonalMessage-intent digest — the exact preimage hash the wallet
 * signs for `signPersonalMessage` (message BCS-wrapped as
 * `vector<u8>`, i.e. ULEB length prefix + bytes).
 */
export function suiPersonalMessageDigest(messageBase64: string): string {
  const message = base64ToBytes(messageBase64);
  const lenPrefix = Uint8Array.from(ulebEncode(message.length));
  const bcsWrapped = new Uint8Array(lenPrefix.length + message.length);
  bcsWrapped.set(lenPrefix, 0);
  bcsWrapped.set(message, lenPrefix.length);
  return digestWithIntent(INTENT_PERSONAL_MESSAGE, bcsWrapped);
}

export async function computeSuiSigningDigest(
  args: ComputeSigningDigestArgs,
): Promise<SigningDigest | null> {
  if (args.kind === "transaction") {
    return {
      scheme: "sui-tx-digest",
      values: [
        {
          label: "Transaction digest",
          value: suiTransactionDigest(args.transaction),
          encoding: "base58",
        },
      ],
    };
  }
  if (args.kind === "personalMessage") {
    return {
      scheme: "sui-tx-digest",
      values: [
        {
          label: "Signing digest",
          value: suiPersonalMessageDigest(args.messageBase64),
          encoding: "base58",
        },
      ],
    };
  }
  return null;
}
