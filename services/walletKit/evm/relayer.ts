/**
 * `relayer` — pure 1Shot public-relayer JSON-RPC client for the EVM kit.
 *
 * Wire format tracks the **live** 1Shot API (skill `references/schemas.md`
 * + `examples.md`), not the Phase-3 spec draft: `send`/`estimate` take a
 * single params object with `transactions:[{permissionContext, executions}]`
 * + `context`; `chainId` is a decimal string; `getStatus` takes
 * `{id, logs}` and returns numeric status codes.
 *
 * Isolated from `EvmWalletKit.ts` so the request builders + decoders are
 * Node-testable with an injected `fetch`. Rules (mirror `delegations.ts`):
 *   - No `react` / `react-native` / `expo` imports.
 *   - No `viem` import — bigint ⇄ hex is done by hand.
 *   - The only I/O is `fetch`, injected so tests can mock it.
 *   - Thrown `Error.message` is a SHORT FIXED LABEL only — never the
 *     server body / status (CLAUDE.md user-facing-errors hard rule).
 *     Raw detail goes to a `__DEV__`-guarded log.
 */

import type {
  DelegationStruct,
  Estimate7710TransactionResult,
  RelayerAuthorizationEntry,
  RelayerBundleEntry,
  RelayerCapabilities,
  RelayerExecution,
  RelayerFeeData,
  RelayerStatus,
  Send7710TransactionResult,
} from "../types.ts";

/** Injected `fetch`. Defaults to the platform global at call sites. */
export type RelayerFetch = typeof fetch;

/** Mainnet JSON-RPC endpoint. */
export const RELAYER_MAINNET_URL = "https://relayer.1shotapi.com/relayers";
/** Testnet JSON-RPC endpoint (Sepolia / Base Sepolia). */
export const RELAYER_TESTNET_URL = "https://relayer.1shotapi.dev/relayers";

/** viem chain ids routed to the testnet relayer. */
const TESTNET_CHAIN_IDS = new Set<number>([11155111, 84532]);

/**
 * SI-1 fee-overcharge ceiling in whole stablecoin units ⇒ $5.00. Any
 * `requiredPaymentAmount` above this is treated as a safety violation and
 * the estimate is failed before a `send` can ever quote it.
 */
export const RELAYER_FEE_SAFETY_MAX_WHOLE = 5n;

/**
 * {@link RELAYER_FEE_SAFETY_MAX_WHOLE} in the fee token's atoms. The
 * relayer tags the same stablecoin with different decimals per chain
 * (USDC / USDT are 6dp on most chains but 18dp on BSC), so callers that
 * know the fee token pass its `decimals` here instead of assuming 6.
 */
export function relayerFeeSafetyMaxAtoms(decimals: number): bigint {
  const dp = Number.isInteger(decimals) && decimals >= 0 ? decimals : 6;
  return RELAYER_FEE_SAFETY_MAX_WHOLE * 10n ** BigInt(dp);
}

/**
 * Default SI-1 ceiling in 6-decimal atoms (USDC on every chain but BSC).
 * Kept for callers that only ever pay in 6dp USDC (x402 settlement).
 */
export const RELAYER_FEE_SAFETY_MAX_USDC_ATOMS = relayerFeeSafetyMaxAtoms(6);

/**
 * Resolves the relayer endpoint for a chain. Testnets (Sepolia, Base
 * Sepolia) hit the `.dev` host; everything else the `.com` host.
 */
export function getRelayerEndpoint(chainId: number): string {
  return TESTNET_CHAIN_IDS.has(chainId)
    ? RELAYER_TESTNET_URL
    : RELAYER_MAINNET_URL;
}

/**
 * Relayer JSON-RPC error codes the client branches on (1Shot error-
 * handling guide / `schemas.md` error catalog). Only the ones we act on
 * are listed; everything else is treated as a hard failure.
 */
