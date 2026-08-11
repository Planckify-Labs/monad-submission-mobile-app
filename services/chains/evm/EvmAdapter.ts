import {
  type Account,
  type Chain,
  createPublicClient,
  createWalletClient,
  fromHex,
  type Hash,
  type Hex,
  hexToString,
  http,
  isAddress,
  isHex,
  type PublicClient,
  toHex,
} from "viem";
import { takumipayLogoBase64 } from "@/constants/takumipay";
import type { TWallet } from "@/constants/types/walletTypes";
import type {
  ApprovalDecision,
  ApprovalIntent,
} from "@/services/bridge/approval";
import { BundleStatusStore } from "@/services/bridge/bundleStatus";
import { NonceTracker } from "@/services/bridge/nonceTracker";
import { guardWalletPresence } from "@/services/bridge/walletPresenceGuard";
import type {
  AdapterContext,
  ChainAdapter,
  ChainRequest,
  ChainResult,
  Origin,
} from "@/services/chains/types";
import { originKey } from "@/services/permissions/caip";
import { PermissionStore } from "@/services/permissions/store";
import { getAccountForWallet } from "@/services/walletService";
import { Bundler, getBundlerConfig, type UserOperation } from "./bundler";
import { type UserChain, UserChainStore } from "./chainStore";
import {
  cachedDappCookies,
  canForwardCookies,
  refreshDappCookies,
} from "./dappCookies";
import { getInstallUuid } from "./eip6963";
// --- TWV-2026-010 — Allowlisted 7702 delegators. The authoritative list
// lives in `./eip7702Guard.ts`; re-exported here for legacy callers
// referencing this name. Bytecode-prologue sniff is also enforced
// at the signing boundary (`execSignAuthorization`).
import {
  decideAuthorizationByAddress,
  decideAuthorizationByBytecode,
  AUTHORIZED_DELEGATORS as EIP7702_ALLOWLIST,
} from "./eip7702Guard";
import { PROVIDER_ERRORS, ProviderRpcError } from "./errors";
import {
  sanitiseChainString,
  sanitiseIconUrl,
  validateBlockExplorerUrls,
} from "./explorerAllowlist";
import { getEvmInjectedScript } from "./injectedScript";
import { OriginChainStore } from "./originChainStore";
import type {
  EvmAddChainPayload,
  EvmAuthorizationPayload,
  EvmBatchCallsPayload,
  EvmConnectPayload,
  EvmSendTxPayload,
  EvmSignMessagePayload,
  EvmSignTypedDataPayload,
  EvmSwitchChainPayload,
  EvmWatchAssetPayload,
  FeeSource,
  GasEstimate,
} from "./payloads";
import { getPaymasterConfig, Paymaster } from "./paymaster";
import { verifySignature } from "./signatureVerifier";

const AUTHORIZED_DELEGATORS = EIP7702_ALLOWLIST;

type ChainConfig = {
  chain: Chain;
  rpcUrl: string;
  /**
   * Extra headers to send on every RPC call to this chain. Set for custom
   * chains served on a dApp's own RPC: we forward the dApp's `Origin` /
   * `Referer` so an Origin-gated RPC proxy doesn't reject the wallet's
   * native fetch as cross-origin. Never set for project-RPC (registered)
   * chains. See docs/design-notes/chain-switch-ux.md.
   */
  fetchHeaders?: Record<string, string>;
};

// Upper bound on the pre-approval gas estimate. The estimate is
// explicitly non-essential (the sheet falls back to dApp-supplied
// values), but it is `await`ed before the approval intent is created,
// so a slow / rate-limited RPC would otherwise gate the whole approval
// sheet behind it. On a 429 the default viem transport honours the
// upstream `Retry-After` header, which on a rate-limited public
// endpoint (e.g. Cloudflare `error code: 1015`) can stall for minutes.
const GAS_ESTIMATE_TIMEOUT_MS = 4000;

/**
 * Resolve `p`, or reject after `ms`. Used to cap non-essential
 * pre-approval RPC reads so a slow / rate-limited endpoint can never
 * block the approval sheet from appearing.
 */
function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("preflight.timeout")), ms),
    ),
  ]);
}

// viem transport for a chain config, forwarding any `fetchHeaders` (custom
// chains carry the dApp's Origin/Referer so an Origin-gated RPC proxy accepts
// the wallet's native fetch). `http`'s own options (retry/timeout) merge in.
function httpTransport(
  config: ChainConfig,
  extra?: { retryCount?: number; timeout?: number },
) {
  return http(config.rpcUrl, {
    ...(extra ?? {}),
    ...(config.fetchHeaders
      ? { fetchOptions: { headers: config.fetchHeaders } }
      : {}),
  });
}

// Scheme+host of a dApp URL, for the forwarded Origin/Referer headers.
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

// Build a ChainConfig for a custom chain served on the dApp's own RPC, with
// the origin forwarded so an Origin-gated proxy doesn't reject us as CORS, plus
// the dApp's session cookies for a cookie-gated proxy — but ONLY to the dApp's
// own origin (never a third-party RPC). Cookies come from the sync cache (warmed
// by the switch probe); we also kick a background refresh to keep them fresh.
function buildCustomConfig(chain: UserChain, originUrl: string): ChainConfig {
  const origin = safeOrigin(originUrl);
  const rpcUrl = chain.rpcUrls[0];
  const headers: Record<string, string> = { Origin: origin, Referer: origin };
  if (canForwardCookies(rpcUrl, origin)) {
    const cookie = cachedDappCookies(origin);
    if (cookie) headers.Cookie = cookie;
    void refreshDappCookies(origin);
  }
  return {
    chain: {
      id: chain.chainId,
      name: chain.chainName,
      nativeCurrency: chain.nativeCurrency,
      rpcUrls: { default: { http: chain.rpcUrls } },
    } as unknown as Chain,
    rpcUrl,
    fetchHeaders: headers,
  };
}

// Reachability probe for a custom chain's RPC before we let an origin switch
// to it: confirms the endpoint answers `eth_chainId` with the claimed id,
// using the forwarded Origin so Origin-gated proxies pass. Returns false on
// any failure (unreachable / cookie-gated / wrong chainId) so the switch fails
// cleanly instead of stranding the dApp on a chain the wallet can't serve.
async function probeRpc(
  rpcUrl: string,
  expectedChainId: number,
  origin: string,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Origin: origin,
      Referer: origin,
    };
    // Cookie-gated proxy: forward the dApp's session cookies, but only to the
    // dApp's own HTTPS origin. This also warms the cache for the serving path.
    if (canForwardCookies(rpcUrl, origin)) {
      const cookie = await refreshDappCookies(origin);
      if (cookie) headers.Cookie = cookie;
    }
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const j = (await res.json()) as { result?: string };
    if (typeof j.result !== "string") return false;
    return Number(fromHex(j.result as Hex, "number")) === expectedChainId;
  } catch {
    return false;
  }
}

export interface EvmAdapterOpts {
  /** Resolves the active viem Chain + RPC for the context's wallet. */
  resolveChainConfig: (ctx: AdapterContext) => ChainConfig | null;
  /**
   * Resolves a *supported* EVM chain by numeric id from the backend
   * `/blockchains` feed, independent of the currently-active chain.
   * The add/switch handlers use this so a chain the project already
   * supports is treated as a first-class network (switched to, served on
   * the project RPC) rather than a dApp-defined custom network whose RPC
   * we would persist. Returns null for chains absent from the feed, and
   * may be undefined when the app hasn't wired a feed source.
   */
  resolveSupportedChain?: (chainId: number) => ChainConfig | null;
  /**
   * Resolves the default EVM chain (backend feed's default row, fallback
   * mainnet) served on the project RPC. Used as the starting chain for an
   * origin that has never switched. Phase 2 keeps dApp chain state fully
   * isolated from the home-screen active chain, so a fresh dApp starts here,
   * NOT on whatever chain the user happens to have active on the home screen.
   */
  resolveDefaultChain?: () => ChainConfig | null;
  /** Appends a token to the user's token-list store. Provided by app. */
  onWatchAsset?: (payload: EvmWatchAssetPayload) => Promise<void>;
  /** Opens the internal tx history screen filtered to a bundle id. */
  onShowCallsStatus?: (bundleId: string) => void;
}

let adapterInstance: EvmAdapter | null = null;

export function getEvmAdapter(): EvmAdapter | null {
  return adapterInstance;
}

export function createEvmAdapter(opts: EvmAdapterOpts): EvmAdapter {
  adapterInstance = new EvmAdapter(opts);
  return adapterInstance;
}

export class EvmAdapter implements ChainAdapter {
  readonly namespace = "eip155" as const;
  private opts: EvmAdapterOpts;

  constructor(opts: EvmAdapterOpts) {
    this.opts = opts;
  }

