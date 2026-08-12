/**
 * Chain-agnostic clear-signing orchestrator — task 65 (TWV-2026-066)
 * Phase B.
 *
 * `resolveClearSigningSummary(ns, args)` asks the namespace's
 * `WalletKitAdapter` for a descriptor via the optional
 * `resolveClearSigningDescriptor` capability (presence-checked — this
 * file must never contain a `namespace ===` branch), then falls back
 * to the existing bespoke decoders, then to the explicit
 * "unrecognized" state (`null`). Callers render `null` as the honest
 * "Unrecognized contract call" card — never a guess, never a block on
 * signing.
 *
 * The bespoke fallback is shape-based, not namespace-based: the
 * ERC-2612 / Permit2 decoders inspect the typed-data payload and
 * return `null` for anything that isn't theirs, so probing them is
 * safe for every chain.
 */

import type { Namespace } from "@/services/chains/types";
import { walletKitRegistry } from "@/services/walletKit/registry";
import type {
  ClearSigningDescriptor,
  ResolveClearSigningDescriptorArgs,
} from "@/services/walletKit/types";
// Side-effect import: docks the built-in typed-data decoders. A new
// EIP-712 standard becomes legible by adding a file there and one
// `registerTypedDataDecoder` call — this function does not change.
import "./typedDataDecoders";
import { decodeTypedData } from "./typedDataRegistry";

function bespokeFallback(
  args: ResolveClearSigningDescriptorArgs,
): ClearSigningDescriptor | null {
  const call = args.call;
  if (!call || typeof call !== "object") return null;
  const typedData = (call as { typedData?: unknown }).typedData;
  if (!typedData || typeof typedData !== "object") return null;
  // The signer comes from the caller (`intent.wallet`), never from a
  // field inside the payload — see `ResolveClearSigningDescriptorArgs`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return decodeTypedData(typedData as any, { signer: args.signer });
}

/**
 * Resolve the best available descriptor for a Stage-1-decoded call.
 * Adapter capability first, bespoke decoders second, `null`
 * (= explicit unrecognized state) last. Never throws — a resolver
 * failure is a raw-fallback, not an error the sheet has to handle.
 */
export async function resolveClearSigningSummary(
  ns: Namespace,
  args: ResolveClearSigningDescriptorArgs,
): Promise<ClearSigningDescriptor | null> {
  try {
    if (walletKitRegistry.has(ns)) {
      const kit = walletKitRegistry.get(ns);
      const viaAdapter = await kit.resolveClearSigningDescriptor?.(args);
      if (viaAdapter) return viaAdapter;
    }
  } catch (err) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn("[clearSigning] adapter resolution failed", err);
    }
  }
  return bespokeFallback(args);
}
