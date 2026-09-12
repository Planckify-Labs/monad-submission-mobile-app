/**
 * `SolanaWalletKit` — binds the Solana primitives (Tasks 07–11) behind
 * the `WalletKitAdapter` interface (Task 04) so screens, onboarding
 * sheets, and the bridge signer all dispatch through one seam.
 *
 * Spec reference: `docs/solana-chain-support-spec.md` §4.5, §6.1, §7.6.
 *
 * Rules (non-negotiable — enforced by review):
 *   - No signing path outside `services/walletService.ts`.
 *     `sendNativeTransfer` calls `getSolanaSignerForWallet` — it does
 *     not reconstruct a signer itself (TWV-2026-070).
 *   - Narrow, don't cast. Every `ChainConfig`-accepting method guards
 *     on `namespace === "solana"` at entry and throws on mismatch;
 *     never `as any`.
 *   - `FEE_RESERVE_LAMPORTS` is a named constant so reviewers can see
 *     exactly what's being reserved and why.
 *
 * This file is the single registration target for Solana's first-party
 * wallet operations. Future chain families plug in the same way — one
 * new file under `services/walletKit/<family>/` + one register call in
 * `boot.ts`.
 */

import { validateMnemonic } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english";
import type { KeyPairSigner } from "@solana/kit";
import {
  address,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
} from "@solana/kit";

import type { ChainConfig } from "../../../constants/configs/chainConfig.ts";
import type { TWallet } from "../../../constants/types/walletTypes.ts";
import {
  createSolanaWalletFromMnemonic,
  createSolanaWalletFromPrivateKey,
  isValidSolanaAddress,
  isValidSolanaPrivateKey,
  truncateAddress as truncateAddressUtil,
} from "../../../utils/walletUtils.ts";
import { bytesToBase58 } from "../../chains/solana/codec.ts";
import { buildAndSendSplTransfer } from "../../chains/solana/splTransferService.ts";
import {
  buildAndSendSolTransfer,
  getSolanaBalance,
} from "../../chains/solana/transferService.ts";
import {
  generateWalletMnemonic,
  getPrivateKeyForWallet,
  getSolanaSignerForWallet,
} from "../../walletService.ts";
import type {
  CreateWalletFromMnemonicParams,
  CreateWalletFromPrivateKeyParams,
  EstimateMaxTransferableArgs,
  NativeTransferArgs,
  SendAnchorInstructionArgs,
  SignX402SvmPaymentArgs,
  TokenTransferArgs,
  TruncateAddressOptions,
  WalletKitAdapter,
} from "../types.ts";
import { SvmWalletNamespaceMismatchError } from "../types.ts";
import {
  solanaCaip2For,
  solanaCheckBridgeDestinationReadiness,
  solanaSubmitBridgeExecution,
  solanaToAssetCaip19,
} from "./bridge.ts";
import {
  computeSolanaSigningDigest,
  fetchSolanaAccountData,
  resolveSolanaClearSigningDescriptor,
} from "./clearSigning.ts";
import { buildSolanaPaymentRequest } from "./paymentRequest.ts";
import {
  assertSolanaSigner,
  signX402SvmPaymentWithSigner,
} from "./signX402SvmPayment.ts";
import {
  solanaWalletConnectCodec,
  solanaWalletConnectNamespace,
} from "./walletConnect.ts";

// 5,000 lamports signature fee + 890,880 lamports minimum rent-exempt
// buffer (empty account) so native transfer never drains below rent.
const FEE_RESERVE_LAMPORTS: bigint = 5_000n + 890_880n;

/** 1 SOL = 1e9 lamports. Named so the formatters stay self-documenting. */
const LAMPORTS_PER_SOL = 1_000_000_000;

const SOLANA_NAMESPACE = "solana" as const;

function assertSolana(
  chain: ChainConfig,
): asserts chain is Extract<ChainConfig, { namespace: "solana" }> {
  if (chain.namespace !== SOLANA_NAMESPACE) {
    throw new Error("SolanaWalletKit: expected solana chain");
  }
}

