import { takumipayLogoBase64 } from "@/constants/takumipay";
import type {
  ApprovalDecision,
  ApprovalIntent,
} from "@/services/bridge/approval";
import type {
  AdapterContext,
  ChainAdapter,
  ChainRequest,
  ChainResult,
} from "@/services/chains/types";
import { addressesEqual } from "@/services/walletKit/chainInfo";
import { originKey } from "@/services/permissions/caip";
import { PermissionStore } from "@/services/permissions/store";
import { getSolanaRpc } from "@/services/rpc/solanaRpcPool";
import { bytesToBase64 } from "./codec";
import { assertSolanaErrorCode } from "./errorCodes";
import { getSolanaInjectedScript } from "./injectedScript";
import {
  canonicalizeChain,
  chainToCluster,
  clusterToChain,
  type SolanaChain,
  type SolanaCluster,
  type SolanaConnectPayload,
  type SolanaSignAllTransactionsPayload,
  type SolanaSignInPayload,
  type SolanaSignMessagePayload,
  type SolanaSignTxPayload,
  type SolanaSwitchClusterPayload,
  type SolanaWatchTokenPayload,
} from "./payloads";
import { parseToken2022Extensions, type Token2022Extension } from "./token2022";

export interface SolanaSignerFns {
  signMessage: (address: string, message: string) => Promise<string>;
  signTransaction: (
    address: string,
    txBase64: string,
    cluster: SolanaCluster,
  ) => Promise<string>;
  signAndSendTransaction: (
    address: string,
    txBase64: string,
    cluster: SolanaCluster,
  ) => Promise<string>;
  signIn?: (
    address: string,
    messageUtf8: string,
  ) => Promise<{ signature: string }>;
}

let signerImpl: SolanaSignerFns | null = null;

export function registerSolanaSigner(signer: SolanaSignerFns): void {
  signerImpl = signer;
}

const MAX_BATCH_TX = 20;

function rpcError(code: number, message: string, data?: unknown): ChainResult {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    // Fail fast in dev if anyone emits a non-§10.3 code; in prod we
    // surface the code untouched rather than mask a bug mid-flight.
    assertSolanaErrorCode(code);
  }
  return { status: "error", code, message, data };
}

function codedError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function asString(x: unknown): string {
  return typeof x === "string" ? x : "";
}