export const RELAYER_ERROR = {
  INSUFFICIENT_PAYMENT: 4200,
  INVALID_SIGNATURE: 4201,
  UNSUPPORTED_PAYMENT_TOKEN: 4202,
  QUOTE_EXPIRED: 4204,
  INSUFFICIENT_BALANCE: 4205,
  UNSUPPORTED_CHAIN: 4206,
  INVALID_AUTHORIZATION_LIST: 4210,
  SIMULATION_FAILED: 4211,
  DUPLICATE_TASK_ID: 4214,
} as const;

/**
 * Typed JSON-RPC failure. The `message` is a FIXED LABEL only — the raw
 * server body / code never goes into it (CLAUDE.md user-facing-errors
 * rule). The numeric `code` is carried as a structured field for internal
 * control flow (e.g. retry on `QUOTE_EXPIRED`); callers must not surface
 * it to users.
 */
export class RelayerRpcError extends Error {
  readonly name = "RelayerRpcError";
  readonly code?: number;
  constructor(method: string, code?: number) {
    super(`${method} request failed`);
    this.code = code;
  }
}

/** Reads the relayer error code off an unknown thrown value, if present. */
export function getRelayerErrorCode(err: unknown): number | undefined {
  return err instanceof RelayerRpcError ? err.code : undefined;
}

/** Typed SI-1 violation so callers can branch on `name` for UX copy. */
export class RelayerFeeOverchargeError extends Error {
  readonly name = "RelayerFeeOverchargeError";
  readonly amount: bigint;
  readonly max: bigint;
  constructor(amount: bigint, max: bigint) {
    super("relayer fee exceeds safety bound");
    this.amount = amount;
    this.max = max;
  }
}

/**
 * SI-1 guard. Throws a fixed-label error when `amount` exceeds `max`
 * (default {@link RELAYER_FEE_SAFETY_MAX_USDC_ATOMS}). Exported so the
 * send-side caller can re-assert before broadcasting.
 */
export function assertFeeWithinSafetyBound(
  amount: bigint,
  max: bigint = RELAYER_FEE_SAFETY_MAX_USDC_ATOMS,
): void {
  if (amount > max) {
    throw new RelayerFeeOverchargeError(amount, max);
  }
}

/** `__DEV__`-guarded raw logger — never reaches production users. */
function logRelayerDebug(label: string, detail: unknown): void {
  const dev = typeof __DEV__ !== "undefined" ? __DEV__ : false;
  if (dev) {
    console.warn(`[relayer] ${label}`, detail);
  }
}

/** `0x`-prefixed lowercase hex for a non-negative bigint (`0n` → `"0x0"`). */
function toHexQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

/**
 * Tolerant `bigint` parse for relayer numeric fields (`gasPrice`,
 * `minFee`, `requiredPaymentAmount`). The live API is looser than the
 * documented schema (`schemas.md`): a wei / atoms value may arrive as a
 * `0x`-hex string, a *bare* hex string (no `0x`), a decimal-integer
 * string, a JSON number, or a decimal string with a fractional part. A
 * naive `BigInt(value)` throws `SyntaxError: can't convert string to
 * bigint` on several of these and aborts the whole quote. We normalize
 * all of them here (fractions are truncated toward zero — wei/atoms are
 * integers) and throw a fixed-label error only on a genuinely
 * unparseable value, with the raw value dev-logged for diagnosis.
 */
export function parseRelayerBigInt(
  method: string,
  field: string,
  value: unknown,
): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return BigInt(Math.trunc(value));
    logRelayerDebug(`${method} non-finite ${field}`, value);
    throw new RelayerRpcError(method);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (s !== "") {
      // 0x-prefixed hex.
      if (/^[+-]?0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
      // Plain decimal integer.
      if (/^[+-]?\d+$/.test(s)) return BigInt(s);
      // Decimal with a fractional part → truncate toward zero.
      const frac = /^([+-]?)(\d*)\.\d+$/.exec(s);
      if (frac) return BigInt(`${frac[1]}${frac[2] || "0"}`);
      // Bare hex (contains a–f, no `0x` prefix) → treat as hex.
      if (/^[0-9a-fA-F]+$/.test(s)) return BigInt(`0x${s}`);
    }
  }
  logRelayerDebug(`${method} unparseable ${field}`, value);
  throw new RelayerRpcError(method);
}

