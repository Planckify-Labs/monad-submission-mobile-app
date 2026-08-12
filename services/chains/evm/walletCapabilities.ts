/**
 * EIP-5792 `wallet_getCapabilities` dock.
 *
 * The spec's capability map is open-ended by design: `atomic`,
 * `paymasterService`, `auxiliaryFunds` and `flowControl` are the ones
 * defined today, and ERC-7677 / future EIPs keep adding more. Rather
 * than growing a literal object inside the RPC handler every time,
 * capabilities dock here as providers — same optional-capability +
 * presence-check shape the `WalletKitAdapter` registry uses.
 *
 * Adding a capability is one `registerCapabilityProvider` call and no
 * edit to `EvmAdapter`. A provider returning `null` is omitted from the
 * response entirely, which is what the spec asks for when a capability
 * simply does not apply — an absent key and `{ supported: false }` are
 * not the same signal to a dApp.
 */

import type { TWallet } from "@/constants/types/walletTypes";
import { getPaymasterConfig } from "./paymaster";

export interface CapabilityContext {
  address: `0x${string}`;
  chainId: number;
  /**
   * The wallet at `address` when it is one of ours, `null` otherwise.
   * A dApp may ask about an address we do not hold; every provider must
   * answer honestly for that case rather than assuming the active wallet.
   */
  wallet: TWallet | null;
}

export interface CapabilityProvider {
  /** EIP-5792 capability key, e.g. `"atomic"`. */
  key: string;
  /** Per-(address, chain) value, or `null` to omit the key. */
  resolve(ctx: CapabilityContext): Record<string, unknown> | null;
}

/**
 * EIP-5792 atomicity status for a wallet on a given chain.
 *
 *   supported   — calls execute atomically and contiguously
 *   ready       — the wallet can become `supported` with user approval
 *   unsupported — no atomicity or contiguity guarantee
 *
 * `ready` is the case a boolean cannot express, and is why the draft's
 * `atomicBatch: { supported }` had to go: a 7702-capable EOA that has
 * not yet delegated *on this chain* is not "unsupported" — it is one
 * authorization away from atomic, and dApps use that to decide whether
 * to offer a batched flow at all.
 */
export function atomicStatus(
  wallet: TWallet | null | undefined,
  chainId: number,
): "supported" | "ready" | "unsupported" {
  if (!wallet) return "unsupported";
  if (wallet.type === "Smart4337") return "supported";
  if (wallet.type === "Smart7702") {
    return wallet.smart7702?.authorizationByChain?.[chainId] !== undefined
      ? "supported"
      : "ready";
  }
  return "unsupported";
}

/**
 * True only when the batch is guaranteed all-or-nothing *right now*.
 * `ready` is deliberately false here: the request path uses this to
 * honour `atomicRequired`, and "one approval away from atomic" is not
 * atomic.
 */
export function canExecuteAtomically(
  wallet: TWallet | null | undefined,
  chainId: number,
): boolean {
  return atomicStatus(wallet, chainId) === "supported";
}

const providers: CapabilityProvider[] = [];

/** Dock a capability. Re-registering the same key replaces it. */
export function registerCapabilityProvider(p: CapabilityProvider): void {
  const i = providers.findIndex((x) => x.key === p.key);
  if (i >= 0) providers[i] = p;
  else providers.push(p);
}

/** Test seam — drops every provider, including the built-ins below. */
export function __resetCapabilityProviders(): void {
  providers.length = 0;
}

/**
 * Build the capability object for one (address, chain) pair. A provider
 * that throws is skipped rather than failing the whole RPC call: a
 * broken optional capability must not take down capability discovery.
 */
export function resolveCapabilities(
  ctx: CapabilityContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of providers) {
    try {
      const value = p.resolve(ctx);
      if (value) out[p.key] = value;
    } catch (err) {
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn(`[capabilities] provider "${p.key}" failed`, err);
      }
    }
  }
  return out;
}

/** Every capability key this wallet knows how to answer for. */
export function supportedCapabilityKeys(): string[] {
  return providers.map((p) => p.key);
}

/**
 * The first non-optional capability in a `wallet_sendCalls` request that
 * we do not implement, or `null` when the request is satisfiable.
 *
 * EIP-5792 is explicit that a wallet MUST reject a request carrying a
 * capability it does not support unless that capability is marked
 * `optional`. Ignoring one is not leniency: the dApp asked for a batch
 * executed under particular terms, and running it under different ones
 * (no sponsorship, no pre-call, no flow control) produces an on-chain
 * result nobody authorised. Rejecting with 5700 lets the dApp drop the
 * capability and ask again, which is a conversation it can actually have.
 *
 * Checks the top-level object and every per-call one, since either may
 * carry a requirement.
 */
export function firstUnsupportedCapability(
  topLevel: Record<string, unknown> | undefined,
  perCall?: ReadonlyArray<Record<string, unknown> | undefined>,
): string | null {
  const supported = new Set(supportedCapabilityKeys());
  const check = (caps: Record<string, unknown> | undefined): string | null => {
    if (!caps || typeof caps !== "object") return null;
    for (const [key, value] of Object.entries(caps)) {
      if (supported.has(key)) continue;
      // Absent `optional` means required, per the EIP's default.
      const optional =
        value !== null &&
        typeof value === "object" &&
        (value as { optional?: unknown }).optional === true;
      if (!optional) return key;
    }
    return null;
  };
  const top = check(topLevel);
  if (top) return top;
  for (const caps of perCall ?? []) {
    const hit = check(caps);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------
// Built-in providers. Registered at module load, so there is no
// bootstrap-ordering hazard — importing this module is enough.
// ---------------------------------------------------------------------

registerCapabilityProvider({
  key: "atomic",
  resolve: (ctx) => ({ status: atomicStatus(ctx.wallet, ctx.chainId) }),
});

registerCapabilityProvider({
  key: "paymasterService",
  resolve: (ctx) => {
    // Sponsorship rides the smart-account path; an EOA has nothing to
    // sponsor through. Note we advertise support without echoing our
    // paymaster URL: under ERC-7677 the *dApp* supplies the service URL
    // in `wallet_sendCalls` capabilities, so returning ours would hand
    // every origin an infrastructure endpoint it has no need for.
    const smart =
      ctx.wallet?.type === "Smart4337" || ctx.wallet?.type === "Smart7702";
    if (!smart) return { supported: false };
    return { supported: !!getPaymasterConfig(ctx.chainId) };
  },
});

registerCapabilityProvider({
  key: "auxiliaryFunds",
  resolve: () => ({ supported: false }),
});
