/**
 * `SuiWalletKit` — binds the Sui primitives (Tasks 03–07) behind the
 * `WalletKitAdapter` interface (Task 04) so screens, onboarding sheets,
 * and the bridge signer all dispatch through one seam.
 *
 * Spec reference: `docs/sui-chain-support-spec.md` §4 (kit factory shape),
 * §11 resolved decision 4 (no `brandColor` — `ConnectSheet` falls back
 * to `DEFAULT_BRAND_COLOR`).
 *
 * Rules (non-negotiable — enforced by review):
 *   - No signing path outside `services/walletService.ts`. Every method
 *     that needs a keypair calls `getSuiSignerForWallet` — it does not
 *     reconstruct an `Ed25519Keypair` itself (TWV-2026-080).
 *   - Narrow on namespace at every entry. Each `ChainConfig`-accepting
 *     method guards via `assertSuiChain` (or returns `null` for the
 *     display hooks); never `as any`.
 *   - `MAX_GAS_BUDGET_MIST` is a named file-scope constant so reviewers
 *     can see exactly what's being reserved and why (no magic numbers).
 *   - No `brandColor` on the returned adapter — see spec §11 decision 4.
 *
 * SDK note (2.16): the JSON-RPC client is `SuiJsonRpcClient` from
 * `@mysten/sui/jsonRpc`, not `SuiClient` from `@mysten/sui/client`. Its
 * constructor takes `{ url, network }` (both required). We mirror the
 * call shape used in `services/chains/sui/transferService.ts`.
 */

import { fromBase64 } from "@mysten/bcs";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { validateMnemonic } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english";

import type { ChainConfig } from "../../../constants/configs/chainConfig.ts";
import type { TWallet } from "../../../constants/types/walletTypes.ts";
import {
  createSuiWalletFromMnemonic,
  createSuiWalletFromPrivateKey,
  isValidSuiAddress,
  isValidSuiPrivateKey,
  truncateAddress as truncateAddressUtil,
} from "../../../utils/walletUtils.ts";
import { buildAndSendSuiCoinTransfer } from "../../chains/sui/coinTransferService.ts";
import {
  SuiClosedLoopPolicyDeniedError,
  SuiRegulatedCoinDeniedError,
} from "../../chains/sui/errorCodes.ts";
import {
  detectSuiTokenKind,
  getClosedLoopTokenBalance,
} from "../../chains/sui/tokenKind.ts";
import { buildAndSendSuiTransfer } from "../../chains/sui/transferService.ts";
import { breadcrumb, captureException } from "../../telemetry/sui.ts";
import {
  generateWalletMnemonic,
  getSuiSignerForWallet,
} from "../../walletService.ts";
import type {
  CreateWalletFromMnemonicParams,
  CreateWalletFromPrivateKeyParams,
  EstimateMaxTransferableArgs,
  NativeTransferArgs,
  TokenTransferArgs,
  TruncateAddressOptions,
  WalletKitAdapter,
} from "../types.ts";
import {
  computeSuiSigningDigest,
  makeSuiRpcCall,
  resolveSuiClearSigningDescriptor,
} from "./clearSigning.ts";

/**
 * Gas-budget safety reserve subtracted in `estimateMaxTransferable`.
 * 0.05 SUI (50 million MIST) per spec §4 — comfortably above a typical
 * native-transfer gas charge (~3M MIST) so the user never lands a tx
 * that the network rejects for `InsufficientGas`.
 */
const MAX_GAS_BUDGET_MIST: bigint = 50_000_000n;

/** 1 SUI = 1e9 MIST. Named so the formatters stay self-documenting. */
const MIST_PER_SUI = 1_000_000_000;

const SUI_NAMESPACE = "sui" as const;

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Local `asserts`-style narrower so every `ChainConfig`-accepting
 * method narrows `chain` to its Sui arm without `as any` and without
 * leaning on the runtime helper from `chainConfig.ts` (which returns
 * the narrowed value but does not carry a TS `asserts` annotation).
 *
 * Throws with the same message shape as `chainConfig.ts#assertSuiChain`
 * so cross-namespace consumers see a single error string.
 */
function assertSui(
  chain: ChainConfig,
): asserts chain is Extract<ChainConfig, { namespace: "sui" }> {
  if (chain.namespace !== SUI_NAMESPACE) {
    throw new Error(
      `assertSuiChain: expected Sui chain, got namespace=${chain.namespace}`,
    );
  }
}