// ── Wire serializers ───────────────────────────────────────────────────
//
// Our `DelegationStruct` / `CaveatStruct` are already all-hex (no bigint),
// so they serialize straight to JSON. Executions carry a bigint `value`
// that must become a hex quantity string.

function serializeExecution(e: RelayerExecution) {
  return { target: e.target, value: toHexQuantity(e.value), data: e.data };
}

function serializeDelegation(d: DelegationStruct) {
  return {
    delegate: d.delegate,
    delegator: d.delegator,
    authority: d.authority,
    caveats: d.caveats.map((c) => ({
      enforcer: c.enforcer,
      terms: c.terms,
      args: c.args,
    })),
    salt: d.salt,
    signature: d.signature,
  };
}

function serializeBundle(t: RelayerBundleEntry) {
  return {
    permissionContext: t.permissionContext.map(serializeDelegation),
    executions: t.executions.map(serializeExecution),
  };
}

/** Shared `send` / `estimate` params object (estimate omits `context`). */
function buildBundleParams(
  chainId: number,
  transactions: RelayerBundleEntry[],
  authorizationList: RelayerAuthorizationEntry[] | undefined,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    chainId: String(chainId),
    transactions: transactions.map(serializeBundle),
    ...(authorizationList && authorizationList.length
      ? { authorizationList }
      : {}),
    ...extra,
  };
}

/**
 * Single JSON-RPC round-trip. Returns `result` on success; throws a
 * fixed-label error on transport failure or a JSON-RPC `error` payload.
 * The raw status / body is logged (dev-only), never thrown.
 */
async function relayerRpc<T>(
  url: string,
  method: string,
  params: unknown,
  fetchImpl: RelayerFetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
  } catch (err) {
    logRelayerDebug(`${method} transport error`, err);
    throw new RelayerRpcError(method);
  }

  if (!response.ok) {
    logRelayerDebug(`${method} http ${response.status}`, response.statusText);
    throw new RelayerRpcError(method);
  }

  let payload: { result?: T; error?: { message?: string; code?: number } };
  try {
    payload = await response.json();
  } catch (err) {
    logRelayerDebug(`${method} invalid json`, err);
    throw new RelayerRpcError(method);
  }

  if (payload.error) {
    logRelayerDebug(`${method} rpc error`, payload.error);
    throw new RelayerRpcError(
      method,
      typeof payload.error.code === "number" ? payload.error.code : undefined,
    );
  }

  if (payload.result === undefined) {
    logRelayerDebug(`${method} empty result`, payload);
    throw new RelayerRpcError(method);
  }

  return payload.result;
}

// ── relayer_getCapabilities ────────────────────────────────────────────

interface RawCapabilityToken {
  address: string;
  symbol?: string;
  decimals: string | number;
}
interface RawChainCapabilities {
  feeCollector: string;
  targetAddress: string;
  tokens: RawCapabilityToken[];
}

export interface RelayerGetCapabilitiesArgs {
  chainId: number;
  fetchImpl?: RelayerFetch;
}

/**
 * `relayer_getCapabilities` for a single chain. Resolves the redemption
 * `targetAddress` (SI-4) + `feeCollector` + accepted tokens.
 */
export async function relayerGetCapabilities({
  chainId,
  fetchImpl = fetch,
}: RelayerGetCapabilitiesArgs): Promise<RelayerCapabilities> {
  const result = await relayerRpc<Record<string, RawChainCapabilities>>(
    getRelayerEndpoint(chainId),
    "relayer_getCapabilities",
    [String(chainId)],
    fetchImpl,
  );

  const caps: RelayerCapabilities = {};
  // The relayer keys its result by stringified chain id.
  const networkData = result[String(chainId)] ?? result[chainId];
  if (networkData) {
    caps[chainId] = {
      targetAddress: networkData.targetAddress,
      feeCollector: networkData.feeCollector,
      tokens: (networkData.tokens ?? []).map((t) => ({
        address: t.address,
        symbol: t.symbol ?? "",
        decimals: Number(t.decimals),
      })),
    };
  }
  return caps;
}

// ── relayer_getFeeData ─────────────────────────────────────────────────

