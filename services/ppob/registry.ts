/**
 * `ppobCategorizerRegistry` — resolves a `PpobCategorizer` by vendor name.
 *
 * Mirrors `walletKitRegistry` / `gasAbstractionRegistry` (space docking):
 *   - `resolve(vendor)` PRESENCE-CHECKS: returns `null` when no partner is
 *     docked for the vendor, so the UI degrades gracefully to a flat list
 *     rather than throwing. (Unlike walletKit's `get`, a missing PPOB
 *     categorizer is a soft, non-fatal condition — the catalog still
 *     renders, just without tabs.)
 *   - Vendor keys are lower-cased so `"vcGamer"`, `"VCGamer"`, `"vcgamer"`
 *     all resolve to the same categorizer.
 *
 * Rules: no `react` / `react-native` imports here — registration of
 * concrete partners happens in `./boot.ts`.
 */

import type { PpobCategorizer } from "./types";

class PpobCategorizerRegistryImpl {
  private readonly byVendor = new Map<string, PpobCategorizer>();

  register(categorizer: PpobCategorizer): void {
    this.byVendor.set(categorizer.vendor.toLowerCase(), categorizer);
  }

  /**
   * First categorizer docked for `vendor`, or `null` when none is —
   * callers fall back to rendering the catalog untabbed.
   */
  resolve(vendor: string | null | undefined): PpobCategorizer | null {
    if (!vendor) return null;
    return this.byVendor.get(vendor.toLowerCase()) ?? null;
  }

  has(vendor: string | null | undefined): boolean {
    return !!vendor && this.byVendor.has(vendor.toLowerCase());
  }

  getAll(): PpobCategorizer[] {
    return Array.from(this.byVendor.values());
  }

  /** Test-only — not part of the public contract. */
  clear(): void {
    this.byVendor.clear();
  }
}

export { PpobCategorizerRegistryImpl };

export const ppobCategorizerRegistry = new PpobCategorizerRegistryImpl();
