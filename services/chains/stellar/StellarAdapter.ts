/**
 * Stellar dApp-bridge adapter — SEP-0043 via Freighter's concrete
 * `postMessage` transport (§1). Real implementation, replacing the
 * `FEATURE_STELLAR_DAPP_BRIDGE`-gated scaffold.
 *
 * Spec references:
 *   - `docs/stellar-dapp-bridge-spec.md` §4 (adapter contract, dispatch
 *     table).
 *   - `docs/stellar-dapp-bridge-spec.md` §11 (security invariants —
 *     TWV-2026-ZZZ).
 *
 * Security gate (TWV-2026-ZZZ — new gate issued with this spec):
 *   - The bridge's Stellar sign path goes through `StellarSignerFns`
 *     registered by `installStellarSigner` ONLY, which reaches the
 *     keypair through `getStellarSignerForWallet` — the single dwell
 *     site already established and address-reverified by
 *     `stellar-chain-support-spec.md` §3.3/§6 (TWV-2026-090 carryover).
 *   - The injected script never sees the raw secret seed or `S…` StrKey.
 *   - Cross-namespace trust is forbidden in `executeApproval`'s connect
 *     path — an existing EVM/Solana/Sui grant for an origin does NOT
 *     silently authorize Stellar access.
 *   - `executeApproval`'s `signTransaction` case re-parses `payload.xdr`
 *     (the original string), never the inspector's `decoded` structural
 *     view, for the actual `tx.sign(keypair)` call.
 *
 * Any PR that adds a new sign path outside `installStellarSigner` →
 * `getStellarSignerForWallet`, returns Stellar keypair material from a
 * public helper, or adds cross-namespace fallback to
 * `pickStellarWalletForOrigin`, MUST cite TWV-2026-ZZZ in the PR
 * description.
 */

import { Networks, TransactionBuilder } from "@stellar/stellar-base";

import type { StellarChainConfig } from "@/constants/configs/chainConfig";
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
import { PermissionStore } from "@/services/permissions/store";
import { assertStellarErrorCode, STELLAR_ERROR_CODES } from "./errorCodes";
import { resolveStellarChainConfigForPassphrase } from "./horizonClient";
import { getStellarInjectedScript } from "./injectedScript";
import {
  chainToNetwork,
  networkToChain,
  type StellarConnectPayload,
  type StellarNetwork,
  type StellarSignMessagePayload,
  type StellarSignTransactionPayload,
} from "./payloads";

// ── Signer registration ─────────────────────────────────────────────────

export interface StellarSignerFns {
  signTransaction: (
    address: string,
    xdr: string,
    networkPassphrase: string,
    opts: {
      submit?: boolean;
      chain: StellarChainConfig;
    },
  ) => Promise<{ signedTxXdr: string; signerAddress: string; hash?: string }>;
  signMessage: (
    address: string,
    message: string,
  ) => Promise<{ signedMessage: string; signerAddress: string }>;
}

let signerImpl: StellarSignerFns | null = null;

export function registerStellarSigner(signer: StellarSignerFns): void {
  signerImpl = signer;
}

/** Test-only escape hatch — clears the registered signer. */
export function __clearStellarSignerForTesting(): void {
  signerImpl = null;
}

// ── Dispatch helpers ───────────────────────────────────────────────────

function rpcError(code: number, message: string, data?: unknown): ChainResult {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    assertStellarErrorCode(code);
  }
  return { status: "error", code, message, data };
}

function codedError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function asString(x: unknown): string {
  return typeof x === "string" ? x : "";
}

function makeIntent<P>(
  req: ChainRequest,
  kind: ApprovalIntent["kind"],
  payload: P,
  wallet: ApprovalIntent["wallet"],
): ApprovalIntent<P> {
  return {
    id: req.id,
    namespace: "stellar",
    kind,
    origin: req.origin,
    wallet,
    payload,
    annotations: [],
    createdAt: Date.now(),
  };
}

/**
 * Find the Stellar wallet that was granted to this origin on this
 * network. Falls back to the first Stellar wallet if no grant exists
 * yet. Lifted from `SuiAdapter#pickSuiWalletForOrigin` verbatim per
 * spec §4.2 — only the chain-id prefix string changes.
 *
 * §11 carryover: cross-namespace isolation. Grants for `eip155:*` /
 * `solana:*` / `sui:*` chainIds are skipped — only `stellar:*` grants
 * surface a candidate wallet.
 */
