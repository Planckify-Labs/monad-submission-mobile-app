/**
 * Solana Mobile Wallet Adapter transport — deep-link spec §8 (Android).
 *
 * Runs inside the dedicated `MobileWalletAdapterActivity` React root
 * (`services/transports/mwa/MwaEntrypoint.tsx`), never in the main app.
 * `@solana-mobile/mobile-wallet-adapter-walletlib` owns the local
 * WebSocket session and the wire protocol; this module translates each
 * `MWARequest` into a `ChainRequest` through `DappBridge.dispatchExternal`
 * (the same sheets as every other transport) and answers with
 * `resolve()`.
 *
 * Identity (D-8): a native caller (`getCallingPackage()` non-null) MUST
 * pass Digital Asset Links verification of `identity.uri`; failure is
 * answered with no sheet. Browser launches carry no OS identity and are
 * allowed as "Unverified app", keyed `mwa+unverified://…` (§4.9).
 */

import {
  type AuthorizeDappRequest,
  computeAttestOriginBinding,
  type DeauthorizeDappRequest,
  getCallingPackage,
  type MobileWalletAdapterConfig,
  type MWARequest,
  MWARequestFailReason,
  MWARequestType,
  type ReauthorizeDappRequest,
  resolve,
  type SignAndSendTransactionsRequest,
  type SignMessagesRequest,
  type SignTransactionsRequest,
  verifyCallingPackage,
} from "@solana-mobile/mobile-wallet-adapter-walletlib";
import bs58 from "bs58";
import * as WebBrowser from "expo-web-browser";
import { track } from "@/services/analytics/posthog";
import { getDappBridge } from "@/services/bridge/DappBridge";
import { base64ToBytes, bytesToBase64 } from "@/services/chains/solana/codec";
import type { Origin } from "@/services/chains/types";
import {
  FEATURE_MWA,
  MWA_ORIGIN_ATTESTATION,
  MWA_REQUIRE_DAL,
} from "@/services/deeplinks/flags";
import { originKeyFor } from "@/services/deeplinks/originKey";
import type { Provenance } from "@/services/deeplinks/types";
import { hostnameOfHttps } from "@/services/deeplinks/uri";
import { PermissionStore } from "@/services/permissions/store";
import { isFlaggedHost } from "@/services/security/scamDomainFeed";
import { walletKitRegistry } from "@/services/walletKit/registry";
import type { TransportAdapter, TransportSession } from "../types";
import { MWA_ATTEST_ORIGIN_URI, mwaAttestation } from "./attestation";
import { verifyAttestToken } from "./attestationToken";
import { type MwaScopeRecord, mwaScopeStore } from "./scopeStore";

export const MWA_WALLET_URI_BASE = "https://takumipay.xyz/mobilewalletadapter";
export const MWA_WALLET_NAME = "TakumiPay";
/**
 * Feature a web dApp lists in `authorize.features` to opt into origin
 * attestation (mirrors `ProtocolContract.FEATURE_ID_ATTEST_ORIGIN` in the
 * walletlib fork). Under `MWA_ORIGIN_ATTESTATION = "opt-in"` only these
 * dApps are challenged, so clients without the retry keep working.
 */
export const MWA_FEATURE_ATTEST_ORIGIN = "solana:attestOrigin";
export const MWA_CONFIG: MobileWalletAdapterConfig = {
  maxTransactionsPerSigningRequest: 10,
  maxMessagesPerSigningRequest: 10,
  supportedTransactionVersions: [0, "legacy"],
  noConnectionWarningTimeoutMs: 3000,
  optionalFeatures: ["solana:signInWithSolana", "solana:signTransactions"],
};

/** MWA is a Solana-family protocol (`solana:*` chain identifiers). */
const NAMESPACE = "solana" as const;

const MWA_ACCOUNT_FEATURES: Array<`${string}:${string}`> = [
  "solana:signTransactions",
  "solana:signAndSendTransaction",
  "solana:signMessages",
];

