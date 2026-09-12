/**
 * WalletConnect v2 transport — deep-link spec §7.
 *
 * Wallet SDK: `@reown/walletkit` over `@walletconnect/core` with the
 * encrypted MMKV storage + keychain from `./storage.ts` (§7.2). The
 * transport is dumb by design: proposals become the chain adapters' own
 * `connect` requests, `session_request`s become `ChainRequest`s through
 * the kits' `walletConnectCodec`, and every answer is what the adapter
 * returned, re-shaped by the same codec. Nothing here signs, picks a
 * wallet, or names a chain.
 *
 * `import "@walletconnect/react-native-compat"` must precede any
 * `@reown/*` / `@walletconnect/*` import (vendor rule) — it is the first
 * import below.
 */

import "@walletconnect/react-native-compat";
import {
  type IWalletKit,
  WalletKit,
  type WalletKitTypes,
} from "@reown/walletkit";
import { Core } from "@walletconnect/core";
import type { SessionTypes } from "@walletconnect/types";
import {
  buildApprovedNamespaces,
  buildAuthObject,
  getSdkError,
  parseUri,
  populateAuthPayload,
} from "@walletconnect/utils";
import { AppState, type AppStateStatus } from "react-native";
import type { MMKV } from "react-native-mmkv";
import { APP_SCHEME } from "@/constants/appVariant";
import { track } from "@/services/analytics/posthog";
import { readActiveBlockchainRows } from "@/services/blockchains/cache";
import { getDappBridge } from "@/services/bridge/DappBridge";
import { OriginChainStore } from "@/services/chains/evm/originChainStore";
import type { Namespace, Origin } from "@/services/chains/types";
import { chainConfigsForNamespace } from "@/services/deeplinks/chainResolve";
import {
  FEATURE_WALLETCONNECT,
  FEATURE_WALLETCONNECT_LINK_MODE,
} from "@/services/deeplinks/flags";
import { deepLinkNotices } from "@/services/deeplinks/notices";
import { originKeyFor } from "@/services/deeplinks/originKey";
import { returnToCaller } from "@/services/deeplinks/returnToCaller";
import type { Provenance } from "@/services/deeplinks/types";
import { fireNotification } from "@/services/notifications/handlers";
import { PermissionStore } from "@/services/permissions/store";
import { isFlaggedHost } from "@/services/security/scamDomainFeed";
import { walletKitRegistry } from "@/services/walletKit/registry";
import { suiAccountsForSession } from "@/services/walletKit/sui/walletConnect";
import type { PairResult, TransportAdapter, TransportSession } from "../types";
import { isLinkModeEnvelope } from "./deeplinks";
import { registerWalletConnectPush } from "./push";
import { createWcKeychain, createWcStorage, openWcMmkv } from "./storage";

/** An approval sheet not decided within this window is rejected (§7.4). */
export const WC_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
/** Pending-request cap shared with the bridge's own queue caps. */
const SESSION_ORIGIN_PREFIX = "session-origin:";
const SESSION_VERIFY_PREFIX = "session-verify:";

const METADATA: WalletKitTypes.Metadata = {
  name: "TakumiPay",
  description: "TakumiPay multi-chain wallet",
  url: "https://takumipay.xyz",
  icons: ["https://takumipay.xyz/icon.png"],
  redirect: {
    native: `${APP_SCHEME}://`,
    universal: "https://takumipay.xyz/wc",
    ...(FEATURE_WALLETCONNECT_LINK_MODE ? { linkMode: true } : {}),
  },
};

export interface WalletConnectWalletsSource {
  getWallets: () => import("@/constants/types/walletTypes").TWallet[];
}

type Verified = {
  validation: "VALID" | "INVALID" | "UNKNOWN";
  isScam: boolean;
  origin: string;
};