function pickStellarWalletForOrigin(
  ctx: AdapterContext,
  origin: string,
  network?: StellarNetwork,
): AdapterContext["activeWallet"] | null {
  const stellar = ctx.wallets.filter((w) => w.namespace === "stellar");
  if (stellar.length === 0) return null;
  const targetChain = network ? networkToChain(network) : null;
  const grants = PermissionStore.listByOrigin(origin)
    .filter((g) => {
      if (typeof g.chainId !== "string") return false;
      if (!g.chainId.startsWith("stellar:")) return false;
      return targetChain === null || g.chainId === targetChain;
    })
    .slice()
    .sort((a, b) => (b.grantedAt ?? 0) - (a.grantedAt ?? 0));
  for (const g of grants) {
    const m = stellar.find((w) =>
      addressesEqual("stellar", w.address, g.walletAddress),
    );
    if (m) return m;
  }
  return stellar[0];
}

/**
 * Most-recently-granted network for this origin, defaulting to
 * `"mainnet"` (spec §4.2 — "same default posture as Solana/Sui/the
 * static `supportedChains` fallback"). Used for `REQUEST_NETWORK_DETAILS`
 * — derived from the granted wallet's chain, never `ctx.activeWallet`
 * (`[[feedback_dapp_bridge_isolation]]`).
 */
function resolveGrantedNetwork(origin: string): StellarNetwork {
  const grants = PermissionStore.listByOrigin(origin)
    .filter(
      (g) => typeof g.chainId === "string" && g.chainId.startsWith("stellar:"),
    )
    .slice()
    .sort((a, b) => (b.grantedAt ?? 0) - (a.grantedAt ?? 0));
  for (const g of grants) {
    const net = chainToNetwork(g.chainId as string);
    if (net) return net;
  }
  return "mainnet";
}

function defaultNetworkPassphrase(network: StellarNetwork): string {
  return network === "testnet" ? Networks.TESTNET : Networks.PUBLIC;
}

// ── Adapter ────────────────────────────────────────────────────────────

class StellarAdapter implements ChainAdapter {
  readonly namespace = "stellar" as const;

  getInjectedScript(ctx: AdapterContext): string {
    return getStellarInjectedScript({ sessionNonce: ctx.sessionNonce });
  }

  onStateChange(_ctx: AdapterContext): { injectedJs: string } | null {
    // Freighter has no push-event system (§4.4) — there is no
    // `postMessage` type for "the wallet changed accounts." A wallet
    // switch or grant revocation has nothing to push; every
    // `REQUEST_PUBLIC_KEY`/`REQUEST_NETWORK_DETAILS` the dApp sends next
    // re-reads live `PermissionStore` state (see `handleRequest` below),
    // so there's no client-side cached state to poison in the first
    // place. Returning `null` unconditionally is a real protocol
    // simplification, not a shortcut.
    void _ctx;
    return null;
  }

  async handleRequest(
    req: ChainRequest,
    ctx: AdapterContext,
  ): Promise<ChainResult> {
    try {
      switch (req.method) {
        case "REQUEST_CONNECTION_STATUS":
          return this.handleConnectionStatus();
        case "REQUEST_PUBLIC_KEY":
          return this.handlePublicKey(req, ctx);
        case "REQUEST_ALLOWED_STATUS":
          return this.handleAllowedStatus(req, ctx);
        case "SET_ALLOWED_STATUS":
          return this.handleConnect(req, ctx, true);
        case "REQUEST_ACCESS":
          return this.handleConnect(req, ctx, false);
        case "REQUEST_NETWORK":
        case "REQUEST_NETWORK_DETAILS":
          return this.handleNetworkDetails(req);
        case "SUBMIT_TRANSACTION":
          return this.handleSignTransaction(req, ctx);
        case "SUBMIT_BLOB":
          return this.handleSignMessage(req, ctx);
        case "SUBMIT_AUTH_ENTRY":
          // §0 Soroban non-goal — always declined, never enqueued as an
          // intent. Must still respond (§1.5 — no client timeout on
          // this message type).
          return rpcError(
            STELLAR_ERROR_CODES.UNSUPPORTED,
            "Soroban signing is not supported.",
          );
        case "SUBMIT_TOKEN":
          // §16 future work — deferred out of v1's dispatch table.
          return rpcError(
            STELLAR_ERROR_CODES.UNSUPPORTED,
            "Not supported yet.",
          );
        case "REQUEST_USER_INFO":
          // No public `@stellar/freighter-api` export ever sends this
          // (§1.4) — a fixed decline rather than a silent hang.
          return rpcError(STELLAR_ERROR_CODES.UNSUPPORTED, "Not supported.");
        default:
          return rpcError(
            STELLAR_ERROR_CODES.UNSUPPORTED,
            `method ${req.method} not supported`,
          );
      }
    } catch (e) {
      const code =
        (e as Error & { code?: number }).code ?? STELLAR_ERROR_CODES.INTERNAL;
      return rpcError(code, (e as Error).message);
    }
  }

