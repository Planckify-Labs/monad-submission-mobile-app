/**
 * Minimal Horizon REST client — plain `fetch()` against documented
 * endpoints, no `@stellar/stellar-sdk` dependency (spec §3.1, resolved
 * decision 5). `fetch()` is already global under Hermes/RN; Horizon is
 * a JSON-over-HTTP REST API, so no special HTTP client is required for
 * the v1 read/submit surface this kit needs.
 *
 * Spec reference: `docs/stellar-chain-support-spec.md` §3.6.
 */

import {
  type FeeBumpTransaction,
  Networks,
  type Transaction,
} from "@stellar/stellar-base";
import type {
  ChainConfig,
  StellarChainConfig,
} from "@/constants/configs/chainConfig";
import {
  assertStellarChain,
  getStellarMainnetChain,
} from "@/constants/configs/chainConfig";
import { proxyAuthHeaders } from "@/services/rpc/proxyAuth";
import { bytesToBase64 } from "./base64";

/**
 * Serializes a signed `Transaction` to a base64 XDR string WITHOUT
 * going through `tx.toXDR()` (which internally does the buggy
 * `Buffer`-based `.toString("base64")` above). `tx.toEnvelope()` is
 * the SDK's own public accessor for the raw XDR struct; calling
 * `.toXDR("raw")` on it returns the raw byte buffer untouched
 * (`@stellar/js-xdr`'s `encodeResult` returns the buffer as-is for
 * the `"raw"` format, with no `.toString()` call at all) — we then
 * base64-encode those bytes ourselves via `bytesToBase64`.
 */
export function transactionToBase64Xdr(
  tx: Transaction | FeeBumpTransaction,
): string {
  const envelope = tx.toEnvelope() as unknown as {
    toXDR(format: "raw"): Uint8Array;
  };
  return bytesToBase64(envelope.toXDR("raw"));
}

/**
 * Resolves a `StellarChainConfig` from a raw network passphrase string —
 * the reverse direction of `getHorizonClient`'s own `networkPassphrase`
 * getter. Used by the dApp-bridge's submit path
 * (`docs/stellar-dapp-bridge-spec.md` §1.8) and `StellarPreflightInspector`
 * (§8.2), both of which only have a `networkPassphrase` string on the
 * approval payload, not a full `ChainConfig`.
 *
 * Mainnet comes from the app's static `supportedChains` entry
 * (`getStellarMainnetChain`); testnet has no static entry (it only
 * arrives via the backend `/blockchains` feed) so this falls back to the
 * well-known public testnet Horizon endpoint — same "hardcode a public
 * per-network endpoint for the bridge signer" posture
 * `installSolanaSigner`'s `getRpcForCluster` closure already uses.
 */
export function resolveStellarChainConfigForPassphrase(
  networkPassphrase: string,
): StellarChainConfig {
  if (networkPassphrase === Networks.TESTNET) {
    return {
      namespace: "stellar",
      network: "testnet",
      horizonUrl: "https://horizon-testnet.stellar.org",
      isTestnet: true,
    };
  }
  return getStellarMainnetChain();
}

/** A single row of `HorizonAccount.balances`. */
export interface HorizonBalance {
  asset_type:
    | "native"
    | "credit_alphanum4"
    | "credit_alphanum12"
    | "liquidity_pool_shares";
  balance: string;
  asset_code?: string;
  asset_issuer?: string;
  limit?: string;
}

/** The subset of Horizon's `/accounts/{id}` response this kit reads. */
export interface HorizonAccount {
  account_id: string;
  sequence: string;
  subentry_count: number;
  balances: HorizonBalance[];
}

/**
 * Structured Horizon failure — the thrown `Error.message` is a short
 * fixed string (CLAUDE.md user-facing-errors rule: never embed raw
 * server text in `Error.message`); `resultCodes` carries the curated
 * signal (`tx_bad_seq`, `op_no_trust`, `op_low_reserve`, …) that
 * `transferService.ts` / `assetTransferService.ts` classify into typed
 * errors from `errorCodes.ts`.
 */
export class HorizonRequestError extends Error {
  override readonly name = "HorizonRequestError";
  readonly status: number;
  readonly resultCodes?: { transaction?: string; operations?: string[] };
  /**
   * Full parsed Horizon error body (e.g. `title`/`detail`/`extras` for
   * a `transaction_malformed` rejection, which carries no
   * `result_codes` at all — that shape only appears on
   * `transaction_failed`). __DEV__-diagnostic only: a structured
   * property, never folded into `.message` or shown to end users
   * (CLAUDE.md user-facing-errors rule).
   */
  readonly body?: unknown;
  constructor(
    status: number,
    resultCodes?: { transaction?: string; operations?: string[] },
    body?: unknown,
  ) {
    super(`Horizon request failed with status ${status}`);
    this.status = status;
    this.resultCodes = resultCodes;
    this.body = body;
  }
}

/** `true` iff `err` is a Horizon 404 (resource — usually an account — not found). */
export function isHorizonNotFound(err: unknown): boolean {
  return err instanceof HorizonRequestError && err.status === 404;
}

export interface StellarHorizonClient {
  horizonUrl: string;
  networkPassphrase: string;
  loadAccount(address: string): Promise<HorizonAccount>;
  submitTransaction(
    tx: Transaction | FeeBumpTransaction,
  ): Promise<{ hash: string }>;
}

/**
 * Builds a Horizon client bound to `chain`'s `horizonUrl` + network
 * passphrase. Network passphrase is read from `@stellar/stellar-base`'s
 * `Networks` constants rather than hard-coded strings, so a passphrase
 * typo can't silently produce transactions that sign for the wrong
 * network (spec §1.1, §1.4).
 */
export function getHorizonClient(
  chainConfig: ChainConfig,
): StellarHorizonClient {
  const chain = assertStellarChain(chainConfig);
  const { horizonUrl } = chain;

  return {
    horizonUrl,
    get networkPassphrase() {
      return chain.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
    },
    async loadAccount(address: string): Promise<HorizonAccount> {
      const res = await fetch(`${horizonUrl}/accounts/${address}`, {
        headers: proxyAuthHeaders(horizonUrl),
      });
      if (!res.ok) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          // Non-JSON error body — leave `body` undefined.
        }
        throw new HorizonRequestError(res.status, undefined, body);
      }
      return (await res.json()) as HorizonAccount;
    },
    async submitTransaction(
      tx: Transaction | FeeBumpTransaction,
    ): Promise<{ hash: string }> {
      const xdr = transactionToBase64Xdr(tx);
      // `URLSearchParams` (not manual `tx=${encodeURIComponent(xdr)}`
      // templating) — the standard, battle-tested way to build a
      // form-encoded body under RN's `fetch`; also sets the right
      // `Content-Length` semantics implicitly.
      const res = await fetch(`${horizonUrl}/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...proxyAuthHeaders(horizonUrl),
        },
        body: new URLSearchParams({ tx: xdr }).toString(),
      });
      const json = (await res.json()) as {
        hash?: string;
        title?: string;
        detail?: string;
        extras?: {
          result_codes?: { transaction?: string; operations?: string[] };
          invalid_field?: string;
          reason?: string;
        };
      };
      if (!res.ok) {
        throw new HorizonRequestError(res.status, json.extras?.result_codes, {
          ...json,
          // `xdr.length` (not the XDR itself) — enough to sanity-check
          // "did we even send a non-empty envelope" in dev logs without
          // dumping the full base64 payload.
          submittedXdrLength: xdr.length,
        });
      }
      return { hash: json.hash ?? "" };
    },
  };
}