/** Native JSON hands `Uint8Array` fields as number arrays or `{0:…}` objects. */
export function toBytes(x: unknown): Uint8Array {
  if (x instanceof Uint8Array) return x;
  if (Array.isArray(x)) return Uint8Array.from(x as number[]);
  if (x && typeof x === "object")
    return Uint8Array.from(Object.values(x as Record<string, number>));
  if (typeof x === "string") return base64ToBytes(x);
  return new Uint8Array();
}

/** `solana:mainnet` (MWA 2.0) or legacy `mainnet-beta` → adapter chain + cluster. */
export function normalizeMwaChain(chain: string | undefined): {
  chain: string;
  cluster: string;
} {
  const raw = (chain ?? "solana:mainnet").replace(/^solana:/, "");
  const cluster =
    raw === "mainnet" || raw === "mainnet-beta"
      ? "mainnet-beta"
      : raw === "testnet"
        ? "testnet"
        : "devnet";
  return {
    chain: cluster === "mainnet-beta" ? "solana:mainnet" : `solana:${cluster}`,
    cluster,
  };
}

export interface MwaIdentity {
  callingPackage: string | null;
  identityUri?: string;
  identityName?: string;
  verifiedPackage: string | null;
  /** Browser-attested web origin (Phase 3b) when the attestation flow succeeded. */
  attestedOrigin?: string | null;
}

/** Decline any request shape with the walletlib's `USER_DECLINED` reason. */
function declineAny(request: MWARequest): void {
  switch (request.__type) {
    case MWARequestType.ReauthorizeDappRequest:
    case MWARequestType.DeauthorizeDappRequest:
      resolve(request as ReauthorizeDappRequest, {
        failReason: MWARequestFailReason.AuthorizationNotValid,
      });
      return;
    case MWARequestType.AuthorizeDappRequest:
      resolve(request, { failReason: MWARequestFailReason.UserDeclined });
      return;
    default:
      resolve(request as SignMessagesRequest, {
        failReason: MWARequestFailReason.UserDeclined,
      });
  }
}