export interface RelayerGetFeeDataArgs {
  chainId: number;
  token: string;
  fetchImpl?: RelayerFetch;
}

interface RawFeeData {
  gasPrice: string | number;
  rate: number | string;
  minFee: string | number;
  expiry: number | string;
  context?: string;
  token?: { address?: string; decimals?: number | string; symbol?: string };
  tokenDecimals?: number | string;
}

/** Default payment-token decimals when the relayer omits them (USDC = 6). */
const DEFAULT_PAYMENT_DECIMALS = 6;

/**
 * Converts a relayer payment amount to **atoms**. The live API returns
 * `minFee` as a *decimal token amount* (e.g. `"0.01"` = 0.01 USDC), while
 * the documented schema implies atoms. We disambiguate by shape: a value
 * with a fractional part (`"0.01"`) is a whole-token amount and is scaled
 * by `10**decimals`; a bare integer (`"100000"`) is already atoms. Both
 * map `"0.01"` and `"10000"` (6dp) to the same `10000n`.
 */
export function parsePaymentTokenAtoms(
  method: string,
  field: string,
  value: unknown,
  decimals: number,
): bigint {
  if (typeof value === "string" && value.includes(".")) {
    const neg = value.trim().startsWith("-");
    const [rawWhole, rawFrac = ""] = value
      .trim()
      .replace(/^[+-]/, "")
      .split(".");
    const whole = rawWhole === "" ? "0" : rawWhole;
    const frac = rawFrac.slice(0, decimals).padEnd(decimals, "0");
    const atoms = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac || "0");
    return neg ? -atoms : atoms;
  }
  if (typeof value === "number" && !Number.isInteger(value)) {
    return parsePaymentTokenAtoms(method, field, value.toString(), decimals);
  }
  // Integer string / number / bigint → already in atoms.
  return parseRelayerBigInt(method, field, value);
}

/** `relayer_getFeeData` — rough pre-bundle quote. */
export async function relayerGetFeeData({
  chainId,
  token,
  fetchImpl = fetch,
}: RelayerGetFeeDataArgs): Promise<RelayerFeeData> {
  const result = await relayerRpc<RawFeeData>(
    getRelayerEndpoint(chainId),
    "relayer_getFeeData",
    { chainId: String(chainId), token },
    fetchImpl,
  );

  // Raw payload is dev-logged so unexpected wire shapes are diagnosable
  // without surfacing anything to users.
  logRelayerDebug("getFeeData raw", result);

  const tokenDecimals =
    result.token?.decimals !== undefined
      ? Number(result.token.decimals)
      : result.tokenDecimals !== undefined
        ? Number(result.tokenDecimals)
        : DEFAULT_PAYMENT_DECIMALS;

  return {
    gasPrice: parseRelayerBigInt(
      "relayer_getFeeData",
      "gasPrice",
      result.gasPrice,
    ),
    rate: Number(result.rate),
    minFee: parsePaymentTokenAtoms(
      "relayer_getFeeData",
      "minFee",
      result.minFee,
      tokenDecimals,
    ),
    tokenDecimals,
    expiry: Number(result.expiry),
    context: result.context ?? "",
  };
}

// ── relayer_estimate7710Transaction ────────────────────────────────────

export interface RelayerEstimateArgs {
  chainId: number;
  transactions: RelayerBundleEntry[];
  authorizationList?: RelayerAuthorizationEntry[];
  /** SI-1 ceiling override (atoms). Defaults to the USDC $5 bound. */
  feeSafetyMax?: bigint;
  fetchImpl?: RelayerFetch;
}

interface RawEstimateResult {
  success: boolean;
  requiredPaymentAmount?: string | number;
  paymentTokenAddress?: string;
  gasUsed?: Record<string, string>;
  context?: string;
  error?: string;
}

/**
 * `relayer_estimate7710Transaction`. Returns `{ success: false, error }`
 * for validation / simulation failures (the relayer reports these in the
 * result, not as a JSON-RPC error) so the price-lock loop can fix the
 * bundle and re-estimate. SI-1: an over-bound `requiredPaymentAmount` is
 * converted into a safety failure here, before any `send` can quote it.
 */
