/**
 * `services/transfers/transferRecordOutbox.ts` — durable recording of a
 * sent transfer with the backend.
 *
 * Why this exists: the recipient's "Transfer Received" push is triggered
 * ONLY by the sender's app POSTing the transfer to `POST /transactions`
 * (the api has no on-chain listener). Until now that POST was a
 * best-effort call made once, right after the tx was submitted, and it
 * was silently skipped whenever the active wallet had no access token
 * (`transactionApi.createTransaction` returns `{}` in that case). So a
 * sender whose session had lapsed, or who lost connectivity for a
 * moment, or whose app was killed on the success screen, produced a
 * transfer the other person was never told about — while the transfer
 * itself was already final on chain.
 *
 * Shape: outbox. Every transfer is written to MMKV FIRST, then posted;
 * the entry is removed only once the server has acknowledged it.
 * Anything left over is retried by `flushTransferRecordOutbox()` — on
 * app foreground, after a sign-in, and at boot (see
 * `useTransferRecordOutboxFlush`). Entries are keyed by tx hash so a
 * retry can never double-record the same transfer, and the api
 * de-duplicates the recipient's push by hash as well.
 *
 * Attribution rule: the authenticated `api` client signs every request as
 * the ACTIVE wallet, and the server stores the history row under that
 * user. An entry is therefore only posted while its `fromAddress` IS the
 * active wallet — never as whichever wallet happens to be selected when
 * the retry fires.
 *
 * Imports here are STATIC on purpose. Under Metro's lazy bundling (what
 * Expo Go requests by default) every `import()` is a split point, and
 * Metro builds and keeps a separate server-side module graph per split
 * entry; because these modules sit deep in the app's import graph each
 * such graph is ~7.5k modules / ~500 MB of dev-server heap. An earlier
 * version lazy-imported the five modules below, so a boot with queued
 * entries fetched three to five of those graphs and pushed `expo start`
 * past Node's 2 GB default heap ("FATAL ERROR: Reached heap limit").
 * Everything imported here is already in the base bundle, so there was
 * nothing to defer. The agent executors that need an RN-free static
 * graph for their vitest harness lazy-import THIS module instead — see
 * `agent-executors/wallet/recordTransferHistory.ts`.
 */

import { tokenApi } from "@/api/endpoints/tokens";
import { transactionApi } from "@/api/endpoints/transactions";
import { queryClient } from "@/app/_layout";
import { transactionsQueryKeys } from "@/constants/queryKeys/transactionsQueryKeys";
import { storage } from "@/lib/storage/mmkv";
import {
  getActiveWalletAddress,
  isAuthenticatedForWallet,
} from "@/services/auth/activeWalletSession";

/** How the entry names its token. Non-native tokens are resolved to a
 * `tokenId` at post time (the token catalog is public, so that lookup
 * never needs the wallet's session). */
export type TransferTokenRef =
  | { tokenId: string }
  | { contractAddress: string; blockchainId: string };

export interface RecordTransferInput {
  fromAddress: string;
  toAddress: string;
  /** Raw on-chain units (wei / lamports / base units), as a decimal string. */
  amount: string;
  txHash: string;
  token: TransferTokenRef;
  /** History row type; defaults to TRANSFER. Only TRANSFER rows notify the recipient. */
  type?: "TRANSFER" | "PAYMENT";
}

