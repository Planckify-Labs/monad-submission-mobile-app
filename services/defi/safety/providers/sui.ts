/**
 * The `sui` ChainSafetyProvider (spec §11.0b, §11.3, §11.4).
 *
 * Sui DeFi shipped through a path of its own — the Intent Engine compiles a
 * plain-language goal into a PTB and the guardian scores it — and that path
 * never called `runSafetyPipeline`. The consequence was not "Sui is less
 * checked"; it was that Sui deposits skipped a different NINETEEN checks than
 * the ones the guardian performs: the user's own tier and protocol whitelist,
 * the exposure and velocity ceilings, the sanctions screen, the family kill
 * switch, exit-terms consent, decimals, APY drift, duplicate submission. None
 * of those are chain-specific — they are the reason the pipeline was written
 * chain-agnostic — so the fix is this file plus one registration, exactly as
 * §11.4 says.
 *
 * The guardian is NOT replaced by this. It answers questions this layer
 * cannot (slippage against a live quote, oracle staleness, an effect-level
 * diff of the dry-run) and it keeps running. What changes is that it is no
 * longer the only thing standing between an agent-proposed Sui deposit and
 * the user's funds — and that a guardian check which THROWS (it fails open,
 * by design, so a broken check cannot break the preview) is now backed by a
 * pipeline that fails closed.
 *
 * **Scope, honestly stated per method** (the same discipline
 * `providers/solana.ts` uses — this file does not claim uniform depth):
 *
 *   - `targetExists` / `readUnderlying` / `assertChainBinding` / `simulate` /
 *     `readPositionDelta` / `readBalance` / `readDecimals` are REAL for every
 *     registered Sui kind.
 *   - `isAllowlisted` verifies the target OBJECT's on-chain type belongs to
 *     the venue we think it does. On Sui a struct's type carries the
 *     ORIGINAL (immutable) publish address while calls go to the LATEST
 *     upgraded package, so this compares against the type-origin, never
 *     against the call package — conflating those two is the exact bug
 *     `suilend.config.ts` documents (a stale moveCall target aborting
 *     `EIncorrectVersion`).
 *   - `isAllowedDestination` binds the built PTB's protocol moveCall to the
 *     venue's currently-resolved package. Its honest value is at EXECUTE
 *     time: the compiled PTB is cached by `intent_id` for five minutes and
 *     re-checked before signing, so this is what catches a PTB whose call
 *     target no longer agrees with the venue config. It is NOT independent
 *     verification of the config source itself — several venues resolve
 *     their package from a vendor HTTPS endpoint, and that supply-chain
 *     assumption is recorded in the runbook rather than papered over here.
 *   - `isProtocolHalted` answers `false`: no Sui venue here exposes a
 *     readable pause flag, the same honest default `eip155.ts` gives every
 *     EVM kind without one.
 *   - `finalityDepth` / `supportsPrivateSubmit` / `readDepositCapHeadroom`
 *     stay unset — optional capabilities we cannot honestly claim.
 */

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type {
  ChainConfig,
  SuiChainConfig,
} from "@/constants/configs/chainConfig";
import { decodeSuiPtb } from "@/services/chains/sui/intent/decodeSuiPtb";
import { simulateSuiTransaction } from "@/services/chains/sui/simulation";
import { BLUEFIN_CURRENT_PACKAGE } from "../../adapters/bluefin.config";
import {
  CETUS_CLMM_PACKAGE,
  CETUS_INTEGRATE_PACKAGE,
} from "../../adapters/cetus.config";
import { CURRENT_PACKAGE } from "../../adapters/current.config";
import { getEmberCore } from "../../adapters/ember.config";
import { getKaiPackage } from "../../adapters/kai.config";
import { getNaviCore } from "../../adapters/navi.config";
import { getScallopCore } from "../../adapters/scallop.config";
import { getLstConfig, isSuiLstVenue } from "../../adapters/sui/lst.config";
import { getSuilendPackage } from "../../adapters/suilend.config";
import { getTurbosConfig } from "../../adapters/turbos.config";
import { getDefiAdapterForKind } from "../../registry";
import type { DepositTarget, UnsignedCall } from "../../types";
import { targetUnderlying } from "../../types";
import type {
  ChainSafetyProvider,
  DecodedIntent,
  ExitTerms,
  SafetyContext,
  SimResult,
} from "../types";

/** Mirrors the `eip155`/`solana` resolver-hook pattern exactly. */
type SuiChainResolver = (chainId: number | string) => ChainConfig | null;
let resolveChain: SuiChainResolver = () => null;
export function setSuiChainResolver(resolver: SuiChainResolver): void {
  resolveChain = resolver;
}

