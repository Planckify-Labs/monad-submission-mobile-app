/**
 * MWA origin attestation — wallet-side state machine (Phase 3b, spec
 * "Identity verification" > Android). Pure: storage, clock, notices and
 * the return URL are injected (`attestation.ts` wires the app's), so the
 * nonce binding, challenge lifecycle and session cache are node-tested.
 *
 * Browser-launched web dApps carry no OS identity. The MWA spec fixes
 * that with a wallet-hosted attestation script: on first use the wallet
 * opens `https://takumipay.xyz/mwa/attest?m=provision…` in a Custom Tab,
 * the page mints a non-extractable ECDSA P-256 keypair in the browser's
 * storage for our origin and hands the **public** key back through the
 * MWA activity's private return scheme. Later, when a web dApp asks to
 * authorize, the wallet answers `ERROR_ATTEST_ORIGIN_ANDROID` with a
 * challenge; the dApp loads the same page in an iframe, the page signs
 * `{ origin: event.origin, h, context }` (origin set by the browser),
 * and the dApp retries with the token, which `attestationToken.ts`
 * verifies.
 *
 * Nothing here trusts the dApp: the private key never leaves the
 * browser origin, the public key is bound to a provisioning nonce only
 * the wallet-opened tab knew, and the token is bound to the session
 * through `h` (computed natively from the session secret).
 *
 * Storage keys (encrypted MMKV `mwa.v1`, D-17): `attest.key:<context>`,
 * `attest.current`.
 */

import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { hostnameOfHttps } from "@/services/deeplinks/uri";
import { type AttestJwk, parseProvisionReturn } from "./attestationToken";

/** The slice of MMKV this module uses; injected so the state machine is node-testable. */
export interface AttestKv {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
  getAllKeys(): string[];
}

export interface AttestNotice {
  title: string;
  body: string;
  autoDismissMs?: number;
}

export interface MwaAttestationDeps {
  store: () => Promise<AttestKv>;
  /** Where the provisioning page must redirect (the MWA activity's private scheme). */
  returnUrl: string;
  notify: (notice: AttestNotice) => void;
  now?: () => number;
  /** How long to wait for a late `url` event after the auth session settles. */
  lateReturnMs?: number;
}

export const MWA_ATTEST_ORIGIN_URI = "https://takumipay.xyz/mwa/attest";
/** A challenge the dApp has not answered within this window is forgotten. */
export const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const KEY_PREFIX = "attest.key:";
const CURRENT_KEY = "attest.current";

export interface ProvisionedKey {
  context: string;
  jwk: AttestJwk;
  provisionedAt: number;
}

export interface PendingChallenge {
  context: string;
  challenge: Uint8Array;
  identityUri: string;
  issuedAt: number;
}

export interface AttestationBrowser {
  /** Opens `url` in a Custom Tab and resolves with the redirect URL matching `returnUrl`. */
  openAuthSession(
    url: string,
    returnUrl: string,
  ): Promise<{ type: "success"; url: string } | { type: string }>;
}

export class MwaAttestation {
  private readonly deps: MwaAttestationDeps;
  private mmkv: Promise<AttestKv> | null = null;
  private pendingNonce: string | null = null;
  private pendingProvision: {
    resolve: (k: ProvisionedKey | null) => void;
  } | null = null;
  private challenges = new Map<string, PendingChallenge>();
  /** Origins attested during this activity session (spec: "authorized during this session"). */
  private attestedThisSession = new Map<string, string>();
  private reprovisionedThisSession = false;

  constructor(deps: MwaAttestationDeps) {
    this.deps = deps;
  }

