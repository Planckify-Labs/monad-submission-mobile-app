export class ProviderRpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ProviderRpcError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export const PROVIDER_ERRORS = {
  userRejected: () => new ProviderRpcError(4001, "User rejected the request"),
  unauthorized: () => new ProviderRpcError(4100, "Unauthorized"),
  unsupportedMethod: (m: string) =>
    new ProviderRpcError(4200, `Method ${m} not supported`),
  disconnected: () => new ProviderRpcError(4900, "Disconnected"),
  chainNotConnected: () => new ProviderRpcError(4901, "Chain not connected"),
  chainNotAdded: (id: number) =>
    new ProviderRpcError(4902, `Chain ${id} not added`),
  resourceUnavailable: () =>
    new ProviderRpcError(-32002, "Resource unavailable"),
  invalidParams: (detail: string) =>
    new ProviderRpcError(-32602, `Invalid params: ${detail}`),
  internalError: (detail: string) =>
    new ProviderRpcError(-32603, `Internal error: ${detail}`),

  // ── EIP-5792 ────────────────────────────────────────────────────────
  //
  // The finalized EIP defines its own code range, and using -32602 for
  // all of it is not a cosmetic slip. A dApp reads these codes to decide
  // what to do next: 5760 means "ask again without atomicRequired", 5700
  // means "drop the capability", 5710 means "switch chain first". All of
  // them arriving as "Invalid params" tells the dApp its request was
  // malformed, so the only recovery it can attempt is the one that
  // cannot work. That is why the EIP-5792 section of the test dapp reads
  // as a flat failure against us.
  //
  // Codes verified against `eips.ethereum.org/EIPS/eip-5792` directly.
  /** Wallet lacks a capability the request marked non-optional. */
  unsupportedCapability: (name: string) =>
    new ProviderRpcError(5700, `Unsupported non-optional capability: ${name}`),
  /** Wallet does not support the requested chain. */
  unsupportedChainId: (id: number) =>
    new ProviderRpcError(5710, `Unsupported chain id: ${id}`),
  /** A bundle with this identifier already exists. */
  duplicateBundleId: (id: string) =>
    new ProviderRpcError(5720, `Duplicate bundle id: ${id}`),
  /** The bundle identifier is unrecognised. */
  unknownBundleId: (id: string) =>
    new ProviderRpcError(5730, `Unknown bundle id: ${id}`),
  /** The batch exceeds what this wallet will process. */
  bundleTooLarge: () =>
    new ProviderRpcError(5740, "Bundle too large for the wallet to process"),
  /**
   * `atomicRequired: true` on a wallet that cannot execute atomically.
   *
   * Distinct from 5750 ("atomic-ready wallet rejected upgrade", which is
   * a *user* declining a 7702 upgrade): 5760 says the wallet as
   * configured cannot do it at all, so retrying the upgrade prompt is
   * pointless and the dApp should re-request without atomicity.
   */
  atomicityNotSupported: () =>
    new ProviderRpcError(5760, "Wallet cannot execute this batch atomically"),
} as const;

export function toRpcErrorPayload(e: unknown): {
  code: number;
  message: string;
  data?: unknown;
} {
  if (e instanceof ProviderRpcError) {
    return { code: e.code, message: e.message, data: e.data };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { code: -32603, message: msg };
}