  private handleConnectionStatus(): ChainResult {
    // Rarely reached — `window.freighter` fast-path (§1.3) answers most
    // callers before this round-trips at all. If the adapter is live,
    // the wallet is "present."
    return { status: "resolved", value: { isConnected: true } };
  }

  private handlePublicKey(req: ChainRequest, ctx: AdapterContext): ChainResult {
    const wallet = pickStellarWalletForOrigin(ctx, req.origin.url);
    if (!wallet) return { status: "resolved", value: { publicKey: "" } };
    const granted = PermissionStore.isGranted(
      req.origin.url,
      wallet.address,
      networkToChain(resolveGrantedNetwork(req.origin.url)),
    );
    // Privacy fix parity with EVM's `eth_accounts` gate — never leak an
    // address the origin hasn't been granted.
    return {
      status: "resolved",
      value: { publicKey: granted ? wallet.address : "" },
    };
  }

  private handleAllowedStatus(
    req: ChainRequest,
    ctx: AdapterContext,
  ): ChainResult {
    const wallet = pickStellarWalletForOrigin(ctx, req.origin.url);
    const isAllowed = !!(
      wallet &&
      PermissionStore.isGranted(
        req.origin.url,
        wallet.address,
        networkToChain(resolveGrantedNetwork(req.origin.url)),
      )
    );
    return { status: "resolved", value: { isAllowed } };
  }

  private handleNetworkDetails(req: ChainRequest): ChainResult {
    const network = resolveGrantedNetwork(req.origin.url);
    const chain = resolveStellarChainConfigForPassphrase(
      defaultNetworkPassphrase(network),
    );
    return {
      status: "resolved",
      value: {
        networkDetails: {
          network: network === "testnet" ? "TESTNET" : "PUBLIC",
          networkUrl: chain.horizonUrl,
          networkPassphrase: defaultNetworkPassphrase(network),
          sorobanRpcUrl: chain.rpcUrl,
        },
      },
    };
  }

  private handleConnect(
    req: ChainRequest,
    ctx: AdapterContext,
    viaSetAllowedStatus: boolean,
  ): ChainResult {
    const network: StellarNetwork = resolveGrantedNetwork(req.origin.url);
    const wallet = pickStellarWalletForOrigin(ctx, req.origin.url, network);
    if (!wallet) {
      return rpcError(
        STELLAR_ERROR_CODES.UNAUTHORIZED,
        "no Stellar wallet available",
      );
    }

    // Silent-reconnect: if a grant already exists, resolve immediately
    // without a sheet — same property `getAddress()`/`isAllowed()`
    // already give dApps that check first (§4.1).
    const granted = PermissionStore.isGranted(
      req.origin.url,
      wallet.address,
      networkToChain(network),
    );
    if (granted) {
      return {
        status: "resolved",
        value: viaSetAllowedStatus
          ? { isAllowed: true }
          : { publicKey: wallet.address },
      };
    }

    // §11 / TWV-2026-ZZZ: NO cross-namespace trust extension. An
    // EVM/Solana/Sui grant for this origin does NOT imply consent to
    // expose the user's Stellar wallet.
    return {
      status: "needs-approval",
      intent: makeIntent<StellarConnectPayload>(
        req,
        "connect",
        { network, viaSetAllowedStatus },
        wallet,
      ),
    };
  }

  private handleSignTransaction(
    req: ChainRequest,
    ctx: AdapterContext,
  ): ChainResult {
    const params = (req.params ?? {}) as {
      transactionXdr?: string;
      network?: string;
      networkPassphrase?: string;
      accountToSign?: string;
      submit?: boolean;
      submitUrl?: string;
    };
    const xdr = asString(params.transactionXdr);
    if (!xdr) {
      return rpcError(
        STELLAR_ERROR_CODES.INVALID_PARAMS,
        "missing transaction XDR",
      );
    }

    const wallet = pickStellarWalletForOrigin(ctx, req.origin.url);
    if (!wallet) {
      return rpcError(
        STELLAR_ERROR_CODES.UNAUTHORIZED,
        "no Stellar wallet available",
      );
    }

    // §1.4 — `accountToSign` lets a multi-account Freighter user pick
    // which account signs. We connect exactly one address per origin
    // (§1.7); a mismatched `accountToSign` is declined rather than
    // silently signing with a different wallet
    // (`[[feedback_dapp_bridge_isolation]]`).
    if (
      params.accountToSign &&
      !addressesEqual("stellar", params.accountToSign, wallet.address)
    ) {
      return rpcError(
        STELLAR_ERROR_CODES.USER_REJECT,
        "The user rejected this request.",
      );
    }

    const networkPassphrase =
      typeof params.networkPassphrase === "string" && params.networkPassphrase
        ? params.networkPassphrase
        : defaultNetworkPassphrase(resolveGrantedNetwork(req.origin.url));

    // Fail fast on unparseable XDR — never enqueue a sheet for a payload
    // that can't be signed (INVALID_PARAMS per §1.1's -3 taxonomy row).
    try {
      TransactionBuilder.fromXDR(xdr, networkPassphrase);
    } catch {
      return rpcError(
        STELLAR_ERROR_CODES.INVALID_PARAMS,
        "malformed transaction XDR",
      );
    }

    return {
      status: "needs-approval",
      intent: makeIntent<StellarSignTransactionPayload>(
        req,
        "signTransaction",
        {
          address: wallet.address,
          networkPassphrase,
          xdr,
          submit: params.submit === true ? true : undefined,
          submitUrl:
            typeof params.submitUrl === "string" ? params.submitUrl : undefined,
        },
        wallet,
      ),
    };
  }