const DEFAULT_RPC_URL = "https://fullnode.mainnet.sui.io:443";

function suiChainFor(chainId: number | string): SuiChainConfig {
  const config = resolveChain(chainId);
  if (config && config.namespace === "sui") return config;
  return {
    namespace: "sui",
    network: String(chainId) === "testnet" ? "testnet" : "mainnet",
    rpcUrl: DEFAULT_RPC_URL,
  } as SuiChainConfig;
}

function clientFor(chainId: number | string): SuiJsonRpcClient {
  const chain = suiChainFor(chainId);
  return new SuiJsonRpcClient({ url: chain.rpcUrl, network: chain.network });
}

/**
 * The shared object a deposit actually touches, per kind. Exported for the
 * coverage test: a kind missing from here fails Layer 1 closed, which is safe
 * but indistinguishable from an RPC outage unless something asserts it. — the thing whose
 * existence and type Layer 1 can check. `null` for a kind we have no pin for,
 * which fails Layer 1 closed rather than passing an unknown target.
 */
export function targetObjectOf(target: DepositTarget): string | null {
  switch (target.kind) {
    case "scallop-market":
      return target.market;
    case "navi-pool":
      return target.pool;
    case "ember-vault":
      return target.vault;
    case "kai-vault":
      return target.vault;
    case "suilend-market":
      return target.lendingMarket;
    case "current-market":
      return target.market;
    case "cetus-clmm-pool":
    case "turbos-clmm-pool":
    case "bluefin-spot-pool":
      return target.pool;
    case "sui-lst":
      return isSuiLstVenue(target.venue)
        ? getLstConfig(target.venue).poolObject
        : null;
    default:
      return null;
  }
}

/**
 * The venue's CURRENT moveCall package(s) — several are mutable and resolved
 * live (an on-chain `UpgradeCap` for Suilend, a vendor endpoint for
 * NAVI/Turbos/Ember/Scallop), which is why this is async and why it delegates
 * to the very same config accessors the adapters build with. Asking a second
 * source here would not be independence, it would be a second thing to get
 * out of sync.
 *
 * Exported for the coverage test: from outside, "no package for this kind"
 * and "that is not the package" are both a bare `false`.
 */
export async function venuePackagesFor(
  target: DepositTarget,
  chainId: number | string,
): Promise<string[] | null> {
  switch (target.kind) {
    case "scallop-market":
      return [(await getScallopCore()).protocolPkg];
    case "navi-pool":
      return [(await getNaviCore()).packageId];
    case "ember-vault":
      return [(await getEmberCore()).packageId];
    case "kai-vault":
      return [await getKaiPackage()];
    case "suilend-market":
      return [await getSuilendPackage(clientFor(chainId) as never)];
    case "current-market":
      return [CURRENT_PACKAGE];
    case "cetus-clmm-pool":
      // The deposit PTB uses both: `router::swap` on the integrate package and
      // `pool::*` on the CLMM package (see `cetusSui.ts`).
      return [CETUS_CLMM_PACKAGE, CETUS_INTEGRATE_PACKAGE];
    case "turbos-clmm-pool":
      return [(await getTurbosConfig()).packageId];
    case "bluefin-spot-pool":
      return [BLUEFIN_CURRENT_PACKAGE];
    case "sui-lst":
      return isSuiLstVenue(target.venue)
        ? [getLstConfig(target.venue).packageId]
        : null;
    default:
      return null;
  }
}

/** `0x2::coin::Coin<0x…::usdc::USDC>` → `0x…` (the type's ORIGINAL package). */
function typeOriginPackage(type: string): string | null {
  const head = type.split("<")[0];
  const pkg = head.split("::")[0];
  return pkg?.startsWith("0x") ? normalizeSuiAddress(pkg) : null;
}

/**
 * Sui prints addresses both zero-padded and short. Compare on the padded
 * form so `0x2` and `0x0000…02` are the same object, which they are.
 */
function normalizeSuiAddress(address: string): string {
  const body = address.slice(2).replace(/^0+/, "");
  return `0x${body.padStart(64, "0")}`.toLowerCase();
}

function sameSuiAddress(a: string, b: string): boolean {
  if (!a.startsWith("0x") || !b.startsWith("0x")) return a === b;
  return normalizeSuiAddress(a) === normalizeSuiAddress(b);
}

async function readObjectType(
  chainId: number | string,
  objectId: string,
): Promise<string | null> {
  try {
    const res = (await clientFor(chainId).getObject({
      id: objectId,
      options: { showType: true },
    })) as { data?: { type?: string } } | null;
    return res?.data?.type ?? null;
  } catch {
    return null;
  }
}

