/**
 * The `eip155` ChainSafetyProvider — the ONLY chain-specific file in the safety
 * layer (spec §11.0b, §11.4, §11.5 Tier 2).
 *
 * Every check is written against this interface, not against viem. That is what
 * makes "focus on EVM" and "chain-agnostic" compatible: we ship only this
 * provider now, but the checks and the runner are already the version we would
 * keep when Sui/Solana/Stellar DeFi lands — those add `providers/sui.ts` et al.
 * and change nothing else (§13.5).
 *
 * The EVM-native safety parameters this provider owns (§11.5 Tier 2): bytecode
 * presence, EIP-155 chain binding, ERC-20 allowance semantics, function
 * selectors, revert decoding, gas ceilings. The runner never learns any of them.
 */

import {
  type Abi,
  type Address,
  decodeFunctionData,
  erc20Abi,
  parseAbi,
  toFunctionSelector,
} from "viem";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { getPublicClient } from "@/utils/clients";
import {
  morphoSingleton,
  routerAllowlist,
} from "../../constants/evmAddressBook";
import type { DepositTarget, UnsignedCall } from "../../types";
import { NATIVE_ASSET_SENTINEL, targetUnderlying } from "../../types";
import type {
  ChainSafetyProvider,
  DecodedIntent,
  ExitTerms,
  SafetyContext,
  SimResult,
} from "../types";

/**
 * Chains are data (see the backend `chain-directory.ts`): the provider is
 * handed the resolved `ChainConfig` for the chain in play rather than looking
 * one up from a bundled per-chain constant. `setEvmChainResolver` is how the
 * app wires the API's blockchain rows in.
 */
type EvmChainResolver = (chainId: number | string) => ChainConfig | null;

let resolveChain: EvmChainResolver = () => null;

export function setEvmChainResolver(resolver: EvmChainResolver): void {
  resolveChain = resolver;
}

function clientFor(chainId: number | string) {
  const config = resolveChain(chainId);
  if (!config || config.namespace !== "eip155") return null;
  const evm = config as Extract<ChainConfig, { namespace: "eip155" }>;
  try {
    return { client: getPublicClient(evm.chain), chain: evm.chain };
  } catch {
    return null;
  }
}

/** The address a target's transaction is sent to, per kind. */
function destinationOf(
  target: DepositTarget,
  chainId: number | string,
): Address | null {
  switch (target.kind) {
    case "erc4626":
    case "async-vault":
      return target.vault;
    case "aave-v3":
      return target.pool;
    case "compound-v3":
      return target.comet;
    case "compound-v2":
      return target.cToken;
    case "curve-lp":
      return target.pool;
    case "solidly-lp":
      return target.router;
    case "balancer-lp":
      return target.vault;
    case "morpho-blue":
      return morphoSingleton(Number(chainId));
    case "router-call":
      // The destination only exists once a quote is fetched; it is verified
      // against the allowlist at build time instead (§6 guardrail 2).
      return null;
    default:
      return null;
  }
}

const ERC4626_ABI = parseAbi([
  "function asset() view returns (address)",
  "function maxDeposit(address receiver) view returns (uint256)",
]);
const COMET_ABI = parseAbi([
  "function baseToken() view returns (address)",
  "function isSupplyPaused() view returns (bool)",
]);
const CTOKEN_ABI = parseAbi(["function underlying() view returns (address)"]);
/**
 * The two exit signals a vault can actually expose. There is no ERC for
 * "lockup duration", so this is the whole generic surface:
 *
 *  - `supportsInterface(0x620ee8e4)` — ERC-7540 async redeem. Certain
 *    classification (the exit is a request), but carries no duration.
 *  - `cooldownDuration()` — the cooldown-vault convention (Ethena's sUSDe
 *    returns 86400; its own MAX is 90 days), read live because a protocol can
 *    change it between the quote and the signature.
 */