function verifiedOf(
  ctx:
    | { verified?: { validation?: string; isScam?: boolean; origin?: string } }
    | undefined,
): Verified {
  const v = ctx?.verified;
  const validation =
    v?.validation === "VALID" || v?.validation === "INVALID"
      ? v.validation
      : "UNKNOWN";
  return { validation, isScam: v?.isScam === true, origin: v?.origin ?? "" };
}

function provenanceFrom(
  v: Verified,
  claimedOrigin: string | undefined,
  firstSeen: boolean,
): Provenance {
  return {
    claimedOrigin,
    verification: {
      kind: "wc-verify",
      validation: v.validation,
      isScam: v.isScam,
    },
    firstSeen,
    transport: "walletconnect",
  };
}

function peerHost(url: string | undefined): string {
  if (!url) return "";
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url);
  return (m?.[1] ?? url).toLowerCase();
}

class WalletConnectTransport implements TransportAdapter {
  readonly id = "walletconnect" as const;
  private kit: IWalletKit | null = null;
  private mmkv: MMKV | null = null;
  private starting: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  /** Pairing topics that arrived through a deep link (redirect rule, §7.3 step 4). */
  private deepLinkPairings = new Set<string>();
  /**
   * Session topics a dApp deep-linked us for (`…/wc?requestId=&sessionTopic=`),
   * with the time it did. A request answered on such a topic hands the
   * user back to the dApp; the entry is dropped once used or stale.
   */
  private wakeTopics = new Map<string, number>();
  private appStateSub: { remove: () => void } | null = null;
  private pendingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private walletsSource: WalletConnectWalletsSource = { getWallets: () => [] };