  private store(): Promise<AttestKv> {
    if (!this.mmkv) this.mmkv = this.deps.store();
    return this.mmkv;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // ── keys ──────────────────────────────────────────────────────────

  async keys(): Promise<Record<string, AttestJwk>> {
    const mmkv = await this.store();
    const out: Record<string, AttestJwk> = {};
    for (const k of mmkv.getAllKeys()) {
      if (!k.startsWith(KEY_PREFIX)) continue;
      const raw = mmkv.getString(k);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw) as ProvisionedKey;
        out[rec.context] = rec.jwk;
      } catch {
        // skip
      }
    }
    return out;
  }

  async currentKey(): Promise<ProvisionedKey | null> {
    const mmkv = await this.store();
    const ctx = mmkv.getString(CURRENT_KEY);
    if (!ctx) return null;
    const raw = mmkv.getString(KEY_PREFIX + ctx);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ProvisionedKey;
    } catch {
      return null;
    }
  }

  private async saveKey(rec: ProvisionedKey): Promise<void> {
    const mmkv = await this.store();
    mmkv.set(KEY_PREFIX + rec.context, JSON.stringify(rec));
    mmkv.set(CURRENT_KEY, rec.context);
  }

  /**
   * Provision the attestation key through the wallet-hosted page. The
   * nonce binds the returned public key to this very tab; a return that
   * does not echo it is dropped.
   */
  async ensureKey(browser: AttestationBrowser): Promise<ProvisionedKey | null> {
    const existing = await this.currentKey();
    if (existing) return existing;
    const nonce = bytesToHex(randomBytes(16));
    this.pendingNonce = nonce;
    this.deps.notify({
      title: "One-time setup",
      body: "TakumiPay will open a browser page once to set up secure verification for web apps.",
      autoDismissMs: 4000,
    });
    const url = `${MWA_ATTEST_ORIGIN_URI}?m=provision&nonce=${nonce}&return=${encodeURIComponent(this.deps.returnUrl)}`;
    const viaListener = new Promise<ProvisionedKey | null>((resolve) => {
      this.pendingProvision = { resolve };
    });
    let result: Awaited<ReturnType<AttestationBrowser["openAuthSession"]>>;
    try {
      result = await browser.openAuthSession(url, this.deps.returnUrl);
    } catch (e) {
      if (__DEV__) console.warn("[mwa/attest] provisioning tab failed", e);
      result = { type: "cancel" };
    }
    if (result.type === "success" && "url" in result) {
      const done = await this.completeProvisioning(result.url);
      if (done) return done;
    }
    // The redirect may also arrive as a plain `url` event on the activity.
    const late = await Promise.race([
      viaListener,
      new Promise<null>((r) =>
        setTimeout(() => r(null), this.deps.lateReturnMs ?? 1500),
      ),
    ]);
    this.pendingProvision = null;
    return late;
  }

  /** Handle the page's return URL (from the auth session or a `url` event). */
  async completeProvisioning(url: string): Promise<ProvisionedKey | null> {
    const parsed = parseProvisionReturn(url);
    if (!parsed) return null;
    if (!this.pendingNonce || parsed.nonce !== this.pendingNonce) {
      if (__DEV__)
        console.warn(
          "[mwa/attest] provisioning return with unexpected nonce dropped",
        );
      return null;
    }
    this.pendingNonce = null;
    const rec: ProvisionedKey = {
      context: parsed.context,
      jwk: parsed.jwk,
      provisionedAt: this.now(),
    };
    await this.saveKey(rec);
    this.pendingProvision?.resolve(rec);
    this.pendingProvision = null;
    return rec;
  }

  // ── challenges ────────────────────────────────────────────────────

  /** Issue a challenge for `identityUri`; the dApp must answer with a token under `context`. */
  issueChallenge(identityUri: string, key: ProvisionedKey): PendingChallenge {
    this.expireChallenges();
    const c: PendingChallenge = {
      context: key.context,
      challenge: randomBytes(32),
      identityUri,
      issuedAt: this.now(),
    };
    this.challenges.set(challengeKey(identityUri), c);
    return c;
  }

  /** `true` while a challenge for `identityUri` is outstanding (not yet taken or expired). */
  hasChallenge(identityUri: string): boolean {
    this.expireChallenges();
    return this.challenges.has(challengeKey(identityUri));
  }

  /**
   * Forget the current key so the next `ensureKey` provisions a fresh
   * one (the browser answered "unknown_context": its site data was
   * cleared since we provisioned). Old keys stay verifiable for tokens
   * already in flight. At most once per activity session.
   */
  async forgetCurrentKey(): Promise<boolean> {
    if (this.reprovisionedThisSession) return false;
    this.reprovisionedThisSession = true;
    const mmkv = await this.store();
    mmkv.remove(CURRENT_KEY);
    return true;
  }

  takeChallenge(identityUri: string): PendingChallenge | null {
    this.expireChallenges();
    const k = challengeKey(identityUri);
    const c = this.challenges.get(k) ?? null;
    if (c) this.challenges.delete(k);
    return c;
  }

  private expireChallenges(): void {
    const now = this.now();
    for (const [k, c] of this.challenges) {
      if (now - c.issuedAt > CHALLENGE_TTL_MS) this.challenges.delete(k);
    }
  }

  // ── session cache ─────────────────────────────────────────────────

  rememberAttested(identityUri: string, origin: string): void {
    this.attestedThisSession.set(challengeKey(identityUri), origin);
  }

  attestedOriginFor(identityUri: string): string | null {
    return this.attestedThisSession.get(challengeKey(identityUri)) ?? null;
  }

  resetSession(): void {
    this.challenges.clear();
    this.attestedThisSession.clear();
    this.reprovisionedThisSession = false;
  }

  /** Test seam. */
  __resetForTest(): void {
    this.resetSession();
    this.pendingNonce = null;
    this.pendingProvision = null;
  }
}

function challengeKey(identityUri: string): string {
  return hostnameOfHttps(identityUri) ?? identityUri.toLowerCase();
}
