/**
 * Decodes a Stellar XDR transaction envelope into the structural
 * `StellarDecodedOperation[]` view — a pure, no-RPC decode consumed by
 * both `StellarXdrDecoderInspector` (§8.1) and, defensively, any sheet
 * fallback path.
 *
 * Spec reference: `docs/stellar-dapp-bridge-spec.md` §6, §8.1.
 *
 * Field-name mapping confirmed by reading `@stellar/stellar-base`'s own
 * `types/index.d.ts` `Operation` namespace directly (not assumed) —
 * `changeTrust` decodes with a `line` field (not `asset`), `payment`
 * with `asset`, `manageBuyOffer` with `buyAmount` (not `amount`), etc.
 * `Asset#toString()` / `LiquidityPoolAsset#toString()` both already
 * produce the `"native"` / `"CODE:ISSUER"` / pool-id-hex convention this
 * module's asset strings use — reused, not reimplemented.
 */

import type { Transaction, xdr } from "@stellar/stellar-base";
import { Address, TransactionBuilder } from "@stellar/stellar-base";

import type { StellarDecodedOperation } from "./payloads";

export interface DecodedStellarTransaction {
  sourceAccount: string;
  fee: string;
  sequence: string;
  memo: {
    type: "none" | "text" | "id" | "hash" | "return";
    value?: string;
  };
  operations: StellarDecodedOperation[];
}

function assetString(asset: unknown): string {
  if (
    asset &&
    typeof (asset as { toString?: unknown }).toString === "function"
  ) {
    try {
      return (asset as { toString(): string }).toString();
    } catch {
      // fall through
    }
  }
  return "unknown";
}

/**
 * Structural decode of a Soroban `invokeHostFunction` operation. Only
 * the `invokeContract` host-function arm carries a contract invocation;
 * the others (upload WASM, create contract) return the bare tag. Fully
 * defensive: any shape surprise degrades to the bare tag rather than
 * throwing — the raw XDR stays the signing source of truth either way.
 */
function decodeInvokeHostFunction(
  o: Record<string, unknown>,
): StellarDecodedOperation {
  try {
    const func = o.func as xdr.HostFunction | undefined;
    if (!func || typeof func.switch !== "function") {
      return { kind: "invokeHostFunction" };
    }
    if (func.switch().name !== "hostFunctionTypeInvokeContract") {
      return { kind: "invokeHostFunction" };
    }
    const invocation = func.invokeContract();
    const contractId = Address.fromScAddress(
      invocation.contractAddress(),
    ).toString();
    const rawName = invocation.functionName();
    const functionName =
      typeof rawName === "string"
        ? rawName
        : new TextDecoder().decode(new Uint8Array(rawName));
    const argsXdr = invocation.args().map((a) => a.toXDR("base64"));
    return {
      kind: "invokeHostFunction",
      contractId,
      function: functionName,
      argsXdr,
    };
  } catch {
    return { kind: "invokeHostFunction" };
  }
}

/** Narrow, defensive per-operation decode — unrecognized shapes fall back to `{kind:"other"}`. */
function decodeOperation(op: unknown): StellarDecodedOperation {
  const o = op as Record<string, unknown>;
  const type = o.type as string | undefined;

  switch (type) {
    case "payment":
      return {
        kind: "payment",
        destination: String(o.destination ?? ""),
        asset: assetString(o.asset),
        amount: String(o.amount ?? "0"),
      };
    case "createAccount":
      return {
        kind: "createAccount",
        destination: String(o.destination ?? ""),
        startingBalance: String(o.startingBalance ?? "0"),
      };
    case "changeTrust":
      return {
        kind: "changeTrust",
        asset: assetString(o.line),
        limit: String(o.limit ?? "0"),
      };
    case "pathPaymentStrictSend":
      return {
        kind: "pathPaymentStrictSend",
        destination: String(o.destination ?? ""),
        sendAsset: assetString(o.sendAsset),
        destAsset: assetString(o.destAsset),
      };
    case "pathPaymentStrictReceive":
      return {
        kind: "pathPaymentStrictReceive",
        destination: String(o.destination ?? ""),
        sendAsset: assetString(o.sendAsset),
        destAsset: assetString(o.destAsset),
      };
    case "manageSellOffer":
      return {
        kind: "manageSellOffer",
        selling: assetString(o.selling),
        buying: assetString(o.buying),
      };
    case "manageBuyOffer":
      return {
        kind: "manageBuyOffer",
        selling: assetString(o.selling),
        buying: assetString(o.buying),
      };
    case "accountMerge":
      return {
        kind: "accountMerge",
        destination: String(o.destination ?? ""),
      };
    case "invokeHostFunction":
      // Soroban. Task 65 (TWV-2026-066): surface the structural
      // invocation identity (contract / function / raw ScVal args) so
      // the Stage-2 clear-signing resolver can consult the on-chain
      // contract spec. The inspector still flags the call loudly
      // (`soroban.invoke-host-function`, §8.1).
      return decodeInvokeHostFunction(o);
    default:
      return { kind: "other", type: type ?? "unknown" };
  }
}

function decodeMemo(tx: Transaction): DecodedStellarTransaction["memo"] {
  const memo = tx.memo;
  const type = memo?.type as string | undefined;
  // `text`/`id` decode to plain strings per stellar-base's own typing
  // (`Memo<T>.value` is `string` for both); only `hash`/`return` carry
  // raw bytes that need hex-encoding for display.
  if (type === "text" || type === "id") {
    const raw = memo.value;
    const value =
      typeof raw === "string"
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : String(raw ?? "");
    return { type, value };
  }
  if (type === "hash" || type === "return") {
    const raw = memo.value;
    const value = Buffer.isBuffer(raw)
      ? raw.toString("hex")
      : String(raw ?? "");
    return { type, value };
  }
  return { type: "none" };
}

/**
 * Decodes a base64 XDR transaction envelope. Throws on malformed input —
 * callers (the inspector, the adapter's pre-enqueue validation) decide
 * how to handle a decode failure; this function never silently
 * swallows one.
 */
export function decodeStellarTransaction(
  xdr: string,
  networkPassphrase: string,
): DecodedStellarTransaction {
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase) as Transaction;
  return {
    sourceAccount: tx.source,
    fee: String(tx.fee ?? "0"),
    sequence: String(tx.sequence ?? "0"),
    memo: decodeMemo(tx),
    operations: tx.operations.map(decodeOperation),
  };
}
