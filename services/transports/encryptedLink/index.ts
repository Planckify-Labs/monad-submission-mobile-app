/**
 * Phantom-compatible encrypted deep-link transport — deep-link spec §9.
 *
 * Serves `https://takumipay.xyz/ul/v1/<method>` (and the custom-scheme
 * mirror) so Solana native apps built against Phantom's deep-link
 * protocol can target TakumiPay by swapping the base URL. There is no
 * verifier in that protocol; every request is "Unverified app" with the
 * first-seen note, keyed `ul+unverified://<dapp key>` (§4.9).
 *
 * Runs after the interstitial's Continue (`executeHeldIntent`). The
 * chain adapter renders the sheets through `DappBridge.dispatchExternal`;
 * this file only decrypts, validates the session, translates, and
 * redirects. Redirect payloads are `nacl.box` ciphertext or an error
 * code, never plaintext (S-14).
 */

import bs58 from "bs58";
import { Linking } from "react-native";
import type { TBlockchain } from "@/api/types/blockchain";
import type { TWallet } from "@/constants/types/walletTypes";
import { track } from "@/services/analytics/posthog";
import { getDappBridge } from "@/services/bridge/DappBridge";
import type { Origin } from "@/services/chains/types";
import { INTERSTITIAL_COPY } from "@/services/deeplinks/copy";
import type { ExecuteOutcome } from "@/services/deeplinks/execute";
import { FEATURE_ENCRYPTED_LINK } from "@/services/deeplinks/flags";
import { originKeyFor } from "@/services/deeplinks/originKey";
import { safeFetch } from "@/services/deeplinks/safeFetch";
import type { DeepLinkIntent, Provenance } from "@/services/deeplinks/types";
import { hostnameOfHttps, safeDecodeComponent } from "@/services/deeplinks/uri";
import { PermissionStore } from "@/services/permissions/store";
import { isFlaggedHost } from "@/services/security/scamDomainFeed";
import { walletKitRegistry } from "@/services/walletKit/registry";
import type { TransportAdapter, TransportSession } from "../types";
import { boxOpen, boxSeal, NonceRing, randomNonce } from "./crypto";
import {
  METHOD_TABLES,
  UL_ERRORS,
  type UlError,
  ulErrorForRpc,
} from "./methods";
import { validateRedirect, withParams } from "./redirect";
import { encryptedLinkKeys, type SessionRecord } from "./session";

type Intent = Extract<DeepLinkIntent, { kind: "encrypted-link" }>;

export interface EncryptedLinkDeps {
  wallet: TWallet | null;
  chainRows: () => TBlockchain[] | null;
  fetch: typeof fetch;
}

/** Android `TransactionTooLarge` guard on the outbound URL (S-11). */
const MAX_REDIRECT_URL = 256 * 1024;

const nonceRing = new NonceRing();

class EncryptedLinkTransport implements TransportAdapter {
  readonly id = "encrypted-link" as const;
  private listeners = new Set<() => void>();
  private cache: TransportSession[] = [];

