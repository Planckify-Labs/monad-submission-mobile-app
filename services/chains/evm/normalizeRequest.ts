/**
 * Request normalisation for the EVM bridge — the boundary where a
 * dApp-supplied object becomes a payload this wallet is willing to sign.
 *
 * Extracted from `EvmAdapter` so the boundary is directly testable.
 * These functions are the enforcement point for spec phase M, and a
 * validation layer nobody can write a test against is a validation layer
 * that quietly stops validating.
 *
 * Pure: no RPC, no storage, no wallet state. Everything network-shaped
 * (gas estimation, the ERC-165 approve probe) stays on the adapter and
 * runs *after* a request has survived this file.
 */

import { fromHex, type Hex, isAddress } from "viem";
import { PROVIDER_ERRORS, type ProviderRpcError } from "./errors";
import type { EvmBatchCallsPayload, EvmSendTxPayload } from "./payloads";
import { parseRpcData, parseRpcQuantity, parseTxType } from "./rpcEncoding";

export function normalizeTx(
  raw: Record<string, unknown>,
  chainId: number,
  from: `0x${string}`,
):
  | {
      payload: EvmSendTxPayload;
    }
  | { error: ProviderRpcError } {
  try {
    const rawTo = raw.to;
    // Phase M — validate, do not cast. An odd-length `data` used to slip
    // straight through to the decoder, where the misaligned 4-byte
    // selector slice erased the approve warning.
    const parsedData = parseRpcData(raw.data ?? raw.input);
    if (!parsedData.ok) return { error: PROVIDER_ERRORS.invalidParams("data") };
    const data = parsedData.value;
    const hasInitCode =
      typeof data === "string" && data !== "0x" && data.length > 2;

    // A contract-creation transaction is defined by having no recipient.
    // Accept that shape, but only alongside init-code: a tx with neither
    // recipient nor calldata is malformed, and treating it as a deploy
    // would turn a dApp's missing-`to` bug into a value-burning send.
    let to: `0x${string}` | undefined;
    if (rawTo === undefined || rawTo === null || rawTo === "") {
      if (!hasInitCode) return { error: PROVIDER_ERRORS.invalidParams("to") };
      to = undefined;
    } else {
      if (typeof rawTo !== "string" || !isAddress(rawTo))
        return { error: PROVIDER_ERRORS.invalidParams("to") };
      to = rawTo as `0x${string}`;
    }

    // Every QUANTITY field goes through the same parser, so a missing
    // `0x` is a rejection rather than a silent decimal reading.
    //
    // `gas` accepts `gasLimit` as an alias. That is not tidiness: the
    // test dapp's own "Send ETH to Multisig Address" button sends a raw
    // `eth_sendTransaction` with `gasLimit: '0x5208'`, and reading only
    // `gas` dropped the dApp's explicit limit on the floor. We then
    // re-estimated and signed a transaction with a different gas limit
    // than the one the request specified, which is the same class of
    // "executed something other than what was asked" that phase M's
    // transaction-type rule exists to stop.
    const rawByField: Record<string, unknown> = {
      value: raw.value,
      gas: raw.gas ?? raw.gasLimit,
      maxFeePerGas: raw.maxFeePerGas,
      maxPriorityFeePerGas: raw.maxPriorityFeePerGas,
      gasPrice: raw.gasPrice,
      nonce: raw.nonce,
    };
    const quantities: Record<string, bigint | undefined> = {};
    for (const field of Object.keys(rawByField)) {
      const parsed = parseRpcQuantity(rawByField[field]);
      if (!parsed.ok) return { error: PROVIDER_ERRORS.invalidParams(field) };
      quantities[field] = parsed.value;
    }
    const value = quantities.value;
    const gas = quantities.gas;
    const maxFeePerGas = quantities.maxFeePerGas;
    const maxPriorityFeePerGas = quantities.maxPriorityFeePerGas;
    const gasPrice = quantities.gasPrice;
    const nonce =
      quantities.nonce === undefined ? undefined : Number(quantities.nonce);
    const accessList = raw.accessList as EvmSendTxPayload extends {
      accessList?: infer A;
    }
      ? A
      : undefined;

    // Phase M — an unsupported type is rejected, never coerced. Falling
    // through to type 2 meant signing a plain dynamic-fee transaction
    // when the dApp asked for a Tempo (`0x76`), blob (`0x3`) or 7702
    // (`0x4`) transaction, dropping the very fields that distinguish
    // them.
    const parsedType = parseTxType(raw.type);
    if (!parsedType.ok) return { error: PROVIDER_ERRORS.invalidParams("type") };
    const explicitType = parsedType.value;

    let type: 0 | 1 | 2;
    if (explicitType !== undefined) {
      type = explicitType;
    } else if (maxFeePerGas || maxPriorityFeePerGas) type = 2;
    else if (accessList && gasPrice) type = 1;
    else if (gasPrice) type = 0;
    else type = 2;

    // reject invalid combos at the boundary
    if (type === 2 && gasPrice)
      return {
        error: PROVIDER_ERRORS.invalidParams("gasPrice with type 2 tx"),
      };
    if (type === 0 && (maxFeePerGas || maxPriorityFeePerGas))
      return {
        error: PROVIDER_ERRORS.invalidParams("dynamic-fee fields on legacy tx"),
      };

    const common = { to, from, value, data, gas, nonce, chainId } as const;
    const payload: EvmSendTxPayload =
      type === 0
        ? { ...common, type: 0, gasPrice }
        : type === 1
          ? { ...common, type: 1, gasPrice, accessList }
          : {
              ...common,
              type: 2,
              maxFeePerGas,
              maxPriorityFeePerGas,
              accessList,
            };
    return { payload };
  } catch (e) {
    // The field parsers above return rather than throw, so reaching here
    // is unexpected. Keep the dApp-visible reason a fixed label and put
    // the detail in the dev log rather than echoing an internal message
    // back over the bridge.
    if (__DEV__) console.warn("[EvmAdapter] normalizeTx threw", e);
    return { error: PROVIDER_ERRORS.invalidParams("tx") };
  }
}