  /**
   * The chain config for the current request. Prefers the per-origin
   * `chainOverride` stamped by `handleRequest` / `executeApproval` (Phase 2
   * isolation) so reads/txs serve the dApp's SELECTED chain, and only falls
   * back to the app-provided resolver when no override is present (non-bridge
   * callers). The override is what keeps the home-screen active chain out of
   * dApp serving entirely.
   */
  private resolveConfig(ctx: AdapterContext): ChainConfig | null {
    if (ctx.chainOverride) return ctx.chainOverride as ChainConfig;
    return this.opts.resolveChainConfig(ctx);
  }

  /**
   * Resolves the chain an origin is currently on, fully isolated from the
   * home-screen active chain:
   *   selected custom chain  → dApp RPC + forwarded Origin header,
   *   selected registered id → backend feed / project RPC,
   *   nothing selected       → default chain (project RPC).
   */
  private perOriginConfig(originUrl: string): ChainConfig | null {
    const selectedId = OriginChainStore.getSelected(originUrl);
    if (selectedId != null) {
      const custom = UserChainStore.get(selectedId, originUrl);
      if (custom) return buildCustomConfig(custom, originUrl);
      const registered = this.opts.resolveSupportedChain?.(selectedId);
      if (registered) return registered;
      // Selection dangling (chain removed / no longer in feed) — fall through
      // to the default rather than serve a chain we can't resolve.
    }
    // Default chain for a fresh origin. Returning null (e.g. feed not loaded
    // yet) lets `resolveConfig` fall back to the app resolver for that brief
    // window; steady state always has a default, keeping dApp chain state off
    // the home-screen active chain.
    return this.opts.resolveDefaultChain?.() ?? null;
  }

  /**
   * Flags a signing intent when the origin is on a custom chain, so every
   * sign sheet's RiskBanner warns that reads and the simulation on it come
   * from the dApp's own RPC and can't be independently confirmed. The
   * clear-signing DECODE is untouched — it is RPC-independent (it decodes
   * exactly what you sign) and stays fully on; only RPC-derived enrichment
   * is capped as unverified.
   */
  private annotateCustomChain<P>(
    intent: ApprovalIntent<P>,
    originUrl: string,
  ): ApprovalIntent<P> {
    const selectedId = OriginChainStore.getSelected(originUrl);
    if (selectedId != null && UserChainStore.get(selectedId, originUrl)) {
      intent.annotations.push({
        code: "custom-chain.unverified",
        severity: "warn",
        title: "Unverified network",
        detail:
          "This network was added by the site and isn't verified. Balances and previews on it can't be confirmed.",
        source: "local",
      });
    }
    return intent;
  }

  private publicClient(ctx: AdapterContext): PublicClient {
    const config = this.resolveConfig(ctx);
    if (!config) throw PROVIDER_ERRORS.chainNotConnected();
    return createPublicClient({
      chain: config.chain,
      transport: httpTransport(config),
    }) as PublicClient;
  }

  /**
   * Fast-fail client for pre-approval reads (the gas estimate). Unlike
   * `publicClient`, this disables retries and uses a short per-request
   * timeout so a rate-limited endpoint gives up quickly instead of
   * honouring a multi-minute `Retry-After`. The reads it backs are all
   * non-essential — the approval sheet renders with dApp values when
   * they fail — so failing fast is strictly better than blocking.
   */
  private preflightClient(ctx: AdapterContext): PublicClient {
    const config = this.resolveConfig(ctx);
    if (!config) throw PROVIDER_ERRORS.chainNotConnected();
    return createPublicClient({
      chain: config.chain,
      transport: httpTransport(config, { retryCount: 0, timeout: 3000 }),
    }) as PublicClient;
  }

  private walletClient(ctx: AdapterContext, wallet: TWallet) {
    const config = this.resolveConfig(ctx);
    if (!config) throw PROVIDER_ERRORS.chainNotConnected();
    const account = getAccountForWallet(wallet);
    if (!account) throw PROVIDER_ERRORS.internalError("no-account");
    return createWalletClient({
      account: account as Account,
      chain: config.chain,
      transport: httpTransport(config),
    });
  }

  /**
   * Returns a ctx whose `activeWallet` is the wallet this origin has a
   * grant for on the current EVM chain. Falls back to the original ctx
   * when no grant exists (`pickEvmWalletForOrigin`'s fallback covers the
   * "first EVM wallet" / "active-if-EVM" edge cases). Idempotent.
   *
   * See `handleRequest` for the rationale — this replaces the previous
   * implicit coupling where `execConnect` mutated the global active
   * wallet after approval.
   */
  private scopeCtxToOrigin(
    req: ChainRequest,
    ctx: AdapterContext,
  ): AdapterContext {
    // `chainId` is only a tie-breaker between grants now, so an
    // unresolvable chain config (backend feed still in flight on a cold
    // start) no longer forfeits origin scoping entirely — it just picks
    // the origin's wallet without a chain preference. Bailing here used to
    // hand `eth_accounts` the home-screen wallet during that window.
    const config = this.resolveConfig(ctx);
    const effective = pickEvmWalletForOrigin(
      ctx,
      req.origin.url,
      config?.chain.id,
    );
    if (!effective) return ctx;
    if (ctx.activeWallet?.address === effective.address) return ctx;
    return { ...ctx, activeWallet: effective };
  }

  getInjectedScript(ctx: AdapterContext): string {
    const config = this.resolveConfig(ctx);
    const chainIdHex = config ? toHex(config.chain.id) : "0x1";
    const selectedAddress = ctx.activeWallet?.address ?? null;
    return getEvmInjectedScript({
      selectedAddress,
      chainId: chainIdHex,
      networkVersion: String(config?.chain.id ?? 1),
      info: {
        uuid: getInstallUuid(),
        name: "TakumiPay",
        icon: takumipayLogoBase64,
        rdns: "com.takumi.wallet",
      },
      // TWV-2026-015 — closure-scoped nonce; rotated per nav.
      sessionNonce: ctx.sessionNonce,
    });
  }

  onStateChange(_ctx: AdapterContext): { injectedJs: string } | null {
    // Intentionally a no-op. The post-decision slow path used to push
    // `_updateEthereumProvider({selectedAddress, chainId})` built from
    // `ctx.activeWallet` and the global active chain — both of which
    // are home-screen state, not the per-origin state the dApp
    // connected with. After a sign or watch-asset decision this
    // fired an unsolicited `accountsChanged` (and sometimes
    // `chainChanged`) event with whichever wallet/chain the home
    // screen happened to be on at that instant, which could silently
    // flip a dApp away from the wallet it was actually granted
    // permission for.
    //
    // Connect state is pushed by `DappBridge.pushPostDecisionUpdate`'s
    // fast path (built from the response value, origin-correct by
    // construction). Sign* intents don't change provider state. For
    // `wallet_switchEthereumChain`, the dApp reads the new chain off
    // the response promise — no event push needed.
    //
    // See `feedback_dapp_bridge_isolation` memory for the principle.
    void _ctx;
    return null;
  }

