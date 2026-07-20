/**
 * `bootPpobCategorizers` — idempotent registration of every first-party
 * PPOB partner categorizer into `ppobCategorizerRegistry`. Mirrors
 * `services/walletKit/boot.ts` / `services/gasAbstraction/boot.ts`;
 * called once at process boot from `app/_layout.tsx`.
 *
 * To add a PPOB partner (Digiflazz, iak, …): create its categorizer under
 * `partners/`, register it here — no call-site changes anywhere else.
 */

import { createVcGamerCategorizer } from "./partners/vcgamer";
import { ppobCategorizerRegistry } from "./registry";

let booted = false;

export function bootPpobCategorizers(): void {
  if (booted) return;
  ppobCategorizerRegistry.register(createVcGamerCategorizer());
  booted = true;
}

/** Test-only reset hook — not part of the public boot contract. */
export function __resetPpobBootForTests(): void {
  booted = false;
}