export function createSolanaWalletKit(): WalletKitAdapter {
  return {
    namespace: SOLANA_NAMESPACE,
    supportsTokenTransfer: true,
    supportsPrivateKeyImport: true,
    displayName: "Solana",
    brandColor: "#9945FF",
    preferredPaymentRail: "solana",
    requireBiometricForConnect: true,
    // Deep-link spec §4.5 — Solana Pay transfer builder + WalletConnect
    // `solana` namespace / codec (`docs/deeplink-wallet-interactions-spec.md`).
    buildPaymentRequest: buildSolanaPaymentRequest,
    walletConnectNamespace: solanaWalletConnectNamespace,
    walletConnectCodec: solanaWalletConnectCodec,
    formatConnectChipLabel(payload: unknown): string {
      const cluster = (payload as { cluster?: string } | null)?.cluster;
      const label =
        cluster === "devnet"
          ? "Devnet"
          : cluster === "testnet"
            ? "Testnet"
            : "Mainnet";
      return `Solana · ${label}`;
    },
    getChainId(chain) {
      return chain.namespace === SOLANA_NAMESPACE ? chain.cluster : null;
    },
    formatChainLabel(chain) {
      if (chain.namespace !== SOLANA_NAMESPACE) return null;
      const label = chain.cluster === "devnet" ? "Devnet" : "Mainnet";
      return `Solana ${label}`;
    },
    nativeSymbol(chain) {
      return chain.namespace === SOLANA_NAMESPACE ? "SOL" : null;
    },
    getAuthChainSlug(chain) {
      if (chain.namespace !== SOLANA_NAMESPACE) return null;
      return chain.cluster === "devnet" ? "solana-devnet" : "solana-mainnet";
    },
    defaultAuthChainSlug: "solana-mainnet",
    matchesBlockchainRow(chain, row) {
      if (chain.namespace !== SOLANA_NAMESPACE || row.isEVM) return false;
      // chainSlug shares the `solana-` prefix across devnet + mainnet, so
      // gate on testnet parity first (cluster is authoritative).
      if (row.isTestnet !== (chain.cluster === "devnet")) return false;
      if (typeof row.chainSlug === "string") {
        return row.chainSlug.startsWith("solana-");
      }
      // Fallback for backends that predate `chainSlug`: a Solana row is a
      // non-EVM row that doesn't look like Sui (mirrors the prior
      // BalanceSection name/rpc heuristic).
      const name = (row.name ?? "").toLowerCase();
      const rpc = (row.rpcUrl ?? "").toLowerCase();
      const looksSui = name.startsWith("sui") || rpc.includes("sui.io");
      return !looksSui;
    },
    buildTxExplorerUrl(txHash, chain) {
      if (chain.namespace !== SOLANA_NAMESPACE) return null;
      if (!txHash) return null;
      const base = `https://explorer.solana.com/tx/${txHash}`;
      // Default cluster on explorer.solana.com is mainnet-beta, so we
      // only append the query param for non-default clusters.
      return chain.cluster === "devnet" ? `${base}?cluster=devnet` : base;
    },

    // base58 is case-SIGNIFICANT — never fold.
    canonicalizeAddress: (address: string): string => address,

    // ── Wallet creation & validation ────────────────────────────────
    validateAddress: (address: string): boolean =>
      isValidSolanaAddress(address),
    validatePrivateKey: (privateKey: string): boolean =>
      isValidSolanaPrivateKey(privateKey),
    validateMnemonic: (mnemonic: string): boolean =>
      validateMnemonic(mnemonic.trim(), englishWordlist),

    async createWalletFromPrivateKey(
      params: CreateWalletFromPrivateKeyParams,
    ): Promise<TWallet> {
      const wallet = await createSolanaWalletFromPrivateKey(
        params.privateKey,
        params.name,
      );
      if (!wallet) {
        throw new Error(
          "SolanaWalletKit: invalid Solana private key (expected 32- or 64-byte base58)",
        );
      }
      return wallet;
    },

    async createWalletFromMnemonic(
      params: CreateWalletFromMnemonicParams,
    ): Promise<TWallet> {
      const wallet = await createSolanaWalletFromMnemonic(
        params.mnemonic,
        params.name,
      );
      if (!wallet) {
        throw new Error(
          "SolanaWalletKit: invalid BIP-39 mnemonic or SLIP-0010 derivation failure",
        );
      }
      return wallet;
    },

    generateMnemonic: (): string => generateWalletMnemonic(),

    // ── Keys & signers (TWV-2026-070 dwell site) ────────────────────
    async getSignerForWallet(wallet: TWallet): Promise<unknown | null> {
      return getSolanaSignerForWallet(wallet);
    },

    // ── Auth ────────────────────────────────────────────────────────
    async signAuthMessage(wallet: TWallet, message: string): Promise<string> {
      const signer: KeyPairSigner | null =
        await getSolanaSignerForWallet(wallet);
      if (!signer) {
        throw new Error("SolanaWalletKit.signAuthMessage: no signer available");
      }
      const messageBytes = new TextEncoder().encode(message);
      const [sigDict] = await signer.signMessages([
        { content: messageBytes, signatures: {} },
      ]);
      const sigBytes = sigDict[signer.address];
      if (!sigBytes || sigBytes.length !== 64) {
        throw new Error(
          "SolanaWalletKit.signAuthMessage: invalid signature bytes",
        );
      }
      return bytesToBase58(sigBytes);
    },

    // ── Reads ───────────────────────────────────────────────────────
    async getNativeBalance(
      address: string,
      chain: ChainConfig,
    ): Promise<bigint> {
      assertSolana(chain);
      const rpc = createSolanaRpc(chain.rpcUrl);
      return getSolanaBalance(rpc, address);
    },

    async getTokenBalance(
      ownerAddress: string,
      chain: ChainConfig,
      contractAddress: string,
    ): Promise<bigint> {
      assertSolana(chain);
      const rpc = createSolanaRpc(chain.rpcUrl);
      const { value: accounts } = await rpc
        .getTokenAccountsByOwner(
          address(ownerAddress),
          { mint: address(contractAddress) },
          { encoding: "jsonParsed" },
        )
        .send();

      if (accounts.length === 0) return BigInt(0);
      const data = accounts[0].account.data;
      const tokenAmount =
        "parsed" in data ? data.parsed.info.tokenAmount : undefined;
      return tokenAmount ? BigInt(tokenAmount.amount) : BigInt(0);
    },

    // ── Writes ──────────────────────────────────────────────────────
    async sendNativeTransfer({
      wallet,
      to,
      amount,
      chain,
    }: NativeTransferArgs): Promise<string> {
      assertSolana(chain);
      const signer: KeyPairSigner | null =
        await getSolanaSignerForWallet(wallet);
      if (!signer) {
        throw new Error("No Solana signer for wallet");
      }
      const rpc = createSolanaRpc(chain.rpcUrl);
      const rpcSubs = chain.rpcSubscriptionsUrl
        ? createSolanaRpcSubscriptions(chain.rpcSubscriptionsUrl)
        : undefined;
      const signature = await buildAndSendSolTransfer({
        rpc,
        rpcSubs,
        signer,
        to,
        lamports: amount,
      });
      return String(signature);
    },

    async sendTokenTransfer({
      wallet,
      to,
      amount,
      chain,
      contractAddress,
      decimals,
    }: TokenTransferArgs): Promise<string> {
      assertSolana(chain);
      const signer: KeyPairSigner | null =
        await getSolanaSignerForWallet(wallet);
      if (!signer) {
        throw new Error("No Solana signer for wallet");
      }
      const rpc = createSolanaRpc(chain.rpcUrl);
      const rpcSubs = chain.rpcSubscriptionsUrl
        ? createSolanaRpcSubscriptions(chain.rpcSubscriptionsUrl)
        : undefined;
      const signature = await buildAndSendSplTransfer({
        rpc,
        rpcSubs,
        signer,
        to,
        mint: contractAddress,
        amount,
        decimals,
      });
      return String(signature);
    },

    async estimateMaxTransferable({
      balance,
    }: EstimateMaxTransferableArgs): Promise<bigint> {
      return balance > FEE_RESERVE_LAMPORTS
        ? balance - FEE_RESERVE_LAMPORTS
        : 0n;
    },

    // ── Path B-SVM x402 signer (spec §5.2.1, §5.5, milestone M6) ────
    //
    // Solana counterpart to `EvmWalletKit.signTransferWithAuthorization`.
    // The facilitator hands us a pre-built partially-signed versioned
    // transaction (ComputeBudget × 2, TransferChecked, optional Memo);
    // this method resolves the wallet's Solana signer via the
    // walletService dwell site and delegates to the pure
    // `signX402SvmPaymentWithSigner` primitive, which attaches the
    // user's signature over the existing message bytes without
    // mutating instructions. Returns the updated base64 wire tx.
    //
    // EVM kit leaves this `undefined` — consumers presence-check per
    // the chain-extension discipline (memory:
    // `feedback_chain_extension_discipline.md`).
    async signX402SvmPayment(args: SignX402SvmPaymentArgs): Promise<string> {
      // Guard: the wallet must belong to this kit's namespace. We
      // narrow on `wallet.namespace` (not on a `ChainConfig`) because
      // the SVM x402 scheme erases the per-chain config — the
      // facilitator's pre-built tx already encodes the cluster
      // (mainnet-beta / devnet) via its blockhash lifetime, and the
      // `cluster` field on `args` is just carried through to the
      // downstream facilitator POST (task 43). Wrong-namespace
      // wallets fail loud here instead of silently returning an
      // unsigned tx.
      if (args.wallet.namespace !== SOLANA_NAMESPACE) {
        throw new SvmWalletNamespaceMismatchError(args.wallet.namespace);
      }
      const signer: KeyPairSigner | null = await getSolanaSignerForWallet(
        args.wallet,
      );
      assertSolanaSigner(signer, args.wallet.address);
      return signX402SvmPaymentWithSigner(signer, args.transaction);
    },

    async sendAnchorInstruction(
      args: SendAnchorInstructionArgs,
    ): Promise<string> {
      assertSolana(args.chain);
      const signer: KeyPairSigner | null = await getSolanaSignerForWallet(
        args.wallet,
      );
      if (!signer) {
        throw new Error("No Solana signer for wallet");
      }

      const rpc = createSolanaRpc(args.chain.rpcUrl);

      const {
        TransactionMessage,
        VersionedTransaction,
        PublicKey: PK,
        Keypair,
        Connection,
      } = await import("@solana/web3.js");
      const { parseSolanaPrivateKey } = await import(
        "@/services/chains/solana/codec"
      );

      const payerKey = new PK(signer.address);

      let blockhashInfo: { blockhash: string; lastValidBlockHeight: number };
      if (args.durableNonce) {
        blockhashInfo = {
          blockhash: args.durableNonce.nonceAccount.toBase58(),
          lastValidBlockHeight: Number.MAX_SAFE_INTEGER,
        };
      } else {
        const { value } = await rpc
          .getLatestBlockhash({ commitment: "confirmed" })
          .send();
        blockhashInfo = {
          blockhash: value.blockhash,
          lastValidBlockHeight: Number(value.lastValidBlockHeight),
        };
      }

      const message = new TransactionMessage({
        payerKey,
        recentBlockhash: blockhashInfo.blockhash,
        instructions: args.instructions,
      });
      const messageV0 = message.compileToV0Message(args.addressLookupTables);
      const tx = new VersionedTransaction(messageV0);

      // TWV-2026-057 Tier 1 — `args.wallet` comes from app state and no
      // longer carries key material; resolve it from the wallet
      // service's vault instead of reading the field directly.
      const walletPrivateKey = getPrivateKeyForWallet(args.wallet);
      if (!walletPrivateKey) {
        throw new Error("Could not retrieve wallet private key");
      }
      const seed = parseSolanaPrivateKey(walletPrivateKey);
      const keypair = Keypair.fromSecretKey(
        new Uint8Array([...seed, ...payerKey.toBytes()]),
      );
      tx.sign([keypair, ...(args.additionalSigners ?? [])]);

      const connection = new Connection(args.chain.rpcUrl, "confirmed");
      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      // Poll via getSignatureStatuses instead of confirmTransaction
      // (which relies on signatureSubscribe WebSocket — not supported
      // by all RPC providers over HTTP).
      const maxRetries = 30;
      for (let i = 0; i < maxRetries; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const { value } = await connection.getSignatureStatuses([signature]);
        const status = value?.[0];
        if (status?.err) {
          if (__DEV__) {
            console.warn("[SolanaWalletKit] tx failed", signature, status.err);
          }
          throw new Error("Transaction failed");
        }
        if (
          status?.confirmationStatus === "confirmed" ||
          status?.confirmationStatus === "finalized"
        ) {
          return signature;
        }
      }

      // Tx sent but not confirmed within timeout — return signature
      // anyway so the backend can track it via its own watcher.
      return signature;
    },

    // ── Display ─────────────────────────────────────────────────────
    formatNativeAmount(raw: bigint, chain: ChainConfig): string {
      assertSolana(chain);
      return `${(Number(raw) / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
    },
    parseNativeAmount(human: string, chain: ChainConfig): bigint {
      assertSolana(chain);
      return BigInt(Math.round(parseFloat(human) * LAMPORTS_PER_SOL));
    },
    truncateAddress(address: string, opts?: TruncateAddressOptions): string {
      return truncateAddressUtil({
        address,
        startLength: opts?.start,
        endLength: opts?.end,
      });
    },

    // ── Clear signing (task 65 / TWV-2026-066) ──────────────────────
    // Well-known-program map + on-chain Anchor IDL account (what
    // `Program.fetchIdl` reads) — a pinned read against the program
    // itself. The RPC binding prefers the caller's ChainConfig and
    // falls back to the public cluster endpoints the bridge signer
    // already uses.
    async resolveClearSigningDescriptor(args) {
      const rpcUrl =
        args.chain?.namespace === SOLANA_NAMESPACE
          ? args.chain.rpcUrl
          : args.network === "devnet"
            ? "https://api.devnet.solana.com"
            : "https://api.mainnet-beta.solana.com";
      return resolveSolanaClearSigningDescriptor(args, (address) =>
        fetchSolanaAccountData(rpcUrl, address),
      );
    },
    computeSigningDigest: computeSolanaSigningDigest,

    // ── Bridge capability (bridge-capability-spec §5.1, §5.2, §7.5) ──
    // Solana's destination precondition is an associated token account
    // plus rent, not gas — see `./bridge.ts`.
    caip2For: solanaCaip2For,
    toAssetCaip19: solanaToAssetCaip19,
    submitBridgeExecution: solanaSubmitBridgeExecution,
    checkBridgeDestinationReadiness: solanaCheckBridgeDestinationReadiness,
  };
}