  async handleRequest(
    req: ChainRequest,
    ctx: AdapterContext,
  ): Promise<ChainResult> {
    const params = Array.isArray(req.params)
      ? (req.params as unknown[])
      : req.params
        ? [req.params]
        : [];

    // Phase 2 — stamp the per-origin chain BEFORE anything reads it. Every
    // subsequent `resolveConfig(ctx)` (reads, wallet-scoping, tx chainId)
    // then serves the chain THIS origin selected, fully isolated from the
    // home-screen active chain. Set once here so we don't re-resolve per case.
    ctx = {
      ...ctx,
      chainOverride: this.perOriginConfig(req.origin.url) ?? undefined,
    };

    // Origin-scope `ctx.activeWallet` to the wallet this dApp has a grant
    // for. Before `setActiveWallet` was removed from `AdapterContext`,
    // connect-approval flipped the global so subsequent requests saw the
    // right wallet. Now the grant itself is authoritative, but the legacy
    // RPC handlers below still read `ctx.activeWallet` — so we rewrite
    // it here to the per-origin effective wallet. Unconnected origins
    // get `pickEvmWalletForOrigin`'s fallback (global or first EVM
    // wallet), matching pre-refactor behaviour for that edge case too.
    ctx = this.scopeCtxToOrigin(req, ctx);

    try {
      switch (req.method) {
        // ---------- Read / metadata ----------
        case "eth_chainId": {
          const config = this.resolveConfig(ctx);
          if (!config) return err(PROVIDER_ERRORS.chainNotConnected());
          return resolved(toHex(config.chain.id));
        }
        case "net_version": {
          const config = this.resolveConfig(ctx);
          if (!config) return err(PROVIDER_ERRORS.chainNotConnected());
          return resolved(String(config.chain.id));
        }
        case "web3_clientVersion": {
          // Legacy identifier probed by Uniswap's WebAccountsStoreUpdater
          // and other analytics/UX paths. Returning a stable string
          // avoids noisy "Method not supported" warnings in dApp
          // telemetry. Shape matches MetaMask's
          // `MetaMask/v11.x.y/mobile/Chrome/…` pattern, trimmed.
          return resolved("TakumiPay/v1.0.0");
        }
        case "eth_protocolVersion": {
          // Another legacy probe some dApps run; `0x41` = 65 is what
          // MetaMask/Geth return for modern Ethereum. Prevents a
          // second "not supported" warning in the same code path.
          return resolved("0x41");
        }
        case "eth_accounts": {
          // Privacy fix — only disclose when origin has an EIP-2255 grant.
          //
          // Matched per-origin, NOT per-chain: this is the probe every dApp
          // runs on page load to restore its session, and the chain we serve
          // an origin moves on its own (a fresh origin starts on the default
          // chain, an approved `wallet_switchEthereumChain` persists another
          // in `OriginChainStore`). Keying the check on the current chain id
          // meant a connect granted on chain A read back as "not connected"
          // the moment the origin sat on chain B — the dApp lost its
          // connection on the next refresh and never got it back, because
          // the origin's chain selection outlives the page.
          if (!ctx.activeWallet) return resolved([]);
          const allowed = PermissionStore.isGrantedForNamespace(
            req.origin.url,
            ctx.activeWallet.address,
            "eip155",
          );
          return resolved(allowed ? [ctx.activeWallet.address] : []);
        }
        case "eth_blockNumber":
        case "eth_gasPrice":
        case "eth_maxPriorityFeePerGas":
        case "eth_feeHistory":
        case "eth_getBalance":
        case "eth_call":
        case "eth_getCode":
        case "eth_getStorageAt":
        case "eth_getLogs":
        case "eth_getTransactionByHash":
        case "eth_getTransactionReceipt":
        case "eth_estimateGas":
        case "eth_getBlockByNumber":
        case "eth_getBlockByHash":
        case "eth_getTransactionCount": {
          const pc = this.publicClient(ctx);
          const result = await pc.request({
            method: req.method as any,
            params: params as any,
          });
          return resolved(result);
        }

        // ---------- Connect / permissions ----------
        case "eth_requestAccounts":
        case "wallet_requestPermissions": {
          const cfg = this.resolveConfig(ctx);
          if (!cfg) return err(PROVIDER_ERRORS.chainNotConnected());

          // Pick the EVM wallet this origin should see. NEVER route
          // `ctx.activeWallet` when it is non-EVM — we'd return a
          // base58 Solana address to a viem-based dApp, which then
          // rejects the connect entirely.
          const evmWallet = pickEvmWalletForOrigin(
            ctx,
            req.origin.url,
            cfg.chain.id,
          );

          // Zero EVM wallets on the device. `silent: false` because the
          // eager/reconnect probe is `eth_accounts` (handled above, and
          // it answers with an empty list) — reaching this arm means the
          // user actually asked to connect, so a sheet explaining the
          // gap is warranted rather than a bare `disconnected` the dApp
          // renders on its own terms.
          const missing = guardWalletPresence(ctx, "eip155", false, () =>
            makeIntent(
              req,
              "connect",
              { requestedAccounts: 1, chainId: cfg.chain.id },
              null,
            ),
          );
          if (missing) return missing;

          if (!evmWallet) return err(PROVIDER_ERRORS.disconnected());

          // Silent re-connect: if this origin already has a grant for
          // the resolved EVM wallet, return silently. dApps (wagmi
          // eager-connect, yearn, etc.) call eth_requestAccounts /
          // wallet_requestPermissions repeatedly on mount + reconnect;
          // prompting every time would hammer the user with sheets.
          //
          // Chain-independent for the same reason `eth_accounts` is —
          // see the note there. Re-prompting after an approved chain
          // switch is not a stronger check, just a worse one: the user
          // learns to tap through connect sheets they already answered.
          if (
            PermissionStore.isGrantedForNamespace(
              req.origin.url,
              evmWallet.address,
              "eip155",
            )
          ) {
            if (req.method === "eth_requestAccounts") {
              return resolved([evmWallet.address]);
            }
            // wallet_requestPermissions expects the EIP-2255 grant list.
            return resolved(PermissionStore.asEip2255(req.origin.url));
          }

          // NOTE: no cross-namespace trust extension. A recent Solana
          // grant for this origin does NOT imply consent to expose the
          // user's EVM wallet — they're different identities, each
          // requires explicit user approval via its own sheet.

          const payload: EvmConnectPayload = {
            requestedAccounts: 1,
            chainId: cfg.chain.id,
          };
          return needsApproval(makeIntent(req, "connect", payload, evmWallet));
        }
        case "wallet_getPermissions": {
          return resolved(PermissionStore.asEip2255(req.origin.url));
        }
        case "wallet_revokePermissions": {
          await PermissionStore.revoke({ origin: req.origin.url });
          return resolved(null);
        }

        // ---------- Signing ----------
        case "personal_sign": {
          const [message, address] = params as [unknown, unknown];
          if (typeof message !== "string" || typeof address !== "string")
            return err(PROVIDER_ERRORS.invalidParams("personal_sign"));
          if (!isAddress(address))
            return err(PROVIDER_ERRORS.invalidParams("address"));
          if (!ctx.activeWallet) return err(PROVIDER_ERRORS.disconnected());
          if (ctx.activeWallet.address.toLowerCase() !== address.toLowerCase())
            return err(PROVIDER_ERRORS.unauthorized());
          const payload: EvmSignMessagePayload = {
            message,
            display: isHex(message as Hex) ? "hex" : "utf8",
            address: address as `0x${string}`,
          };
          return needsApproval(
            makeIntent(req, "signMessage", payload, ctx.activeWallet, {
              method: "personal_sign",
            }),
          );
        }
        // `eth_sign` is hard-rejected at the bridge (TWV-2026-007 —
        // see HARD_REJECT_METHODS in services/bridge/DappBridge.ts).
        // Intentionally no case here; defence-in-depth below also returns
        // PROVIDER_ERRORS.unsupportedMethod for any method not matched.
        case "eth_signTypedData":
        case "eth_signTypedData_v1":
        case "eth_signTypedData_v3":
        case "eth_signTypedData_v4": {
          const [address, typedDataRaw] = params as [unknown, unknown];
          if (typeof address !== "string" || !isAddress(address))
            return err(PROVIDER_ERRORS.invalidParams("address"));
          if (!ctx.activeWallet) return err(PROVIDER_ERRORS.disconnected());
          if (ctx.activeWallet.address.toLowerCase() !== address.toLowerCase())
            return err(PROVIDER_ERRORS.unauthorized());
          const typedData =
            typeof typedDataRaw === "string"
              ? safeJson(typedDataRaw)
              : typedDataRaw;
          if (!typedData || typeof typedData !== "object")
            return err(PROVIDER_ERRORS.invalidParams("typedData"));
          const payload: EvmSignTypedDataPayload = {
            typedData: typedData as EvmSignTypedDataPayload["typedData"],
            address: address as `0x${string}`,
            method:
              req.method === "eth_signTypedData_v1"
                ? "eth_signTypedData"
                : (req.method as
                    | "eth_signTypedData"
                    | "eth_signTypedData_v3"
                    | "eth_signTypedData_v4"),
          };
          return needsApproval(
            this.annotateCustomChain(
              makeIntent(req, "signTypedData", payload, ctx.activeWallet),
              req.origin.url,
            ),
          );
        }

        // ---------- Transactions ----------
        case "eth_sendTransaction": {
          const [rawTx] = params as [Record<string, unknown>];
          if (!rawTx || typeof rawTx !== "object")
            return err(PROVIDER_ERRORS.invalidParams("tx"));
          if (!ctx.activeWallet) return err(PROVIDER_ERRORS.disconnected());
          const cfg = this.resolveConfig(ctx);
          if (!cfg) return err(PROVIDER_ERRORS.chainNotConnected());
          const normalized = normalizeTx(
            rawTx,
            cfg.chain.id,
            ctx.activeWallet.address as `0x${string}`,
          );
          if ("error" in normalized) return err(normalized.error);

          if (normalized.payload.chainId !== cfg.chain.id) {
            return err(PROVIDER_ERRORS.chainNotConnected());
          }

          // Gas re-estimation side-by-side (task 18). Bounded by a hard
          // timeout on a fast-fail client: the estimate is non-essential
          // but it is awaited before the approval intent is created, so
          // an unbounded read on a rate-limited RPC would leave the user
          // staring at nothing while no sheet appears (viem honours the
          // upstream `Retry-After`, stalling for minutes). Cap it so a
          // slow RPC degrades to "dApp values only" within a few seconds.
          try {
            const pc = this.preflightClient(ctx);
            const estimate = await raceTimeout(
              this.buildGasEstimate(pc, normalized.payload, rawTx),
              GAS_ESTIMATE_TIMEOUT_MS,
            );
            (normalized.payload as { gasEstimate?: GasEstimate }).gasEstimate =
              estimate;
          } catch {
            // non-fatal: sheet will show dApp values only
          }

          return needsApproval(
            this.annotateCustomChain(
              makeIntent(
                req,
                "sendTransaction",
                normalized.payload,
                ctx.activeWallet,
              ),
              req.origin.url,
            ),
          );
        }
        case "eth_sendRawTransaction": {
          // Decode + wrap as a regular send-tx approval.
          const [raw] = params as [unknown];
          if (typeof raw !== "string" || !isHex(raw))
            return err(PROVIDER_ERRORS.invalidParams("raw"));
          if (!ctx.activeWallet) return err(PROVIDER_ERRORS.disconnected());
          // Raw broadcasts are rare and risky; bounce back with a clear
          // invalid params rather than signing a pre-signed tx blindly.
          return err(
            PROVIDER_ERRORS.invalidParams(
              "eth_sendRawTransaction is not supported; use eth_sendTransaction",
            ),
          );
        }

        // ---------- Chains ----------
        case "wallet_addEthereumChain": {
          const [raw] = params as [Record<string, unknown>];
          const normalized = normalizeAddChain(raw);
          if ("error" in normalized) return err(normalized.error);
          // EIP-3085: for a chainId the wallet already recognizes, return
          // null (no-op) rather than duplicating it. A chain present in the
          // backend `/blockchains` feed is a first-class supported network —
          // we NEVER persist the dApp's rpcUrls for it. Reads/signing stay on
          // the project RPC via resolveChainConfig; the dApp's follow-up
          // `wallet_switchEthereumChain` handles activation. This keeps the
          // approval-UI trust inputs (gas, nonce, balance, simulation) on RPC
          // we control (see design-notes/chain-switch-ux.md).
          if (this.opts.resolveSupportedChain?.(normalized.payload.chainId)) {
            return resolved(null);
          }
          // Custom chains are scoped to the origin that added them.
          if (UserChainStore.has(normalized.payload.chainId, req.origin.url)) {
            return resolved(null);
          }
          // Unregistered chain: the project has no RPC for it, so the dApp's
          // rpcUrls are the only option. Treat as a genuine custom-network add
          // and route through approval (custom chains are stored second-class
          // and served on their own RPC — see chainStore + AddChainSheet).
          return needsApproval(
            makeIntent(req, "addChain", normalized.payload, ctx.activeWallet),
          );
        }
        // TWV-2026-017 — review gate. Every switch MUST route through
        // `needsApproval` and emit a fresh sheet; never reuse a prior
        // grant for "this dApp". A PR that adds caching / "remember this
        // choice" / auto-approve flags here is a merge-block — see
        // `docs/design-notes/chain-switch-ux.md`.
        case "wallet_switchEthereumChain": {
          const [raw] = params as [{ chainId?: string }];
          if (!raw?.chainId || typeof raw.chainId !== "string")
            return err(PROVIDER_ERRORS.invalidParams("chainId"));
          let targetId: number;
          try {
            targetId = Number(fromHex(raw.chainId as Hex, "number"));
          } catch {
            return err(PROVIDER_ERRORS.invalidParams("chainId"));
          }
          // EIP-3326: "The chain ID MUST be known to the wallet." We treat a
          // chain as known when it is registered in the backend `/blockchains`
          // feed (a supported network), user-added as a custom chain, or the
          // chain currently resolved for this context. Otherwise 4902 so the
          // dApp knows to call `wallet_addEthereumChain` first.
          const current = this.resolveConfig(ctx);
          const supported = this.opts.resolveSupportedChain?.(targetId) ?? null;
          // Custom chains are scoped to the origin that added them.
          const custom = UserChainStore.get(targetId, req.origin.url);
          const known =
            Boolean(supported) ||
            custom !== null ||
            current?.chain.id === targetId;
          if (!known) return err(PROVIDER_ERRORS.chainNotAdded(targetId));
          // Already the active chain — no-op success.
          if (current?.chain.id === targetId) return resolved(null);
          return needsApproval(
            makeIntent(
              req,
              "switchChain",
              {
                chainId: targetId,
                fromChainId: current?.chain.id,
                fromChainName: current?.chain.name,
                toChainName: supported?.chain.name ?? custom?.chainName,
                toIsCustom: !supported && custom !== null,
              } satisfies EvmSwitchChainPayload,
              ctx.activeWallet,
            ),
          );
        }

        // ---------- Assets ----------
        case "wallet_watchAsset": {
          const [raw] = params as [Record<string, unknown>];
          const normalized = normalizeWatchAsset(raw);
          if ("error" in normalized) return err(normalized.error);
          return needsApproval(
            makeIntent(req, "watchAsset", normalized.payload, ctx.activeWallet),
          );
        }

        // ---------- Batched calls (EIP-5792) ----------
        case "wallet_sendCalls": {
          const [raw] = params as [Record<string, unknown>];
          if (!ctx.activeWallet) return err(PROVIDER_ERRORS.disconnected());
          const cfg = this.resolveConfig(ctx);
          if (!cfg) return err(PROVIDER_ERRORS.chainNotConnected());
          const normalized = normalizeSendCalls(
            raw,
            cfg.chain.id,
            ctx.activeWallet.address as `0x${string}`,
          );
          if ("error" in normalized) return err(normalized.error);
          return needsApproval(
            this.annotateCustomChain(
              makeIntent(
                req,
                "sendCalls",
                normalized.payload,
                ctx.activeWallet,
              ),
              req.origin.url,
            ),
          );
        }
        case "wallet_getCallsStatus": {
          const [bundleId] = params as [string];
          const record = BundleStatusStore.get(bundleId);
          if (!record) {
            return err(
              PROVIDER_ERRORS.invalidParams(`unknown bundle ${bundleId}`),
            );
          }
          return resolved({
            version: "1.0",
            chainId: toHex(record.chainId),
            status:
              record.status === "CONFIRMED"
                ? 200
                : record.status === "FAILED"
                  ? 500
                  : 100,
            receipts: record.receipts
              .filter(
                (r): r is Extract<typeof r, { status: "CONFIRMED" }> =>
                  r.status === "CONFIRMED",
              )
              .map((r) => r.receipt),
            atomic: record.atomic,
          });
        }
        case "wallet_showCallsStatus": {
          const [bundleId] = params as [string];
          this.opts.onShowCallsStatus?.(bundleId);
          return resolved(null);
        }
        case "wallet_getCapabilities": {
          const [addressRaw] = params as [unknown];
          const address =
            typeof addressRaw === "string"
              ? addressRaw
              : ctx.activeWallet?.address;
          if (!address || !isAddress(address))
            return err(PROVIDER_ERRORS.invalidParams("address"));
          const smart =
            ctx.activeWallet &&
            ctx.activeWallet.address.toLowerCase() === address.toLowerCase()
              ? ctx.activeWallet.type === "Smart4337" ||
                ctx.activeWallet.type === "Smart7702"
              : false;
          const cfg = this.resolveConfig(ctx);
          const chainIdHex = cfg ? toHex(cfg.chain.id) : "0x1";
          const paymasterUrl = cfg
            ? getPaymasterConfig(cfg.chain.id)?.url
            : undefined;
          return resolved({
            [address]: {
              [chainIdHex]: {
                atomicBatch: { supported: smart },
                paymasterService: {
                  supported: smart && !!paymasterUrl,
                  url: paymasterUrl,
                },
                auxiliaryFunds: { supported: false },
              },
            },
          });
        }

        // ---------- Subscriptions (defer) ----------
        case "eth_subscribe":
        case "eth_unsubscribe": {
          return err(PROVIDER_ERRORS.unsupportedMethod(req.method));
        }

        default:
          return err(PROVIDER_ERRORS.unsupportedMethod(req.method));
      }
    } catch (e) {
      if (e instanceof ProviderRpcError) return err(e);
      return err(
        PROVIDER_ERRORS.internalError(
          e instanceof Error ? e.message : String(e),
        ),
      );
    }
  }

