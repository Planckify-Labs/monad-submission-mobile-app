import type { WebView } from "react-native-webview";
import { toRpcErrorPayload } from "@/services/chains/evm/errors";
import { ChainAdapterRegistry } from "@/services/chains/registry";
import type {
  AdapterContext,
  ChainRequest,
  Namespace,
  Origin,
} from "@/services/chains/types";
import { originKey } from "@/services/permissions/caip";
import {
  namespaceForChainKey,
  PermissionStore,
} from "@/services/permissions/store";
import type { ApprovalDecision, ApprovalIntent } from "./approval";
import { bridgeEventBus } from "./events";
import { runPipeline, runSingleInspector } from "./inspector";
import { pendingIntentsStore } from "./pendingIntents";
import { redactParams } from "./redact";

// TWV-2026-007: `eth_sign` signs an arbitrary 32-byte hash with no
// structured-data display — any dApp that reaches it is one prompt away
// from a blank-check signature. Hard-reject at the bridge so no approval
// intent is ever created. Rejection is terminal — no user override.
export const HARD_REJECT_METHODS: ReadonlySet<string> = new Set(["eth_sign"]);

interface InFlight {
  resolve: (result: unknown) => void;
  reject: (code: number, message: string, data?: unknown) => void;
  origin: Origin;
  namespace: Namespace;
  method: string;
  startedAt: number;
}

export type ContextProvider = () => AdapterContext;

export interface DappBridgeOpts {
  getContext: ContextProvider;
  getWebView: () => WebView | null;
}

export class DappBridge {
  private inFlight = new Map<string, InFlight>();
  private pendingByOrigin = new Map<string, string>();
  private opts: DappBridgeOpts;
  // TWV-2026-013 — current top-frame origin reported by the WebView's
  // navigation callback. Every dispatched request must declare an
  // origin host that matches this; mismatches are sub-frame attempts.
  private trackedTopOrigin: string | null = null;
  // TWV-2026-015 — current session nonce; rotated on every top-frame
  // navigation. Compared (constant-time) against `__takumi_nonce` on
  // every inbound message; missing or stale → drop silently.
  //
  // `acceptedNonces` is a bounded ring of recent nonces we've issued in
  // THIS WebView session. The security property we need is "reject
  // messages from frames that never saw a main-frame-stamped nonce"
  // (sub-frame forgery under CVE-2020-6506-class XSS). Every nonce in
  // this set is main-frame-stamped, so all of them are legit — we just
  // don't know which one the script's closure happens to have at the
  // moment of the call, because the RN WebView doesn't re-inject on
  // SPA navigation, so `window.__takumi_solana_nonce` / EVM's closure
  // can be N rotations behind when the dApp fires a request.
  //
  // Ring capped at 32 entries — enough for a deep browsing session,
  // small enough to not matter at the bytes level. Origin-pin remains
  // the authoritative cross-frame defense.
  private sessionNonce: string | null = null;
  private acceptedNonces: string[] = [];
  private static readonly NONCE_HISTORY_MAX = 32;

  constructor(opts: DappBridgeOpts) {
    this.opts = opts;
    pendingIntentsStore.onResolve((id, decision) => {
      void this.handleDecision(id, decision);
    });
  }

  /**
   * Rebind opts without touching subscriptions. The screen re-creates the
   * closures backing \`getContext\` and \`getWebView\` on every render; this
   * lets us pick up the fresh closures without ever creating a second
   * bridge (which would stack listeners on \`pendingIntentsStore\` and
   * cause duplicate \`executeApproval\` runs per decision).
   */
  updateOpts(opts: DappBridgeOpts): void {
    this.opts = opts;
  }

  /**
   * TWV-2026-015 — install / rotate the per-session nonce. The screen
   * generates this from the OS CSPRNG at every top-frame load and
   * stamps it into the injected provider script's closure scope.
   *
   * Every rotation is recorded in `acceptedNonces` (bounded ring); the
   * dispatch path accepts any nonce that was once current. See the
   * field comment on `acceptedNonces` for why.
   */
  setSessionNonce(nonce: string | null): void {
    this.sessionNonce = nonce;
    if (nonce !== null && !this.acceptedNonces.includes(nonce)) {
      this.acceptedNonces.push(nonce);
      if (this.acceptedNonces.length > DappBridge.NONCE_HISTORY_MAX) {
        this.acceptedNonces.shift();
      }
    }
  }