  private handleSignMessage(
    req: ChainRequest,
    ctx: AdapterContext,
  ): ChainResult {
    const params = (req.params ?? {}) as {
      blob?: string;
      networkPassphrase?: string;
      accountToSign?: string;
    };
    const message = asString(params.blob);
    if (!message) {
      return rpcError(STELLAR_ERROR_CODES.INVALID_PARAMS, "missing message");
    }

    const wallet = pickStellarWalletForOrigin(ctx, req.origin.url);
    if (!wallet) {
      return rpcError(
        STELLAR_ERROR_CODES.UNAUTHORIZED,
        "no Stellar wallet available",
      );
    }

    if (
      params.accountToSign &&
      !addressesEqual("stellar", params.accountToSign, wallet.address)
    ) {
      return rpcError(
        STELLAR_ERROR_CODES.USER_REJECT,
        "The user rejected this request.",
      );
    }

    return {
      status: "needs-approval",
      intent: makeIntent<StellarSignMessagePayload>(
        req,
        "signMessage",
        {
          address: wallet.address,
          message,
          networkPassphrase:
            typeof params.networkPassphrase === "string"
              ? params.networkPassphrase
              : undefined,
        },
        wallet,
      ),
    };
  }

  // ── Approval execution ────────────────────────────────────────────

  async executeApproval(
    intent: ApprovalIntent,
    decision: ApprovalDecision,
    _ctx: AdapterContext,
  ): Promise<unknown> {
    void _ctx;
    if (decision.outcome === "reject") {
      throw codedError(STELLAR_ERROR_CODES.USER_REJECT, "user rejected");
    }

    switch (intent.kind) {
      case "connect": {
        const payload = intent.payload as StellarConnectPayload;
        const wallet = intent.wallet;
        if (wallet) {
          await PermissionStore.grant({
            origin: intent.origin.url,
            walletAddress: wallet.address,
            chainId: networkToChain(payload.network),
          });
        }
        return payload.viaSetAllowedStatus
          ? { isAllowed: true }
          : { publicKey: wallet?.address ?? "" };
      }
      case "signMessage": {
        if (!signerImpl) {
          throw codedError(
            STELLAR_ERROR_CODES.INTERNAL,
            "no Stellar signer registered",
          );
        }
        const p = intent.payload as StellarSignMessagePayload;
        const r = await signerImpl.signMessage(p.address, p.message);
        return {
          signedMessage: r.signedMessage,
          signerAddress: r.signerAddress,
        };
      }
      case "signTransaction": {
        if (!signerImpl) {
          throw codedError(
            STELLAR_ERROR_CODES.INTERNAL,
            "no Stellar signer registered",
          );
        }
        const p = intent.payload as StellarSignTransactionPayload;
        // §11 — sign `payload.xdr` (the original string), never a
        // reconstruction from `payload.decoded`. A decoder bug can
        // produce a wrong display; it must never produce a wrong
        // signature.
        const chain = resolveStellarChainConfigForPassphrase(
          p.networkPassphrase,
        );
        const r = await signerImpl.signTransaction(
          p.address,
          p.xdr,
          p.networkPassphrase,
          { submit: p.submit === true, chain },
        );
        const out: {
          signedTransaction: string;
          signerAddress: string;
          hash?: string;
        } = {
          signedTransaction: r.signedTxXdr,
          signerAddress: r.signerAddress,
        };
        if (r.hash) out.hash = r.hash;
        return out;
      }
      default:
        throw codedError(
          STELLAR_ERROR_CODES.UNSUPPORTED,
          `unsupported intent kind: ${intent.kind}`,
        );
    }
  }
}

export { StellarAdapter, pickStellarWalletForOrigin, resolveGrantedNetwork };

export function createStellarAdapter(): ChainAdapter {
  return new StellarAdapter();
}