  async executeApproval(
    intent: ApprovalIntent,
    decision: ApprovalDecision,
    ctx: AdapterContext,
  ): Promise<unknown> {
    if (decision.outcome === "reject") {
      throw PROVIDER_ERRORS.userRejected();
    }

    // Serve execution on the same per-origin chain the request was built
    // under (Phase 2 isolation) — never the home-screen active chain.
    ctx = {
      ...ctx,
      chainOverride: this.perOriginConfig(intent.origin.url) ?? undefined,
    };

    switch (intent.kind) {
      case "connect":
        return this.execConnect(intent, decision, ctx);
      case "signMessage":
        return this.execSignMessage(intent, ctx);
      case "signTypedData":
        return this.execSignTypedData(intent, ctx);
      case "sendTransaction":
        return this.execSendTransaction(intent, ctx);
      case "switchChain":
        return this.execSwitchChain(intent, ctx);
      case "addChain":
        return this.execAddChain(intent, ctx);
      case "watchAsset":
        return this.execWatchAsset(intent);
      case "sendCalls":
        return this.execSendCalls(intent, decision, ctx);
      case "signAuthorization":
        return this.execSignAuthorization(intent, ctx);
      default:
        throw PROVIDER_ERRORS.unsupportedMethod(intent.kind);
    }
  }

