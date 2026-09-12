/**
 * Wallet-URI detector — see `docs/umkm-usdc-payout-spec.md` §4.3 #4 and
 * task `docs/umkm-usdc-payout-task/03_wallet_uri_detector_*.md`.
 *
 * Handles two schemes:
 *   - **EIP-681** (`ethereum:`): `ethereum:<address>[@<chainId>][/transfer]
 *     [?value=&uint256=&address=]`. When the URI carries a `@chainId`, the
 *     detector emits `target: { namespace: "eip155", chainId }` so the
 *     scan router can pre-switch `activeChain` before the user lands on
 *     `/send`. When the path is `/transfer` with an `address=` query, the
 *     original `<address>` is treated as the ERC-20 token contract and the
 *     payload's wallet target flips to the `address=` recipient.
 *   - **Solana Pay** (`solana:`): `solana:<pubkey>[?amount=&spl-token=
 *     &cluster=]`. Emits `target: { namespace: "solana", cluster }` with a
 *     default of `mainnet-beta` when `?cluster=` is omitted, per spec
 *     §4.2.
 *
 * Chain-extension discipline (memory
 * `feedback_chain_extension_discipline.md`): the two scheme branches live
 * **only inside this detector**. No caller is allowed to re-parse
 * `ethereum:` / `solana:` prefixes — `target` is the authoritative chain
 * hint for downstream consumers.
 *
 * The module is pure: no React, no networking, no Expo imports. RN's
 * `URL` constructor on Hermes treats unknown schemes as opaque (it does
 * not expose `pathname` / `searchParams` reliably for `ethereum:` /
 * `solana:`), so the implementation does its own lightweight parsing of
 * the scheme-specific part. `URLSearchParams` is used for the query
 * string because it's stable across Hermes and Node.
 */

import { type Detector, register } from "../detectorRegistry.ts";
import type { PayChannel, PaymentIntent, RawScan } from "../types.ts";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Solana public keys are base58-encoded Ed25519 public keys, typically
// 32–44 chars. We keep the check conservative (length + base58 alphabet)
// and leave deeper validation to the wallet-address detector / viem-less
// base58 utilities if a downstream task needs it.
const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const parseBigIntOrUndefined = (raw: string | null): bigint | undefined => {
  if (raw === null || raw === "") return undefined;
  try {
    // `BigInt()` accepts both decimal and `0x…` hex strings.
    return BigInt(raw);
  } catch {
    return undefined;
  }
};

const parseChainId = (raw: string): number | undefined => {
  // EIP-681 specifies decimal, but Wallet-Connect deep links are known to
  // emit `0x…` hex chainIds in the wild — accept both.
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    const asBig = BigInt(trimmed);
    // Safe-integer bound: all real chainIds fit in Number.MAX_SAFE_INTEGER.
    if (asBig > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    return Number(asBig);
  } catch {
    return undefined;
  }
};

export const parseEthereum = (raw: RawScan): PayChannel | null => {
  // Strip `ethereum:` (case-sensitive per EIP-681).
  const body = raw.slice("ethereum:".length);
  if (body === "") return null;

  // Split query string off first so path/chainId parsing stays simple.
  const queryIdx = body.indexOf("?");
  const head = queryIdx === -1 ? body : body.slice(0, queryIdx);
  const queryStr = queryIdx === -1 ? "" : body.slice(queryIdx + 1);

  // Split `<address>[@chainId][/function]`.
  // Find the first `@` or `/` after the address.
  let address = head;
  let chainIdStr: string | undefined;
  let fn: string | undefined;

  const atIdx = head.indexOf("@");
  const slashIdx = head.indexOf("/");

  if (atIdx !== -1 && (slashIdx === -1 || atIdx < slashIdx)) {
    address = head.slice(0, atIdx);
    if (slashIdx === -1) {
      chainIdStr = head.slice(atIdx + 1);
    } else {
      chainIdStr = head.slice(atIdx + 1, slashIdx);
      fn = head.slice(slashIdx + 1);
    }
  } else if (slashIdx !== -1) {
    address = head.slice(0, slashIdx);
    fn = head.slice(slashIdx + 1);
  }

  if (!EVM_ADDRESS_RE.test(address)) return null;

  const params = new URLSearchParams(queryStr);

  let finalAddress = address;
  let token: string | undefined;
  let amount: bigint | undefined;

  if (fn === "transfer") {
    // ERC-20 transfer: the URI's address is the token contract; the
    // `address=` query param is the recipient; `uint256=` is the amount.
    const recipient = params.get("address");
    if (recipient && EVM_ADDRESS_RE.test(recipient)) {
      token = address;
      finalAddress = recipient;
    }
    amount = parseBigIntOrUndefined(params.get("uint256"));
  } else {
    // Native value transfer: `?value=<wei>` or `?uint256=<wei>`.
    amount =
      parseBigIntOrUndefined(params.get("value")) ??
      parseBigIntOrUndefined(params.get("uint256"));
  }

  const channel: PayChannel = {
    kind: "wallet",
    namespace: "eip155",
    address: finalAddress,
  };

  if (chainIdStr !== undefined) {
    const chainId = parseChainId(chainIdStr);
    if (chainId !== undefined) {
      channel.target = { namespace: "eip155", chainId };
    }
  }
  if (amount !== undefined) channel.amount = amount;
  if (token !== undefined) channel.token = token;

  return channel;
};

