/**
 * `StellarWalletKit` — binds the Stellar primitives (Tasks 03–07) behind
 * the `WalletKitAdapter` interface (Task 08) so screens, onboarding
 * sheets, and the agent executors all dispatch through one seam.
 *
 * Spec reference: `docs/stellar-chain-support-spec.md` §4 (kit factory
 * shape).
 *
 * Rules (non-negotiable — enforced by review, mirrors SuiWalletKit):
 *   - No signing path outside `services/walletService.ts`. Every method
 *     that needs a keypair calls `getStellarSignerForWallet` — it does
 *     not reconstruct a `Keypair` itself (TWV-2026-090).
 *   - Narrow on namespace at every entry via `assertStellar` (or return
 *     `null` for the display hooks); never `as any`.
 *   - Decimals reminder (spec §3.8): XLM AND every Stellar asset —
 *     including USDC/EURC — is 7-decimal fixed point. This is a
 *     Stellar-wide invariant, not a per-asset metadata field the way
 *     EVM/Solana/Sui `decimals` is.
 */

import { validateMnemonic } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english";
import type { Keypair } from "@stellar/stellar-base";
import { Networks } from "@stellar/stellar-base";

import type { ChainConfig } from "@/constants/configs/chainConfig";
import { assertStellarChain } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import {
  createStellarWalletFromMnemonic,
  createStellarWalletFromPrivateKey,
  isValidStellarAddress,
  isValidStellarSecretKey,
  truncateAddress as truncateAddressUtil,
} from "@/utils/walletUtils";
import {
  computeMinBalanceStroops,
  detectAccountFunded,
  NEW_ACCOUNT_MIN_BALANCE_STROOPS,
  STELLAR_FEE_RESERVE_STROOPS,
} from "../../chains/stellar/accountState";
import {
  buildAndSendStellarAssetTransfer,
  getStellarAssetBalance,
} from "../../chains/stellar/assetTransferService";
import { bytesToBase64 } from "../../chains/stellar/base64";
import {
  getHorizonClient,
  isHorizonNotFound,
} from "../../chains/stellar/horizonClient";
import { sep53Digest } from "../../chains/stellar/sep53";
import { invokeSorobanContract } from "../../chains/stellar/sorobanInvoke";
import { getSorobanRpcClient } from "../../chains/stellar/sorobanRpcClient";
import {
  buildAndSendStellarNativeTransfer,
  getStellarNativeBalance,
} from "../../chains/stellar/transferService";
import {
  ensureTrustline,
  hasTrustline,
} from "../../chains/stellar/trustlineService";
import { breadcrumb, captureException } from "../../telemetry/stellar";
import {
  generateWalletMnemonic,
  getStellarSignerForWallet,
} from "../../walletService";
import type {
  CheckAssetReceivableArgs,
  CheckAssetReceivableResult,
  CreateWalletFromMnemonicParams,
  CreateWalletFromPrivateKeyParams,
  EstablishTrustlineArgs,
  EstablishTrustlineResult,
  EstimateMaxTransferableArgs,
  NativeTransferArgs,
  SendSorobanTransactionArgs,
  TokenTransferArgs,
  TruncateAddressOptions,
  WalletKitAdapter,
} from "../types";
import {
  stellarCaip2For,
  stellarCheckBridgeDestinationReadiness,
  stellarFromAssetCaip19,
  stellarSubmitBridgeExecution,
  stellarToAssetCaip19,
} from "./bridge";
import {
  computeStellarSigningDigest,
  fetchSorobanContractWasm,
  resolveStellarClearSigningDescriptor,
} from "./clearSigning";
import { buildStellarPaymentRequest } from "./paymentRequest";
import {
  stellarWalletConnectCodec,
  stellarWalletConnectNamespace,
} from "./walletConnect";

const STELLAR_NAMESPACE = "stellar" as const;

/** 1 XLM = 10,000,000 stroops (spec §1.3, §3.8). */
const STROOPS_PER_XLM = 10_000_000;

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Local `asserts`-style narrower — mirrors `SuiWalletKit.ts#assertSui`.
 */
function assertStellar(
  chain: ChainConfig,
): asserts chain is Extract<ChainConfig, { namespace: "stellar" }> {
  if (chain.namespace !== STELLAR_NAMESPACE) {
    throw new Error(
      `assertStellarChain: expected Stellar chain, got namespace=${chain.namespace}`,
    );
  }
}