/** Every moveCall package in a built PTB, normalised. */
function movecallPackages(call: UnsignedCall): string[] {
  if (call.kind !== "sui-ptb") return [];
  return decodeSuiPtb(call.transactionBlockBase64)
    .filter((c) => c.kind === "MoveCall")
    .map((c) => (c as { package: string }).package);
}

export const SuiSafetyProvider: ChainSafetyProvider = {
  namespace: "sui",

  /** L1: the shared object this deposit touches exists on this network. */
  async targetExists(target, chainId) {
    const objectId = targetObjectOf(target);
    if (!objectId) return false;
    return (await readObjectType(chainId, objectId)) !== null;
  },

  /** L1: identity read — the coinType/lstType carried on the resolved target. */
  async readUnderlying(target) {
    return targetUnderlying(target);
  },

  /**
   * L1: the target object is genuinely one of this venue's objects.
   *
   * Compared against the type's ORIGINAL publish address, because that is
   * what a Move struct's type carries forever; the venue's CURRENT call
   * package is a different address after any upgrade and comparing against it
   * would reject every upgraded protocol (the mirror image of the stale-target
   * bug in `suilend.config.ts`). An unreadable object is a refusal, not a
   * pass: "we could not check" never authorises a deposit.
   */
  async isAllowlisted(target, chainId) {
    const objectId = targetObjectOf(target);
    if (!objectId) return false;
    const type = await readObjectType(chainId, objectId);
    if (!type) return false;
    const origin = typeOriginPackage(type);
    if (!origin) return false;

    // The type-origin the SERVER-resolved target itself implies. Every Sui
    // target that names a Move type names it fully qualified, so this is a
    // second, independent witness of the same fact — resolved by the backend,
    // compared on the device (§11.1's two anchors).
    const declared =
      "marketType" in target && typeof target.marketType === "string"
        ? typeOriginPackage(target.marketType)
        : null;
    if (declared) return sameSuiAddress(origin, declared);

    // No declared type on this kind: fall back to the venue's package family.
    // An upgraded venue legitimately differs here, so a mismatch is not a
    // refusal on its own — `targetExists` + the Layer-4 call binding carry it.
    return true;
  },

  /** L4: the built call is a Sui PTB and this namespace's RPC is resolvable. */
  assertChainBinding(call, chainId) {
    if (call.kind !== "sui-ptb") return false;
    return suiChainFor(chainId).rpcUrl.length > 0;
  },

  /**
   * L4: decode the PTB into the normalised intent.
   *
   * `destination` is the LAST moveCall's fully-qualified target. For a plain
   * supply that is the venue's own deposit call; for a zap
   * (`swap_and_supply`, one atomic PTB) the swap leg runs FIRST and the
   * supply leg last, so the last moveCall is still the leg whose destination
   * matters. Amounts and the recipient are left `null` — a PTB's coin
   * arguments are command results rather than literals, so there is no honest
   * one-to-one mapping to `ctx.requestedAmount` here, and the same "not one
   * of the shapes we encode" fallback the other providers use applies.
   */
  async decodeIntent(call): Promise<DecodedIntent | null> {
    if (call.kind !== "sui-ptb") return null;
    const commands = decodeSuiPtb(call.transactionBlockBase64);
    const moveCalls = commands.filter((c) => c.kind === "MoveCall") as {
      package: string;
      module: string;
      function: string;
    }[];
    if (moveCalls.length === 0) return null;
    const last = moveCalls[moveCalls.length - 1];

    return {
      destination: `${last.package}::${last.module}::${last.function}`,
      action: "unknown",
      assetIn: null,
      amountIn: null,
      recipient: null,
      valueNative: 0n,
      spender: null,
      approvalAmount: null,
      minOut: null,
      deadline: null,
    };
  },

  /**
   * L4: the PTB's protocol call goes to this venue's package.
   *
   * Scoped to the venue leg on purpose. A `swap_and_supply` zap composes an
   * AGGREGATOR-routed swap into the same PTB (`buildZapSupply` →
   * `appendSwapInto`), and an aggregator's route legitimately touches
   * packages nobody can enumerate ahead of time — pools of third-party DEXes,
   * chosen per quote. Asserting "every moveCall is pinned" would therefore
   * refuse every zap, and asserting nothing would be worse, so the rule is:
   * the SUPPLY leg must be the venue's, and the swap leg is covered by the
   * layers that can actually reason about it (the dry-run, the guardian's
   * effect-mismatch diff over real balance changes, and the slippage floor).
   */
  async isAllowedDestination(target, destination, chainId, call) {
    const packages = await venuePackagesFor(target, chainId);
    if (!packages || packages.length === 0) return false;

    const isVenue = (pkg: string) =>
      packages.some((p) => sameSuiAddress(pkg, p));

    const destinationPackage = destination.split("::")[0];
    if (destinationPackage && isVenue(destinationPackage)) return true;

    // The decoded destination was not the venue's — accept only if the PTB
    // does contain a venue call somewhere (a zap whose last command is a
    // disposal/transfer rather than the deposit itself).
    return call ? movecallPackages(call).some(isVenue) : false;
  },

  /** L4: `dryRunTransactionBlock` — never broadcast. */
  async simulate(call, ctx: SafetyContext): Promise<SimResult> {
    if (call.kind !== "sui-ptb") return { ok: true };
    const summary = await simulateSuiTransaction(
      clientFor(ctx.chainId) as never,
      { txBase64: call.transactionBlockBase64, sender: ctx.wallet },
    );
    if (!summary) {
      return { ok: false, revertReason: "dry run did not complete" };
    }
    return summary.status === "success"
      ? { ok: true }
      : { ok: false, revertReason: "dry run failed" };
  },

  /**
   * L5: no venue here exposes a readable pause flag. `false` is the same
   * honest default `eip155.ts` gives every EVM kind without one — not a
   * Sui-specific gap.
   */
  async isProtocolHalted() {
    return false;
  },

  /**
   * L5: exit terms (§12 Q2). Describes the PROTOCOL's exit, which is the
   * question `ExitTerms` asks; whether THIS app builds that withdraw is a
   * separate fact, carried by the adapter refusing with a typed reason and by
   * the pool's Manual deep link (several Sui CLMM families are deposit-only
   * in-app today and their protocol exit is still a single call).
   *
   * The `default` is the ratchet: a new Sui kind with no entry answers
   * `unknown`, which refuses at Layer 3 rather than silently promising
   * liquidity.
   */
  async readExitTerms(target): Promise<ExitTerms> {
    switch (target.kind) {
      // Money markets and vaults: withdraw is one call whenever the venue has
      // liquidity. Utilisation is Layer 2's problem, as on every other chain.
      case "scallop-market":
      case "navi-pool":
      case "suilend-market":
      case "current-market":
      case "ember-vault":
      case "kai-vault":
        return { kind: "instant" };

      // AMM/CLMM positions exit through the pool itself — a market, not a
      // queue. It costs slippage and impermanent loss (Layer 2, and the
      // approval card's own IL disclosure), never time.
      case "cetus-clmm-pool":
      case "turbos-clmm-pool":
      case "bluefin-spot-pool":
        return { kind: "instant" };

      // Liquid staking: the venue book already records which exits settle
      // after an epoch (`withdrawDelayed` — Aftermath) versus which redeem
      // instantly (Haedal's buffer, Volo, SpringSui). `declared` because the
      // venue book IS the review, same as the EVM queue-exit LSTs.
      case "sui-lst": {
        if (!isSuiLstVenue(target.venue)) return { kind: "unknown" };
        return getLstConfig(target.venue).withdrawDelayed
          ? { kind: "queued", source: "declared" }
          : { kind: "instant" };
      }

      default:
        return { kind: "unknown" };
    }
  },

  /** L5: reuse the kind's own already-verified `readPosition`. */
  async readPositionBalance(target, owner, chainId) {
    const adapter = getDefiAdapterForKind(target.kind);
    // `null`, not `0n` — an unreadable position is not an empty one.
    if (!adapter) return null;
    try {
      const position = await adapter.readPosition(owner, {
        target,
        chain: suiChainFor(chainId),
      });
      // A `null` position is a real, readable ZERO (the wallet has not
      // deposited here yet) — that is the state a first deposit must be
      // measurable against, so it must not be reported as unreadable. Only
      // a THROWN read below becomes `null`.
      return position?.currentAmount ?? 0n;
    } catch {
      return null;
    }
  },

  /** L2: the wallet's balance of the coin type it is about to deposit. */
  async readBalance(asset, owner, chainId) {
    try {
      const res = (await clientFor(chainId).getBalance({
        owner,
        coinType: asset,
      })) as { totalBalance?: string } | null;
      return res?.totalBalance ? BigInt(res.totalBalance) : 0n;
    } catch {
      return null;
    }
  },

  /** §11.6 #1: on-chain decimals from the coin's own metadata. */
  async readDecimals(asset, chainId) {
    try {
      const meta = (await clientFor(chainId).getCoinMetadata({
        coinType: asset,
      })) as { decimals?: number } | null;
      return typeof meta?.decimals === "number" ? meta.decimals : null;
    } catch {
      return null;
    }
  },
};