  // --- Execution branches ---------------------------------------------------

  private async execConnect(
    intent: ApprovalIntent,
    decision: ApprovalDecision,
    ctx: AdapterContext,
  ): Promise<string[]> {
    const payload = intent.payload as EvmConnectPayload;
    const chosenIndex =
      typeof decision.data === "object" &&
      decision.data !== null &&
      "walletIndex" in decision.data
        ? (decision.data as { walletIndex: number }).walletIndex
        : null;
    let wallet =
      chosenIndex !== null ? ctx.wallets[chosenIndex] : intent.wallet;
    // Guardrail — if the picked wallet is non-EVM (user somehow got a
    // Solana wallet onto the EVM ConnectSheet picker), refuse rather
    // than return a base58 Solana address to a viem-based dApp.
    if (!wallet || wallet.namespace !== "eip155") {
      const fallback = pickEvmWalletForOrigin(
        ctx,
        intent.origin.url,
        payload.chainId,
      );
      if (!fallback) throw PROVIDER_ERRORS.disconnected();
      wallet = fallback;
    }
    // Per-origin grant is the source of truth for "which wallet is this
    // dApp using" — we do NOT flip the global active wallet here (doing
    // so from Solana's symmetric path caused the EVM-breakage incident
    // that motivated removing `setActiveWallet` from `AdapterContext`).
    await PermissionStore.grant({
      origin: intent.origin.url,
      walletAddress: wallet.address,
      chainId: payload.chainId,
    });
    return [wallet.address];
  }

  private async execSignMessage(
    intent: ApprovalIntent,
    ctx: AdapterContext,
  ): Promise<Hex> {
    const payload = intent.payload as EvmSignMessagePayload;
    const wallet = intent.wallet ?? ctx.activeWallet;
    if (!wallet) throw PROVIDER_ERRORS.disconnected();
    const account = getAccountForWallet(wallet);
    if (!account) throw PROVIDER_ERRORS.internalError("no-account");
    if (payload.display === "hex") {
      return account.signMessage({
        message: { raw: payload.message as Hex },
      });
    }
    return account.signMessage({ message: payload.message });
  }

  private async execSignTypedData(
    intent: ApprovalIntent,
    ctx: AdapterContext,
  ): Promise<Hex> {
    const payload = intent.payload as EvmSignTypedDataPayload;
    const wallet = intent.wallet ?? ctx.activeWallet;
    if (!wallet) throw PROVIDER_ERRORS.disconnected();
    const account = getAccountForWallet(wallet);
    if (!account) throw PROVIDER_ERRORS.internalError("no-account");
    return account.signTypedData(payload.typedData as any);
  }

  private async execSendTransaction(
    intent: ApprovalIntent,
    ctx: AdapterContext,
  ): Promise<Hash> {
    const payload = intent.payload as EvmSendTxPayload & {
      gasEstimate?: GasEstimate;
      feeSource?: FeeSource;
    };
    const wallet = intent.wallet ?? ctx.activeWallet;
    if (!wallet) throw PROVIDER_ERRORS.disconnected();

    if (wallet.type === "Smart4337" || wallet.type === "Smart7702") {
      return this.execViaBundler(wallet, [payload], payload.chainId, ctx);
    }

    const client = this.walletClient(ctx, wallet);
    const pc = this.publicClient(ctx);

    // Prefer the user-confirmed gas estimate if the sheet picked one.
    const useEstimate = payload.gasEstimate;
    const tx: Record<string, unknown> = {
      to: payload.to,
      value: payload.value,
      data: payload.data,
      gas: payload.gas,
    };
    if (payload.type === 0) {
      tx.gasPrice =
        useEstimate?.recommended === "wallet"
          ? useEstimate.wallet.gasPrice
          : (payload.gasPrice ?? useEstimate?.wallet.gasPrice);
    } else if (payload.type === 1) {
      tx.gasPrice =
        useEstimate?.recommended === "wallet"
          ? useEstimate.wallet.gasPrice
          : (payload.gasPrice ?? useEstimate?.wallet.gasPrice);
      tx.accessList = payload.accessList;
    } else {
      tx.maxFeePerGas =
        useEstimate?.recommended === "wallet"
          ? useEstimate.wallet.maxFeePerGas
          : (payload.maxFeePerGas ?? useEstimate?.wallet.maxFeePerGas);
      tx.maxPriorityFeePerGas =
        useEstimate?.recommended === "wallet"
          ? useEstimate.wallet.maxPriorityFeePerGas
          : (payload.maxPriorityFeePerGas ??
            useEstimate?.wallet.maxPriorityFeePerGas);
      tx.accessList = payload.accessList;
    }

    if (typeof payload.nonce === "number") {
      tx.nonce = payload.nonce;
    } else {
      const onChain = await pc.getTransactionCount({
        address: wallet.address as `0x${string}`,
      });
      tx.nonce = await NonceTracker.reserveNonce(
        wallet.address,
        payload.chainId,
        onChain,
      );
    }

    const hash = await (client.sendTransaction as any)(tx);
    await NonceTracker.markSubmitted(
      wallet.address,
      payload.chainId,
      tx.nonce as number,
      hash,
      {
        to: payload.to,
        value: payload.value ? toHex(payload.value) : undefined,
        data: payload.data,
        maxFeePerGas:
          payload.type === 2 && payload.maxFeePerGas
            ? toHex(payload.maxFeePerGas)
            : undefined,
        maxPriorityFeePerGas:
          payload.type === 2 && payload.maxPriorityFeePerGas
            ? toHex(payload.maxPriorityFeePerGas)
            : undefined,
        gasPrice:
          payload.type === 0 && payload.gasPrice
            ? toHex(payload.gasPrice)
            : undefined,
      },
    );
    // Poll confirmation off the hot path so the dApp isn't blocked.
    pc.waitForTransactionReceipt({ hash })
      .then(() =>
        NonceTracker.markConfirmed(
          wallet.address,
          payload.chainId,
          tx.nonce as number,
        ),
      )
      .catch(() =>
        NonceTracker.markFailed(
          wallet.address,
          payload.chainId,
          tx.nonce as number,
        ),
      );
    return hash;
  }

  private async execSwitchChain(
    intent: ApprovalIntent,
    _ctx: AdapterContext,
  ): Promise<null> {
    const payload = intent.payload as EvmSwitchChainPayload;
    const origin = intent.origin.url;
    // Custom chains are served on the dApp's own RPC. Probe it first (with
    // the forwarded Origin) so we never strand the dApp on a chain we can't
    // reach — an unreachable / cookie-gated RPC fails cleanly here instead of
    // "switch succeeded" followed by every read erroring.
    const custom = UserChainStore.get(payload.chainId, origin);
    if (custom) {
      const ok = await probeRpc(
        custom.rpcUrls[0],
        payload.chainId,
        safeOrigin(origin),
      );
      if (!ok) throw PROVIDER_ERRORS.chainNotAdded(payload.chainId);
    }
    // Record the origin's selection. This is the ONLY state a switch writes —
    // the home-screen active chain is never touched (Phase 2 isolation).
    OriginChainStore.setSelected(origin, payload.chainId);
    return null;
  }