const EXIT_PROBE_ABI = parseAbi([
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function cooldownDuration() view returns (uint24)",
]);
/** ERC-7540 `IERC7540Redeem`. An async redeem is a request, never a withdraw. */
const ERC7540_REDEEM_INTERFACE_ID = "0x620ee8e4";
const CURVE_ABI = parseAbi([
  "function coins(uint256 i) view returns (address)",
]);
const AAVE_ABI = parseAbi([
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
]);

/**
 * Selectors we can decode into a normalised intent. Anything outside this set
 * decodes to `action: "unknown"`, which the Layer-4 check treats as
 * un-assertable rather than as approved.
 */
const KNOWN_FUNCTIONS = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function supply(address asset, uint256 amount)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function withdraw(address asset, uint256 amount)",
  "function mint(uint256 mintAmount) returns (uint256)",
  "function redeemUnderlying(uint256 redeemAmount) returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const APPROVE_SELECTOR = toFunctionSelector(
  "function approve(address spender, uint256 amount) returns (bool)",
);

/**
 * `eth_call` a view and report what it answered, or `null` if it reverted.
 *
 * Reverting is a legitimate answer here, not an error: "this contract has no
 * `underlying()`" is exactly how a native cToken market identifies itself, and
 * "`stable()` is missing" is how a Uniswap pair distinguishes itself from a
 * Solidly one. Callers read `null` as "the chain could not confirm it" and fail
 * closed.
 */