/**
 * Splits the compound `"{CODE}:{ISSUER}"` `contractAddress` string
 * (spec §3.7 — the existing `contractAddress` token column repurposed
 * for Stellar's `(code, issuer)` asset identity) into its parts.
 */
function parseCompoundAssetId(contractAddress: string): {
  code: string;
  issuer: string;
} {
  const idx = contractAddress.indexOf(":");
  if (idx <= 0 || idx === contractAddress.length - 1) {
    throw new Error(
      `StellarWalletKit: malformed compound asset id "${contractAddress}" (expected "CODE:ISSUER")`,
    );
  }
  return {
    code: contractAddress.slice(0, idx),
    issuer: contractAddress.slice(idx + 1),
  };
}

export function createStellarWalletKit(): WalletKitAdapter {
  return {
    namespace: STELLAR_NAMESPACE,
    supportsTokenTransfer: true,
    supportsPrivateKeyImport: true,
    // Soroban `deposit_points` — `services/nanopay/pathPointDepositStellar.ts`.
    supportsPointDeposit: true,
    displayName: "Stellar",
    requireBiometricForConnect: true,
    // Deep-link spec §4.5 — SEP-0007 `pay` builder + WalletConnect
    // `stellar` namespace / codec.
    buildPaymentRequest: buildStellarPaymentRequest,
    walletConnectNamespace: stellarWalletConnectNamespace,
    walletConnectCodec: stellarWalletConnectCodec,

    getChainId(chain) {
      return chain.namespace === STELLAR_NAMESPACE ? chain.network : null;
    },
    formatChainLabel(chain) {
      if (chain.namespace !== STELLAR_NAMESPACE) return null;
      return `Stellar ${capitalize(chain.network)}`;
    },
    nativeSymbol(chain) {
      return chain.namespace === STELLAR_NAMESPACE ? "XLM" : null;
    },
    getAuthChainSlug(chain) {
      if (chain.namespace !== STELLAR_NAMESPACE) return null;
      return chain.network === "testnet"
        ? "stellar-testnet"
        : "stellar-mainnet";
    },
    defaultAuthChainSlug: "stellar-mainnet",
    matchesBlockchainRow(chain, row) {
      if (chain.namespace !== STELLAR_NAMESPACE || row.isEVM) return false;
      if (row.isTestnet !== (chain.network !== "mainnet")) return false;
      if (typeof row.chainSlug === "string") {
        return row.chainSlug.startsWith("stellar-");
      }
      const name = (row.name ?? "").toLowerCase();
      const rpc = (row.rpcUrl ?? "").toLowerCase();
      return name.startsWith("stellar") || rpc.includes("stellar.org");
    },
    buildTxExplorerUrl(hash, chain) {
      if (chain.namespace !== STELLAR_NAMESPACE || !hash) return null;
      // StellarExpert — the de facto standard explorer (spec §11
      // resolved decision 3). Note the URL segment is "public", not
      // "mainnet".
      const net = chain.network === "mainnet" ? "public" : "testnet";
      return `https://stellar.expert/explorer/${net}/tx/${hash}`;
    },

    // base32 StrKey is case-SIGNIFICANT (canonically uppercase) — never fold.
    canonicalizeAddress: (address: string): string => address,

    // ── Wallet creation & validation ────────────────────────────────
    validateAddress: (address: string): boolean =>
      isValidStellarAddress(address),
    validatePrivateKey: (privateKey: string): boolean =>
      isValidStellarSecretKey(privateKey),
    validateMnemonic: (mnemonic: string): boolean =>
      validateMnemonic(mnemonic.trim(), englishWordlist),

    async createWalletFromPrivateKey(
      params: CreateWalletFromPrivateKeyParams,
    ): Promise<TWallet> {
      const wallet = await createStellarWalletFromPrivateKey(
        params.privateKey,
        params.name,
      );
      if (!wallet) {
        throw new Error(
          "StellarWalletKit: invalid Stellar secret key (expected StrKey S…)",
        );
      }
      return wallet;
    },

    async createWalletFromMnemonic(
      params: CreateWalletFromMnemonicParams,
    ): Promise<TWallet> {
      const wallet = await createStellarWalletFromMnemonic(
        params.mnemonic,
        params.name,
      );
      if (!wallet) {
        throw new Error(
          "StellarWalletKit: invalid BIP-39 mnemonic or SLIP-0010 derivation failure",
        );
      }
      return wallet;
    },

    generateMnemonic: (): string => generateWalletMnemonic(),

    // ── Keys & signers (TWV-2026-090 dwell site) ────────────────────
    async getSignerForWallet(wallet: TWallet): Promise<unknown | null> {
      return getStellarSignerForWallet(wallet);
    },

    // ── Auth — SEP-53 message signing ───────────────────────────────
    // Stellar's Keypair.sign/verify are raw ed25519 with no built-in
    // framing (unlike Sui's messageWithIntent). Rather than sign the raw
    // UTF-8 bytes, we apply SEP-53: sign over
    // `SHA-256("Stellar Signed Message:\n" ‖ message)`. That prefix
    // domain-separates this login signature from a transaction signature
    // so an auth message can never collide with a transaction preimage.
    // Mirrors the server verifier (api/src/auth/siws-stellar/sep53.ts).
    async signAuthMessage(wallet: TWallet, message: string): Promise<string> {
      const kp: Keypair | null = await getStellarSignerForWallet(wallet);
      if (!kp) {
        throw new Error(
          "StellarWalletKit.signAuthMessage: no signer available",
        );
      }
      // `bytesToBase64` (btoa-based), NOT `signature.toString("base64")`
      // — the ambient global `Buffer` this SDK's signing path relies on
      // does not correctly implement `.toString("base64")` under this
      // app's Hermes runtime (confirmed via the same bug that broke
      // transaction submission — see `horizonClient.ts`'s
      // `transactionToBase64Xdr`).
      const signature = kp.sign(sep53Digest(message));
      return bytesToBase64(signature);
    },

    // ── Reads ───────────────────────────────────────────────────────
    async getNativeBalance(
      address: string,
      chain: ChainConfig,
    ): Promise<bigint> {
      assertStellar(chain);
      const horizon = getHorizonClient(chain);
      return getStellarNativeBalance(horizon, address);
    },

    async getTokenBalance(
      address: string,
      chain: ChainConfig,
      contractAddress: string,
    ): Promise<bigint> {
      assertStellar(chain);
      const horizon = getHorizonClient(chain);
      const { code, issuer } = parseCompoundAssetId(contractAddress);
      return getStellarAssetBalance(horizon, address, code, issuer);
    },

    // ── Writes ──────────────────────────────────────────────────────
    async sendNativeTransfer({
      wallet,
      to,
      amount,
      chain,
    }: NativeTransferArgs): Promise<string> {
      assertStellar(chain);
      breadcrumb({
        category: "stellar.sendNativeTransfer",
        message: "start",
        level: "info",
        data: { network: chain.network },
      });
      const signer: Keypair | null = await getStellarSignerForWallet(wallet);
      if (!signer) {
        breadcrumb({
          category: "stellar.sendNativeTransfer",
          message: "failure: no signer",
          level: "error",
          data: { network: chain.network },
        });
        throw new Error("No Stellar signer for wallet");
      }
      const horizon = getHorizonClient(chain);
      try {
        const hash = await buildAndSendStellarNativeTransfer({
          horizon,
          signer,
          to,
          stroops: amount,
        });
        breadcrumb({
          category: "stellar.sendNativeTransfer",
          message: "success",
          level: "info",
          data: { network: chain.network },
        });
        return hash;
      } catch (err) {
        breadcrumb({
          category: "stellar.sendNativeTransfer",
          message: "failure",
          level: "error",
          data: {
            network: chain.network,
            errorName: err instanceof Error ? err.name : typeof err,
          },
        });
        captureException(err, {
          name: "stellar.sendNativeTransfer",
          payload: {
            errorName: err instanceof Error ? err.name : typeof err,
            network: chain.network,
          },
        });
        throw err;
      }
    },

    async sendTokenTransfer({
      wallet,
      to,
      amount,
      chain,
      contractAddress,
      // `decimals` is intentionally unused — every Stellar asset is a
      // fixed 7 decimals (spec §3.8); there is no per-token decimals
      // hint the way EVM/Solana/Sui `decimals` is. Kept on the args
      // type for cross-namespace call-site parity.
    }: TokenTransferArgs): Promise<string> {
      assertStellar(chain);
      breadcrumb({
        category: "stellar.sendTokenTransfer",
        message: "start",
        level: "info",
        data: { network: chain.network },
      });
      const signer: Keypair | null = await getStellarSignerForWallet(wallet);
      if (!signer) {
        breadcrumb({
          category: "stellar.sendTokenTransfer",
          message: "failure: no signer",
          level: "error",
          data: { network: chain.network },
        });
        throw new Error("No Stellar signer for wallet");
      }
      const horizon = getHorizonClient(chain);
      const { code, issuer } = parseCompoundAssetId(contractAddress);
      try {
        const hash = await buildAndSendStellarAssetTransfer({
          horizon,
          signer,
          to,
          code,
          issuer,
          amount,
        });
        breadcrumb({
          category: "stellar.sendTokenTransfer",
          message: "success",
          level: "info",
          data: { network: chain.network },
        });
        return hash;
      } catch (err) {
        breadcrumb({
          category: "stellar.sendTokenTransfer",
          message: "failure",
          level: "error",
          data: {
            network: chain.network,
            errorName: err instanceof Error ? err.name : typeof err,
          },
        });
        captureException(err, {
          name: "stellar.sendTokenTransfer",
          payload: {
            errorName: err instanceof Error ? err.name : typeof err,
            network: chain.network,
          },
        });
        throw err;
      }
    },

    // ── Soroban contract invocation (onchain settlement rail) ────────
    // The only Soroban-touching method on this kit — v1 classic ops
    // (transfers/trustlines) stay Horizon-only. Docks the generic
    // `invokeSorobanContract` flow behind the `WalletKitAdapter` so the
    // pay-merchant screen dispatches on capability, never namespace. Signing
    // stays inside `getStellarSignerForWallet` (TWV-2026-090).
    async sendSorobanTransaction({
      wallet,
      chain,
      contractId,
      method,
      args,
    }: SendSorobanTransactionArgs): Promise<string> {
      assertStellar(chain);
      breadcrumb({
        category: "stellar.sendSorobanTransaction",
        message: "start",
        level: "info",
        data: { network: chain.network, method },
      });
      const signer: Keypair | null = await getStellarSignerForWallet(wallet);
      if (!signer) {
        breadcrumb({
          category: "stellar.sendSorobanTransaction",
          message: "failure: no signer",
          level: "error",
          data: { network: chain.network, method },
        });
        throw new Error("No Stellar signer for wallet");
      }
      try {
        const hash = await invokeSorobanContract({
          rpc: getSorobanRpcClient(chain),
          horizon: getHorizonClient(chain),
          signer,
          contractId,
          method,
          args,
        });
        breadcrumb({
          category: "stellar.sendSorobanTransaction",
          message: "success",
          level: "info",
          data: { network: chain.network, method },
        });
        return hash;
      } catch (err) {
        breadcrumb({
          category: "stellar.sendSorobanTransaction",
          message: "failure",
          level: "error",
          data: {
            network: chain.network,
            method,
            errorName: err instanceof Error ? err.name : typeof err,
          },
        });
        captureException(err, {
          name: "stellar.sendSorobanTransaction",
          payload: {
            errorName: err instanceof Error ? err.name : typeof err,
            network: chain.network,
            method,
          },
        });
        throw err;
      }
    },

    // ── Pre-flight receivability (spec §4.1/§8.2) ────────────────────
    // The one Stellar-specific send-side check: a non-native asset
    // cannot be delivered to a destination that hasn't opted in (or
    // doesn't exist yet). Surfacing this BEFORE submission lets the
    // sender see "recipient hasn't set up this asset yet" instead of a
    // post-hoc Horizon failure.
    async checkAssetReceivable({
      chain,
      to,
      contractAddress,
    }: CheckAssetReceivableArgs): Promise<CheckAssetReceivableResult> {
      assertStellar(chain);
      const horizon = getHorizonClient(chain);
      const funded = await detectAccountFunded(horizon, to);
      if (!funded) {
        return {
          ok: false,
          reason:
            "This address hasn't received any XLM yet — it needs to be funded before it can hold other assets.",
        };
      }
      const { code, issuer } = parseCompoundAssetId(contractAddress);
      const trusts = await hasTrustline(horizon, to, code, issuer);
      if (!trusts) {
        return {
          ok: false,
          reason: `The recipient hasn't set up ${code} yet — ask them to add a trustline for it first.`,
        };
      }
      return { ok: true };
    },

    // ── Receive-side self-service trustline (spec §4.1/§8.3) ─────────
    async hasTrustline({
      chain,
      to: address,
      contractAddress,
    }: CheckAssetReceivableArgs): Promise<boolean> {
      assertStellar(chain);
      const horizon = getHorizonClient(chain);
      const { code, issuer } = parseCompoundAssetId(contractAddress);
      return hasTrustline(horizon, address, code, issuer);
    },

    async establishTrustline({
      wallet,
      chain,
      contractAddress,
    }: EstablishTrustlineArgs): Promise<EstablishTrustlineResult> {
      assertStellar(chain);
      const signer = await getStellarSignerForWallet(wallet);
      if (!signer) {
        throw new Error("No Stellar signer for wallet");
      }
      const horizon = getHorizonClient(chain);
      const { code, issuer } = parseCompoundAssetId(contractAddress);
      return ensureTrustline({ horizon, signer, code, issuer });
    },

    async estimateMaxTransferable({
      balance,
      chain,
      from,
    }: EstimateMaxTransferableArgs): Promise<bigint> {
      assertStellar(chain);
      const horizon = getHorizonClient(chain);
      let reserve: bigint;
      try {
        const account = await horizon.loadAccount(from);
        reserve =
          computeMinBalanceStroops(account) + STELLAR_FEE_RESERVE_STROOPS;
      } catch (e) {
        if (isHorizonNotFound(e)) {
          reserve =
            NEW_ACCOUNT_MIN_BALANCE_STROOPS + STELLAR_FEE_RESERVE_STROOPS;
        } else {
          throw e;
        }
      }
      return balance > reserve ? balance - reserve : 0n;
    },

    // ── Display ─────────────────────────────────────────────────────
    formatNativeAmount(raw: bigint, chain: ChainConfig): string {
      assertStellar(chain);
      return `${(Number(raw) / STROOPS_PER_XLM).toFixed(4)} XLM`;
    },
    parseNativeAmount(human: string, chain: ChainConfig): bigint {
      assertStellar(chain);
      return BigInt(Math.round(parseFloat(human) * STROOPS_PER_XLM));
    },
    truncateAddress(address: string, opts?: TruncateAddressOptions): string {
      return truncateAddressUtil({
        address,
        startLength: opts?.start ?? 6,
        endLength: opts?.end ?? 4,
      });
    },

    // ── Clear signing (task 65 / TWV-2026-066) ──────────────────────
    // Soroban contract-spec resolution via the on-chain WASM's
    // `contractspecv0` custom section — a pinned two-hop
    // `getLedgerEntries` read against the deployed contract itself.
    // `args.network` carries the dApp session's network passphrase
    // when no ChainConfig is bound; anything other than the public
    // passphrase resolves to the testnet RPC (matches the two-network
    // ChainConfig shape).
    async resolveClearSigningDescriptor(args) {
      const configuredRpc =
        args.chain?.namespace === STELLAR_NAMESPACE
          ? args.chain.rpcUrl
          : undefined;
      const isPublic =
        args.chain?.namespace === STELLAR_NAMESPACE
          ? args.chain.network === "mainnet"
          : args.network === Networks.PUBLIC;
      const rpcUrl =
        configuredRpc ??
        (isPublic
          ? "https://mainnet.sorobanrpc.com"
          : "https://soroban-testnet.stellar.org");
      return resolveStellarClearSigningDescriptor(args, (contractId) =>
        fetchSorobanContractWasm(rpcUrl, contractId),
      );
    },
    computeSigningDigest: computeStellarSigningDigest,

    // ── Bridge capability (bridge-capability-spec §5.1, §5.2, §7.5) ──
    // Stellar is the reason destination readiness is a per-namespace
    // capability rather than a gas check: a trustline is a hard opt-in
    // the recipient must have performed. See `./bridge.ts`.
    caip2For: stellarCaip2For,
    toAssetCaip19: stellarToAssetCaip19,
    fromAssetCaip19: stellarFromAssetCaip19,
    submitBridgeExecution: stellarSubmitBridgeExecution,
    checkBridgeDestinationReadiness: stellarCheckBridgeDestinationReadiness,
  };
}