export interface TransferRecordEntry extends RecordTransferInput {
  /** `outboxKey(txHash)` — the de-dup key. */
  key: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

export interface FlushResult {
  posted: number;
  /** Entries left for a later flush (other wallet active, no session, or failed). */
  remaining: number;
  dropped: number;
}

const OUTBOX_KEY = "takumipay_transfer_record_outbox";
/** A week-old transfer nobody could record is not worth a push any more. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounds the MMKV blob if the backend is unreachable for a long time. */
const MAX_ENTRIES = 200;
/** Per flush, so a big backlog drains across foregrounds instead of in one burst. */
const MAX_POSTS_PER_FLUSH = 10;

// ─── storage ─────────────────────────────────────────────────────────────────

function outboxKey(txHash: string): string {
  // Lower-cased for the KEY only: EVM hashes are case-insensitive and Solana
  // signatures never collide on case in practice. The stored payload keeps
  // the hash verbatim.
  return txHash.trim().toLowerCase();
}

export function readOutbox(): TransferRecordEntry[] {
  try {
    const raw = storage.getString(OUTBOX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

function writeOutbox(entries: TransferRecordEntry[]): void {
  try {
    // Newest first, capped — an outbox this full means the server has been
    // down for days; the oldest records are the least useful to keep.
    const bounded = [...entries]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_ENTRIES);
    if (bounded.length === 0) {
      storage.remove(OUTBOX_KEY);
    } else {
      storage.set(OUTBOX_KEY, JSON.stringify(bounded));
    }
  } catch (err) {
    if (__DEV__) console.warn("[transferOutbox] write failed:", err);
  }
}

function isEntry(v: unknown): v is TransferRecordEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.key === "string" &&
    typeof e.fromAddress === "string" &&
    typeof e.toAddress === "string" &&
    typeof e.amount === "string" &&
    typeof e.txHash === "string" &&
    typeof e.createdAt === "number" &&
    !!e.token &&
    typeof e.token === "object"
  );
}

function upsertEntry(input: RecordTransferInput): TransferRecordEntry {
  const key = outboxKey(input.txHash);
  const entries = readOutbox();
  const existing = entries.find((e) => e.key === key);
  if (existing) return existing;
  const entry: TransferRecordEntry = {
    ...input,
    key,
    createdAt: Date.now(),
    attempts: 0,
  };
  writeOutbox([entry, ...entries]);
  return entry;
}

function removeEntry(key: string): void {
  writeOutbox(readOutbox().filter((e) => e.key !== key));
}

function noteFailure(key: string, error: string): void {
  writeOutbox(
    readOutbox().map((e) =>
      e.key === key
        ? { ...e, attempts: e.attempts + 1, lastError: error.slice(0, 200) }
        : e,
    ),
  );
}

// ─── posting ─────────────────────────────────────────────────────────────────

async function resolveTokenId(ref: TransferTokenRef): Promise<string | null> {
  if ("tokenId" in ref) return ref.tokenId;
  const tokens = await tokenApi.searchTokens({
    contractAddress: ref.contractAddress,
    blockchainId: ref.blockchainId,
  });
  return tokens?.[0]?.id ?? null;
}

type PostOutcome =
  | { status: "posted"; id: string }
  /** Retry later: no session for this wallet, network, server error. */
  | { status: "retry"; error: string }
  /** Never going to work (e.g. unknown token): drop the entry. */
  | { status: "drop"; error: string };

async function postEntry(entry: TransferRecordEntry): Promise<PostOutcome> {
  try {
    const tokenId = await resolveTokenId(entry.token);
    if (!tokenId) return { status: "drop", error: "token not in catalog" };

    const record = await transactionApi.createTransaction({
      tokenId,
      type: entry.type ?? "TRANSFER",
      amount: entry.amount,
      txHash: entry.txHash,
      fromAddress: entry.fromAddress,
      toAddress: entry.toAddress,
    });
    // `createTransaction` answers `{}` instead of throwing when the active
    // wallet has no session — the very case this outbox exists for.
    if (!record?.id) return { status: "retry", error: "no session" };
    return { status: "posted", id: record.id };
  } catch (err) {
    return { status: "retry", error: errorText(err) };
  }
}

async function invalidateActivity(): Promise<void> {
  // The Activity tab is React Query-backed; poke it so the new row shows
  // without a pull-to-refresh. `queryClient` comes from the app root the
  // same way `hooks/useRQGlobalState.ts` gets it; the import cycle
  // (`_layout` → `useTransferRecordOutboxFlush` → here → `_layout`) is
  // fine because the binding is only touched at call time.
  try {
    queryClient.invalidateQueries({
      queryKey: transactionsQueryKeys.all,
      exact: false,
    });
  } catch (err) {
    if (__DEV__) console.warn("[transferOutbox] invalidate failed:", err);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Record a transfer the wallet just sent. Persists first, then posts once
 * if the sending wallet is active and signed in. Never throws — the tx is
 * already on chain, and nothing here may fail the send flow.
 *
 * @returns the backend record id when it was posted right away, else
 * `undefined` (the entry stays in the outbox for `flushTransferRecordOutbox`).
 */
export async function recordTransfer(
  input: RecordTransferInput,
): Promise<string | undefined> {
  if (!input.txHash || !input.fromAddress || !input.toAddress) {
    return undefined;
  }
  let entry: TransferRecordEntry;
  try {
    entry = upsertEntry(input);
  } catch (err) {
    if (__DEV__) console.warn("[transferOutbox] could not persist:", err);
    return undefined;
  }
  const outcome = await attempt(entry);
  return outcome.status === "posted" ? outcome.id : undefined;
}

/**
 * Retry whatever is still in the outbox. Only entries whose sender is the
 * active wallet are attempted (see the attribution rule above); the rest
 * wait for that wallet to become active again.
 */
export async function flushTransferRecordOutbox(): Promise<FlushResult> {
  const result: FlushResult = { posted: 0, remaining: 0, dropped: 0 };
  const entries = readOutbox();
  if (entries.length === 0) return result;

  const now = Date.now();
  const active = await getActiveWalletAddress();

  let posts = 0;
  for (const entry of [...entries].sort((a, b) => a.createdAt - b.createdAt)) {
    if (now - entry.createdAt > MAX_AGE_MS) {
      removeEntry(entry.key);
      result.dropped += 1;
      continue;
    }
    if (!active || !sameAddress(entry.fromAddress, active)) {
      result.remaining += 1;
      continue;
    }
    if (posts >= MAX_POSTS_PER_FLUSH) {
      result.remaining += 1;
      continue;
    }
    posts += 1;
    const outcome = await attempt(entry, { activeAddress: active });
    if (outcome.status === "posted") result.posted += 1;
    else if (outcome.status === "drop") result.dropped += 1;
    else result.remaining += 1;
  }

  if (__DEV__ && (result.posted || result.dropped)) {
    console.log(
      `[transferOutbox] flushed posted=${result.posted} dropped=${result.dropped} remaining=${result.remaining}`,
    );
  }
  return result;
}

/** Test/diagnostic hook: how many transfers are still waiting to be recorded. */
export function pendingTransferRecordCount(): number {
  return readOutbox().length;
}

async function attempt(
  entry: TransferRecordEntry,
  known: { activeAddress?: string | null } = {},
): Promise<PostOutcome> {
  const active =
    known.activeAddress !== undefined
      ? known.activeAddress
      : await getActiveWalletAddress();

  if (!active || !sameAddress(entry.fromAddress, active)) {
    // Posting now would file it under a different wallet's user.
    return { status: "retry", error: "sender is not the active wallet" };
  }
  if (!(await isAuthenticatedForWallet(active))) {
    noteFailure(entry.key, "no session");
    return { status: "retry", error: "no session" };
  }

  const outcome = await postEntry(entry);
  if (outcome.status === "posted") {
    removeEntry(entry.key);
    void invalidateActivity();
  } else if (outcome.status === "drop") {
    removeEntry(entry.key);
    if (__DEV__) {
      console.warn(
        `[transferOutbox] dropping ${entry.txHash}: ${outcome.error}`,
      );
    }
  } else {
    noteFailure(entry.key, outcome.error);
    if (__DEV__) {
      console.warn(
        `[transferOutbox] will retry ${entry.txHash}: ${outcome.error}`,
      );
    }
  }
  return outcome;
}
