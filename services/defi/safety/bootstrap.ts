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
 * its `simulate` and `decodeIntent` are trustworthy. `eip155`, `solana` and
 * `sui` are registered; `stellar` still adds a file here when it lands.
 *
 * Booting also installs the OPS config (`opsConfig.ts`) — the kill switch,
 * deny list, chain gate and audit sink that Layer 3 and the runner read.
 * Registering the checks without it produced the worst of both worlds: gates
 * that exist, are selected, run, and can never fire.
 */

import { LAYER0_CHECKS } from "./checks/layer0-input";
import { LAYER1_CHECKS } from "./checks/layer1-identity";
import { LAYER2_CHECKS } from "./checks/layer2-economic";
import { LAYER3_CHECKS } from "./checks/layer3-policy";
import { LAYER4_CHECKS } from "./checks/layer4-execution";
import { LAYER5_CHECKS } from "./checks/layer5-state";
import { bootDefiOpsConfig, resetDefiOpsConfig } from "./opsConfig";
import { Eip155SafetyProvider } from "./providers/eip155";
import { SolanaSafetyProvider } from "./providers/solana";
import { SuiSafetyProvider } from "./providers/sui";
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

  // Every provider-backed check above covers EVM from this one
  // registration; Stellar still adds a file when it lands.
  registerChainSafetyProvider(Eip155SafetyProvider);
  // Solana — see `providers/solana.ts`'s header for scope (full for every
  // required method; `decodeIntent` is fully decoded only for
  // `jito-vault-deposit`/`kamino-kvault`, honestly partial elsewhere).
  registerChainSafetyProvider(SolanaSafetyProvider);
  // Sui — see `providers/sui.ts`'s header. Docked so the Intent Engine's
  // deposits get the same nineteen chain-agnostic checks every other chain
  // gets; the guardian keeps running alongside it, answering the questions
  // (live slippage, oracle staleness, effect diff) this layer cannot.
  registerChainSafetyProvider(SuiSafetyProvider);

  bootDefiOpsConfig();

  booted = true;
}

/** Test seam. */
export function resetDefiSafetyBootstrap(): void {
  booted = false;
  resetDefiOpsConfig();
}
