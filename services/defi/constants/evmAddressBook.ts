/**
 * Mobile twin of the backend address-book
 * (`api/src/strategies/targets/address-book/`) — spec §11 Layer-1, §12 Q7.
 *
 * Most resolved targets carry their own destination (`comet`, `pool`, `vault`,
 * `router`), so the adapter reads it from the server-resolved target and this
 * file stays small. Two things genuinely cannot live on the target:
 *
 *  1. **The Morpho Blue singleton** — `supply`/`withdraw` go to one contract per
 *     chain, and §5.2 pins it as a per-chain constant rather than shipping it in
 *     a payload the device would have to trust.
 *  2. **The router allowlist** — the device has to verify, independently of the
 *     backend, that a router-call quote's `to` is a router we pinned. Reading
 *     that from the same response we are checking would be no check at all
 *     (§11.1: two independent trust anchors must agree).
 *
 * Same governance as the backend book: pinned, reviewed, no env override.
 */

import type { Address } from "viem";
import type { DepositTarget } from "../types";

/** `eqAddr` for this module — case-insensitive, tolerant of undefined. */
function eq(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * The singleton `Morpho` contract per chain. A chain absent here has no Morpho
 * Blue support on device, and the adapter refuses to build rather than guessing.
 */
export const MORPHO_BLUE_SINGLETONS: Readonly<Record<number, Address>> = {
  1: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", // Ethereum
  8453: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", // Base
};

export function morphoSingleton(chainId: number): Address | null {
  return MORPHO_BLUE_SINGLETONS[chainId] ?? null;
}

/** Pendle Router v4 — one deterministic address across supported chains. */
export const PENDLE_ROUTER =
  "0x888888888889758F76e7103c6CbF23ABbF58F946" as Address;

export const UNISWAP_V3_POSITION_MANAGERS: Readonly<Record<number, Address>> = {
  1: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  10: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  137: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  42161: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  8453: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
};

export const UNISWAP_V4_POSITION_MANAGERS: Readonly<Record<number, Address>> = {
  1: "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e",
  8453: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
};

/** The Balancer v2 Vault singleton — one address on every chain it is deployed to. */
export const BALANCER_V2_VAULT: Address =
  "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

/**
 * `BalancerQueries` (v2) per chain — mirrors the backend's pin
 * (`api/src/strategies/targets/address-book/dex.ts`, verified against
 * `balancer/balancer-deployments`, 2026-08-19). Unlike the Vault, this address
 * is NOT the same across chains, so it is a map, never a single constant. A
 * chain absent here has no reviewed queries deployment — the adapter MUST
 * refuse to build rather than price a join/exit with a zero minimum (§12 Q4).
 */
export const BALANCER_QUERIES: Readonly<Record<number, Address>> = {
  1: "0xE39B5e3B6D74016b2F6A9673D7d7493B6DF549d5", // Ethereum
  10: "0xE39B5e3B6D74016b2F6A9673D7d7493B6DF549d5", // Optimism
  137: "0xE39B5e3B6D74016b2F6A9673D7d7493B6DF549d5", // Polygon
  8453: "0x300Ab2038EAc391f26D9F895dc61F8F66a548833", // Base
  42161: "0xE39B5e3B6D74016b2F6A9673D7d7493B6DF549d5", // Arbitrum
  43114: "0xC128468b7Ce63eA702C1f104D55A2566b13D3ABD", // Avalanche
  100: "0x0F3e0c4218b7b0108a3643cFe9D3ec0d4F57c54e", // Gnosis
};

export function balancerQueries(chainId: number): Address | null {
  return BALANCER_QUERIES[chainId] ?? null;
}

type RouterProtocol = Extract<
  DepositTarget,
  { kind: "router-call" }
>["protocol"];

/**
 * Contracts a `router-call` quote is allowed to target (§6 guardrail 2). An
 * empty list means we cannot verify this (protocol, chain) pairing, so the
 * build is blocked — never "allow because we have no rule".
 */
export function routerAllowlist(
  protocol: RouterProtocol,
  chainId: number,
): readonly Address[] {
  switch (protocol) {
    case "pendle":
      return [PENDLE_ROUTER];
    case "uniswap-v3": {
      const pm = UNISWAP_V3_POSITION_MANAGERS[chainId];
      return pm ? [pm] : [];
    }
    case "uniswap-v4": {
      const pm = UNISWAP_V4_POSITION_MANAGERS[chainId];
      return pm ? [pm] : [];
    }
  }
}

export function isRouterAllowlisted(
  protocol: RouterProtocol,
  chainId: number,
  to: string | undefined,
): boolean {
  return routerAllowlist(protocol, chainId).some((a) => eq(a, to));
}
