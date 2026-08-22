/**
 * Chain sandboxes — "how far can we rehearse a write on this chain without
 * spending money?", answered per namespace.
 *
 * ## Why this is a registry and not `if (namespace === "eip155")`
 *
 * The fork harness is anvil-shaped: `executeCall` refuses anything that is not
 * an `evm-call`. That is correct today (EVM is where the protocol resolvers are
 * being expanded) and wrong as a permanent assumption — this app ships DeFi
 * targets for Sui and Solana too (`scallop-market`, `navi-pool`, `ember-vault`,
 * `sui-lst`, `solana-reserve`). Docking one of those must be adding a file, not
 * editing the gate, which is the same rule `services/defi/safety/providers/`
 * already follows and `pnpm check:chains` enforces in shared code.
 *
 * ## The two rungs, and why they are not the same claim
 *
 * Not every chain has a mainnet-forking sandbox, so "rehearsable" is not a
 * boolean:
 *
 *   `execute`   Stand up a fork of mainnet state, submit real signed
 *               transactions, and read the position back. Proves the ROUND TRIP
 *               — deposit and withdraw — because state persists between calls.
 *               EVM (anvil) today; Solana can reach this rung
 *               (`surfpool` / `solana-test-validator --clone`).
 *
 *   `simulate`  Dry-run one transaction against LIVE mainnet state and read the
 *               reported balance/object changes. Costs nothing and moves
 *               nothing, and for a deposit it genuinely answers "would this
 *               land". It CANNOT prove a round trip: nothing persists, so there
 *               is no position to withdraw from. Sui
 *               (`dryRunTransactionBlock` → `balanceChanges`/`objectChanges`)
 *               and Stellar/Soroban (`simulateTransaction`) sit here.
 *
 *   `none`      No provider. The family stays Manual and the coverage gate says
 *               so by name.
 *
 * A namespace that reports `simulate` must NOT be presented as having passed the
 * same bar as one that reports `execute`. `forkCoverage.test.ts` prints the rung
 * alongside every family for exactly that reason: the failure this whole
 * exercise exists to prevent is an unrun check reading as a pass.
 */

import type { Namespace } from "@/services/chains/types";
import { canFork, type ForkContext, startFork } from "./harness";

/** How faithfully a chain can be rehearsed. Ordered weakest → strongest. */
export type RehearsalRung = "none" | "simulate" | "execute";

export const RUNG_RANK: Readonly<Record<RehearsalRung, number>> = {
  none: 0,
  simulate: 1,
  execute: 2,
};

export interface ChainSandboxProvider {
  readonly namespace: Namespace;

  /**
   * The best rung available for a chain **in the current environment**.
   *
   * Environment-sensitive on purpose: anvil can execute Arbitrum, but only if
   * `FORK_RPC_URL_42161` is set and `FORK_TESTS=1`. Reporting `execute` when
   * the run cannot actually execute is the same lie as a skipped test that
   * prints green.
   */
  rung(chainId: number): RehearsalRung;

  /**
   * Boot a sandbox for a chain this provider reports `execute` for.
   *
   * OPTIONAL under the space-docking rule: a `simulate`-only namespace does not
   * implement it, and callers presence-check rather than branching on the
   * namespace.
   */
  start?(chainId: number): Promise<ForkContext>;
}

const providers = new Map<Namespace, ChainSandboxProvider>();

export function registerChainSandboxProvider(p: ChainSandboxProvider): void {
  providers.set(p.namespace, p);
}

export function sandboxProviderFor(
  namespace: Namespace,
): ChainSandboxProvider | null {
  return providers.get(namespace) ?? null;
}

export function listChainSandboxProviders(): ChainSandboxProvider[] {
  return [...providers.values()];
}

/**
 * The rung for a namespace/chain pair. `none` for an unregistered namespace —
 * the honest answer, and the one that keeps a family Manual instead of
 * silently unverified.
 */
export function rehearsalRung(
  namespace: Namespace,
  chainId: number,
): RehearsalRung {
  return sandboxProviderFor(namespace)?.rung(chainId) ?? "none";
}

/**
 * EVM — anvil, via the existing harness.
 *
 * `canFork` already encodes the environment question (`FORK_TESTS=1` plus a
 * `FORK_RPC_URL_<id>`), so this provider is a thin declaration over it rather
 * than a second copy of the rule.
 */
export const Eip155SandboxProvider: ChainSandboxProvider = {
  namespace: "eip155",
  rung(chainId) {
    return canFork(chainId) ? "execute" : "none";
  },
  start(chainId) {
    return startFork(chainId);
  },
};

registerChainSandboxProvider(Eip155SandboxProvider);