  private async execAddChain(
    intent: ApprovalIntent,
    _ctx: AdapterContext,
  ): Promise<null> {
    const payload = intent.payload as EvmAddChainPayload;
    const origin = safeOrigin(intent.origin.url);
    // Health check — `eth_chainId` against rpc[0] with 5s timeout. Forward the
    // dApp's Origin/Referer so an Origin-gated RPC proxy accepts the wallet's
    // native fetch (same mechanism used when serving the chain). A cookie/
    // session-gated proxy still fails here, which is the honest outcome: we
    // can't serve a chain we can't reach, so we don't record it.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Origin: origin,
        Referer: origin,
      };
      if (canForwardCookies(payload.rpcUrls[0], origin)) {
        const cookie = await refreshDappCookies(origin);
        if (cookie) headers.Cookie = cookie;
      }
      const res = await fetch(payload.rpcUrls[0], {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const j = await res.json();
      const got = Number(fromHex(j.result as Hex, "number"));
      if (got !== payload.chainId) {
        throw PROVIDER_ERRORS.invalidParams(
          `RPC reports chainId ${got}, expected ${payload.chainId}`,
        );
      }
    } catch (e) {
      if (e instanceof ProviderRpcError) throw e;
      throw PROVIDER_ERRORS.invalidParams(
        `RPC health check failed for ${payload.rpcUrls[0]}`,
      );
    }
    // TWV-2026-049 — validate dApp-supplied explorer / icon / chain
    // strings before persisting. Unverified explorers are stored with
    // a tag so the tx-history UI can require long-press + in-app WebView.
    const explorerValidation = validateBlockExplorerUrls(
      payload.chainId,
      payload.blockExplorerUrls,
    );
    const verifiedExplorerUrls = explorerValidation
      .filter((v) => v.status === "verified")
      .map((v) => v.url);
    const unverifiedExplorerUrls = explorerValidation
      .filter((v) => v.status === "unverified")
      .map((v) => v.url);
    const sanitisedIconUrls = (payload.iconUrls ?? [])
      .map(sanitiseIconUrl)
      .filter((u): u is string => typeof u === "string");
    await UserChainStore.add({
      chainId: payload.chainId,
      chainName: sanitiseChainString(payload.chainName, 64),
      // Scope the custom network to the origin that added it.
      origin: intent.origin.url,
      nativeCurrency: {
        ...payload.nativeCurrency,
        name: sanitiseChainString(payload.nativeCurrency?.name, 32),
        symbol: sanitiseChainString(payload.nativeCurrency?.symbol, 8),
      },
      rpcUrls: payload.rpcUrls,
      blockExplorerUrls: [...verifiedExplorerUrls, ...unverifiedExplorerUrls],
      explorerTrust:
        unverifiedExplorerUrls.length === 0 && verifiedExplorerUrls.length > 0
          ? "verified"
          : "unverified",
      iconUrls: sanitisedIconUrls,
      addedAt: Date.now(),
    });
    return null;
  }

  private async execWatchAsset(intent: ApprovalIntent): Promise<boolean> {
    const payload = intent.payload as EvmWatchAssetPayload;
    if (this.opts.onWatchAsset) {
      await this.opts.onWatchAsset(payload);
    }
    return true;
  }