  /** Constant-time string equality for nonce comparison. */
  private nonceEquals(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  async dispatch(rawMessage: unknown): Promise<void> {
    const parsed = parseMessage(rawMessage);
    if (!parsed) {
      if (__DEV__) {
        console.warn("[bridge] dispatch drop: parseMessage returned null", {
          rawPreview:
            typeof rawMessage === "string"
              ? rawMessage.slice(0, 120)
              : typeof rawMessage,
        });
      }
      return;
    }
    const { id, namespace, method, params, origin, nonce } = parsed;

    if (__DEV__) {
      console.debug("[bridge] dispatch recv", {
        id,
        namespace,
        method,
        nonceLen: typeof nonce === "string" ? nonce.length : null,
        sessionNonceLen:
          typeof this.sessionNonce === "string"
            ? this.sessionNonce.length
            : null,
      });
    }

    // TWV-2026-015 — silent drop on nonces this session never issued.
    // Accept any nonce from the session-history ring; see `acceptedNonces`
    // field comment for the rationale.
    if (this.sessionNonce !== null) {
      const isKnown =
        typeof nonce === "string" &&
        this.acceptedNonces.some((n) => this.nonceEquals(nonce, n));
      if (!isKnown) {
        if (__DEV__) {
          console.warn("[bridge] dispatch drop: unknown nonce", {
            id,
            method,
            namespace,
            reqNoncePreview:
              typeof nonce === "string" ? `${nonce.slice(0, 6)}…` : null,
            sessionNoncePreview: `${this.sessionNonce.slice(0, 6)}…`,
            historyLen: this.acceptedNonces.length,
          });
        }
        return;
      }
    }

    const adapter = ChainAdapterRegistry.get(namespace);
    if (!adapter) {
      this.postError(id, 4200, `namespace ${namespace} not supported`);
      return;
    }

    const startedAt = Date.now();
    // Register in-flight so approval path can resolve it.
    this.inFlight.set(id, {
      resolve: (value) => this.postResult(id, value),
      reject: (code, message, data) => this.postError(id, code, message, data),
      origin,
      namespace,
      method,
      startedAt,
    });

    bridgeEventBus.emit({
      kind: "request",
      at: startedAt,
      id,
      namespace,
      method,
      origin,
      params: redactParams(method, params),
    });

    if (HARD_REJECT_METHODS.has(method)) {
      this.postError(id, 4200, `${method} is deprecated and unsupported`);
      return;
    }

    // TWV-2026-013 — origin pinning. Reject any request whose declared
    // origin host disagrees with the tracked top-frame host. Sub-frame
    // messages (CVE-2020-6506-class XSS) cannot impersonate the top
    // origin under this check. `trackedTopOrigin === null` means we
    // haven't received a navigation event yet (cold start) — accept,
    // because the alternative is to brick the very first request the
    // page issues at load.
    if (this.trackedTopOrigin !== null) {
      const declaredHost = originKey(origin.url);
      const trackedHost = originKey(this.trackedTopOrigin);
      if (declaredHost !== trackedHost) {
        this.postError(
          id,
          4100,
          `origin mismatch — declared ${declaredHost}, top frame is ${trackedHost}`,
        );
        return;
      }
    }

    try {
      const ctx = this.opts.getContext();
      const req: ChainRequest = {
        id,
        namespace,
        method,
        params,
        origin,
      };
      const result = await adapter.handleRequest(req, ctx);
      if (result.status === "resolved") {
        this.postResult(id, result.value);
        return;
      }
      if (result.status === "error") {
        this.postError(id, result.code, result.message, result.data);
        return;
      }
      await this.enqueue(result.intent);
    } catch (e) {
      const { code, message, data } = toRpcErrorPayload(e);
      this.postError(id, code, message, data);
    }
  }

  async enqueue(intent: ApprovalIntent): Promise<void> {
    const originHost = originKey(intent.origin.url);
    const existing = this.pendingByOrigin.get(originHost);
    if (existing && existing !== intent.id) {
      this.postError(
        intent.id,
        -32002,
        "Resource unavailable — another approval from this origin is pending",
      );
      return;
    }
    this.pendingByOrigin.set(originHost, intent.id);

    const controller = new AbortController();
    const pipeline = await runPipeline(intent, "auto", controller.signal);
    const merged: ApprovalIntent = {
      ...intent,
      annotations: [...intent.annotations, ...pipeline.annotations],
      payload: pipeline.patch
        ? ({
            ...(intent.payload as object),
            ...pipeline.patch,
          } as ApprovalIntent["payload"])
        : intent.payload,
    };

    bridgeEventBus.emit({
      kind: "intent",
      at: Date.now(),
      intent: merged,
      annotations: merged.annotations,
      verdict: pipeline.verdict,
    });

    if (pipeline.verdict === "block") {
      this.pendingByOrigin.delete(originHost);
      this.postError(intent.id, 4001, "Request blocked by wallet policy");
      return;
    }

    pendingIntentsStore.push(merged);
  }

  /** Called by the screen on WebView navigation — enforces §10.4 inv 5. */
  onNavigate(url: string, title?: string): void {
    // TWV-2026-013 — capture top-frame origin for the origin-pin check
    // in `dispatch()`. Updated on every navigation; sub-frame loads
    // never hit this callback because RN-WebView only emits it for the
    // main frame.
    this.trackedTopOrigin = url;
    bridgeEventBus.emit({
      kind: "navigate",
      at: Date.now(),
      url,
      title,
    });
    const newHost = originKey(url);
    for (const intent of pendingIntentsStore.snapshot) {
      const intentHost = originKey(intent.origin.url);
      if (intentHost !== newHost) {
        this.resolve(intent.id, { id: intent.id, outcome: "reject" });
      }
    }
  }

  /**
   * External entry — UI layer (ApprovalHost) delivers the user decision
   * here, which fans out to the adapter's executeApproval.
   */
  resolve(id: string, decision: ApprovalDecision): void {
    pendingIntentsStore.resolve(id, decision);
  }

  /**
   * UI-initiated disconnect. The connection manager sheet calls this when
   * the user revokes a wallet (or a whole site) from the dApps browser.
   *
   * Two effects:
   *   1. Revoke the persisted grant(s) in `PermissionStore` so the next
   *      `standard:connect({silent})` / `eth_accounts` is denied — i.e. no
   *      silent reconnect on the dApp's next visit.
   *   2. If the revoked origin is the live top-frame, push an empty
   *      accounts update into the WebView for each affected namespace so
   *      the injected provider fires the standard wallet→dApp disconnect
   *      event (`accountsChanged []` + `disconnect` on EVM; Wallet-Standard
   *      `change({accounts:[]})` on Solana/Sui). Revokes for a site that
   *      isn't currently open need no event — there's no live session to
   *      notify.
   *
   * `walletAddress` omitted ⇒ disconnect every wallet for the origin.
   */
  async revokeConnection(args: {
    origin: string;
    walletAddress?: string;
  }): Promise<void> {
    // Snapshot the affected grants BEFORE revoke so we know which
    // namespaces' providers need an empty-accounts push.
    const before = PermissionStore.listByOrigin(args.origin);
    await PermissionStore.revoke(args);

    const live =
      this.trackedTopOrigin !== null &&
      originKey(this.trackedTopOrigin) === originKey(args.origin);
    if (!live) return;

    const wanted = args.walletAddress?.toLowerCase();
    const affected = new Set<Namespace>();
    for (const g of before) {
      if (wanted && g.walletAddress.toLowerCase() !== wanted) continue;
      affected.add(namespaceForChainKey(g.chainId));
    }
    for (const ns of affected) this.pushDisconnectForNamespace(ns);
  }

  /**
   * Inject the empty-accounts update for one namespace into the live
   * WebView. Reuses the same injected provider helpers the connect flow
   * drives in `pushPostDecisionUpdate` — pushing an empty account set is
   * exactly what makes each provider emit its disconnect/accounts-changed
   * event. Each helper is guarded with `&&` so a page that never had that
   * namespace's provider installed is a no-op.
   *
   * Stellar has no equivalent push here (`docs/stellar-dapp-bridge-spec.md`
   * §4.4/§1.2) — Freighter's real wire protocol defines no wallet→dApp
   * message type at all, so there is no "emit an accounts-changed event"
   * call to make. A dApp only learns about a revoked grant on its next
   * `getAddress()`/`isConnected()` round trip, which is exactly the
   * limitation real Freighter has too (revoking from the extension's own
   * popup doesn't live-update an already-open dApp tab either). The best
   * available fix for TakumiPay's in-app disconnect action — which real
   * Freighter has no analogue for, since it has no popup UI reachable from
   * inside the WebView — is to reload the page so the dApp re-runs its
   * connection check from scratch, same as a user manually refreshing
   * after revoking a real extension's access.
   */
  private pushDisconnectForNamespace(namespace: Namespace): void {
    const wv = this.opts.getWebView();
    if (!wv) return;
    if (namespace === "eip155") {
      wv.injectJavaScript(
        `try{window._updateEthereumProvider&&window._updateEthereumProvider({selectedAddress:null});}catch(e){}\ntrue;`,
      );
    } else if (namespace === "solana") {
      wv.injectJavaScript(
        `try{window._updateSolanaWallet&&window._updateSolanaWallet({accounts:[]});}catch(e){}\ntrue;`,
      );
    } else if (namespace === "sui") {
      wv.injectJavaScript(
        `try{window._updateSuiWallet&&window._updateSuiWallet({accounts:[]});}catch(e){}\ntrue;`,
      );
    } else if (namespace === "stellar") {
      wv.reload();
    }
  }

  /**
   * Agent entry — lets the agent submit its own intent through the same
   * pipeline. Returns the terminal decision.
   */
  async submitAgentIntent(
    intent: Omit<ApprovalIntent, "annotations"> & {
      annotations?: ApprovalIntent["annotations"];
    },
  ): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const agentOrigin: Origin = {
      ...intent.origin,
      via: "agent",
    };
    const fullIntent: ApprovalIntent = {
      ...intent,
      annotations: intent.annotations ?? [],
      origin: agentOrigin,
    };
    return new Promise((resolve) => {
      this.inFlight.set(intent.id, {
        resolve: (value) => resolve({ result: value }),
        reject: (code, message) => resolve({ error: { code, message } }),
        origin: agentOrigin,
        namespace: intent.namespace,
        method: `agent:${intent.kind}`,
        startedAt: Date.now(),
      });
      bridgeEventBus.emit({
        kind: "request",
        at: Date.now(),
        id: intent.id,
        namespace: intent.namespace,
        method: `agent:${intent.kind}`,
        origin: agentOrigin,
        params: redactParams("agent", intent.payload),
      });
      void this.enqueue(fullIntent);
    });
  }

