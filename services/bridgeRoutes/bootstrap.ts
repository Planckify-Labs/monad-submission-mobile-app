/**
 * Bridge adapter registration.
 *
 * Spec: docs/bridge-capability-spec.md §5.2.
 *
 * The ONLY place that knows the adapter set. Adding a provider (Bitcoin,
 * a Stellar-native bridge when one exists) is one `register` call plus
 * the adapter file — no enum edit, no branch in shared code, and nothing
 * under `components/`, `hooks/`, or `app/` learns a namespace string.
 *
 * Mirrors `services/defi/bootstrap.ts`, and is idempotent for the same
 * reason: Fast Refresh and test harnesses re-import modules freely.
 */

import { cctpStellarBridgeAdapter } from "./adapters/cctpStellarAdapter";
import { lifiBridgeAdapter } from "./adapters/lifiAdapter";
import { listBridgeAdapters, registerBridgeAdapter } from "./registry";

let booted = false;

export function bootstrapBridgeAdapters(): void {
  if (booted && listBridgeAdapters().length > 0) return;

  // `lifi` — any asset, EVM + Solana + Sui. Misses Stellar.
  registerBridgeAdapter(lifiBridgeAdapter);

  // `cctp` — USDC only, Stellar-only routes. Covers exactly what LI.FI
  // cannot, which is the case the registry exists to absorb (§3.2, §5.4).
  registerBridgeAdapter(cctpStellarBridgeAdapter);

  booted = true;
}