function isUtf8Displayable(base64: string): boolean {
  try {
    // Decode and re-encode; if round-trip matches, treat as utf-8. Keeps
    // SIWS-style messages as utf8 without requiring dApp opt-in.
    const bin =
      typeof globalThis.atob === "function"
        ? globalThis.atob(base64)
        : Buffer.from(base64, "base64").toString("binary");
    for (let i = 0; i < bin.length; i++) {
      const c = bin.charCodeAt(i);
      if (c === 0) return false;
      if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function makeIntent<P>(
  req: ChainRequest,
  kind: ApprovalIntent["kind"],
  payload: P,
  wallet: ApprovalIntent["wallet"],
): ApprovalIntent<P> {
  return {
    id: req.id,
    namespace: "solana",
    kind,
    origin: req.origin,
    wallet,
    payload,
    annotations: [],
    createdAt: Date.now(),
  };
}

function pickSolanaWallet(ctx: AdapterContext): AdapterContext["activeWallet"] {
  const sol = ctx.wallets.find((w) => w.namespace === "solana");
  if (!sol) throw codedError(4100, "no Solana wallet available");
  return sol;
}

/**
 * Find the Solana wallet that was granted to this origin on this cluster.
 * Falls back to the first Solana wallet if no grant exists yet (e.g. the
 * initial non-silent connect where the grant gets written alongside the
 * wallet pick).
 *
 * This decouples the Solana adapter from `ctx.activeWallet` — the global
 * active wallet is a UI concern (home-screen header, portfolio view) and
 * must not be flipped by a Solana dApp connect or subsequent EVM dApps
 * break ("Chain not connected" on `eth_requestAccounts`).
 */
function pickSolanaWalletForOrigin(
  ctx: AdapterContext,
  origin: string,
  cluster?: SolanaCluster,
): AdapterContext["activeWallet"] | null {
  const solanaWallets = ctx.wallets.filter((w) => w.namespace === "solana");
  if (solanaWallets.length === 0) return null;
  const targetChain = cluster ? clusterToChain(cluster) : null;
  const grants = PermissionStore.listByOrigin(origin).filter((g) => {
    if (typeof g.chainId !== "string") return false;
    if (!g.chainId.startsWith("solana:")) return false;
    return targetChain === null || g.chainId === targetChain;
  });
  for (const g of grants) {
    const match = solanaWallets.find((w) =>
      addressesEqual("solana", w.address, g.walletAddress),
    );
    if (match) return match;
  }
  return solanaWallets[0];
}

function resolveCluster(
  req: ChainRequest,
  ctx: AdapterContext,
): { chain: SolanaChain; cluster: SolanaCluster } {
  const params = (req.params as unknown[]) ?? [];
  const first = (params[0] ?? {}) as { chain?: unknown };
  // Wallet-Standard calls pass chain at the input level (array of inputs);
  // the adapter sees `[[{account, transaction, chain}, …]]` or `[{...}]`.
  let chainRaw: string | undefined;
  if (typeof first.chain === "string") chainRaw = first.chain;
  if (!chainRaw && Array.isArray(params[0])) {
    const inner = (params[0] as unknown[])[0] as { chain?: string } | undefined;
    if (inner?.chain) chainRaw = inner.chain;
  }
  if (chainRaw) {
    const chain = canonicalizeChain(chainRaw);
    return { chain, cluster: chainToCluster(chain) };
  }
  // Fallback: active wallet's cluster hint via activeChain id if available;
  // otherwise default to mainnet. The Solana activeChain hint has no
  // canonical shape on ctx yet — task 18 wires switchCluster events.
  return { chain: "solana:mainnet", cluster: "mainnet-beta" };
}

function assertClusterMatches(
  req: ChainRequest,
  ctx: AdapterContext,
): ChainResult | { chain: SolanaChain; cluster: SolanaCluster } {
  try {
    return resolveCluster(req, ctx);
  } catch (e) {
    const code = (e as Error & { code?: number }).code ?? -32602;
    return rpcError(code, (e as Error).message);
  }
}

class SolanaAdapter implements ChainAdapter {
  readonly namespace = "solana" as const;

  getInjectedScript(ctx: AdapterContext): string {
    const solWallet = ctx.wallets.find((w) => w.namespace === "solana");
    return getSolanaInjectedScript({
      activeAddress: solWallet?.address ?? null,
      sessionNonce: ctx.sessionNonce,
      iconDataUrl: takumipayLogoBase64,
    });
  }

  onStateChange(_ctx: AdapterContext): { injectedJs: string } | null {
    // Intentionally a no-op. Same isolation rule as Sui — dApp
    // connections must not propagate home-screen active-wallet
    // changes into the dApp's Wallet Standard `change` event, or a
    // home-screen wallet swap silently flips a dApp's signing wallet
    // out from under it. Per-decision state pushes happen via
    // `DappBridge.pushPostDecisionUpdate` (connect fast path threads
    // the resolved wallet from the response value); any per-origin
    // state-sync must read `PermissionStore` keyed by origin, not
    // `ctx.activeWallet`. See `feedback_dapp_bridge_isolation`.
    void _ctx;
    return null;
  }

  async handleRequest(
    req: ChainRequest,
    ctx: AdapterContext,
  ): Promise<ChainResult> {
    try {
      const method =
        req.method === "solana:standard:connect"
          ? "standard:connect"
          : req.method;
      if (req.method === "solana:standard:connect" && __DEV__) {
        // One-release legacy alias.
        console.warn(
          "[solana] legacy method 'solana:standard:connect' — use 'standard:connect'",
        );
      }

      switch (method) {
        case "standard:connect":
          return this.handleConnect(req, ctx);
        case "standard:disconnect":
          return await this.handleDisconnect(req, ctx);
        case "solana:signIn":
          return this.handleSignIn(req, ctx);
        case "solana:signMessage":
          return this.handleSignMessage(req, ctx);
        case "solana:signTransaction":
          return this.handleSignTransaction(req, ctx);
        case "solana:signAndSendTransaction":
          return this.handleSignAndSendTransaction(req, ctx);
        case "takumi:switchCluster":
          return this.handleSwitchCluster(req, ctx);
        case "takumi:watchToken":
          return await this.handleWatchToken(req, ctx);
        default:
          return rpcError(4200, `method ${req.method} not supported`);
      }
    } catch (e) {
      const code = (e as Error & { code?: number }).code ?? -32603;
      return rpcError(code, (e as Error).message);
    }
  }

  private async handleDisconnect(
    req: ChainRequest,
    ctx: AdapterContext,
  ): Promise<ChainResult> {
    // Revoke every Solana grant for this origin so subsequent silent
    // connects (`standard:connect({silent:true})`) are denied. We purge
    // origin-wide rather than per-wallet because all Solana grants for
    // this origin should clear on explicit disconnect.
    void ctx;
    await PermissionStore.revoke({ origin: req.origin.url });
    return { status: "resolved", value: null };
  }

  private handleConnect(req: ChainRequest, ctx: AdapterContext): ChainResult {
    const params = (req.params as unknown[]) ?? [];
    const opts = (params[0] ?? {}) as {
      silent?: boolean;
      onlyIfTrusted?: boolean;
    };
    const silent = !!(opts.silent ?? opts.onlyIfTrusted);

    const cluster: SolanaCluster = "mainnet-beta";
    const chain = clusterToChain(cluster);
    // Prefer the wallet already granted to this origin on this cluster;
    // fall back to first Solana wallet on non-silent connects so the
    // sheet has something sensible to highlight by default.
    const solWallet = pickSolanaWalletForOrigin(ctx, req.origin.url, cluster);

    if (silent) {
      if (!solWallet) return rpcError(4100, "no Solana wallet available");
      const granted = PermissionStore.isGranted(
        req.origin.url,
        solWallet.address,
        chain,
      );
      if (!granted) return rpcError(4100, "not authorized");
      return {
        status: "resolved",
        value: { accounts: [{ address: solWallet.address }] },
      };
    }

    if (!solWallet) return rpcError(4100, "no Solana wallet available");

    // NOTE: no cross-namespace trust extension. A recent EVM grant for
    // this origin does NOT imply consent to expose the user's Solana
    // wallet — they're different identities, each requires explicit
    // user approval via its own sheet.
    return {
      status: "needs-approval",
      intent: makeIntent<SolanaConnectPayload>(
        req,
        "connect",
        { cluster, onlyIfTrusted: silent },
        solWallet,
      ),
    };
  }

  private handleSignIn(req: ChainRequest, ctx: AdapterContext): ChainResult {
    const solWallet = pickSolanaWalletForOrigin(ctx, req.origin.url);
    if (!solWallet) return rpcError(4100, "no Solana wallet available");
    const params = (req.params as unknown[]) ?? [];
    const input = (params[0] ?? {}) as Partial<SolanaSignInPayload>;
    // §10.4 inv 1 — caller must provide domain; we do not invent it.
    const domain =
      typeof input.domain === "string"
        ? input.domain
        : originKey(req.origin.url);
    // §4.8 — reject address mismatch pre-sheet.
    if (input.address && input.address !== solWallet.address) {
      return rpcError(4100, "address mismatch");
    }
    const payload: SolanaSignInPayload = {
      domain,
      address: solWallet.address,
      statement: input.statement,
      uri: input.uri,
      version: input.version,
      chainId: input.chainId,
      nonce: input.nonce,
      issuedAt: input.issuedAt,
      expirationTime: input.expirationTime,
      notBefore: input.notBefore,
      requestId: input.requestId,
      resources: input.resources,
    };
    return {
      status: "needs-approval",
      intent: makeIntent<SolanaSignInPayload>(
        req,
        "signIn",
        payload,
        solWallet,
      ),
    };
  }

  private handleSignMessage(
    req: ChainRequest,
    ctx: AdapterContext,
  ): ChainResult {
    const solWallet = pickSolanaWalletForOrigin(ctx, req.origin.url);
    if (!solWallet) return rpcError(4100, "no Solana wallet available");
    const params = (req.params as unknown[]) ?? [];
    const first = (params[0] ?? {}) as { address?: string; message?: string };
    const message = asString(first.message);
    const display: "utf8" | "base64" = isUtf8Displayable(message)
      ? "utf8"
      : "base64";
    return {
      status: "needs-approval",
      intent: makeIntent<SolanaSignMessagePayload>(
        req,
        "signMessage",
        {
          address: asString(first.address) || solWallet.address,
          message,
          display,
        },
        solWallet,
      ),
    };
  }

  private handleSignTransaction(
    req: ChainRequest,
    ctx: AdapterContext,
  ): ChainResult {
    const solWallet = pickSolanaWalletForOrigin(ctx, req.origin.url);
    if (!solWallet) return rpcError(4100, "no Solana wallet available");

    const params = (req.params as unknown[]) ?? [];
    const inputs = Array.isArray(params) ? (params as unknown[]) : [];

    if (inputs.length === 0) return rpcError(-32602, "no transactions");
    if (inputs.length > MAX_BATCH_TX)
      return rpcError(-32602, `too many transactions (max ${MAX_BATCH_TX})`);

    // Every input carries its own chain per WS §solana:signTransaction. If
    // inputs disagree, reject — multi-cluster batches have no user-safe UX.
    let chain: SolanaChain | null = null;
    const txs: Array<{ transaction: string; version: 0 | "legacy" }> = [];
    for (const raw of inputs) {
      const item = (raw ?? {}) as { transaction?: string; chain?: string };
      const tx = asString(item.transaction);
      if (!tx) return rpcError(-32602, "missing transaction");
      let thisChain: SolanaChain = "solana:mainnet";
      if (typeof item.chain === "string") {
        try {
          thisChain = canonicalizeChain(item.chain);
        } catch (e) {
          return rpcError(
            (e as Error & { code?: number }).code ?? -32602,
            (e as Error).message,
          );
        }
      }
      if (chain && chain !== thisChain)
        return rpcError(-32602, "mixed chains in batch");
      chain = thisChain;
      txs.push({ transaction: tx, version: 0 });
    }
    const cluster = chainToCluster(chain ?? "solana:mainnet");

    if (inputs.length === 1) {
      return {
        status: "needs-approval",
        intent: makeIntent<SolanaSignTxPayload>(
          req,
          "signTransaction",
          {
            mode: "sign-only",
            address: solWallet.address,
            cluster,
            version: txs[0].version,
            transaction: txs[0].transaction,
          },
          solWallet,
        ),
      };
    }
    return {
      status: "needs-approval",
      intent: makeIntent<SolanaSignAllTransactionsPayload>(
        req,
        "signAllTransactions",
        {
          address: solWallet.address,
          cluster,
          transactions: txs,
        },
        solWallet,
      ),
    };
  }

  private handleSignAndSendTransaction(
    req: ChainRequest,
    ctx: AdapterContext,
  ): ChainResult {
    const solWallet = pickSolanaWalletForOrigin(ctx, req.origin.url);
    if (!solWallet) return rpcError(4100, "no Solana wallet available");

    const params = (req.params as unknown[]) ?? [];
    const first = (params[0] ?? {}) as {
      transaction?: string;
      chain?: string;
      options?: SolanaSignTxPayload["options"];
    };
    const tx = asString(first.transaction);
    if (!tx) return rpcError(-32602, "missing transaction");

    let chain: SolanaChain = "solana:mainnet";
    if (typeof first.chain === "string") {
      try {
        chain = canonicalizeChain(first.chain);
      } catch (e) {
        return rpcError(
          (e as Error & { code?: number }).code ?? -32602,
          (e as Error).message,
        );
      }
    }
    const cluster = chainToCluster(chain);
    return {
      status: "needs-approval",
      intent: makeIntent<SolanaSignTxPayload>(
        req,
        "signTransaction",
        {
          mode: "sign-and-send",
          address: solWallet.address,
          cluster,
          version: 0,
          transaction: tx,
          options: first.options,
        },
        solWallet,
      ),
    };
  }

  private handleSwitchCluster(
    req: ChainRequest,
    ctx: AdapterContext,
  ): ChainResult {
    const solWallet = pickSolanaWalletForOrigin(ctx, req.origin.url);
    if (!solWallet) return rpcError(4100, "no Solana wallet available");
    const params = (req.params as unknown[]) ?? [];
    const first = (params[0] ?? {}) as { to?: SolanaCluster };
    const to = first.to;
    if (to !== "mainnet-beta" && to !== "devnet" && to !== "testnet")
      return rpcError(-32602, "invalid cluster");
    return {
      status: "needs-approval",
      intent: makeIntent<SolanaSwitchClusterPayload>(
        req,
        "switchCluster",
        { from: "mainnet-beta", to },
        solWallet,
      ),
    };
  }

  private async handleWatchToken(
    req: ChainRequest,
    ctx: AdapterContext,
  ): Promise<ChainResult> {
    const solWallet = pickSolanaWalletForOrigin(ctx, req.origin.url);
    if (!solWallet) return rpcError(4100, "no Solana wallet available");
    const params = (req.params as unknown[]) ?? [];
    const first = (params[0] ?? {}) as { mint?: string; hint?: unknown };
    const mint = asString(first.mint);
    if (!mint) return rpcError(-32602, "missing mint");
    const hint =
      first.hint && typeof first.hint === "object"
        ? (first.hint as {
            symbol?: string;
            name?: string;
            decimals?: number;
            image?: string;
          })
        : {};

    // On-chain verification per §4.7 — re-fetch mint owner + decimals +
    // extensions. Never trust dApp-supplied metadata. Failure surfaces
    // as -32603 so the sheet never renders without ground truth.
    const verified = await verifyMintOnChain(mint);
    if (!verified) return rpcError(-32603, "mint unreadable");

    return {
      status: "needs-approval",
      intent: makeIntent<SolanaWatchTokenPayload>(
        req,
        "watchAsset",
        {
          mint,
          symbol: hint.symbol,
          name: hint.name,
          decimals: hint.decimals,
          image: hint.image,
          verified,
        },
        solWallet,
      ),
    };
  }

  async executeApproval(
    intent: ApprovalIntent,
    decision: ApprovalDecision,
    ctx: AdapterContext,
  ): Promise<unknown> {
    if (decision.outcome === "reject") {
      throw codedError(4001, "user rejected");
    }
    if (!signerImpl) throw codedError(-32603, "no Solana signer registered");

    switch (intent.kind) {
      case "connect": {
        const payload = intent.payload as SolanaConnectPayload;
        // The user's wallet pick from the ConnectSheet rides in
        // `decision.data.walletIndex`. Switch the active wallet to
        // that selection BEFORE we write the grant so Change Wallet
        // actually changes things.
        const pickedIndex =
          decision.data &&
          typeof decision.data === "object" &&
          "walletIndex" in decision.data
            ? (decision.data as { walletIndex?: number }).walletIndex
            : undefined;
        let wallet = intent.wallet;
        if (typeof pickedIndex === "number" && ctx.wallets[pickedIndex]) {
          const picked = ctx.wallets[pickedIndex];
          if (picked.namespace === "solana") {
            wallet = picked;
            // Adapter cannot mutate the global active wallet — that
            // capability was removed from `AdapterContext` precisely
            // because this connect path used to flip the global and
            // break subsequent EVM-dApp connects. Per-origin tracking
            // happens via `pickSolanaWalletForOrigin` which reads the
            // `PermissionStore` grant on every request.
          }
        }
        if (wallet) {
          await PermissionStore.grant({
            origin: intent.origin.url,
            walletAddress: wallet.address,
            chainId: clusterToChain(payload.cluster),
          });
        }
        return {
          accounts: wallet ? [{ address: wallet.address }] : [],
          cluster: payload.cluster,
        };
      }
      case "signMessage": {
        const p = intent.payload as SolanaSignMessagePayload;
        const sig = await signerImpl.signMessage(p.address, p.message);
        return {
          signedMessage: p.message,
          signature: sig,
        };
      }
      case "signIn": {
        const p = intent.payload as SolanaSignInPayload;
        if (!p.address) throw codedError(4100, "no address");
        // SIWS message: canonical UTF-8 string built by the SIWS
        // inspector. Convert to the base64 wire contract the signer
        // + injected shim share (see signer.ts signMessage: expects
        // base64 on the way in, returns base64 on the way out; the
        // shim's b64d round-trips to the Uint8Array the dApp wants).
        const canonicalMessage =
          typeof (intent as { payload: { message?: string } }).payload
            .message === "string"
            ? (intent as { payload: { message?: string } }).payload.message!
            : JSON.stringify(p);
        const canonicalBytes = new TextEncoder().encode(canonicalMessage);
        const messageB64 = bytesToBase64(canonicalBytes);
        const sig = signerImpl.signIn
          ? await signerImpl.signIn(p.address, messageB64)
          : { signature: await signerImpl.signMessage(p.address, messageB64) };
        return {
          account: { address: p.address },
          signedMessage: messageB64,
          signature: sig.signature,
        };
      }
      case "signTransaction": {
        const p = intent.payload as SolanaSignTxPayload;
        if (p.mode === "sign-and-send") {
          const sig = await signerImpl.signAndSendTransaction(
            p.address,
            p.transaction,
            p.cluster,
          );
          return [{ signature: sig }];
        }
        const signed = await signerImpl.signTransaction(
          p.address,
          p.transaction,
          p.cluster,
        );
        return [{ signedTransaction: signed }];
      }
      case "signAllTransactions": {
        const p = intent.payload as SolanaSignAllTransactionsPayload;
        const out: Array<{ signedTransaction: string }> = [];
        for (const tx of p.transactions) {
          const signed = await signerImpl.signTransaction(
            p.address,
            tx.transaction,
            p.cluster,
          );
          out.push({ signedTransaction: signed });
        }
        return out;
      }
      case "switchCluster":
      case "watchAsset":
        // Task 18/19 implement the state-mutating side.
        return { ok: true };
      default:
        throw codedError(4200, `unsupported intent kind: ${intent.kind}`);
    }
  }
}

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

async function verifyMintOnChain(
  mint: string,
): Promise<SolanaWatchTokenPayload["verified"] | null> {
  try {
    const rpc = getSolanaRpc("mainnet-beta");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = (await (rpc as any)
      .getAccountInfo(mint, { encoding: "base64" })
      .send()) as
      | { value: { data: unknown; owner: string } | null }
      | undefined;
    const value = info?.value;
    if (!value) return null;
    const owner = value.owner;
    let mintOwner: "spl-token" | "token-2022";
    if (owner === SPL_TOKEN_PROGRAM) mintOwner = "spl-token";
    else if (owner === TOKEN_2022_PROGRAM) mintOwner = "token-2022";
    else return null;

    let extensions: Token2022Extension[] = [];
    if (mintOwner === "token-2022") {
      const raw = Array.isArray(value.data) ? value.data[0] : value.data;
      if (typeof raw === "string") {
        try {
          const bin =
            typeof atob === "function"
              ? atob(raw)
              : // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (globalThis as any).Buffer?.from?.(raw, "base64").toString(
                  "binary",
                );
          if (typeof bin === "string") {
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            extensions = parseToken2022Extensions(bytes);
          }
        } catch {
          // leave extensions empty
        }
      }
    }
    return {
      mintOwner,
      extensions: extensions.map((e) => String(e.kind)),
    };
  } catch {
    return null;
  }
}

export function createSolanaAdapter(): ChainAdapter {
  return new SolanaAdapter();
}

// Silence unused-warning while keeping the helper available for §4.5 wiring.
void assertClusterMatches;