export async function relayerEstimate7710Transaction({
  chainId,
  transactions,
  authorizationList,
  feeSafetyMax,
  fetchImpl = fetch,
}: RelayerEstimateArgs): Promise<Estimate7710TransactionResult> {
  let result: RawEstimateResult;
  try {
    result = await relayerRpc<RawEstimateResult>(
      getRelayerEndpoint(chainId),
      "relayer_estimate7710Transaction",
      buildBundleParams(chainId, transactions, authorizationList, {}),
      fetchImpl,
    );
  } catch (err) {
    // Transport / JSON-RPC failure — surface as a soft failure so the
    // caller's loop can decide, mirroring the result-level error path.
    logRelayerDebug("estimate transport error", err);
    return { success: false, error: "estimate failed" };
  }

  if (!result.success) {
    return { success: false, error: result.error ?? "simulation failed" };
  }

  const requiredPaymentAmount =
    result.requiredPaymentAmount !== undefined
      ? parseRelayerBigInt(
          "relayer_estimate7710Transaction",
          "requiredPaymentAmount",
          result.requiredPaymentAmount,
        )
      : undefined;

  if (requiredPaymentAmount !== undefined) {
    try {
      assertFeeWithinSafetyBound(requiredPaymentAmount, feeSafetyMax);
    } catch {
      logRelayerDebug("estimate fee over safety bound", {
        requiredPaymentAmount: requiredPaymentAmount.toString(),
      });
      return { success: false, error: "fee exceeds safety bound" };
    }
  }

  return {
    success: true,
    requiredPaymentAmount,
    paymentTokenAddress: result.paymentTokenAddress,
    gasUsed: result.gasUsed,
    context: result.context,
  };
}

// ── relayer_send7710Transaction ────────────────────────────────────────

export interface RelayerSendArgs {
  chainId: number;
  transactions: RelayerBundleEntry[];
  context: string;
  authorizationList?: RelayerAuthorizationEntry[];
  destinationUrl?: string;
  memo?: string;
  fetchImpl?: RelayerFetch;
}

/** `relayer_send7710Transaction`. Returns the assigned `taskId`. */
export async function relayerSend7710Transaction({
  chainId,
  transactions,
  context,
  authorizationList,
  destinationUrl,
  memo,
  fetchImpl = fetch,
}: RelayerSendArgs): Promise<Send7710TransactionResult> {
  // The relayer returns the task id directly as the JSON-RPC result.
  const taskId = await relayerRpc<string>(
    getRelayerEndpoint(chainId),
    "relayer_send7710Transaction",
    buildBundleParams(chainId, transactions, authorizationList, {
      context,
      ...(destinationUrl ? { destinationUrl } : {}),
      ...(memo ? { memo } : {}),
    }),
    fetchImpl,
  );

  return { taskId };
}

// ── relayer_getStatus ──────────────────────────────────────────────────

export interface RelayerGetStatusArgs {
  chainId: number;
  taskId: string;
  fetchImpl?: RelayerFetch;
}

interface RawStatus {
  status: number;
  hash?: string;
  receipt?: { transactionHash?: string };
  message?: string;
  data?: unknown;
  memo?: string;
}

/** Maps the relayer's numeric status code to the friendly label. */
function mapStatusCode(code: number): RelayerStatus["status"] {
  switch (code) {
    case 200:
      return "success";
    case 400:
    case 500:
      return "failed";
    case 110:
      return "submitted";
    default:
      // 100 Pending, plus any unknown code — keep polling.
      return "pending";
  }
}

/** `relayer_getStatus` — single status read for a submitted task. */
export async function relayerGetStatus({
  chainId,
  taskId,
  fetchImpl = fetch,
}: RelayerGetStatusArgs): Promise<RelayerStatus> {
  const result = await relayerRpc<RawStatus>(
    getRelayerEndpoint(chainId),
    "relayer_getStatus",
    { id: taskId, logs: false },
    fetchImpl,
  );

  return {
    status: mapStatusCode(result.status),
    statusCode: result.status,
    transactionHash: result.receipt?.transactionHash ?? result.hash,
    memo: result.memo,
  };
}