  async runOnDemandInspector(name: string, intentId: string): Promise<void> {
    const intent = pendingIntentsStore.snapshot.find((i) => i.id === intentId);
    if (!intent) return;
    const controller = new AbortController();
    const res = await runSingleInspector(name, intent, controller.signal);
    if (!res) return;
    // Mutate via a remove+push so subscribers see the update.
    pendingIntentsStore.remove(intentId);
    pendingIntentsStore.push({
      ...intent,
      annotations: [...intent.annotations, ...res.annotations],
    });
  }

  private pushPostDecisionUpdate(
    intent: ApprovalIntent,
    value: unknown,
    adapter: ReturnType<typeof ChainAdapterRegistry.get>,
  ): void {
    if (!adapter) return;
    const wv = this.opts.getWebView();
    if (!wv) return;

    // Fast path — connect returns [address]; inject the state update
    // directly from that so we don't need to wait for React to re-render.
    if (
      intent.kind === "connect" &&
      intent.namespace === "eip155" &&
      Array.isArray(value) &&
      typeof value[0] === "string"
    ) {
      const addr = value[0];
      const chainId = (intent.payload as { chainId?: number }).chainId ?? 1;
      const chainIdHex = `0x${chainId.toString(16)}`;
      wv.injectJavaScript(`
        (function(){
          try {
            window._updateEthereumProvider && window._updateEthereumProvider({
              selectedAddress: ${JSON.stringify(addr)},
              chainId: ${JSON.stringify(chainIdHex)},
              networkVersion: ${JSON.stringify(String(chainId))}
            });
          } catch (e) {}
        })();
        true;
      `);
      return;
    }

    // Fast path — Sui / Solana connect intents carry the user-picked
    // wallet's address inside the response `value.accounts[0].address`
    // (the picker writes `decision.data.walletIndex` and the adapter's
    // `executeApproval` resolves the wallet from that index). The
    // `AdapterContext` intentionally has no `setActiveWallet`, so the
    // slow path's `freshCtx.activeWallet` does NOT reflect the user's
    // pick — re-reading ctx would inject the first-Sui-wallet address
    // and the dApp would receive an `accountsChanged` event for the
    // wrong wallet (reproduces "connected to the wrong wallet" reports
    // on pivy.me et al when picking a non-first Sui wallet).
    //
    // The injected `C1()` helper in each chain's script already calls
    // `setAccounts(accs, chain)` from the response on the connect
    // promise resolution, so this push is redundant for the happy path
    // — but we still want to fire `_updateSuiWallet` / `_updateSolanaWallet`
    // so the Wallet Standard `change` listeners catch a consistent
    // accounts list, mirroring the EVM fast path.
    // Fast path — EVM `wallet_switchEthereumChain`. After the user
    // approves, the adapter has recorded the origin's chain selection
    // per-origin (`OriginChainStore`) — WITHOUT touching the home-screen
    // active chain (Phase 2 isolation) — and EIP-3326 requires the wallet
    // to emit `chainChanged` so the dApp knows to refresh. This fast path
    // emits it keyed off `intent.payload.chainId` (the chain the dApp asked
    // to switch to), no `ctx` / global-active read.
    if (intent.kind === "switchChain" && intent.namespace === "eip155") {
      const chainId = (intent.payload as { chainId?: number }).chainId;
      if (typeof chainId === "number") {
        const chainIdHex = `0x${chainId.toString(16)}`;
        wv.injectJavaScript(`
          (function(){
            try {
              window._updateEthereumProvider && window._updateEthereumProvider({
                chainId: ${JSON.stringify(chainIdHex)},
                networkVersion: ${JSON.stringify(String(chainId))}
              });
            } catch (e) {}
          })();
          true;
        `);
      }
      // EIP-3326: on a successful chain switch the wallet SHOULD "cancel all
      // pending RPC requests and chain-specific user confirmations". Any other
      // approval still queued for this origin was framed under the old chain
      // (a sendTransaction / signTypedData carries a chainId), so approving it
      // now would sign against a chain the dApp already moved off of. Reject
      // and drop those; the dApp can re-request under the new chain.
      for (const p of pendingIntentsStore.snapshot) {
        if (p.id === intent.id || p.origin.url !== intent.origin.url) continue;
        pendingIntentsStore.resolve(p.id, { id: p.id, outcome: "reject" });
        pendingIntentsStore.remove(p.id);
      }
      return;
    }

    if (
      intent.kind === "connect" &&
      (intent.namespace === "sui" || intent.namespace === "solana") &&
      typeof value === "object" &&
      value !== null
    ) {
      const v = value as {
        accounts?: { address?: unknown; publicKey?: unknown }[];
        chain?: unknown;
      };
      const first = v.accounts?.[0];
      const addr =
        first && typeof first.address === "string" ? first.address : null;
      if (addr) {
        if (intent.namespace === "sui") {
          // Sui: thread the real ed25519 publicKey alongside the address
          // so the injected `MA()` helper builds an account with the
          // correct 32-byte pubkey (the address is NOT the pubkey on
          // Sui — see `SuiAdapter.executeApproval` comment). Without
          // this, dApps that read `account.publicKey` to derive the
          // expected address mismatch and reject as "wrong wallet".
          const pk =
            first && typeof first.publicKey === "string"
              ? first.publicKey
              : null;
          const accountsLiteral = `[{address:${JSON.stringify(addr)}${
            pk ? `,publicKey:${JSON.stringify(pk)}` : ""
          }}]`;
          const chain = typeof v.chain === "string" ? v.chain : null;
          const chainArg = chain ? `,chain:${JSON.stringify(chain)}` : "";
          wv.injectJavaScript(`
            try{window._updateSuiWallet&&window._updateSuiWallet({accounts:${accountsLiteral}${chainArg}});}catch(e){}
            true;
          `);
        } else {
          // Solana: address == base58(pubkey), so the injected `MA()`
          // can derive publicKey from address — no extra field needed.
          const accountsLiteral = `[{address:${JSON.stringify(addr)}}]`;
          wv.injectJavaScript(`
            try{window._updateSolanaWallet&&window._updateSolanaWallet({accounts:${accountsLiteral}});}catch(e){}
            true;
          `);
        }
        return;
      }
    }

    // Slow path — delay one tick so setActiveWallet / setActiveChain
    // mutations have a chance to settle before we re-read ctx.
    setTimeout(() => {
      const freshCtx = this.opts.getContext();
      const state = adapter.onStateChange?.(freshCtx);
      const wv2 = this.opts.getWebView();
      if (state?.injectedJs && wv2) wv2.injectJavaScript(state.injectedJs);
    }, 100);
  }