class MwaTransport implements TransportAdapter {
  readonly id = "mwa" as const;
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
    const scopes = await mwaScopeStore.list();
    this.cache = scopes.map((s) => ({
      id: s.scopeHex,
      transport: "mwa" as const,
      peer: {
        name:
          s.identityName ??
          hostnameOfHttps(s.identityUri ?? "") ??
          "Unverified app",
        url: s.identityUri ?? "",
      },
      chains: [normalizeMwaChain(s.cluster).chain],
      accounts: [`${normalizeMwaChain(s.cluster).chain}:${s.walletAddress}`],
      originKey: s.originKey,
      createdAt: s.issuedAt,
      expiresAt: s.issuedAt + 30 * 24 * 60 * 60 * 1000,
    }));
    this.notify();
  }

  sessions(): TransportSession[] {
    return this.cache;
  }

  async disconnect(scopeHex: string): Promise<void> {
    const rec = this.cache.find((s) => s.id === scopeHex);
    if (rec) {
      await PermissionStore.revoke({
        origin: rec.originKey,
        namespace: NAMESPACE,
      });
      await mwaScopeStore.revokeByOrigin(rec.originKey);
    }
    await this.refresh();
  }

  // ── Identity (D-8) ──────────────────────────────────────────────────

  async resolveIdentity(appIdentity?: {
    identityUri?: string;
    identityName?: string;
  }): Promise<MwaIdentity> {
    let callingPackage: string | null = null;
    try {
      callingPackage = (await getCallingPackage()) ?? null;
    } catch {
      callingPackage = null;
    }
    let verifiedPackage: string | null = null;
    if (callingPackage && appIdentity?.identityUri) {
      try {
        verifiedPackage = (await verifyCallingPackage(appIdentity.identityUri))
          ? callingPackage
          : null;
      } catch {
        verifiedPackage = null;
      }
    }
    return {
      callingPackage,
      identityUri: appIdentity?.identityUri,
      identityName: appIdentity?.identityName,
      verifiedPackage,
    };
  }

  private originFor(identity: MwaIdentity): {
    originKey: string;
    origin: Origin;
    provenance: Provenance;
  } {
    const originKey = originKeyFor({
      transport: "mwa",
      identityUri: identity.identityUri ?? null,
      verifiedPackage: identity.verifiedPackage,
      attestedOrigin: identity.attestedOrigin ?? null,
    });
    const firstSeen = PermissionStore.listByOrigin(originKey).length === 0;
    const provenance: Provenance = {
      claimedOrigin: identity.identityUri
        ? (hostnameOfHttps(identity.identityUri) ?? identity.identityUri)
        : undefined,
      verification: identity.verifiedPackage
        ? { kind: "digital-asset-links", package: identity.verifiedPackage }
        : identity.attestedOrigin
          ? { kind: "origin-attestation", origin: identity.attestedOrigin }
          : { kind: "none" },
      firstSeen,
      transport: "mwa",
    };
    const origin: Origin = {
      url: originKey,
      displayUrl: identity.identityUri,
      title: identity.identityName,
      via: "mwa",
    };
    return { originKey, origin, provenance };
  }

  // ── Requests ────────────────────────────────────────────────────────

  async handleRequest(request: MWARequest): Promise<void> {
    if (!FEATURE_MWA) {
      declineAny(request);
      return;
    }
    try {
      switch (request.__type) {
        case MWARequestType.AuthorizeDappRequest:
          return await this.authorize(request);
        case MWARequestType.ReauthorizeDappRequest:
          return await this.reauthorize(request);
        case MWARequestType.DeauthorizeDappRequest:
          return await this.deauthorize(request);
        case MWARequestType.SignMessagesRequest:
          return await this.signMessages(request);
        case MWARequestType.SignTransactionsRequest:
          return await this.signTransactions(request);
        case MWARequestType.SignAndSendTransactionsRequest:
          return await this.signAndSend(request);
      }
    } catch (e) {
      if (__DEV__) console.warn("[mwa] request failed", request.__type, e);
      declineAny(request);
    }
  }

  private async authorize(req: AuthorizeDappRequest): Promise<void> {
    const identity = await this.resolveIdentity(req.appIdentity);
    // D-8: a native caller must verify; no sheet on failure.
    if (
      MWA_REQUIRE_DAL &&
      identity.callingPackage &&
      !identity.verifiedPackage
    ) {
      resolve(req, { failReason: MWARequestFailReason.UserDeclined });
      return;
    }
    if (identity.identityUri && isFlaggedHost(identity.identityUri)) {
      resolve(req, { failReason: MWARequestFailReason.UserDeclined });
      return;
    }
    // Phase 3b: a browser launch has no OS identity, but the spec's origin
    // attestation can still verify the web origin. Either the request
    // carries a token to verify, or we answer with a challenge and stop.
    if (!identity.callingPackage && identity.identityUri) {
      const att = await this.attestOrigin(req, identity.identityUri);
      if (att.kind === "challenge-sent") return;
      if (att.kind === "declined") {
        resolve(req, { failReason: MWARequestFailReason.UserDeclined });
        return;
      }
      if (att.kind === "attested") identity.attestedOrigin = att.origin;
    }
    const { originKey, origin, provenance } = this.originFor(identity);
    const { chain, cluster } = normalizeMwaChain(req.chain);
    const bridge = getDappBridge();
    if (!bridge) {
      resolve(req, { failReason: MWARequestFailReason.UserDeclined });
      return;
    }
    const kit = walletKitRegistry.get(NAMESPACE);
    const connect = kit.walletConnectCodec?.connectRequest(chain) ?? {
      method: "standard:connect",
      params: [{ silent: false }],
    };
    const res = await bridge.dispatchExternal({
      namespace: NAMESPACE,
      method: connect.method,
      params: connect.params,
      origin,
      via: "mwa",
      provenance,
    });
    if (res.error) {
      resolve(req, { failReason: MWARequestFailReason.UserDeclined });
      return;
    }
    const address = (res.result as { accounts?: Array<{ address?: string }> })
      ?.accounts?.[0]?.address;
    if (!address) {
      resolve(req, { failReason: MWARequestFailReason.UserDeclined });
      return;
    }

    let signInResult:
      | { address: string; signed_message: string; signature: string }
      | undefined;
    if (req.signInPayload) {
      const sign = await bridge.dispatchExternal({
        namespace: NAMESPACE,
        method: "solana:signIn",
        params: [{ ...req.signInPayload, address }],
        origin,
        via: "mwa",
        provenance,
      });
      if (sign.error) {
        resolve(req, { failReason: MWARequestFailReason.UserDeclined });
        return;
      }
      const r = sign.result as { signedMessage?: string; signature?: string };
      signInResult = {
        address: bytesToBase64(bs58.decode(address)),
        signed_message: r.signedMessage ?? "",
        signature: r.signature ?? "",
      };
    }

    const record: Omit<MwaScopeRecord, "issuedAt"> = {
      originKey,
      identityUri: identity.identityUri,
      identityName: identity.identityName,
      walletAddress: address,
      cluster,
      verifiedPackage: identity.verifiedPackage ?? undefined,
      attestedOrigin: identity.attestedOrigin ?? undefined,
    };
    const authorizationScope = await mwaScopeStore.issue(record);
    await this.refresh();
    track("dapp_connected", {
      chain: NAMESPACE,
      dapp_host: provenance.claimedOrigin,
      dapp_name: identity.identityName,
    });
    track("deeplink_approved", { class: "associate", transport: "mwa" });
    resolve(req, {
      accounts: [
        {
          publicKey: bs58.decode(address),
          accountLabel: MWA_WALLET_NAME,
          chains: [chain as `${string}:${string}`],
          features: MWA_ACCOUNT_FEATURES,
        },
      ],
      walletUriBase: MWA_WALLET_URI_BASE,
      authorizationScope,
      signInResult,
    });
  }

  /**
   * Origin attestation for a browser-launched dApp (spec "Identity
   * verification" > Android). Gated by `MWA_ORIGIN_ATTESTATION`:
   * `opt-in` challenges only dApps listing `solana:attestOrigin` in
   * `features`, so clients without the retry are untouched.
   */
  private async attestOrigin(
    req: AuthorizeDappRequest,
    identityUri: string,
  ): Promise<
    | { kind: "skipped" }
    | { kind: "attested"; origin: string }
    | { kind: "challenge-sent" }
    | { kind: "declined" }
  > {
    if (MWA_ORIGIN_ATTESTATION === "off") return { kind: "skipped" };
    const features = (req.features ?? []) as readonly string[];
    const optedIn = features.includes(MWA_FEATURE_ATTEST_ORIGIN);
    if (MWA_ORIGIN_ATTESTATION === "opt-in" && !optedIn)
      return { kind: "skipped" };

    const cached = mwaAttestation.attestedOriginFor(identityUri);
    if (cached) return { kind: "attested", origin: cached };

    if (!req.attestOrigin) {
      // A second challenge round without a token means the browser could
      // not find the provisioned key (site data cleared): provision a
      // fresh one once, then challenge again.
      if (mwaAttestation.hasChallenge(identityUri)) {
        mwaAttestation.takeChallenge(identityUri);
        await mwaAttestation.forgetCurrentKey();
      }
      return this.sendChallenge(req, identityUri);
    }

    const challenge = mwaAttestation.takeChallenge(identityUri);
    // No outstanding challenge (late or replayed retry): issue a fresh one.
    if (!challenge) return this.sendChallenge(req, identityUri);
    let binding: string | null = null;
    try {
      binding = await computeAttestOriginBinding(req, challenge.challenge);
    } catch (e) {
      if (__DEV__) console.warn("[mwa/attest] binding computation failed", e);
    }
    if (!binding) return { kind: "declined" };
    const verdict = verifyAttestToken({
      token: req.attestOrigin,
      keys: await mwaAttestation.keys(),
      expectedContext: challenge.context,
      expectedBinding: binding,
      identityUri,
    });
    if (!verdict.ok) {
      if (__DEV__) console.warn("[mwa/attest] token refused", verdict.reason);
      return { kind: "declined" };
    }
    mwaAttestation.rememberAttested(identityUri, verdict.origin);
    return { kind: "attested", origin: verdict.origin };
  }

  private async sendChallenge(
    req: AuthorizeDappRequest,
    identityUri: string,
  ): Promise<
    { kind: "challenge-sent" } | { kind: "skipped" } | { kind: "declined" }
  > {
    const key = await mwaAttestation.ensureKey({
      openAuthSession: (url, returnUrl) =>
        WebBrowser.openAuthSessionAsync(url, returnUrl),
    });
    if (!key) {
      // No key could be provisioned (no browser, user backed out). Under
      // `required` the dApp cannot proceed; under `opt-in` it falls back
      // to the unverified path it would have had anyway.
      return MWA_ORIGIN_ATTESTATION === "required"
        ? { kind: "declined" }
        : { kind: "skipped" };
    }
    const c = mwaAttestation.issueChallenge(identityUri, key);
    resolve(req, {
      failReason: MWARequestFailReason.AttestOriginRequired,
      context: c.context,
      challenge: c.challenge,
      attestOriginUri: MWA_ATTEST_ORIGIN_URI,
    });
    return { kind: "challenge-sent" };
  }

  private async scopeFor(req: {
    authorizationScope: Uint8Array;
    appIdentity?: { identityUri?: string; identityName?: string };
  }): Promise<MwaScopeRecord | null> {
    const scope = toBytes(req.authorizationScope);
    const rec = await mwaScopeStore.lookup(scope);
    if (!rec) return null;
    // A native caller must still be the package the scope was issued to.
    if (rec.verifiedPackage) {
      const identity = await this.resolveIdentity(req.appIdentity);
      if (identity.verifiedPackage !== rec.verifiedPackage) return null;
    }
    // The grant behind the scope must still exist (revocable from the app).
    if (
      !PermissionStore.isGrantedForNamespace(
        rec.originKey,
        rec.walletAddress,
        NAMESPACE,
      )
    )
      return null;
    return rec;
  }

  private async reauthorize(req: ReauthorizeDappRequest): Promise<void> {
    const rec = await this.scopeFor(req);
    if (!rec) {
      resolve(req, { failReason: MWARequestFailReason.AuthorizationNotValid });
      return;
    }
    const rotated = await mwaScopeStore.rotate(toBytes(req.authorizationScope));
    if (!rotated) {
      resolve(req, { failReason: MWARequestFailReason.AuthorizationNotValid });
      return;
    }
    await this.refresh();
    resolve(req, { authorizationScope: rotated });
  }

  private async deauthorize(req: DeauthorizeDappRequest): Promise<void> {
    const scope = toBytes(req.authorizationScope);
    const rec = await mwaScopeStore.lookup(scope);
    if (rec) {
      await PermissionStore.revoke({
        origin: rec.originKey,
        namespace: NAMESPACE,
      });
      await mwaScopeStore.revoke(scope);
      await this.refresh();
    }
    resolve(req, {});
  }

  private async dispatchSigned(
    rec: MwaScopeRecord,
    method: string,
    params: unknown,
    appIdentity?: { identityUri?: string; identityName?: string },
  ): Promise<{ result?: unknown; error?: { code: number } }> {
    const bridge = getDappBridge();
    if (!bridge) return { error: { code: -32603 } };
    const identity: MwaIdentity = {
      callingPackage: rec.verifiedPackage ?? null,
      identityUri: rec.identityUri ?? appIdentity?.identityUri,
      identityName: rec.identityName ?? appIdentity?.identityName,
      verifiedPackage: rec.verifiedPackage ?? null,
      attestedOrigin: rec.attestedOrigin ?? null,
    };
    const { origin, provenance } = this.originFor(identity);
    return bridge.dispatchExternal({
      namespace: NAMESPACE,
      method,
      params,
      origin,
      via: "mwa",
      provenance,
    });
  }

  private async signMessages(req: SignMessagesRequest): Promise<void> {
    const rec = await this.scopeFor(req);
    if (!rec) {
      resolve(req, { failReason: MWARequestFailReason.AuthorizationNotValid });
      return;
    }
    if (req.payloads.length > MWA_CONFIG.maxMessagesPerSigningRequest) {
      resolve(req, { failReason: MWARequestFailReason.TooManyPayloads });
      return;
    }
    const signed: Uint8Array[] = [];
    for (const raw of req.payloads) {
      const res = await this.dispatchSigned(
        rec,
        "solana:signMessage",
        [{ address: rec.walletAddress, message: bytesToBase64(toBytes(raw)) }],
        req.appIdentity,
      );
      if (res.error) {
        resolve(req, { failReason: MWARequestFailReason.UserDeclined });
        return;
      }
      signed.push(
        base64ToBytes((res.result as { signature?: string })?.signature ?? ""),
      );
    }
    track("deeplink_approved", { class: "signing", transport: "mwa" });
    resolve(req, { signedPayloads: signed });
  }

  private async signTransactions(req: SignTransactionsRequest): Promise<void> {
    const rec = await this.scopeFor(req);
    if (!rec) {
      resolve(req, { failReason: MWARequestFailReason.AuthorizationNotValid });
      return;
    }
    if (req.payloads.length > MWA_CONFIG.maxTransactionsPerSigningRequest) {
      resolve(req, { failReason: MWARequestFailReason.TooManyPayloads });
      return;
    }
    const { chain } = normalizeMwaChain(req.chain);
    const inputs = req.payloads.map((p) => ({
      transaction: bytesToBase64(toBytes(p)),
      chain,
    }));
    const res = await this.dispatchSigned(
      rec,
      "solana:signTransaction",
      inputs,
      req.appIdentity,
    );
    if (res.error) {
      resolve(req, { failReason: MWARequestFailReason.UserDeclined });
      return;
    }
    const list = Array.isArray(res.result)
      ? (res.result as Array<{ signedTransaction?: string }>)
      : [];
    track("deeplink_approved", { class: "signing", transport: "mwa" });
    resolve(req, {
      signedPayloads: list.map((v) => base64ToBytes(v.signedTransaction ?? "")),
    });
  }

  private async signAndSend(
    req: SignAndSendTransactionsRequest,
  ): Promise<void> {
    const rec = await this.scopeFor(req);
    if (!rec) {
      resolve(req, { failReason: MWARequestFailReason.AuthorizationNotValid });
      return;
    }
    if (req.payloads.length > MWA_CONFIG.maxTransactionsPerSigningRequest) {
      resolve(req, { failReason: MWARequestFailReason.TooManyPayloads });
      return;
    }
    const { chain } = normalizeMwaChain(req.chain);
    const signatures: Uint8Array[] = [];
    // Sequential, one sheet each (§8.2): every transaction is shown and
    // simulated on its own before it is broadcast.
    for (const raw of req.payloads) {
      const res = await this.dispatchSigned(
        rec,
        "solana:signAndSendTransaction",
        [
          {
            transaction: bytesToBase64(toBytes(raw)),
            chain,
            options: {
              minContextSlot: req.minContextSlot,
              commitment: req.commitment,
              skipPreflight: req.skipPreflight,
              maxRetries: req.maxRetries,
            },
          },
        ],
        req.appIdentity,
      );
      if (res.error) {
        resolve(req, { failReason: MWARequestFailReason.UserDeclined });
        return;
      }
      const sig =
        (Array.isArray(res.result)
          ? (res.result[0] as { signature?: string })
          : undefined
        )?.signature ?? "";
      signatures.push(bs58.decode(sig));
    }
    track("deeplink_approved", { class: "signing", transport: "mwa" });
    resolve(req, { signedTransactions: signatures });
  }
}

export const mwaTransport = new MwaTransport();