export function normalizeSendCalls(
  raw: Record<string, unknown>,
  activeChainId: number,
  activeAddress: `0x${string}`,
): { payload: EvmBatchCallsPayload } | { error: ProviderRpcError } {
  if (!raw || typeof raw !== "object")
    return { error: PROVIDER_ERRORS.invalidParams("sendCalls") };

  // Accept the withdrawn "1.0" draft alongside the finalized "2.0.0" so
  // dApps that have not migrated keep working; responses are always
  // emitted in 2.0.0 shape. Absent means 2.0.0 — that is what viem,
  // wagmi and the MetaMask SDK send today.
  const rawVersion = raw.version;
  const version =
    rawVersion === undefined || rawVersion === null
      ? "2.0.0"
      : (rawVersion as string);
  if (version !== "1.0" && version !== "2.0.0")
    return { error: PROVIDER_ERRORS.invalidParams("version") };

  const chainIdHex = raw.chainId as Hex | undefined;
  const chainId = chainIdHex
    ? Number(fromHex(chainIdHex, "number"))
    : activeChainId;
  // 5710, not 4901. EIP-5792 gives "unsupported chain id" its own code
  // so the dApp knows to switch chains and retry; a generic "chain not
  // connected" reads as a connection problem it cannot act on.
  if (chainId !== activeChainId)
    return { error: PROVIDER_ERRORS.unsupportedChainId(chainId) };
  const from = ((raw.from as string) ?? activeAddress) as `0x${string}`;
  if (from.toLowerCase() !== activeAddress.toLowerCase())
    return { error: PROVIDER_ERRORS.invalidParams("from") };
  const callsRaw = raw.calls as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(callsRaw))
    return { error: PROVIDER_ERRORS.invalidParams("calls") };
  // Phase M applies per batch entry too. Validating only the
  // single-transaction path would leave the odd-hex bypass intact behind
  // `wallet_sendCalls`, which is the same shape of hole phase L exists
  // to close.
  const calls: EvmBatchCallsPayload["calls"] = [];
  for (const c of callsRaw) {
    const data = parseRpcData(c.data);
    if (!data.ok) return { error: PROVIDER_ERRORS.invalidParams("calls.data") };
    const value = parseRpcQuantity(c.value);
    if (!value.ok)
      return { error: PROVIDER_ERRORS.invalidParams("calls.value") };
    const gas = parseRpcQuantity(c.gas ?? c.gasLimit);
    if (!gas.ok) return { error: PROVIDER_ERRORS.invalidParams("calls.gas") };
    if (typeof c.to === "string" && c.to !== "" && !isAddress(c.to)) {
      return { error: PROVIDER_ERRORS.invalidParams("calls.to") };
    }
    calls.push({
      // Optional: a batch entry may be a contract creation.
      to:
        typeof c.to === "string" && c.to !== ""
          ? (c.to as `0x${string}`)
          : undefined,
      value: value.value,
      data: data.value,
      gas: gas.value,
      // Carried through so the required-capability check can see a
      // per-call requirement, not just the top-level one.
      capabilities: c.capabilities as Record<string, unknown> | undefined,
    });
  }
  return {
    payload: {
      version,
      chainId,
      from,
      atomicRequired: raw.atomicRequired === true,
      calls,
      capabilities: raw.capabilities as Record<string, unknown> | undefined,
    },
  };
}