  private async handleDecision(
    id: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const intent = pendingIntentsStore.snapshot.find((i) => i.id === id);
    if (!intent) return;
    const inflight = this.inFlight.get(id);
    const latency = inflight ? Date.now() - inflight.startedAt : 0;

    bridgeEventBus.emit({
      kind: "decision",
      at: Date.now(),
      id,
      outcome: decision.outcome,
      latencyMs: latency,
    });

    const originHost = originKey(intent.origin.url);
    this.pendingByOrigin.delete(originHost);

    if (decision.outcome === "reject") {
      pendingIntentsStore.remove(id);
      this.postError(id, 4001, "User rejected the request");
      return;
    }

    const ctx = this.opts.getContext();
    const adapter = ChainAdapterRegistry.get(intent.namespace);
    if (!adapter) {
      pendingIntentsStore.remove(id);
      this.postError(id, 4200, "adapter not available");
      return;
    }
    try {
      const value = await adapter.executeApproval(intent, decision, ctx);
      pendingIntentsStore.remove(id);
      this.postResult(id, value);
      // Push post-decision provider state into the WebView. For connect
      // specifically we build the update from the returned address rather
      // than the captured ctx — `ctx.activeWallet` reflects the pre-click
      // state until React re-renders, so reading from ctx would inject the
      // OLD address and the dApp would never see `accountsChanged`. The
      // fresh-ctx onStateChange path still runs a tick later to cover
      // chain changes that flow through app-level state.
      this.pushPostDecisionUpdate(intent, value, adapter);
    } catch (e) {
      pendingIntentsStore.remove(id);
      const { code, message, data } = toRpcErrorPayload(e);
      this.postError(id, code, message, data);
    }
  }