  private async execSendCalls(
    intent: ApprovalIntent,
    _decision: ApprovalDecision,
    ctx: AdapterContext,
  ): Promise<string> {
    const payload = intent.payload as EvmBatchCallsPayload;
    const wallet = intent.wallet ?? ctx.activeWallet;
    if (!wallet) throw PROVIDER_ERRORS.disconnected();
    const bundleId = randomId();
    const atomic =
      wallet.type === "Smart4337" ||
      (wallet.type === "Smart7702" &&
        wallet.smart7702?.authorizationByChain?.[payload.chainId] !==
          undefined);
    await BundleStatusStore.create({
      bundleId,
      chainId: payload.chainId,
      from: payload.from,
      atomic,
      calls: payload.calls.map((c) => ({
        to: c.to,
        value: c.value ? toHex(c.value) : undefined,
        data: c.data,
      })),
      receipts: payload.calls.map(() => ({ status: "PENDING" })),
      status: "PENDING",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    if (atomic) {
      const hash = await this.execViaBundler(
        wallet,
        payload.calls as EvmSendTxPayload[],
        payload.chainId,
        ctx,
      );
      await BundleStatusStore.update(bundleId, {
        status: "CONFIRMED",
        receipts: payload.calls.map(() => ({
          status: "CONFIRMED",
          receipt: {
            transactionHash: hash,
            status: "0x1",
          },
        })),
      });
      return bundleId;
    }

    // EOA sequential path
    const receipts: Array<{
      status: "CONFIRMED";
      receipt: {
        transactionHash: Hash;
        status: "0x1" | "0x0";
      };
    }> = [];
    let failedAt: number | null = null;
    for (let i = 0; i < payload.calls.length; i++) {
      const call = payload.calls[i];
      try {
        const txHash = await this.execSendTransaction(
          {
            ...intent,
            kind: "sendTransaction",
            payload: {
              type: 2,
              to: call.to,
              from: payload.from,
              value: call.value,
              data: call.data,
              gas: call.gas,
              chainId: payload.chainId,
            } as EvmSendTxPayload,
          },
          ctx,
        );
        receipts.push({
          status: "CONFIRMED",
          receipt: { transactionHash: txHash, status: "0x1" },
        });
      } catch (e) {
        failedAt = i;
        await BundleStatusStore.update(bundleId, {
          status: "FAILED",
          receipts: [
            ...receipts,
            {
              status: "FAILED",
              error: e instanceof Error ? e.message : String(e),
            },
            ...payload.calls
              .slice(i + 1)
              .map(() => ({ status: "PENDING" as const })),
          ],
        });
        break;
      }
    }
    if (failedAt === null) {
      await BundleStatusStore.update(bundleId, {
        status: "CONFIRMED",
        receipts,
      });
    }
    return bundleId;
  }

  private async execViaBundler(
    wallet: TWallet,
    calls: EvmSendTxPayload[] | EvmBatchCallsPayload["calls"],
    chainId: number,
    ctx: AdapterContext,
  ): Promise<Hash> {
    const bundlerConfig = getBundlerConfig(chainId);
    if (!bundlerConfig)
      throw PROVIDER_ERRORS.internalError("no bundler for chain");
    const pc = this.publicClient(ctx);

    // callData encoding: simplified — one call = direct callData; batch goes
    // through the smart account's `executeBatch`. A production impl would
    // branch on the account ABI. For now we build a bare-bones UserOp
    // skeleton and delegate gas fields to the bundler.
    const firstCall = (calls as EvmSendTxPayload[])[0];
    const callData: Hex = (firstCall?.data as Hex) ?? "0x";

    const nonceOnChain = await pc.getTransactionCount({
      address: wallet.address as `0x${string}`,
    });

    const userOp: UserOperation = {
      sender: wallet.address as `0x${string}`,
      nonce: toHex(nonceOnChain),
      initCode: "0x",
      callData,
      callGasLimit: "0x100000",
      verificationGasLimit: "0x100000",
      preVerificationGas: "0x10000",
      maxFeePerGas: "0x59682f00",
      maxPriorityFeePerGas: "0x59682f00",
      paymasterAndData: "0x",
      signature: ("0x" + "00".repeat(65)) as Hex,
    };

    // Paymaster — if wallet opted in.
    const feeSource = (firstCall as { feeSource?: FeeSource } | undefined)
      ?.feeSource;
    if (
      feeSource &&
      feeSource !== "native" &&
      typeof getPaymasterConfig === "function"
    ) {
      const paymasterConfig = getPaymasterConfig(chainId);
      if (paymasterConfig) {
        try {
          const stub = await Paymaster.getStubData(
            paymasterConfig,
            userOp,
            toHex(chainId),
            { sponsored: feeSource === "sponsored" },
          );
          userOp.paymasterAndData = stub.paymasterAndData;
        } catch {
          // Sponsored path explicitly does not silently degrade. If the
          // paymaster rejected, surface an error and let the user retry
          // with feeSource = native.
          throw PROVIDER_ERRORS.internalError(
            "Paymaster rejected sponsorship — try native gas.",
          );
        }
      }
    }

    const gas = await Bundler.estimateUserOpGas(bundlerConfig, userOp);
    userOp.callGasLimit = gas.callGasLimit;
    userOp.verificationGasLimit = gas.verificationGasLimit;
    userOp.preVerificationGas = gas.preVerificationGas;

    if (
      feeSource &&
      feeSource !== "native" &&
      typeof getPaymasterConfig === "function"
    ) {
      const paymasterConfig = getPaymasterConfig(chainId);
      if (paymasterConfig) {
        const data = await Paymaster.getData(
          paymasterConfig,
          userOp,
          toHex(chainId),
          { sponsored: feeSource === "sponsored" },
        );
        userOp.paymasterAndData = data.paymasterAndData;
      }
    }

    // Signing the UserOp hash is ABI-dependent on the account. A production
    // impl would use viem/account-abstraction's account client. We sign the
    // userOpHash via a best-effort path — the EOA signer's personal_sign.
    const account = getAccountForWallet(wallet);
    if (!account) throw PROVIDER_ERRORS.internalError("no signer");
    const userOpHash = await pc.call({
      to: bundlerConfig.entryPoint,
      // getUserOpHash(UserOperation, chainId) selector 0x…
      data: "0x" as Hex,
    });
    const signature = await account.signMessage({
      message: { raw: (userOpHash.data ?? "0x") as Hex },
    });
    userOp.signature = signature;

    const userOpHashSubmitted = await Bundler.sendUserOp(bundlerConfig, userOp);
    const receipt = await Bundler.waitForUserOpReceipt(
      bundlerConfig,
      userOpHashSubmitted,
    );
    return receipt.transactionHash;
  }

  private async execSignAuthorization(
    intent: ApprovalIntent,
    ctx: AdapterContext,
  ): Promise<Hex> {
    const payload = intent.payload as EvmAuthorizationPayload;
    // TWV-2026-010 — allowlist enforced at the signing boundary itself,
    // not just in the UI. A bypass through deeplink / bridge / agent
    // cannot reach the key.
    const addressDecision = decideAuthorizationByAddress(payload.delegator);
    if (!addressDecision.ok) {
      throw PROVIDER_ERRORS.invalidParams(addressDecision.message);
    }
    // Bytecode sniff — skip for zero-address (revoke) since there's no
    // code to inspect. Best-effort: a transport failure does NOT block
    // signing of an allowlisted delegate (we don't want a DoS via RPC
    // outage), but a positive SELFDESTRUCT match always rejects.
    if (
      payload.delegator.toLowerCase() !==
      "0x0000000000000000000000000000000000000000"
    ) {
      try {
        const pc = this.publicClient(ctx);
        const code = (await pc.getCode({ address: payload.delegator })) as
          | `0x${string}`
          | undefined;
        const bytecodeDecision = decideAuthorizationByBytecode(code);
        if (!bytecodeDecision.ok) {
          throw PROVIDER_ERRORS.invalidParams(bytecodeDecision.message);
        }
      } catch (e) {
        if (e instanceof ProviderRpcError) throw e;
        // Transport failure — log and proceed; allowlist already gated.
        if (__DEV__) console.warn("[7702] bytecode sniff failed", e);
      }
    }
    const wallet = intent.wallet ?? ctx.activeWallet;
    if (!wallet) throw PROVIDER_ERRORS.disconnected();
    const account = getAccountForWallet(wallet);
    if (!account) throw PROVIDER_ERRORS.internalError("no signer");
    // Delegate to viem's signAuthorization when available on the account.
    const signFn = (
      account as unknown as {
        signAuthorization?: (params: {
          contractAddress: `0x${string}`;
          chainId: number;
          nonce: number;
        }) => Promise<Hex>;
      }
    ).signAuthorization;
    if (typeof signFn !== "function")
      throw PROVIDER_ERRORS.internalError(
        "account does not support signAuthorization",
      );
    const sig = await signFn({
      contractAddress: payload.delegator,
      chainId: payload.chainId,
      nonce: payload.nonce,
    });
    return sig;
  }

  // --- Public helpers --------------------------------------------------------

  /**
   * Exposed for SIWE / backend auth. Verifies a signature against an address
   * using EOA recover, ERC-1271, or EIP-6492 counterfactual paths in order.
   */
  async verifySignature(params: {
    address: `0x${string}`;
    hash: Hash;
    signature: Hex;
    chainId: number;
  }): Promise<{
    valid: boolean;
    scheme: "ecdsa" | "erc1271" | "eip6492" | null;
  }> {
    // Resolve a public client for the requested chain explicitly — SIWE
    // messages specify their own chainId.
    const chainStored = UserChainStore.get(params.chainId);
    const ctxLike: AdapterContext = {
      activeWallet: null,
      wallets: [],
      getAccount: () => null,
    };
    let pc: PublicClient;
    try {
      pc = this.publicClient(ctxLike);
    } catch {
      if (!chainStored) return { valid: false, scheme: null };
      pc = createPublicClient({
        chain: {
          id: chainStored.chainId,
          name: chainStored.chainName,
          nativeCurrency: chainStored.nativeCurrency,
          rpcUrls: { default: { http: chainStored.rpcUrls } },
        } as unknown as Chain,
        transport: http(chainStored.rpcUrls[0]),
      }) as PublicClient;
    }
    return verifySignature({
      address: params.address,
      hash: params.hash,
      signature: params.signature,
      publicClient: pc,
    });
  }

  private async buildGasEstimate(
    pc: PublicClient,
    payload: EvmSendTxPayload,
    rawTx: Record<string, unknown>,
  ): Promise<GasEstimate> {
    const dAppGas =
      typeof rawTx.gas === "string"
        ? safeBigint(rawTx.gas as string)
        : undefined;
    const dAppMaxFee =
      typeof rawTx.maxFeePerGas === "string"
        ? safeBigint(rawTx.maxFeePerGas as string)
        : undefined;
    const dAppPrio =
      typeof rawTx.maxPriorityFeePerGas === "string"
        ? safeBigint(rawTx.maxPriorityFeePerGas as string)
        : undefined;
    const dAppGasPrice =
      typeof rawTx.gasPrice === "string"
        ? safeBigint(rawTx.gasPrice as string)
        : undefined;

    const walletGas = await pc.estimateGas({
      account: payload.from,
      to: payload.to,
      value: payload.value ?? 0n,
      data: payload.data,
    });

    let walletMaxFee: bigint | undefined;
    let walletPriority: bigint | undefined;
    let walletGasPrice: bigint | undefined;
    if (payload.type === 2) {
      try {
        const fh = await pc.getFeeHistory({
          blockCount: 5,
          rewardPercentiles: [50],
        });
        const baseFee = fh.baseFeePerGas.at(-1) ?? 0n;
        const reward =
          fh.reward?.flat().reduce((a, b) => (a > b ? a : b), 0n) ??
          1_500_000_000n;
        walletPriority = reward;
        walletMaxFee = baseFee * 2n + reward;
      } catch {
        walletPriority = 1_500_000_000n;
        walletMaxFee = 30_000_000_000n;
      }
    } else {
      try {
        walletGasPrice = await pc.getGasPrice();
      } catch {
        walletGasPrice = undefined;
      }
    }

    const recommended = decideRecommended(
      payload.type === 2 ? dAppMaxFee : dAppGasPrice,
      payload.type === 2 ? walletMaxFee : walletGasPrice,
      dAppGas,
      walletGas,
    );
    const rationale = buildRationale(
      recommended,
      dAppGas,
      walletGas,
      payload.type === 2 ? dAppMaxFee : dAppGasPrice,
      payload.type === 2 ? walletMaxFee : walletGasPrice,
    );

    return {
      dApp: {
        gas: dAppGas,
        maxFeePerGas: dAppMaxFee,
        maxPriorityFeePerGas: dAppPrio,
        gasPrice: dAppGasPrice,
      },
      wallet: {
        gas: walletGas,
        maxFeePerGas: walletMaxFee,
        maxPriorityFeePerGas: walletPriority,
        gasPrice: walletGasPrice,
      },
      recommended,
      rationale,
    };
  }
}

// --- Helpers ---------------------------------------------------------------

function resolved(value: unknown): ChainResult {
  return { status: "resolved", value };
}
function needsApproval(intent: ApprovalIntent): ChainResult {
  return { status: "needs-approval", intent };
}
function err(e: ProviderRpcError): ChainResult {
  return { status: "error", code: e.code, message: e.message, data: e.data };
}

/**
 * Find an EVM wallet for this origin. Prefers the wallet previously
 * granted to this origin on this chain; falls back to active wallet if
 * it is EVM; then to the first EVM wallet in the list.
 *
 * This decouples the EVM adapter from `ctx.activeWallet` when the user
 * currently has a non-EVM (e.g. Solana) wallet selected in the UI.
 * Returning the user's Solana address to an EVM dApp produces
 * `viem: Address "Gspcn..." is invalid` at the dApp's address validator
 * — the dApp receives a "connect success" but immediately errors.
 */
function pickEvmWalletForOrigin(
  ctx: AdapterContext,
  origin: string,
  chainId?: number,
): TWallet | null {
  const evmWallets = ctx.wallets.filter((w) => w.namespace === "eip155");
  if (evmWallets.length === 0) return null;
  // Every EVM grant this origin holds, current chain first. Filtering to
  // `g.chainId === chainId` (as this did) dropped the origin's real wallet
  // the moment it moved to another chain, so the caller silently fell
  // through to "first EVM wallet" and the dApp saw a wallet swap it never
  // asked for. Account access spans the family; the chain only decides
  // which grant is the most specific match.
  const grants = PermissionStore.listByOriginForNamespace(origin, "eip155");
  const ordered =
    chainId === undefined
      ? grants
      : [
          ...grants.filter((g) => g.chainId === chainId),
          ...grants.filter((g) => g.chainId !== chainId),
        ];
  for (const g of ordered) {
    const match = evmWallets.find(
      (w) => w.address.toLowerCase() === g.walletAddress.toLowerCase(),
    );
    if (match) return match;
  }
  if (ctx.activeWallet && ctx.activeWallet.namespace === "eip155") {
    return ctx.activeWallet;
  }
  return evmWallets[0];
}

function makeIntent<P>(
  req: ChainRequest,
  kind: ApprovalIntent["kind"],
  payload: P,
  wallet: TWallet | null,
  extra?: Record<string, unknown>,
): ApprovalIntent<P & Record<string, unknown>> {
  return {
    id: req.id,
    namespace: "eip155",
    kind,
    origin: req.origin,
    wallet,
    payload: { ...(payload as object), ...(extra ?? {}) } as P &
      Record<string, unknown>,
    annotations: [],
    createdAt: Date.now(),
  };
}

function normalizeTx(
  raw: Record<string, unknown>,
  chainId: number,
  from: `0x${string}`,
):
  | {
      payload: EvmSendTxPayload;
    }
  | { error: ProviderRpcError } {
  try {
    const to = raw.to as `0x${string}` | undefined;
    if (!to || !isAddress(to))
      return { error: PROVIDER_ERRORS.invalidParams("to") };
    const value = raw.value ? safeBigint(raw.value as string) : undefined;
    const data = (raw.data ?? raw.input) as Hex | undefined;
    const gas = raw.gas ? safeBigint(raw.gas as string) : undefined;
    const maxFeePerGas = raw.maxFeePerGas
      ? safeBigint(raw.maxFeePerGas as string)
      : undefined;
    const maxPriorityFeePerGas = raw.maxPriorityFeePerGas
      ? safeBigint(raw.maxPriorityFeePerGas as string)
      : undefined;
    const gasPrice = raw.gasPrice
      ? safeBigint(raw.gasPrice as string)
      : undefined;
    const accessList = raw.accessList as EvmSendTxPayload extends {
      accessList?: infer A;
    }
      ? A
      : undefined;
    const nonce =
      typeof raw.nonce === "string"
        ? Number(fromHex(raw.nonce as Hex, "number"))
        : typeof raw.nonce === "number"
          ? raw.nonce
          : undefined;
    const explicitType =
      typeof raw.type === "string"
        ? Number(fromHex(raw.type as Hex, "number"))
        : typeof raw.type === "number"
          ? raw.type
          : undefined;

    let type: 0 | 1 | 2;
    if (explicitType === 0 || explicitType === 1 || explicitType === 2) {
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
    return {
      error: PROVIDER_ERRORS.invalidParams(
        e instanceof Error ? e.message : "tx",
      ),
    };
  }
}

function normalizeAddChain(
  raw: Record<string, unknown>,
): { payload: EvmAddChainPayload } | { error: ProviderRpcError } {
  if (!raw || typeof raw !== "object")
    return { error: PROVIDER_ERRORS.invalidParams("addChain") };
  const chainIdHex = raw.chainId as Hex | undefined;
  if (!chainIdHex || !isHex(chainIdHex))
    return { error: PROVIDER_ERRORS.invalidParams("chainId") };
  const chainId = Number(fromHex(chainIdHex, "number"));
  const chainName = raw.chainName as string;
  const nativeCurrency =
    raw.nativeCurrency as EvmAddChainPayload["nativeCurrency"];
  const rpcUrls = raw.rpcUrls as string[] | undefined;
  if (
    !chainName ||
    !nativeCurrency ||
    !Array.isArray(rpcUrls) ||
    rpcUrls.length === 0
  )
    return { error: PROVIDER_ERRORS.invalidParams("addChain fields") };
  return {
    payload: {
      chainId,
      chainName,
      nativeCurrency,
      rpcUrls,
      blockExplorerUrls: raw.blockExplorerUrls as string[] | undefined,
      iconUrls: raw.iconUrls as string[] | undefined,
    },
  };
}

function normalizeWatchAsset(
  raw: Record<string, unknown>,
): { payload: EvmWatchAssetPayload } | { error: ProviderRpcError } {
  if (!raw || typeof raw !== "object")
    return { error: PROVIDER_ERRORS.invalidParams("watchAsset") };
  const type = raw.type as string;
  const options = raw.options as Record<string, unknown>;
  if (!options) return { error: PROVIDER_ERRORS.invalidParams("options") };
  const address = options.address as `0x${string}`;
  const chainId = Number(
    typeof options.chainId === "string"
      ? fromHex(options.chainId as Hex, "number")
      : options.chainId,
  );
  let image = options.image as string | undefined;
  if (image && !image.startsWith("https://")) image = undefined;
  if (!isAddress(address))
    return { error: PROVIDER_ERRORS.invalidParams("address") };
  if (!chainId || Number.isNaN(chainId))
    return { error: PROVIDER_ERRORS.invalidParams("chainId") };
  if (type === "ERC20") {
    const symbol = options.symbol as string;
    const decimals = Number(options.decimals);
    if (!symbol || Number.isNaN(decimals))
      return { error: PROVIDER_ERRORS.invalidParams("symbol/decimals") };
    return {
      payload: { standard: "ERC20", address, symbol, decimals, image, chainId },
    };
  }
  if (type === "ERC721" || type === "ERC1155") {
    return {
      payload: {
        standard: type,
        address,
        tokenId: options.tokenId as string | undefined,
        symbol: options.symbol as string | undefined,
        image,
        chainId,
      },
    };
  }
  return { error: PROVIDER_ERRORS.invalidParams("unsupported type") };
}

function normalizeSendCalls(
  raw: Record<string, unknown>,
  activeChainId: number,
  activeAddress: `0x${string}`,
): { payload: EvmBatchCallsPayload } | { error: ProviderRpcError } {
  if (!raw || typeof raw !== "object")
    return { error: PROVIDER_ERRORS.invalidParams("sendCalls") };
  const version = (raw.version as string) ?? "1.0";
  if (version !== "1.0")
    return { error: PROVIDER_ERRORS.invalidParams("version") };
  const chainIdHex = raw.chainId as Hex | undefined;
  const chainId = chainIdHex
    ? Number(fromHex(chainIdHex, "number"))
    : activeChainId;
  if (chainId !== activeChainId)
    return { error: PROVIDER_ERRORS.chainNotConnected() };
  const from = ((raw.from as string) ?? activeAddress) as `0x${string}`;
  if (from.toLowerCase() !== activeAddress.toLowerCase())
    return { error: PROVIDER_ERRORS.invalidParams("from") };
  const callsRaw = raw.calls as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(callsRaw))
    return { error: PROVIDER_ERRORS.invalidParams("calls") };
  const calls = callsRaw.map((c) => ({
    to: c.to as `0x${string}`,
    value: c.value ? safeBigint(c.value as string) : undefined,
    data: c.data as Hex | undefined,
    gas: c.gas ? safeBigint(c.gas as string) : undefined,
  }));
  return {
    payload: {
      version: "1.0",
      chainId,
      from,
      calls,
      capabilities: raw.capabilities as Record<string, unknown> | undefined,
    },
  };
}

function safeBigint(v: string | number | bigint): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (v.startsWith("0x")) return BigInt(v);
  return BigInt(v);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function decideRecommended(
  dAppFee: bigint | undefined,
  walletFee: bigint | undefined,
  dAppGas: bigint | undefined,
  walletGas: bigint,
): "wallet" | "dApp" {
  if (dAppFee === undefined || dAppGas === undefined) return "wallet";
  if (!walletFee) return "dApp";
  const feeDelta =
    walletFee > dAppFee
      ? Number(((walletFee - dAppFee) * 100n) / dAppFee)
      : Number(((dAppFee - walletFee) * 100n) / (walletFee || 1n));
  const gasDelta =
    walletGas > dAppGas
      ? Number(((walletGas - dAppGas) * 100n) / (dAppGas || 1n))
      : Number(((dAppGas - walletGas) * 100n) / (walletGas || 1n));
  return feeDelta > 10 || gasDelta > 10 ? "wallet" : "dApp";
}

function buildRationale(
  recommended: "wallet" | "dApp",
  dAppGas: bigint | undefined,
  walletGas: bigint,
  dAppFee: bigint | undefined,
  walletFee: bigint | undefined,
): string {
  if (recommended === "dApp")
    return "dApp values are within 10% of wallet estimate.";
  if (!dAppFee || !dAppGas)
    return "dApp omitted gas fields; using wallet estimate.";
  if (walletFee && dAppFee && walletFee > dAppFee) {
    return `dApp fee is ${Number(((walletFee - dAppFee) * 100n) / dAppFee)}% below wallet estimate; transaction may not confirm.`;
  }
  if (walletGas > dAppGas) {
    return `dApp gas is ${Number(((walletGas - dAppGas) * 100n) / dAppGas)}% below wallet estimate.`;
  }
  return "Wallet recommends its estimate.";
}

// --- Origin helper re-export ------------------------------------------------

export function normalizeOrigin(origin: Origin): Origin {
  return { ...origin, url: originKey(origin.url) };
}

// --- Re-exports for convenience --------------------------------------------

export {
  PROVIDER_ERRORS,
  ProviderRpcError,
} from "./errors";