  async start(): Promise<void> {
    await this.refresh();
  }
  async stop(): Promise<void> {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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

  async refresh(): Promise<void> {
    const records = await encryptedLinkKeys.listSessions();
    this.cache = records.map((r) => ({
      id: r.dappPublicKey,
      transport: "encrypted-link" as const,
      peer: { name: r.name ?? r.app_url, url: r.app_url },
      chains: [
        METHOD_TABLES[r.chain]?.clusterToChain(r.cluster) ??
          `${r.chain}:${r.cluster}`,
      ],
      accounts: [`${r.chain}:${r.cluster}:${r.public_key}`],
      originKey: originKeyFor({
        transport: "encrypted-link",
        dappPublicKey: r.dappPublicKey,
      }),
      createdAt: r.timestamp,
      expiresAt: r.timestamp + 30 * 24 * 60 * 60 * 1000,
    }));
    this.notify();
  }

  sessions(): TransportSession[] {
    return this.cache;
  }

  async disconnect(dappPublicKey: string): Promise<void> {
    const key = originKeyFor({ transport: "encrypted-link", dappPublicKey });
    await PermissionStore.revoke({ origin: key });
    await encryptedLinkKeys.deleteSession(dappPublicKey);
    await encryptedLinkKeys.forgetSecret(dappPublicKey);
    await this.refresh();
  }

  // ── Entry ───────────────────────────────────────────────────────────

  async handle(
    intent: Intent,
    deps: EncryptedLinkDeps,
  ): Promise<ExecuteOutcome> {
    if (!FEATURE_ENCRYPTED_LINK)
      return { kind: "rejected", code: "not_enabled" };
    const p = intent.params;
    const dappKey = p.dapp_encryption_public_key;
    const redirectLink =
      safeDecodeComponent(p.redirect_link) ?? p.redirect_link;
    let theirPub: Uint8Array;
    try {
      theirPub = bs58.decode(dappKey);
    } catch {
      return { kind: "rejected", code: "malformed" };
    }
    if (theirPub.length !== 32) return { kind: "rejected", code: "malformed" };

    if (intent.method === "connect")
      return this.connect(intent, redirectLink, deps);
    return this.method(intent, redirectLink);
  }

  // ── connect ─────────────────────────────────────────────────────────

  private async connect(
    intent: Intent,
    redirectLink: string,
    deps: EncryptedLinkDeps,
  ): Promise<ExecuteOutcome> {
    const p = intent.params;
    const appUrl = safeDecodeComponent(p.app_url) ?? p.app_url;
    const redirectKind = validateRedirect(redirectLink, appUrl);
    if (!redirectKind) return { kind: "rejected", code: "malformed" };
    const appHost = hostnameOfHttps(appUrl);
    if (!appHost) return { kind: "rejected", code: "malformed" };
    if (
      isFlaggedHost(appUrl) ||
      (redirectKind === "https" && isFlaggedHost(redirectLink))
    ) {
      return { kind: "rejected", code: "malicious" };
    }
    const table = METHOD_TABLES.solana;
    const cluster =
      p.cluster && /^[a-z-]+$/.test(p.cluster)
        ? p.cluster
        : table.defaultCluster;

    // Metadata from the redirect origin, https only (Phantom behaviour),
    // with the S-6 fetch discipline. Best-effort: a failure means no name.
    let name: string | undefined;
    if (redirectKind === "https") {
      try {
        const res = await safeFetch(redirectLink, {
          fetchImpl: deps.fetch,
          sameHost: true,
        });
        const m = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(res.text);
        name = m?.[1]?.trim();
      } catch {
        name = undefined;
      }
    }

    const dappKey = p.dapp_encryption_public_key;
    const originKey = originKeyFor({
      transport: "encrypted-link",
      dappPublicKey: dappKey,
    });
    const firstSeen = PermissionStore.listByOrigin(originKey).length === 0;
    const provenance: Provenance = {
      ...intent.provenance,
      claimedOrigin: appHost,
      firstSeen,
    };
    const origin: Origin = {
      url: originKey,
      displayUrl: appUrl,
      title: name ?? appHost,
      via: "deeplink",
    };

    const kit = walletKitRegistry.get(table.namespace);
    const connect = kit.walletConnectCodec?.connectRequest(
      table.clusterToChain(cluster),
    ) ?? {
      method: "standard:connect",
      params: [{ silent: false }],
    };
    const bridge = getDappBridge();
    if (!bridge) return { kind: "rejected", code: "malformed" };
    const res = await bridge.dispatchExternal({
      namespace: table.namespace,
      method: connect.method,
      params: connect.params,
      origin,
      via: "deeplink",
      provenance,
    });
    if (res.error) {
      const err = ulErrorForRpc(res.error.code);
      await this.redirect(
        redirectLink,
        redirectKind,
        { errorCode: String(err.errorCode), errorMessage: err.errorMessage },
        name ?? appHost,
      );
      return err.errorCode === 4001
        ? { kind: "user-rejected" }
        : { kind: "rejected", code: "malformed" };
    }
    const accounts =
      (res.result as { accounts?: Array<{ address?: string }> })?.accounts ??
      [];
    const publicKey = accounts[0]?.address;
    if (!publicKey) return { kind: "rejected", code: "malformed" };

    const sessionJson = {
      app_url: appUrl,
      timestamp: Date.now(),
      chain: table.sessionChain,
      cluster,
      public_key: publicKey,
    };
    const session = await encryptedLinkKeys.issueSession(sessionJson);
    const record: SessionRecord = {
      ...sessionJson,
      dappPublicKey: dappKey,
      redirectOrigin:
        redirectKind === "https" ? appHost : redirectLink.split(":")[0],
      name,
    };
    await encryptedLinkKeys.saveSession(record);
    await this.refresh();
    track("dapp_connected", {
      chain: table.namespace,
      dapp_host: appHost,
      dapp_name: name,
    });
    track("deeplink_approved", { class: "pair", transport: "encrypted-link" });

    const { publicKey: ourPub } = await encryptedLinkKeys.walletKeypair();
    const sealed = await this.seal(dappKey, { public_key: publicKey, session });
    return this.redirect(
      redirectLink,
      redirectKind,
      {
        phantom_encryption_public_key: bs58.encode(ourPub),
        nonce: sealed.nonce,
        data: sealed.data,
      },
      name ?? appHost,
    );
  }

  // ── subsequent methods ──────────────────────────────────────────────

  private async method(
    intent: Intent,
    redirectLink: string,
  ): Promise<ExecuteOutcome> {
    const p = intent.params;
    const dappKey = p.dapp_encryption_public_key;
    const record = await encryptedLinkKeys.getSession(dappKey);
    // An unknown dApp key has no session record: the request cannot be
    // valid, and its redirect target is unvalidated, so answer on screen.
    if (!record) return { kind: "rejected", code: "wrong_account" };
    const redirectKind = validateRedirect(redirectLink, record.app_url);
    if (!redirectKind) return { kind: "rejected", code: "malformed" };
    const label =
      record.name ?? hostnameOfHttps(record.app_url) ?? record.app_url;
    const fail = async (err: UlError): Promise<ExecuteOutcome> => {
      await this.redirect(
        redirectLink,
        redirectKind,
        { errorCode: String(err.errorCode), errorMessage: err.errorMessage },
        label,
      );
      if (err === UL_ERRORS.userRejected) return { kind: "user-rejected" };
      return {
        kind: "rejected",
        code: err === UL_ERRORS.unauthorized ? "wrong_account" : "malformed",
      };
    };

    let nonce: Uint8Array;
    let box: Uint8Array;
    try {
      nonce = bs58.decode(p.nonce);
      box = bs58.decode(p.payload);
    } catch {
      return fail(UL_ERRORS.invalidInput);
    }
    const secret = await encryptedLinkKeys.sharedSecret(dappKey);
    if (!nonceRing.accept(dappKey, nonce)) return fail(UL_ERRORS.invalidInput);
    const opened = boxOpen(box, nonce, secret);
    if (!opened) return fail(UL_ERRORS.invalidInput);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(new TextDecoder().decode(opened)) as Record<
        string,
        unknown
      >;
    } catch {
      return fail(UL_ERRORS.invalidInput);
    }
    const session =
      typeof payload.session === "string"
        ? await encryptedLinkKeys.openSession(payload.session)
        : null;
    if (!session) return fail(UL_ERRORS.unauthorized);
    const table = METHOD_TABLES[session.chain];
    if (
      !table ||
      session.app_url !== record.app_url ||
      session.public_key !== record.public_key
    ) {
      return fail(UL_ERRORS.unauthorized);
    }

    const originKey = originKeyFor({
      transport: "encrypted-link",
      dappPublicKey: dappKey,
    });
    const origin: Origin = {
      url: originKey,
      displayUrl: record.app_url,
      title: label,
      via: "deeplink",
    };
    const provenance: Provenance = {
      ...intent.provenance,
      claimedOrigin: hostnameOfHttps(record.app_url) ?? undefined,
      firstSeen: false,
    };

    if (intent.method === "disconnect") {
      await this.disconnect(dappKey);
      return this.redirect(redirectLink, redirectKind, {}, label);
    }
    if (intent.method === "connect") return fail(UL_ERRORS.methodNotFound);
    const method = intent.method;

    const translated = table.toChainRequest(method, payload, session);
    if (!translated) return fail(UL_ERRORS.invalidInput);
    const bridge = getDappBridge();
    if (!bridge) return fail(UL_ERRORS.internal);
    const res = await bridge.dispatchExternal({
      namespace: table.namespace,
      method: translated.method,
      params: translated.params,
      origin,
      via: "deeplink",
      provenance,
    });
    if (res.error) return fail(ulErrorForRpc(res.error.code));
    track("deeplink_approved", {
      class: "signing",
      transport: "encrypted-link",
    });
    const data = table.fromChainResult(method, res.result);
    const sealed = await this.seal(dappKey, data);
    return this.redirect(
      redirectLink,
      redirectKind,
      { nonce: sealed.nonce, data: sealed.data },
      label,
    );
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private async seal(
    dappKey: string,
    json: Record<string, unknown>,
  ): Promise<{ nonce: string; data: string }> {
    const secret = await encryptedLinkKeys.sharedSecret(dappKey);
    const nonce = randomNonce();
    const data = boxSeal(
      new TextEncoder().encode(JSON.stringify(json)),
      nonce,
      secret,
    );
    return { nonce: bs58.encode(nonce), data: bs58.encode(data) };
  }

  private async redirect(
    redirectLink: string,
    kind: "custom" | "https",
    params: Record<string, string>,
    appLabel: string,
  ): Promise<ExecuteOutcome> {
    const url =
      Object.keys(params).length > 0
        ? withParams(redirectLink, params)
        : redirectLink;
    if (url.length > MAX_REDIRECT_URL)
      return { kind: "rejected", code: "too_large" };
    if (kind === "custom") {
      try {
        await Linking.openURL(url);
        return { kind: "handed-off" };
      } catch {
        return {
          kind: "done",
          title: "Done",
          body: INTERSTITIAL_COPY.sentBackTo.replace("{app}", appLabel),
        };
      }
    }
    // https redirects open the browser (vendor); show a button instead.
    return {
      kind: "done",
      title: "Done",
      body: INTERSTITIAL_COPY.sentBackTo.replace("{app}", appLabel),
      returnTo: {
        label: INTERSTITIAL_COPY.returnTo.replace("{app}", appLabel),
        url,
      },
    };
  }
}

export const encryptedLinkTransport = new EncryptedLinkTransport();
export { validateRedirect };
