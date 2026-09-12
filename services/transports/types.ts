/**
 * `TransportAdapter` — the shape every Class-C session transport docks
 * with (deep-link spec §4.2 / §13.1). Transports are dumb: they translate
 * wire messages to `ChainRequest`s through `DappBridge.dispatchExternal`
 * and translate results back. No transport signs.
 */

import type { DeepLinkRejectCode } from "@/services/deeplinks/types";

export interface TransportSession {
  /** Stable id (WC topic, MWA authorization scope hash, ul dapp key). */
  id: string;
  transport: "walletconnect" | "mwa" | "encrypted-link";
  /** Peer metadata, rendered as plain text only. */
  peer: { name: string; url: string; icon?: string };
  /** CAIP-2 chains the session is approved for. */
  chains: string[];
  /** CAIP-10 accounts bound to the session. */
  accounts: string[];
  /** Origin key used for `PermissionStore` grants (`originKeyFor`). */
  originKey: string;
  createdAt: number;
  expiresAt?: number;
  /**
   * WalletConnect Verify API state captured when the session was approved
   * (`VALID` = domain match, `UNKNOWN` = unverified, `INVALID` = mismatch
   * the user connected to anyway; a flagged "threat" never becomes a
   * session). Other transports leave it unset.
   */
  verification?: "VALID" | "INVALID" | "UNKNOWN";
}

export interface TransportAdapter {
  readonly id: "walletconnect" | "mwa" | "encrypted-link";
  /** Idempotent; may be called before any wallet exists. */
  start(): Promise<void>;
  stop(): Promise<void>;
  sessions(): TransportSession[];
  disconnect(sessionId: string): Promise<void>;
  /** Notify subscribers when `sessions()` changes. */
  subscribe(listener: () => void): () => void;
}

export type PairResult = { ok: true } | { ok: false; code: DeepLinkRejectCode };