async function probes(
  client: ReturnType<typeof getPublicClient>,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<unknown | null> {
  try {
    return await client.readContract({
      address,
      abi,
      functionName,
      args,
    });
  } catch {
    return null;
  }
}

export const Eip155SafetyProvider: ChainSafetyProvider = {
  namespace: "eip155",

  /** L1: `EXTCODESIZE > 0`. */
  async targetExists(target, chainId) {
    const ctx = clientFor(chainId);
    if (!ctx) return false;
    const destination = destinationOf(target, chainId);
    if (!destination) {
      // router-call has no fixed destination; the market must at least exist.
      if (target.kind === "router-call") {
        const code = await ctx.client
          .getBytecode({ address: target.market })
          .catch(() => undefined);
        return typeof code === "string" && code.length > 2;
      }
      return false;
    }
    const code = await ctx.client
      .getBytecode({ address: destination })
      .catch(() => undefined);
    return typeof code === "string" && code.length > 2;
  },

  /** L1: the identity read appropriate to the kind. */
  async readUnderlying(target, chainId) {
    const ctx = clientFor(chainId);
    if (!ctx) return null;
    switch (target.kind) {
      case "erc4626":
      case "async-vault": {
        const asset = await probes(
          ctx.client,
          target.vault,
          ERC4626_ABI,
          "asset",
        );
        return typeof asset === "string" ? asset : null;
      }
      case "compound-v3": {
        const base = await probes(
          ctx.client,
          target.comet,
          COMET_ABI,
          "baseToken",
        );
        return typeof base === "string" ? base : null;
      }
      case "compound-v2": {
        const under = await probes(
          ctx.client,
          target.cToken,
          CTOKEN_ABI,
          "underlying",
        );
        return typeof under === "string" ? under : null;
      }
      case "curve-lp": {
        const coin = await probes(ctx.client, target.pool, CURVE_ABI, "coins", [
          BigInt(target.index),
        ]);
        return typeof coin === "string" ? coin : null;
      }
      case "aave-v3": {
        const data = await probes(
          ctx.client,
          target.pool,
          AAVE_ABI,
          "getReserveData",
          [target.asset],
        );
        // A listed reserve proves the Pool knows this asset; the asset itself
        // is what the caller asked about.
        const aToken = (data as { aTokenAddress?: string } | null)
          ?.aTokenAddress;
        return aToken && aToken !== `0x${"0".repeat(40)}` ? target.asset : null;
      }
      case "morpho-blue":
        return target.params.loanToken;
      case "lst-stake":
        return target.asset;
      case "router-call":
        return target.tokenIn;
      case "solidly-lp":
      case "balancer-lp":
        return targetUnderlying(target);
      default:
        return null;
    }
  },

  /**
   * L1: is the destination a pinned singleton for its kind? Per-vault kinds
   * are legitimately API-sourced and are admitted by identity instead, so they
   * answer `true` here — that is not a gap, it is the rule from §12 Q7.
   */
  async isAllowlisted(target, chainId) {
    if (target.kind === "morpho-blue") {
      return morphoSingleton(Number(chainId)) !== null;
    }
    if (target.kind === "router-call") {
      // The quote's `to` is checked against this same list when the call is
      // built (§6 guardrail 2). What Layer 1 can assert at resolve time is
      // weaker but still necessary: that a pinned router EXISTS for this
      // (protocol, chain). Without one there is nothing to verify a quote
      // against, so the family must not be offered here at all.
      return routerAllowlist(target.protocol, Number(chainId)).length > 0;
    }
    return true;
  },

  /** L4: EIP-155 binding — the built call must carry the intended chain. */
  assertChainBinding(_call: UnsignedCall, chainId: number | string): boolean {
    // `UnsignedCall` has no chainId of its own; the wallet client signs with
    // the chain it was created for, so binding is proven by the client the
    // caller resolved. What we CAN assert here is that we know the chain.
    return clientFor(chainId) !== null;
  },

  /** L4: ABI-decode the calldata into the normalised intent. */
  async decodeIntent(call: UnsignedCall): Promise<DecodedIntent | null> {
    if (call.kind !== "evm-call") return null;

    const approvals = Array.isArray(call.needsApproval)
      ? call.needsApproval
      : call.needsApproval
        ? [call.needsApproval]
        : [];

    const base: DecodedIntent = {
      destination: call.to,
      action: "unknown",
      assetIn: approvals[0]?.token ?? null,
      amountIn: approvals[0]?.amount ?? null,
      recipient: null,
      valueNative: call.value ?? 0n,
      spender: approvals[0]?.spender ?? null,
      approvalAmount: approvals[0]?.amount ?? null,
      minOut: null,
      deadline: null,
    };

    // A native stake carries no approval, so the value IS the amount (§12 Q5).
    if (approvals.length === 0 && (call.value ?? 0n) > 0n) {
      base.assetIn = NATIVE_ASSET_SENTINEL;
      base.amountIn = call.value ?? 0n;
      base.action = "stake";
    }

    if (call.data.startsWith(APPROVE_SELECTOR)) {
      base.action = "approve";
    }

    try {
      const decoded = decodeFunctionData({
        abi: KNOWN_FUNCTIONS,
        data: call.data,
      });
      const args = (decoded.args ?? []) as readonly unknown[];
      switch (decoded.functionName) {
        case "deposit":
          base.action = "deposit";
          base.amountIn = args[0] as bigint;
          base.recipient = args[1] as string;
          break;
        case "supply":
          base.action = "deposit";
          if (typeof args[0] === "string") {
            base.assetIn = args[0];
            base.amountIn = args[1] as bigint;
            if (typeof args[2] === "string") base.recipient = args[2];
          }
          break;
        case "mint":
          base.action = "deposit";
          base.amountIn = args[0] as bigint;
          break;
        case "withdraw":
          base.action = "withdraw";
          if (typeof args[0] === "string") {
            base.assetIn = args[0];
            base.amountIn = args[1] as bigint;
            if (typeof args[2] === "string") base.recipient = args[2];
          } else {
            base.amountIn = args[0] as bigint;
            base.recipient = args[1] as string;
          }
          break;
        case "redeem":
          base.action = "withdraw";
          base.recipient = args[1] as string;
          break;
        case "redeemUnderlying":
          base.action = "withdraw";
          base.amountIn = args[0] as bigint;
          break;
        case "approve":
          base.action = "approve";
          base.spender = args[0] as string;
          base.approvalAmount = args[1] as bigint;
          break;
      }
    } catch {
      // Not one of the shapes we encode — Curve/Solidly/Balancer/router calls
      // land here. `action: "unknown"` is honest; the Layer-4 check then relies
      // on the allowlist plus simulation rather than on a decode we faked.
    }

    return base;
  },

  /** L4: `eth_call` the built transaction without broadcasting. */
  async simulate(call: UnsignedCall, ctx: SafetyContext): Promise<SimResult> {
    if (call.kind !== "evm-call") return { ok: true };
    const chain = clientFor(ctx.chainId);
    if (!chain) return { ok: false, revertReason: "chain unavailable" };
    try {
      await chain.client.call({
        account: ctx.wallet as Address,
        to: call.to,
        data: call.data,
        value: call.value ?? 0n,
      });
      return { ok: true };
    } catch (err) {
      // The reason is diagnostic only and never reaches a user-facing string.
      return {
        ok: false,
        revertReason: err instanceof Error ? err.name : "revert",
      };
    }
  },

  /** L5: the protocol's own emergency state. */
  async isProtocolHalted(target, chainId) {
    const ctx = clientFor(chainId);
    if (!ctx) return false;
    if (target.kind === "compound-v3") {
      const paused = await probes(
        ctx.client,
        target.comet,
        COMET_ABI,
        "isSupplyPaused",
      );
      return paused === true;
    }
    if (target.kind === "erc4626" || target.kind === "async-vault") {
      // A 4626 vault that will not accept a deposit reports zero capacity —
      // the standard's own way of saying "closed".
      const max = await probes(
        ctx.client,
        target.vault,
        ERC4626_ABI,
        "maxDeposit",
        [target.vault],
      );
      return typeof max === "bigint" && max === 0n;
    }
    return false;
  },

  /**
   * L5: how long funds are locked on the way out (§12 Q2).
   *
   * Deliberately conservative about what counts as proof. Money markets and LP
   * positions have no protocol-imposed lock — an Aave reserve at full
   * utilisation is an *illiquidity* problem for Layer 2, not a lockup — so they
   * answer `instant` by construction. Everything else has to show its terms.
   */
  async readExitTerms(target, chainId): Promise<ExitTerms> {
    switch (target.kind) {
      // No protocol-imposed lock: withdraw is one call whenever liquidity is
      // there. Slippage and utilisation are other layers' problems.
      case "aave-v3":
      case "compound-v3":
      case "compound-v2":
      case "morpho-blue":
      case "curve-lp":
      case "solidly-lp":
      case "balancer-lp":
      case "router-call":
        return { kind: "instant" };

      // ERC-7540 is a request/claim state machine by definition, and §7 keeps
      // the family unregistered until the two-phase UX exists.
      case "async-vault":
        return { kind: "queued", source: "declared" };

      // The venue book already carries the honest exit path, reviewed when the
      // venue was pinned. `dex` is not a lockup: it exits through a market, so
      // it costs slippage (Layer 2), not time.
      case "lst-stake":
        return target.exit === "queue"
          ? { kind: "queued", source: "declared" }
          : { kind: "instant" };

      case "erc4626": {
        const ctx = clientFor(chainId);
        if (!ctx) return { kind: "unknown" };

        const isAsync = await probes(
          ctx.client,
          target.vault,
          EXIT_PROBE_ABI,
          "supportsInterface",
          [ERC7540_REDEEM_INTERFACE_ID],
        );
        if (isAsync === true) return { kind: "queued", source: "onchain" };

        const cooldown = await probes(
          ctx.client,
          target.vault,
          EXIT_PROBE_ABI,
          "cooldownDuration",
        );
        if (typeof cooldown === "bigint" || typeof cooldown === "number") {
          const seconds = Number(cooldown);
          if (seconds > 0)
            return { kind: "delayed", seconds, source: "onchain" };
        }

        // Neither signal present. Treated as instant, and that rests on a
        // narrower fact than it looks: the ONLY vaults that reach here are
        // those a reviewed family resolver admitted (§12 Q1), and ERC-4626
        // requires `redeem` to honour `maxRedeem`. A vault with a bespoke
        // lockup and no 7540/cooldown surface would be mischaracterised — so
        // if a generic "any 4626 that validates" path is ever added, this
        // default MUST become `unknown` for anything outside a reviewed family.
        return { kind: "instant" };
      }

      default:
        return { kind: "unknown" };
    }
  },

  /** L5: post-execution position delta. */
  async readPositionDelta(target, owner, chainId) {
    const ctx = clientFor(chainId);
    if (!ctx) return 0n;
    // The receipt token differs per kind; for the share-bearing families the
    // destination IS the receipt, which covers 4626, cToken and most LP
    // pools. `curve-lp` is the exception since 2026-08-21: a classic Curve
    // pool mints a SEPARATE LP token, and the pool contract itself has no
    // `balanceOf` at all — reading `destinationOf` there would silently
    // report "no position change" after a successful deposit, exactly the
    // failure mode this check exists to catch.
    const receipt =
      target.kind === "lst-stake"
        ? target.receipt
        : target.kind === "curve-lp"
          ? (target.lpToken ?? target.pool)
          : destinationOf(target, chainId);
    if (!receipt) return 0n;
    try {
      return await ctx.client.readContract({
        address: receipt,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner as Address],
      });
    } catch {
      return 0n;
    }
  },

  /**
   * L2: the wallet's holding of the asset. The native sentinel reads the
   * account's own balance — a native stake spends the coin itself, so an
   * `erc20.balanceOf` on `0x0` would be the wrong question.
   */
  async readBalance(asset, owner, chainId) {
    const ctx = clientFor(chainId);
    if (!ctx) return null;
    try {
      if (asset.toLowerCase() === NATIVE_ASSET_SENTINEL.toLowerCase()) {
        return await ctx.client.getBalance({ address: owner as Address });
      }
      return await ctx.client.readContract({
        address: asset as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner as Address],
      });
    } catch {
      // Unreadable ≠ empty. Fail open and let the dry-run be the backstop.
      return null;
    }
  },

  /** §11.6 #1: on-chain decimals — never a symbol map. */
  async readDecimals(asset, chainId) {
    if (asset.toLowerCase() === NATIVE_ASSET_SENTINEL.toLowerCase()) return 18;
    const ctx = clientFor(chainId);
    if (!ctx) return null;
    try {
      return await ctx.client.readContract({
        address: asset as Address,
        abi: erc20Abi,
        functionName: "decimals",
      });
    } catch {
      return null;
    }
  },

  /**
   * §11.6 #3: confirmations before "settled". L2s with single-block finality
   * need one; L1 Ethereum's reorg window is deeper. Sourced from the chain
   * config so a newly-onboarded chain gets the conservative default rather than
   * an optimistic one.
   */
  finalityDepth(chainId) {
    return Number(chainId) === 1 ? 3 : 1;
  },

  /** §11.6 #4: no private-mempool route is wired yet — say so honestly. */
  supportsPrivateSubmit() {
    return false;
  },

  /** L2: `maxDeposit` headroom, where the standard exposes it. */
  async readDepositCapHeadroom(target, owner, chainId) {
    if (target.kind !== "erc4626" && target.kind !== "async-vault") return null;
    const ctx = clientFor(chainId);
    if (!ctx) return null;
    const max = await probes(
      ctx.client,
      target.vault,
      ERC4626_ABI,
      "maxDeposit",
      [owner as Address],
    );
    return typeof max === "bigint" ? max : null;
  },
};
