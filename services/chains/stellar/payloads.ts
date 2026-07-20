/**
 * Stellar dApp bridge approval payloads + structural types.
 * Per `docs/stellar-dapp-bridge-spec.md` §6.
 *
 * Contract goals:
 *   - Mirrors `services/chains/sui/payloads.ts`'s role for the Stellar
 *     namespace — every adapter / inspector / sheet imports from this
 *     module rather than re-declaring shapes.
 *   - JSON-safe by convention: stroop amounts, fee, and sequence are
 *     strings (bigint-unsafe JSON otherwise, spec §6).
 *   - `xdr` (the raw base64 envelope) is always the signing source of
 *     truth; `decoded` is a display-only structural view populated by
 *     `StellarXdrDecoderInspector` (§8.1) — never hand-built by the
 *     adapter (§11 signature-vs-display invariant).
 */

export type StellarNetwork = "mainnet" | "testnet";
export type StellarChain = "stellar:mainnet" | "stellar:testnet";

export type StellarConnectPayload = {
  network: StellarNetwork;
  /**
   * `SET_ALLOWED_STATUS` (Freighter's `setAllowed()`) routes through the
   * same `connect` intent/sheet as `REQUEST_ACCESS` (§4.1) — this
   * discriminator is internal-only (never part of the wire response) so
   * `executeApproval` can return `{ isAllowed: true }` instead of
   * `{ publicKey }` for that wire method without threading the original
   * `EXTERNAL_SERVICE_TYPES` name through the whole approval pipeline.
   */
  viaSetAllowedStatus?: boolean;
};

/** Structural view of one decoded operation — populated by
 *  StellarXdrDecoderInspector (§8.1), never hand-built by the adapter. */
export type StellarDecodedOperation =
  | {
      kind: "payment";
      destination: string;
      asset: string /* "native" | "CODE:ISSUER" */;
      amount: string;
    }
  | { kind: "createAccount"; destination: string; startingBalance: string }
  | { kind: "changeTrust"; asset: string; limit: string }
  | {
      kind: "pathPaymentStrictSend" | "pathPaymentStrictReceive";
      destination: string;
      sendAsset: string;
      destAsset: string;
    }
  | {
      kind: "manageSellOffer" | "manageBuyOffer";
      selling: string;
      buying: string;
    }
  | { kind: "accountMerge"; destination: string }
  | {
      // Soroban invocation. Structural fields added by task 65
      // (TWV-2026-066) so Stage-2 can resolve the on-chain contract
      // spec; all optional — non-invokeContract host functions (upload
      // WASM, create contract) still decode to the bare tag.
      kind: "invokeHostFunction";
      contractId?: string;
      function?: string;
      /** base64 `ScVal` per invocation argument, order preserved. */
      argsXdr?: string[];
    }
  | { kind: "other"; type: string };

export type StellarSignTransactionPayload = {
  address: string;
  networkPassphrase: string;
  /** Raw XDR envelope (base64) exactly as the dApp supplied it — primary
   *  source of truth; `executeApproval` re-parses this, never the
   *  decoded view, for the actual signature (defense against a
   *  decoder/inspector bug silently signing something different from
   *  what was displayed). */
  xdr: string;
  /** SEP-0043 optional fields (§1.1, §1.8) — sign-only when absent/false. */
  submit?: boolean;
  submitUrl?: string;
  /** Populated by StellarXdrDecoderInspector (§8.1). */
  decoded?: StellarDecodedOperation[];
  sourceAccount?: string;
  fee?: string; // stroops, string (bigint-unsafe JSON otherwise)
  sequence?: string;
  memo?: { type: "none" | "text" | "id" | "hash" | "return"; value?: string };
  /** Populated by StellarPreflightInspector (§8.2). */
  preflight?: {
    destinationExists?: boolean;
    destinationHasTrustline?: boolean; // only meaningful when the sole/primary op is a non-native payment
  };
};

export type StellarSignMessagePayload = {
  address: string;
  message: string;
  networkPassphrase?: string;
};

export type StellarApprovalPayload =
  | ({ kind: "connect" } & StellarConnectPayload)
  | ({ kind: "signTransaction" } & StellarSignTransactionPayload)
  | ({ kind: "signMessage" } & StellarSignMessagePayload);

// ── Helpers ────────────────────────────────────────────────────────────

const ALL_NETWORKS: ReadonlySet<StellarNetwork> = new Set<StellarNetwork>([
  "mainnet",
  "testnet",
]);

export function isStellarNetwork(value: unknown): value is StellarNetwork {
  return typeof value === "string" && ALL_NETWORKS.has(value as StellarNetwork);
}

export function networkToChain(net: StellarNetwork): StellarChain {
  return `stellar:${net}`;
}

export function chainToNetwork(chain: string): StellarNetwork | null {
  if (!chain.startsWith("stellar:")) return null;
  const ref = chain.slice("stellar:".length);
  return isStellarNetwork(ref) ? ref : null;
}