export function createSuiWalletKit(): WalletKitAdapter {
  return {
    namespace: SUI_NAMESPACE,
    supportsTokenTransfer: true,
    supportsPrivateKeyImport: true,
    displayName: "Sui",
    // No `brandColor` — ConnectSheet falls back to DEFAULT_BRAND_COLOR
    // per spec §11 resolved decision 4.
    requireBiometricForConnect: true,

    formatConnectChipLabel(payload: unknown): string {
      const network =
        (payload as { network?: string } | null)?.network ?? "mainnet";
      return `Sui · ${capitalize(network)}`;
    },
    getChainId(chain) {
      return chain.namespace === SUI_NAMESPACE ? chain.network : null;
    },
    formatChainLabel(chain) {
      if (chain.namespace !== SUI_NAMESPACE) return null;
      return `Sui ${capitalize(chain.network)}`;
    },
    nativeSymbol(chain) {
      return chain.namespace === SUI_NAMESPACE ? "SUI" : null;
    },
    getAuthChainSlug(chain) {
      if (chain.namespace !== SUI_NAMESPACE) return null;
      if (chain.network === "testnet") return "sui-testnet";
      if (chain.network === "devnet") return "sui-devnet";
      return "sui-mainnet";
    },
    defaultAuthChainSlug: "sui-mainnet",
    matchesBlockchainRow(chain, row) {
      if (chain.namespace !== SUI_NAMESPACE || row.isEVM) return false;
      if (row.isTestnet !== (chain.network !== "mainnet")) return false;
      if (typeof row.chainSlug === "string") {
        return row.chainSlug.startsWith("sui-");
      }
      const name = (row.name ?? "").toLowerCase();
      const rpc = (row.rpcUrl ?? "").toLowerCase();
      return name.startsWith("sui") || rpc.includes("sui.io");
    },
    buildTxExplorerUrl(digest, chain) {
      if (chain.namespace !== SUI_NAMESPACE) return null;
      if (!digest) return null;
      // SuiVision uses subdomain-prefixed hosts for non-default networks.
      if (chain.network === "testnet") {
        return `https://testnet.suivision.xyz/txblock/${digest}`;
      }
      if (chain.network === "devnet") {
        return `https://devnet.suivision.xyz/txblock/${digest}`;
      }
      return `https://suivision.xyz/txblock/${digest}`;
    },

    // Sui addresses are 0x-hex, case-insignificant — fold to lowercase.
    canonicalizeAddress: (address: string): string => address.toLowerCase(),

    // ── Wallet creation & validation ────────────────────────────────
    validateAddress: (address: string): boolean => isValidSuiAddress(address),
    validatePrivateKey: (privateKey: string): boolean =>
      isValidSuiPrivateKey(privateKey),
    validateMnemonic: (mnemonic: string): boolean =>
      validateMnemonic(mnemonic.trim(), englishWordlist),

    async createWalletFromPrivateKey(
      params: CreateWalletFromPrivateKeyParams,
    ): Promise<TWallet> {
      const wallet = await createSuiWalletFromPrivateKey(
        params.privateKey,
        params.name,
      );
      if (!wallet) {
        throw new Error(
          "SuiWalletKit: invalid Sui private key (expected bech32 suiprivkey1…, 32-byte hex, or base64)",
        );
      }
      return wallet;
    },

    async createWalletFromMnemonic(
      params: CreateWalletFromMnemonicParams,
    ): Promise<TWallet> {
      const wallet = await createSuiWalletFromMnemonic(
        params.mnemonic,
        params.name,
      );
      if (!wallet) {
        throw new Error(
          "SuiWalletKit: invalid BIP-39 mnemonic or SLIP-0010 derivation failure",
        );
      }
      return wallet;
    },

    generateMnemonic: (): string => generateWalletMnemonic(),

    // ── Keys & signers (TWV-2026-080 dwell site) ────────────────────
    async getSignerForWallet(wallet: TWallet): Promise<unknown | null> {
      return getSuiSignerForWallet(wallet);
    },

    // ── Auth ────────────────────────────────────────────────────────
    async signAuthMessage(wallet: TWallet, message: string): Promise<string> {
      const kp: Ed25519Keypair | null = await getSuiSignerForWallet(wallet);
      if (!kp) {
        throw new Error("SuiWalletKit.signAuthMessage: no signer available");
      }
      const { signature } = await kp.signPersonalMessage(
        new TextEncoder().encode(message),
      );
      // base64; includes flag + pubkey per the Sui Wallet Standard.
      return signature;
    },

    // ── Reads ───────────────────────────────────────────────────────
    async getNativeBalance(
      address: string,
      chain: ChainConfig,
    ): Promise<bigint> {
      assertSui(chain);
      const client = new SuiJsonRpcClient({
        url: chain.rpcUrl,
        network: chain.network,
      });
      const { totalBalance } = await client.getBalance({ owner: address });
      return BigInt(totalBalance);
    },

    async getTokenBalance(
      address: string,
      chain: ChainConfig,
      coinType: string,
    ): Promise<bigint> {
      assertSui(chain);
      const client = new SuiJsonRpcClient({
        url: chain.rpcUrl,
        network: chain.network,
      });
      // Coin<T> is the standard route. If detection reveals a closed-loop
      // type, the helper kicks over to getClosedLoopTokenBalance —
      // avoids leaking detector logic into shared kit code.
      const kind = await detectSuiTokenKind(client, coinType);
      if (kind?.kind === "closed-loop") {
        return getClosedLoopTokenBalance(client, {
          owner: address,
          coinType,
          tokenPolicyId: kind.tokenPolicyId,
        });
      }
      const { totalBalance } = await client.getBalance({
        owner: address,
        coinType,
      });
      return BigInt(totalBalance);
    },

    // ── Writes ──────────────────────────────────────────────────────
    async sendNativeTransfer({
      wallet,
      to,
      amount,
      chain,
    }: NativeTransferArgs): Promise<string> {
      assertSui(chain);
      breadcrumb({
        category: "sui.sendNativeTransfer",
        message: "start",
        level: "info",
        data: { network: chain.network },
      });
      const signer: Ed25519Keypair | null = await getSuiSignerForWallet(wallet);
      if (!signer) {
        breadcrumb({
          category: "sui.sendNativeTransfer",
          message: "failure: no signer",
          level: "error",
          data: { network: chain.network },
        });
        throw new Error("No Sui signer for wallet");
      }
      const client = new SuiJsonRpcClient({
        url: chain.rpcUrl,
        network: chain.network,
      });
      try {
        const digest = await buildAndSendSuiTransfer({
          client,
          signer,
          to,
          mist: amount,
        });
        breadcrumb({
          category: "sui.sendNativeTransfer",
          message: "success",
          level: "info",
          data: { network: chain.network },
        });
        return digest;
      } catch (err) {
        breadcrumb({
          category: "sui.sendNativeTransfer",
          message: "failure",
          level: "error",
          data: {
            network: chain.network,
            errorName: err instanceof Error ? err.name : typeof err,
          },
        });
        captureException(err, {
          name: "sui.sendNativeTransfer",
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
      contractAddress: coinType,
      // `decimals` is intentionally unused — Sui's Coin<T> protocol
      // surface doesn't take a decimal hint at the PTB level; the SDK
      // resolves it via on-chain coin metadata. Kept on the args type
      // for cross-namespace call-site parity with EVM / Solana.
    }: TokenTransferArgs): Promise<string> {
      assertSui(chain);
      // NOTE (privacy): we deliberately do NOT log `coinType` — until
      // token rows carry an `isUserPasted` discriminator, treat all
      // CoinTypes as PII-tinted. We attach `tokenKind` only AFTER
      // detection so the breadcrumb captures the dispatch shape (Coin /
      // Regulated / Closed-Loop) without leaking the user-pasted type
      // string.
      // TODO: source-tag the CoinType once token rows carry an
      // `isUserPasted` discriminator.
      breadcrumb({
        category: "sui.sendTokenTransfer",
        message: "start",
        level: "info",
        data: { network: chain.network },
      });
      const signer: Ed25519Keypair | null = await getSuiSignerForWallet(wallet);
      if (!signer) {
        breadcrumb({
          category: "sui.sendTokenTransfer",
          message: "failure: no signer",
          level: "error",
          data: { network: chain.network },
        });
        throw new Error("No Sui signer for wallet");
      }
      const client = new SuiJsonRpcClient({
        url: chain.rpcUrl,
        network: chain.network,
      });

      // Pre-detect token kind so the breadcrumb on success/failure
      // carries the dispatch shape. The transfer service re-detects
      // (no API trust), so this extra read only costs a cache hit on
      // the second call.
      let tokenKind: "coin" | "regulated-coin" | "closed-loop" | "unknown" =
        "unknown";
      try {
        const detected = await detectSuiTokenKind(client, coinType, {
          network: chain.network,
        });
        if (detected) {
          if (detected.kind === "closed-loop") {
            tokenKind = "closed-loop";
          } else {
            tokenKind = detected.regulated ? "regulated-coin" : "coin";
          }
        }
      } catch {
        // detection is best-effort for telemetry — swallow.
      }

      try {
        const digest = await buildAndSendSuiCoinTransfer({
          client,
          signer,
          to,
          coinType,
          amount,
        });
        breadcrumb({
          category: "sui.sendTokenTransfer",
          message: "success",
          level: "info",
          data: { network: chain.network, tokenKind },
        });
        return digest;
      } catch (err) {
        const errorName = err instanceof Error ? err.name : typeof err;
        const ctxPayload: Record<string, unknown> = {
          errorName,
          network: chain.network,
          tokenKind,
        };
        // Public chain identifiers are not PII — attach so a dashboard
        // can surface "deny-list X is blocking N transfers/day".
        if (err instanceof SuiRegulatedCoinDeniedError) {
          // SuiRegulatedCoinDeniedError carries `coinType` only; we
          // intentionally drop it (treat as PII for v1).
          // No public id is available on this error today.
        } else if (err instanceof SuiClosedLoopPolicyDeniedError) {
          ctxPayload.tokenPolicyId = err.tokenPolicyId;
        }
        breadcrumb({
          category: "sui.sendTokenTransfer",
          message: "failure",
          level: "error",
          data: { network: chain.network, tokenKind, errorName },
        });
        captureException(err, {
          name: "sui.sendTokenTransfer",
          payload: ctxPayload,
        });
        throw err;
      }
    },

    async estimateMaxTransferable({
      balance,
    }: EstimateMaxTransferableArgs): Promise<bigint> {
      return balance > MAX_GAS_BUDGET_MIST ? balance - MAX_GAS_BUDGET_MIST : 0n;
    },

    // ── Sui-PTB submission (Intent Engine + future Sui DeFi adapters) ──
    async signAndExecuteSuiPtb({ wallet, chain, ptbBase64 }): Promise<string> {
      assertSui(chain);
      breadcrumb({
        category: "sui.signAndExecuteSuiPtb",
        message: "start",
        level: "info",
        data: { network: chain.network },
      });
      const signer: Ed25519Keypair | null = await getSuiSignerForWallet(wallet);
      if (!signer) {
        breadcrumb({
          category: "sui.signAndExecuteSuiPtb",
          message: "failure: no signer",
          level: "error",
          data: { network: chain.network },
        });
        throw new Error("No Sui signer for wallet");
      }
      const client = new SuiJsonRpcClient({
        url: chain.rpcUrl,
        network: chain.network,
      });
      // The pre-built PTB is the exact bytes the user previewed (SI-4) —
      // we re-hydrate and sign it, never rebuild. `signAndExecuteTransaction`
      // wraps intent prefixing + BLAKE2b internally (see transferService).
      const tx = Transaction.from(fromBase64(ptbBase64));
      try {
        const { digest } = await client.signAndExecuteTransaction({
          transaction: tx,
          signer,
          options: { showEffects: false },
        });
        breadcrumb({
          category: "sui.signAndExecuteSuiPtb",
          message: "success",
          level: "info",
          data: { network: chain.network },
        });
        return digest;
      } catch (err) {
        breadcrumb({
          category: "sui.signAndExecuteSuiPtb",
          message: "failure",
          level: "error",
          data: {
            network: chain.network,
            errorName: err instanceof Error ? err.name : typeof err,
          },
        });
        captureException(err, {
          name: "sui.signAndExecuteSuiPtb",
          payload: {
            errorName: err instanceof Error ? err.name : typeof err,
            network: chain.network,
          },
        });
        throw err;
      }
    },

    // ── Display ─────────────────────────────────────────────────────
    formatNativeAmount(raw: bigint, chain: ChainConfig): string {
      assertSui(chain);
      return `${(Number(raw) / MIST_PER_SUI).toFixed(4)} SUI`;
    },
    parseNativeAmount(human: string, chain: ChainConfig): bigint {
      assertSui(chain);
      return BigInt(Math.round(parseFloat(human) * MIST_PER_SUI));
    },
    truncateAddress(address: string, opts?: TruncateAddressOptions): string {
      return truncateAddressUtil({
        address,
        startLength: opts?.start ?? 6,
        endLength: opts?.end ?? 4,
      });
    },

    // ── Clear signing (task 65 / TWV-2026-066) ──────────────────────
    // `sui_getNormalizedMoveFunction` — the deployed package's own
    // parameter types via a pinned RPC read. Falls back to the public
    // fullnodes the bridge signer already uses when no ChainConfig is
    // bound.
    async resolveClearSigningDescriptor(args) {
      const rpcUrl =
        args.chain?.namespace === SUI_NAMESPACE
          ? args.chain.rpcUrl
          : args.network === "testnet"
            ? "https://fullnode.testnet.sui.io:443"
            : args.network === "devnet"
              ? "https://fullnode.devnet.sui.io:443"
              : "https://fullnode.mainnet.sui.io:443";
      return resolveSuiClearSigningDescriptor(args, makeSuiRpcCall(rpcUrl));
    },
    computeSigningDigest: computeSuiSigningDigest,
  };
}