export const parseSolana = (raw: RawScan): PayChannel | null => {
  const body = raw.slice("solana:".length);
  if (body === "") return null;

  const queryIdx = body.indexOf("?");
  const address = queryIdx === -1 ? body : body.slice(0, queryIdx);
  const queryStr = queryIdx === -1 ? "" : body.slice(queryIdx + 1);

  if (!SOLANA_PUBKEY_RE.test(address)) return null;

  const params = new URLSearchParams(queryStr);

  // Solana Pay `amount` is a decimal number with up to 9 fractional
  // digits. The `PayChannel.amount` contract is `bigint` (base units) —
  // but Solana Pay amounts are *human* units (e.g. `1.5 USDC`). We cannot
  // convert without knowing the SPL mint's decimals, which requires an
  // RPC fetch. So we only populate `amount` when the value is an integer
  // (no fractional part) — the send screen will re-parse otherwise.
  let amount: bigint | undefined;
  const amountRaw = params.get("amount");
  if (amountRaw !== null && amountRaw !== "" && !amountRaw.includes(".")) {
    amount = parseBigIntOrUndefined(amountRaw);
  }
  // Human-unit spelling for the deep-link builder / interstitial — the
  // QR path keeps its existing behaviour (`amount` only when integral).
  const amountDecimal =
    amountRaw !== null && amountRaw !== "" ? amountRaw : undefined;

  const token = params.get("spl-token") ?? undefined;

  const clusterRaw = params.get("cluster");
  const cluster: "mainnet-beta" | "devnet" =
    clusterRaw === "devnet" ? "devnet" : "mainnet-beta";

  const channel: PayChannel = {
    kind: "wallet",
    namespace: "solana",
    address,
    target: { namespace: "solana", cluster },
  };
  if (amount !== undefined) channel.amount = amount;
  if (amountDecimal !== undefined) channel.amountDecimal = amountDecimal;
  if (token !== undefined) channel.token = token;

  return channel;
};

const detect = (raw: RawScan): PaymentIntent | null => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();

  let channel: PayChannel | null = null;
  if (trimmed.startsWith("ethereum:")) {
    channel = parseEthereum(trimmed);
  } else if (trimmed.startsWith("solana:")) {
    channel = parseSolana(trimmed);
  }

  if (!channel) return null;

  return {
    source: "qr",
    channel,
    rawScan: raw,
  };
};

/**
 * Priority **40** — wedged between structured detectors (TakumiPay JWS
 * / x402 / EMVCo at 10/20/30) and the raw wallet-address detector (50).
 * This means a payload that matches *both* `ethereum:0x…` and a bare
 * `0x…` (unreachable in practice — the regexes don't overlap, but the
 * ordering is what future detectors depend on) resolves via the URI
 * branch first, preserving the `@chainId` hint.
 */
export const walletUriDetector: Detector = {
  name: "walletUri",
  priority: 40,
  detect,
};

register(walletUriDetector);