  bindWallets(source: WalletConnectWalletsSource): void {
    this.walletsSource = source;
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // ignore
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get isStarted(): boolean {
    return this.kit !== null;
  }

  /** Cheap check for the eager-start rule without initialising the SDK. */
  async hasStoredSessions(): Promise<boolean> {
    try {
      const mmkv = await openWcMmkv();
      return mmkv
        .getAllKeys()
        .some((k) => k.startsWith("kv:") && k.includes("session"));
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (!FEATURE_WALLETCONNECT) return;
    if (this.kit) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const projectId = process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID;
      if (!projectId) {
        if (__DEV__)
          console.warn(
            "[wc] EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID is not set; transport disabled",
          );
        return;
      }
      const mmkv = await openWcMmkv();
      this.mmkv = mmkv;
      const core = new Core({
        projectId,
        storage: createWcStorage(mmkv) as never,
        keychain: createWcKeychain(mmkv) as never,
      });
      const kit = await WalletKit.init({ core, metadata: METADATA });
      kit.on("session_proposal", (args) => void this.onProposal(args));
      kit.on("session_authenticate", (args) => void this.onAuthenticate(args));
      kit.on("session_request", (args) => void this.onRequest(args));
      kit.on("session_delete", (args) => void this.onDelete(args));
      kit.on("session_request_expire", ({ id }) => this.expireRequest(id));
      this.kit = kit;
      // The relay socket rarely survives a long background stretch; the
      // core reconnects on its own heartbeat, but kicking it on foreground
      // gets a request that was queued at the relay onto the screen now
      // rather than a few seconds later.
      this.appStateSub?.remove();
      this.appStateSub = AppState.addEventListener("change", (s) =>
        this.onAppState(s),
      );
      void registerWalletConnectPush(kit);
      this.notify();
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.kit = null;
    this.notify();
  }

  private onAppState(state: AppStateStatus): void {
    if (state !== "active") return;
    this.reconnectRelay();
  }

  private reconnectRelay(): void {
    const relayer = this.kit?.core.relayer;
    if (!relayer || relayer.connected) return;
    relayer.restartTransport().catch((e) => {
      if (__DEV__) console.warn("[wc] relay restart failed", e);
    });
  }

  /**
   * A dApp opened `<wallet link>/wc?requestId=&sessionTopic=` (the
   * sign-client's redirect when it sends a request). Make sure the SDK is
   * up and the relay is connected so the request lands, and remember the
   * topic so answering it returns the user to the dApp.
   */
  async wake(w: { topic: string; requestId: string }): Promise<void> {
    this.wakeTopics.set(w.topic, Date.now());
    await this.start();
    this.reconnectRelay();
  }

  /** `true` once per wake: the user came from the dApp for this topic. */
  private consumeWake(topic: string): boolean {
    const at = this.wakeTopics.get(topic);
    if (at === undefined) return false;
    this.wakeTopics.delete(topic);
    return Date.now() - at < WC_REQUEST_TIMEOUT_MS;
  }

  // ── Pairing ─────────────────────────────────────────────────────────

  async pair(
    uri: string,
    opts: { fromDeepLink: boolean },
  ): Promise<PairResult> {
    if (!FEATURE_WALLETCONNECT) return { ok: false, code: "not_enabled" };
    // Phase 2b (§7.7): a Link Mode envelope (`…/wc?wc_ev=…&topic=…`) is not
    // a pairing. With `redirect.linkMode` on, the SDK registers its own
    // `Linking` listener and dispatches the envelope itself; the kernel
    // only has to make sure the SDK is started.
    if (isLinkModeEnvelope(uri)) {
      await this.start();
      return this.kit ? { ok: true } : { ok: false, code: "not_enabled" };
    }
    let parsed: ReturnType<typeof parseUri>;
    try {
      parsed = parseUri(uri);
    } catch {
      return { ok: false, code: "malformed" };
    }
    if (parsed.version !== 2 || !parsed.topic || !parsed.symKey)
      return { ok: false, code: "malformed" };
    if (parsed.relay?.protocol && parsed.relay.protocol !== "irn")
      return { ok: false, code: "unsupported_operation" };
    if (parsed.expiryTimestamp && parsed.expiryTimestamp * 1000 < Date.now()) {
      return { ok: false, code: "expired" };
    }
    await this.start();
    if (!this.kit) return { ok: false, code: "not_enabled" };
    if (opts.fromDeepLink) this.deepLinkPairings.add(parsed.topic);
    try {
      await this.kit.pair({ uri });
      return { ok: true };
    } catch (e) {
      if (__DEV__) console.warn("[wc] pair failed", e);
      this.deepLinkPairings.delete(parsed.topic);
      return { ok: false, code: "expired" };
    }
  }

  // ── Proposals ───────────────────────────────────────────────────────

  private supportedNamespaces(): Record<
    string,
    {
      chains: string[];
      methods: string[];
      events: string[];
      accounts: string[];
    }
  > {
    const wallets = this.walletsSource.getWallets();
    const rows = readActiveBlockchainRows();
    const out: Record<
      string,
      {
        chains: string[];
        methods: string[];
        events: string[];
        accounts: string[];
      }
    > = {};
    for (const kit of walletKitRegistry.getAll()) {
      if (!kit.walletConnectNamespace) continue;
      const ns = kit.walletConnectNamespace({
        wallets,
        chains: chainConfigsForNamespace(kit.namespace, rows),
      });
      if (ns && ns.chains.length > 0 && ns.accounts.length > 0)
        out[kit.namespace] = ns;
    }
    return out;
  }

  private requestedNamespaces(
    proposal: WalletKitTypes.SessionProposal["params"],
  ): Namespace[] {
    const keys = new Set<string>([
      ...Object.keys(proposal.requiredNamespaces ?? {}),
      ...Object.keys(proposal.optionalNamespaces ?? {}),
    ]);
    // A proposal may key on a full CAIP-2 (`eip155:1`) instead of a namespace.
    return [...keys]
      .map((k) => k.split(":")[0] as Namespace)
      .filter((k, i, a) => a.indexOf(k) === i);
  }

  private async onProposal(
    args: WalletKitTypes.SessionProposal,
  ): Promise<void> {
    const kit = this.kit;
    if (!kit) return;
    const { id, params: proposal, verifyContext } = args;
    const meta = proposal.proposer.metadata;
    const v = verifiedOf(verifyContext);
    const reject = async (key: Parameters<typeof getSdkError>[0]) => {
      try {
        await kit.rejectSession({ id, reason: getSdkError(key) });
      } catch {
        // already gone
      }
    };

    // D-14: scam / flagged → hard block, no override.
    if (v.isScam || isFlaggedHost(meta.url)) {
      await reject("USER_REJECTED");
      deepLinkNotices.push({
        title: "Connection refused",
        body: "This app is flagged as malicious. The wallet will not connect to it.",
      });
      return;
    }

    const originKey = originKeyFor({
      transport: "walletconnect",
      pairingTopic: proposal.pairingTopic,
      verifiedOrigin: v.validation === "VALID" ? v.origin : null,
    });
    const firstSeen = PermissionStore.listByOrigin(originKey).length === 0;
    const provenance = provenanceFrom(v, meta.url, firstSeen);
    const origin: Origin = {
      url: originKey,
      displayUrl: meta.url,
      title: meta.name,
      icon: meta.icons?.[0],
      via: "walletconnect",
    };

    const supported = this.supportedNamespaces();
    const requested = this.requestedNamespaces(proposal);
    const bridge = getDappBridge();
    if (!bridge) {
      await reject("USER_REJECTED");
      return;
    }

    // One `connect` sheet per requested namespace we can serve, through
    // the adapter's own connect request, so the grant lands under the
    // transport origin key exactly as a WebView connect would.
    const approvedByNs: Record<
      string,
      {
        chains: string[];
        methods: string[];
        events: string[];
        accounts: string[];
      }
    > = {};
    for (const ns of requested) {
      const offer = supported[ns];
      const kitAdapter = walletKitRegistry.has(ns)
        ? walletKitRegistry.get(ns)
        : null;
      const codec = kitAdapter?.walletConnectCodec;
      if (!offer || !codec) continue;
      const requestedChains = [
        ...(proposal.requiredNamespaces?.[ns]?.chains ?? []),
        ...(proposal.optionalNamespaces?.[ns]?.chains ?? []),
      ].filter((c) => offer.chains.includes(c));
      const firstChain = requestedChains[0] ?? offer.chains[0];
      const connect = codec.connectRequest(firstChain);
      const res = await bridge.dispatchExternal({
        namespace: ns,
        method: connect.method,
        params: connect.params,
        origin,
        via: "walletconnect",
        provenance,
      });
      if (res.error) continue;
      // The adapter granted the chosen wallet under `originKey`; narrow
      // the offer to that wallet's accounts.
      const grants = PermissionStore.listByOriginForNamespace(originKey, ns);
      const granted = new Set(grants.map((g) => g.walletAddress.toLowerCase()));
      const accounts = offer.accounts.filter((a) =>
        granted.has((a.split(":")[2] ?? "").toLowerCase()),
      );
      if (accounts.length === 0) continue;
      approvedByNs[ns] = { ...offer, accounts };
    }

    if (Object.keys(approvedByNs).length === 0) {
      await reject("USER_REJECTED");
      this.returnAfterDecision(proposal.pairingTopic, meta, "Not connected");
      return;
    }

    let namespaces: SessionTypes.Namespaces;
    try {
      namespaces = buildApprovedNamespaces({
        proposal,
        supportedNamespaces: approvedByNs,
      });
    } catch (e) {
      if (__DEV__)
        console.warn("[wc] buildApprovedNamespaces refused the proposal", e);
      await reject("UNSUPPORTED_CHAINS");
      deepLinkNotices.push({
        title: "Can't connect",
        body: "This app needs a network or wallet type this wallet doesn't have yet.",
      });
      // Undo the grants the sheets created for a session that never formed.
      await PermissionStore.revoke({ origin: originKey });
      return;
    }

    const suiAccounts = suiAccountsForSession(
      Object.values(namespaces).flatMap((n) => n.accounts),
      this.walletsSource.getWallets(),
    );
    try {
      const session = await kit.approveSession({
        id,
        namespaces,
        sessionProperties:
          suiAccounts.length > 0
            ? { sui_getAccounts: JSON.stringify(suiAccounts) }
            : undefined,
      });
      this.mmkv?.set(SESSION_ORIGIN_PREFIX + session.topic, originKey);
      this.mmkv?.set(SESSION_VERIFY_PREFIX + session.topic, JSON.stringify(v));
      track("dapp_connected", {
        chain: Object.keys(namespaces).join(","),
        dapp_host: peerHost(meta.url),
        dapp_name: meta.name,
      });
      track("deeplink_approved", { class: "pair", transport: "walletconnect" });
      this.notify();
      this.returnAfterDecision(proposal.pairingTopic, meta, "Connected");
    } catch (e) {
      if (__DEV__) console.warn("[wc] approveSession failed", e);
      await PermissionStore.revoke({ origin: originKey });
    }
  }

  /**
   * §7.3 step 4 / vendor guidance: only a pairing that arrived through an
   * OS link sends the user back (approved or declined); a QR scan, a
   * pasted URI or the in-app browser stays put.
   */
  private returnAfterDecision(
    pairingTopic: string,
    meta: WalletKitTypes.Metadata,
    noticeTitle: string,
  ): void {
    const fromDeepLink = this.deepLinkPairings.delete(pairingTopic);
    if (!fromDeepLink) return;
    returnToCaller({
      appName: meta.name,
      redirect: meta.redirect,
      noticeTitle,
    });
  }

  // ── One-Click Auth (Phase 2b, §7.7) ─────────────────────────────────

  /**
   * `session_authenticate`: SIWE (CAIP-122) sign-in that creates the
   * session in one step. EVM only by the vendor's design. The wallet
   * still shows the same two consents a proposal would: the connect
   * sheet (binds the wallet under the transport origin key) and one
   * `personal_sign` sheet per chain the dApp asked for and we serve.
   */
  private async onAuthenticate(
    args: WalletKitTypes.SessionAuthenticate,
  ): Promise<void> {
    const kit = this.kit;
    if (!kit) return;
    const { id, topic, params, verifyContext } = args;
    const meta = params.requester.metadata;
    const v = verifiedOf(verifyContext);
    const reject = async () => {
      try {
        await kit.rejectSessionAuthenticate({
          id,
          reason: getSdkError("USER_REJECTED"),
        });
      } catch {
        // already gone
      }
    };
    if (v.isScam || isFlaggedHost(meta.url)) {
      await reject();
      deepLinkNotices.push({
        title: "Connection refused",
        body: "This app is flagged as malicious. The wallet will not connect to it.",
      });
      return;
    }
    if (params.expiryTimestamp && params.expiryTimestamp * 1000 < Date.now()) {
      await reject();
      return;
    }

    const originKey = originKeyFor({
      transport: "walletconnect",
      pairingTopic: topic,
      verifiedOrigin: v.validation === "VALID" ? v.origin : null,
    });
    const firstSeen = PermissionStore.listByOrigin(originKey).length === 0;
    const provenance = provenanceFrom(v, meta.url, firstSeen);
    const origin: Origin = {
      url: originKey,
      displayUrl: meta.url,
      title: meta.name,
      icon: meta.icons?.[0],
      via: "walletconnect",
    };

    // The EVM kit is the only namespace the auth flow can serve; found by
    // capability (serves `personal_sign`), not by name.
    const supported = this.supportedNamespaces();
    const evmEntry = Object.entries(supported).find(([, ns]) =>
      ns.methods.includes("personal_sign"),
    );
    const bridge = getDappBridge();
    if (!evmEntry || !bridge) {
      await reject();
      return;
    }
    const namespace = evmEntry[0] as Namespace;
    const offer = evmEntry[1];
    const codec = walletKitRegistry.get(namespace).walletConnectCodec;
    if (!codec) {
      await reject();
      return;
    }

    let authPayload: ReturnType<typeof populateAuthPayload>;
    try {
      authPayload = populateAuthPayload({
        authPayload: params.authPayload,
        chains: offer.chains,
        methods: offer.methods,
      });
    } catch (e) {
      if (__DEV__)
        console.warn("[wc] populateAuthPayload refused the request", e);
      await reject();
      return;
    }
    const chains = authPayload.chains.filter((c) => offer.chains.includes(c));
    if (chains.length === 0) {
      await reject();
      return;
    }

    // 1. Connect sheet → grant under the transport origin key.
    const connect = codec.connectRequest(chains[0]);
    const connected = await bridge.dispatchExternal({
      namespace,
      method: connect.method,
      params: connect.params,
      origin,
      via: "walletconnect",
      provenance,
    });
    if (connected.error) {
      await reject();
      return;
    }
    const address = Array.isArray(connected.result)
      ? String(connected.result[0] ?? "")
      : "";
    if (!address) {
      await reject();
      return;
    }

    // 2. One SIWE signature per requested chain (vendor flow).
    const auths: ReturnType<typeof buildAuthObject>[] = [];
    for (const chain of chains) {
      const iss = `did:pkh:${chain}:${address}`;
      const message = kit.formatAuthMessage({ request: authPayload, iss });
      const hex = `0x${Array.from(new TextEncoder().encode(message), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("")}`;
      const ref = Number(chain.split(":")[1]);
      if (Number.isInteger(ref)) OriginChainStore.setSelected(originKey, ref);
      const signed = await bridge.dispatchExternal({
        namespace,
        method: "personal_sign",
        params: [hex, address],
        origin,
        via: "walletconnect",
        provenance,
      });
      if (signed.error || typeof signed.result !== "string") {
        await reject();
        await PermissionStore.revoke({ origin: originKey });
        return;
      }
      auths.push(
        buildAuthObject(authPayload, { t: "eip191", s: signed.result }, iss),
      );
    }

    try {
      const { session } = await kit.approveSessionAuthenticate({ id, auths });
      if (session) {
        this.mmkv?.set(SESSION_ORIGIN_PREFIX + session.topic, originKey);
        this.mmkv?.set(
          SESSION_VERIFY_PREFIX + session.topic,
          JSON.stringify(v),
        );
      }
      track("dapp_connected", {
        chain: chains.join(","),
        dapp_host: peerHost(meta.url),
        dapp_name: meta.name,
      });
      track("deeplink_approved", { class: "pair", transport: "walletconnect" });
      this.notify();
      this.returnAfterDecision(topic, meta, "Connected");
    } catch (e) {
      if (__DEV__) console.warn("[wc] approveSessionAuthenticate failed", e);
      await PermissionStore.revoke({ origin: originKey });
    }
  }

  // ── Requests ────────────────────────────────────────────────────────

  private respond(
    topic: string,
    id: number,
    body: { result: unknown } | { error: { code: number; message: string } },
  ): void {
    const kit = this.kit;
    if (!kit) return;
    const response =
      "result" in body
        ? { id, jsonrpc: "2.0" as const, result: body.result }
        : { id, jsonrpc: "2.0" as const, error: body.error };
    kit.respondSessionRequest({ topic, response }).catch((e: unknown) => {
      if (__DEV__) console.warn("[wc] respond failed", e);
    });
  }

  private expireRequest(id: number): void {
    const t = this.pendingTimers.get(id);
    if (t) clearTimeout(t);
    this.pendingTimers.delete(id);
    getDappBridge()?.resolve(`wc-${id}`, { id: `wc-${id}`, outcome: "reject" });
  }

  private sessionOrigin(session: SessionTypes.Struct): {
    originKey: string;
    verified: Verified;
  } {
    const stored = this.mmkv?.getString(SESSION_ORIGIN_PREFIX + session.topic);
    const verifiedRaw = this.mmkv?.getString(
      SESSION_VERIFY_PREFIX + session.topic,
    );
    let verified: Verified = {
      validation: "UNKNOWN",
      isScam: false,
      origin: "",
    };
    try {
      if (verifiedRaw) verified = JSON.parse(verifiedRaw) as Verified;
    } catch {
      // keep default
    }
    const originKey =
      stored ??
      originKeyFor({
        transport: "walletconnect",
        pairingTopic: session.pairingTopic,
        verifiedOrigin:
          verified.validation === "VALID" ? verified.origin : null,
      });
    return { originKey, verified };
  }

  private async onRequest(args: WalletKitTypes.SessionRequest): Promise<void> {
    const kit = this.kit;
    if (!kit) return;
    const { id, topic, params, verifyContext } = args;
    const { request, chainId } = params;
    const session = kit.getActiveSessions()[topic];
    if (!session) {
      this.respond(topic, id, {
        error: { code: 4900, message: "Session not found" },
      });
      return;
    }
    if (
      request.expiryTimestamp &&
      request.expiryTimestamp * 1000 < Date.now()
    ) {
      this.respond(topic, id, {
        error: { code: 4001, message: "Request expired" },
      });
      return;
    }

    const live = verifiedOf(verifyContext);
    const meta = session.peer.metadata;
    // D-14 for requests: scam / flagged → block; INVALID mid-life → block
    // until reconnected (the proposal path is where the override lives).
    if (
      live.isScam ||
      isFlaggedHost(meta.url) ||
      live.validation === "INVALID"
    ) {
      this.respond(topic, id, {
        error: { code: 4001, message: "Request blocked by wallet policy" },
      });
      deepLinkNotices.push({
        title: "Request blocked",
        body:
          live.validation === "INVALID"
            ? "This app's domain no longer matches what it claims. Disconnect and reconnect it to continue."
            : "This app is flagged as malicious. The request was refused.",
      });
      return;
    }

    const namespace = chainId.split(":")[0] as Namespace;
    const nsSession = session.namespaces[namespace];
    const approvedChains = new Set<string>([
      ...(nsSession?.chains ?? []),
      ...(nsSession?.accounts ?? []).map((a) =>
        a.split(":").slice(0, 2).join(":"),
      ),
    ]);
    if (!nsSession || !approvedChains.has(chainId)) {
      this.respond(topic, id, {
        error: { code: 4901, message: "Chain not connected" },
      });
      return;
    }
    const kitAdapter = walletKitRegistry.has(namespace)
      ? walletKitRegistry.get(namespace)
      : null;
    const codec = kitAdapter?.walletConnectCodec;
    if (!codec) {
      this.respond(topic, id, {
        error: { code: 4200, message: "Unsupported namespace" },
      });
      return;
    }
    const translated = codec.toChainRequest(
      request.method,
      request.params,
      chainId,
      {
        accounts: nsSession.accounts,
      },
    );
    if (!translated) {
      this.respond(topic, id, {
        error: { code: -32601, message: "Method not found" },
      });
      return;
    }
    if ("transportResult" in translated) {
      this.respond(topic, id, { result: translated.transportResult });
      return;
    }

    const { originKey, verified } = this.sessionOrigin(session);
    const provenance = provenanceFrom(verified, meta.url, false);
    const origin: Origin = {
      url: originKey,
      displayUrl: meta.url,
      title: meta.name,
      icon: meta.icons?.[0],
      via: "walletconnect",
    };
    // EVM: the request's chain becomes the origin's selected chain so the
    // adapter's per-origin resolver serves it (`OriginChainStore`).
    if (typeof translated.chainOverride === "number") {
      OriginChainStore.setSelected(originKey, translated.chainOverride);
    }

    const bridge = getDappBridge();
    if (!bridge) {
      this.respond(topic, id, {
        error: { code: -32603, message: "Wallet not ready" },
      });
      return;
    }
    const timer = setTimeout(
      () => this.expireRequest(id),
      WC_REQUEST_TIMEOUT_MS,
    );
    this.pendingTimers.set(id, timer);
    // A dApp that has no deep link for us (not listed in WalletGuide, or
    // paired through the generic `wc:` chooser) cannot bring us to the
    // front. The request still lands here over the relay; tell the user.
    if (AppState.currentState !== "active") {
      void fireNotification("dapp-request", {
        title: `${meta.name} is waiting for you`,
        body: "Open TakumiPay to review and approve the request.",
        data: { type: "wc-request", topic },
      });
    }
    const res = await bridge.dispatchExternal({
      namespace,
      method: translated.method,
      params: translated.params,
      origin,
      via: "walletconnect",
      id: `wc-${id}`,
      provenance,
    });
    clearTimeout(timer);
    this.pendingTimers.delete(id);
    if (res.error) {
      this.respond(topic, id, {
        error: { code: res.error.code, message: res.error.message },
      });
      this.returnAfterRequest(topic, meta, "Request declined");
      return;
    }
    this.respond(topic, id, {
      result: codec.fromChainResult(request.method, res.result, request.params),
    });
    track("deeplink_approved", {
      class: "signing",
      transport: "walletconnect",
    });
    kit.extendSession({ topic }).catch(() => {});
    this.returnAfterRequest(topic, meta, "Sent");
  }

  /** The dApp deep-linked us for this request: hand the user back. */
  private returnAfterRequest(
    topic: string,
    meta: WalletKitTypes.Metadata,
    noticeTitle: string,
  ): void {
    if (!this.consumeWake(topic)) return;
    returnToCaller({
      appName: meta.name,
      redirect: meta.redirect,
      noticeTitle,
    });
  }

  private async onDelete(args: WalletKitTypes.SessionDelete): Promise<void> {
    const stored = this.mmkv?.getString(SESSION_ORIGIN_PREFIX + args.topic);
    if (stored) {
      await PermissionStore.revoke({ origin: stored });
      this.mmkv?.remove(SESSION_ORIGIN_PREFIX + args.topic);
      this.mmkv?.remove(SESSION_VERIFY_PREFIX + args.topic);
    }
    this.notify();
  }

  // ── Sessions ────────────────────────────────────────────────────────

  sessions(): TransportSession[] {
    const kit = this.kit;
    if (!kit) return [];
    let active: Record<string, SessionTypes.Struct>;
    try {
      active = kit.getActiveSessions();
    } catch {
      return [];
    }
    return Object.values(active).map((s) => {
      const { originKey } = this.sessionOrigin(s);
      const chains = Object.values(s.namespaces).flatMap((n) => n.chains ?? []);
      const accounts = Object.values(s.namespaces).flatMap(
        (n) => n.accounts as string[],
      );
      return {
        id: s.topic,
        transport: "walletconnect" as const,
        peer: {
          name: s.peer.metadata.name,
          url: s.peer.metadata.url,
          icon: s.peer.metadata.icons?.[0],
        },
        chains:
          chains.length > 0
            ? chains
            : [
                ...new Set(
                  accounts.map((a: string) =>
                    a.split(":").slice(0, 2).join(":"),
                  ),
                ),
              ],
        accounts,
        originKey,
        createdAt: 0,
        expiresAt: s.expiry ? s.expiry * 1000 : undefined,
      };
    });
  }

  async disconnect(topic: string): Promise<void> {
    const kit = this.kit;
    if (!kit) return;
    try {
      await kit.disconnectSession({
        topic,
        reason: getSdkError("USER_DISCONNECTED"),
      });
    } catch (e) {
      if (__DEV__) console.warn("[wc] disconnect failed", e);
    }
    await this.onDelete({ id: 0, topic });
  }
}

export const walletConnectTransport = new WalletConnectTransport();
export { isLinkModeEnvelope };
