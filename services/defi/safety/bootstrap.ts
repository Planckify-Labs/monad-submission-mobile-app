/**
 * Safety bootstrap (spec §11.4) — register every check plus the chains we can
 * actually verify.
 *
 * Ordering is irrelevant: the runner sorts by `layer`. What matters is that a
 * check registered here applies to EVERY chain whose provider is registered,
 * which is the whole point of the split — adding Sui DeFi means adding
 * `providers/sui.ts` and one line below, not revisiting any check.
 *
 * §11.3: a chain with a PARTIAL provider must register read-only/Manual until
 * its `simulate` and `decodeIntent` are trustworthy. We ship `eip155` only.
 */

import { LAYER0_CHECKS } from "./checks/layer0-input";
import { LAYER1_CHECKS } from "./checks/layer1-identity";
import { LAYER2_CHECKS } from "./checks/layer2-economic";
import { LAYER3_CHECKS } from "./checks/layer3-policy";
import { LAYER4_CHECKS } from "./checks/layer4-execution";
import { LAYER5_CHECKS } from "./checks/layer5-state";
import { Eip155SafetyProvider } from "./providers/eip155";
import { registerChainSafetyProvider, registerSafetyCheck } from "./registry";

let booted = false;

export function bootDefiSafety(): void {
  if (booted) return;

  for (const check of [
    ...LAYER0_CHECKS,
    ...LAYER1_CHECKS,
    ...LAYER2_CHECKS,
    ...LAYER3_CHECKS,
    ...LAYER4_CHECKS,
    ...LAYER5_CHECKS,
  ]) {
    registerSafetyCheck(check);
  }

  // The only provider that exists today. Every provider-backed check above
  // covers EVM from this one registration; Sui/Solana/Stellar add a file each.
  registerChainSafetyProvider(Eip155SafetyProvider);

  booted = true;
}

/** Test seam. */
export function resetDefiSafetyBootstrap(): void {
  booted = false;
}