  private postResult(id: string, value: unknown): void {
    const inflight = this.inFlight.get(id);
    this.inFlight.delete(id);
    if (inflight?.resolve) {
      bridgeEventBus.emit({
        kind: "result",
        at: Date.now(),
        id,
        ok: true,
        value,
      });
    }
    this.post({ type: "bridge_response", id, result: value, error: null });
  }

  private postError(
    id: string,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const inflight = this.inFlight.get(id);
    this.inFlight.delete(id);
    if (inflight?.reject) {
      bridgeEventBus.emit({
        kind: "result",
        at: Date.now(),
        id,
        ok: false,
        error: { code, message },
      });
    }
    this.post({
      type: "bridge_response",
      id,
      result: null,
      error: { code, message, data },
    });
  }

  private post(payload: Record<string, unknown>): void {
    const wv = this.opts.getWebView();
    if (!wv) return;
    const json = JSON.stringify(payload);
    // Legacy path — for provider scripts that only listen on
    // _handleEthereumResponse via injection.
    wv.postMessage(json);
    wv.injectJavaScript(`
      try { window._handleEthereumResponse && window._handleEthereumResponse(${json}); } catch (e) {}
      true;
    `);
  }
}

function parseMessage(raw: unknown): {
  id: string;
  namespace: Namespace;
  method: string;
  params: unknown;
  origin: Origin;
  /** TWV-2026-015 — closure-stamped session nonce from the injected provider. */
  nonce?: string;
} | null {
  try {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!data || typeof data !== "object") return null;
    const d = data as Record<string, unknown>;
    // Support legacy ethereum_request shape as well as new bridge_request
    if (d.type !== "ethereum_request" && d.type !== "bridge_request")
      return null;
    const id = String(d.id ?? `${Date.now()}-${Math.random()}`);
    const namespace: Namespace =
      (d.namespace as Namespace) ?? ("eip155" as Namespace);
    const method = String(d.method ?? "");
    const params = d.params ?? [];
    // TWV-2026-013 — prefer the JS-declared top-frame origin (signed
    // with the per-session nonce) over the screen-supplied stamp.
    const declaredOrigin = d.__takumi_origin as string | undefined;
    const origin =
      typeof declaredOrigin === "string"
        ? ({ url: declaredOrigin } as Origin)
        : ((d.origin as Origin) ?? ({ url: "" } as Origin));
    const nonce =
      typeof d.__takumi_nonce === "string" ? d.__takumi_nonce : undefined;
    if (!method) return null;
    return { id, namespace, method, params, origin, nonce };
  } catch {
    return null;
  }
}

let bridgeSingleton: DappBridge | null = null;

export function initDappBridge(opts: DappBridgeOpts): DappBridge {
  // Singleton — re-initializing just rebinds opts. Creating a new
  // instance would add a second resolve-listener to pendingIntentsStore
  // and cause every approval to fire executeApproval N times.
  if (bridgeSingleton) {
    bridgeSingleton.updateOpts(opts);
    return bridgeSingleton;
  }
  bridgeSingleton = new DappBridge(opts);
  return bridgeSingleton;
}

export function getDappBridge(): DappBridge | null {
  return bridgeSingleton;
}
