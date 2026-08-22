import type { Address, Hex } from "viem";
import type {
  ChainConfig,
  SuiChainConfig,
} from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import type { Namespace } from "@/services/chains/types";

export type RiskTier = "conservative" | "balanced" | "aggressive";

/**
 * DepositTarget — the resolved, on-chain-validated deposit destination for a
 * specific DeFiLlama pool (docs/defi-pool-level-deposits-spec.md §4.1). The
 * backend resolves it at score time (from the pool's matching keys) and the
 * mobile executor re-fetches it by `pool_id` before signing — the LLM never
 * handles an address (§6, §8). One resolved target routes to exactly one
 * adapter by its `kind` (§7); a `null` target has no adapter and is the manual
 * deep-link path. Adding a protocol = a new resolver + (if a new kind) a
 * family adapter — never a branch.
 *
 * This is the MOBILE twin of the backend `DepositTarget` in
 * `api/src/strategies/targets/types.ts` — keep the two in sync.
 */
export interface MorphoMarketParams {
  /** The asset a lender supplies (== the pool's underlying). */
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  /** uint256, 1e18-scaled, as a decimal string (JSON-safe). */
  lltv: string;
}

/**
 * Sentinel for "the chain's native coin" in an EVM `asset` field (spec §12 Q5).
 * Native deposits set `value: amount` on the built call and omit
 * `needsApproval` — there is no ERC-20 `approve` for ETH, and emitting one
 * would be a no-op that masks a mis-build.
 */
export const NATIVE_ASSET_SENTINEL =
  "0x0000000000000000000000000000000000000000" as Address;

export type DepositTarget =
  | { kind: "erc4626"; vault: Address; asset: Address }
  | { kind: "aave-v3"; pool: Address; asset: Address }
  // Morpho Blue isolated market on the singleton `Morpho` contract. `marketId`
  // is identity/validation only; `params` is what `supply`/`withdraw` actually
  // take, and `asset` (== params.loanToken) is the deposited token (§3.1).
  | {
      kind: "morpho-blue";
      marketId: Hex;
      params: MorphoMarketParams;
      asset: Address;
    }
  | { kind: "compound-v3"; comet: Address; asset: Address }
  // Compound-v2 cToken forks (Venus vToken, Benqi qiToken, Sonne…). `mint`/
  // `redeem`/`redeemUnderlying` with exchange-rate shares (§5.4). Prefer a
  // protocol's ERC-4626 wrapper (Family A) when one exists — §12 Q3.
  | { kind: "compound-v2"; cToken: Address; asset: Address }
  // Curve LP. `index` is the coin's slot in the pool's `coins[]`; `nCoins` +
  // `isNg` are carried so the adapter picks the right `add_liquidity` arity
  // and index type without an on-chain probe per build (§3.3).
  | {
      kind: "curve-lp";
      pool: Address;
      asset: Address;
      index: number;
      nCoins: 2 | 3 | 4;
      isNg: boolean;
      /**
       * The LP receipt token, when it is NOT the pool contract. Twin of the
       * backend union member — see that file for the full rationale. Classic
       * pools (3pool and its lineage) mint a separate ERC-20; the pool
       * contract itself has no `balanceOf` at all, so `curveLp.ts:lpTokenOf`
       * reads THIS when present.
       */
      lpToken?: Address;
    }
  // Solidly-fork LP (Aerodrome on Base, Velodrome on OP). Deposits go through
  // the Router's `addLiquidity`; `stable` picks the invariant (§6.1).
  | {
      kind: "solidly-lp";
      router: Address;
      pool: Address;
      token0: Address;
      token1: Address;
      stable: boolean;
    }
  // Balancer v3 / Beets. `poolId` is the Vault registration id; `asset` is the
  // single token joined with (§6.2).
  // Uniswap v2 pairs. No `stable` field — every v2 pool is
  // constant-product, unlike its Solidly descendants. Twin of the backend
  // union member; see that file for the full rationale.
  | {
      kind: "uniswap-v2";
      router: Address;
      pool: Address;
      token0: Address;
      token1: Address;
    }
  | { kind: "balancer-lp"; vault: Address; poolId: Hex; asset: Address }
  // Liquid staking / restaking (§6.4). `venue` selects the pinned entry
  // contract + stake shape from the address-book; `receipt` is the
  // rate-appreciating token; `exit` records how a withdraw is serviced so the
  // UI never promises an instant exit it can't honour (§12 Q2).
  // `asset` is `NATIVE_ASSET_SENTINEL` for native-ETH stakes.
  | {
      kind: "lst-stake";
      venue: string;
      receipt: Address;
      asset: Address;
      exit: "queue" | "dex" | "instant";
    }
  // Router-calldata families (Pendle, Uniswap LP) — no stable on-chain deposit
  // ABI we encode; the protocol's hosted API returns the calldata at execute
  // time. The target models IDENTITY only (§3.4, §6).
  | {
      kind: "router-call";
      protocol: "pendle" | "uniswap-v3" | "uniswap-v4";
      market: Address;
      chainId: number;
      tokenIn: Address;
    }
  // ERC-7540 asynchronous vault (request → fulfil → claim). Tier 4: the kind
  // exists so the union is complete and the validator can reject a
  // non-conforming vault, but NO resolver emits it until the two-phase
  // adapter interface ships (§7) — async pools stay Manual until then.
  | {
      kind: "async-vault";
      vault: Address;
      asset: Address;
      flavor: "7540-deposit" | "7540-redeem" | "7540-both";
    }
  | { kind: "scallop-market"; market: string; coinType: string }
  // Ember Vaults (Sui, Bluefin-incubated) — the closest thing to an ERC-4626
  // vault on Sui: `ember_vaults::gateway::deposit_asset_v2<T,R>` where T is the
  // deposited coin (`coinType`) and R is the share/receipt coin (`shareType`).
  // `vault` is the immutable shared `Vault<T,R>` object id; the mutable package
  // + shared `ProtocolConfig` are fetched by the adapter's config (not pinned in
  // the target). One `EmberSuiAdapter` covers every Ember vault the resolver
  // returns — the Sui-family analog of the generic `Erc4626Adapter`.
  | { kind: "ember-vault"; vault: string; coinType: string; shareType: string }
  // NAVI (Sui lending). Unlike Ember/Scallop there is NO receipt coin: the
  // supply is tracked in NAVI's shared `Storage` against the user, keyed by a
  // numeric `assetId` (+ the per-coin `Pool<T>` object). Withdraw is by amount,
  // not by redeeming a share coin — so its position/withdraw model differs.
  | { kind: "navi-pool"; pool: string; assetId: number; coinType: string }
  // Suilend (Sui lending) — `lending_market::deposit_liquidity_and_mint_ctokens
  // <P,T>` → `Coin<reserve::CToken<P,T>>`. `lendingMarket` = shared
  // LendingMarket<P>; `marketType` = the P phantom (`<pkg>::suilend::MAIN_POOL`)
  // — the adapter derives the moveCall package from it; `reserveArrayIndex` = the
  // reserve's slot in LendingMarket.reserves[] (u64 arg); `coinType` (T) ==
  // underlyingTokens[0]. Deposit + zap are in-app; withdraw is on-site for now
  // (Suilend's redeem needs a Pyth pull-oracle push — deferred).
  | {
      kind: "suilend-market";
      lendingMarket: string;
      marketType: string;
      reserveArrayIndex: number;
      coinType: string;
    }
  // Sui liquid staking (Haedal / Volo / SpringSui / Aftermath). The user
  // supplies `Coin<SUI>` and receives a liquid-staking receipt coin; the deposit
  // is ORACLE-FREE (no Pyth), unlike Suilend. `venue` selects the stake shape +
  // pinned shared objects in `adapters/sui/lst.config.ts`; `lstType` is the
  // receipt coin (for validation/display). One `SuiLstAdapter` serves all
  // venues, routed by `kind === "sui-lst"`.
  | { kind: "sui-lst"; venue: string; lstType: string }
  | { kind: "solana-reserve"; program: string; reserve: string; mint: string };

export type DepositTargetKind = DepositTarget["kind"];

/**
 * The asset a resolved target actually takes in, per kind — the one answer to
 * "what is being deposited?" that no model ever touched, since the target
 * itself is resolved server-side and re-fetched by pool id before signing (§6).
 *
 * This is what the safety pipeline anchors `underlyingExpected` on. The tool's
 * `asset_contract` must NOT be used for that: it is an optional model-supplied
 * hint, absent on almost every call, and adapters already cross-check it
 * against the resolved target instead of trusting it.
 *
 * `null` ⇒ the kind does not name its input asset (a Sui LST stakes native
 * SUI), so the caller falls back rather than asserting against a placeholder.
 */
export function targetUnderlying(target: DepositTarget): string | null {
  if ("asset" in target) return target.asset;
  switch (target.kind) {
    // Both legs are deposited; token0 is the leg the identity read reports.
    case "solidly-lp":
    case "uniswap-v2":
      return target.token0;
    case "router-call":
      return target.tokenIn;
    case "scallop-market":
    case "ember-vault":
    case "navi-pool":
    case "suilend-market":
      return target.coinType;
    case "solana-reserve":
      return target.mint;
    default:
      return null;
  }
}

/**
 * The EVM subset of `DepositTargetKind`. Every entry MUST have an explicit
 * on-chain validator — `validateTarget`'s `default: return true` passthrough
 * is removed for these (spec §8.1), so a new EVM kind that forgets its
 * validator is rejected rather than silently trusted. Non-EVM kinds keep
 * resolver-internal validation.
 */
export const EVM_TARGET_KINDS = [
  "erc4626",
  "aave-v3",
  "morpho-blue",
  "compound-v3",
  "compound-v2",
  "curve-lp",
  "solidly-lp",
  "uniswap-v2",
  "balancer-lp",
  "lst-stake",
  "router-call",
  "async-vault",
] as const satisfies readonly DepositTargetKind[];

export type EvmTargetKind = (typeof EVM_TARGET_KINDS)[number];

export function isEvmTargetKind(
  kind: DepositTargetKind,
): kind is EvmTargetKind {
  return (EVM_TARGET_KINDS as readonly string[]).includes(kind);
}

export type StrategyKind =
  | "stablecoin_lending"
  | "liquid_staking"
  | "rwa_yield"
  | "yield_vault"
  | "lp_stable"
  | "lp_volatile"
  | "restaking"
  | "delta_neutral";

export interface DefiOpportunity {
  protocolSlug: string;
  namespace: Namespace;
  chainId: number | string; // EVM number or Solana cluster string
  assetSymbol: string;
  assetContract?: string; // null for native
  apy: number;
  apy7dAvg: number;
  tvlUsd: number;
  score: number; // 0–100
  tier: RiskTier;
  kind: StrategyKind;
  liquidityProfile: "instant" | "queued_short" | "queued_long";
  source: "defillama" | "manual";
}

export interface DefiPosition {
  protocolSlug: string;
  namespace: Namespace;
  chainId: number | string;
  assetSymbol: string;
  amountAtDeposit: bigint;
  amountAtDepositUsd: number;
  currentAmount: bigint;
  currentAmountUsd: number;
  pnlUsd: number;
  openTxHash?: string;
}

/**
 * Optional per-read context for `readPosition` (pool-level deposits §7). EVM
 * adapters resolve their deployment from their own address-book and ignore this;
 * Sui adapters have NO fixed per-asset deployment — they need the resolved pool
 * target to know WHICH reserve/vault to read, and `readPosition(walletAddress)`
 * alone can't carry that. The dispatcher (services/defi/positions/reader.ts)
 * re-resolves the target from the position row's `pool_id` and passes it here.
 * Additive/optional, so existing adapters are unaffected (space-docking).
 */
export interface PositionReadContext {
  /** Server-resolved deposit target for this position's exact pool. */
  target?: DepositTarget;
  /** Underlying asset contract / Sui coinType carried on the position row. */
  assetContract?: string;
  assetSymbol?: string;
  assetDecimals?: number;
  /**
   * The chain the position lives on, built from the backend `Blockchain` row.
   *
   * The EVM family adapters (`compound-v3`, `compound-v2`, `morpho-blue`,
   * `curve-lp`, …) are routed by `DepositTarget.kind`, not by chainId, so they
   * have NO fixed deployment to derive an RPC client from — they need the chain
   * passed in. Sourced from the API's blockchain list rather than a bundled
   * per-chain constant, so a newly-onboarded chain works without a code change.
   * Optional (space-docking): adapters that ignore it are unaffected.
   */
  chain?: ChainConfig;
}

export interface BuildDepositArgs {
  wallet: TWallet;
  chain: ChainConfig;
  asset: { symbol: string; contract?: string; decimals: number };
  amount: bigint; // raw units
  /**
   * Server-resolved, on-chain-validated deposit destination for the exact
   * pool the user picked (spec §4.1, §6). Optional → backward compatible:
   * adapters that ignore it keep their canonical market. Standard-family
   * adapters (`Erc4626Adapter`, generalised Aave/Scallop) read the concrete
   * address/market from here instead of a hardcoded per-deployment constant.
   */
  target?: DepositTarget;
  /**
   * The DeFiLlama pool id this deposit is for.
   *
   * Only the router-calldata family needs it: its calldata does not exist until
   * execute time and is fetched through OUR backend proxy, which re-resolves
   * the target by `poolId` server-side rather than trusting anything the device
   * sends (§6, §8). Optional and presence-checked — every other adapter builds
   * entirely from `target`.
   */
  poolId?: string;
  /**
   * The user's risk tier, for the slippage policy (§12 Q4): conservative users
   * get a tighter budget. Optional; the policy defaults to `balanced` when the
   * caller has not resolved a strategy.
   */
  tier?: RiskTier;
}

export interface BuildWithdrawArgs extends Omit<BuildDepositArgs, "amount"> {
  /** raw units; pass `"MAX"` to exit fully. */
  amount: bigint | "MAX";
}

/**
 * The DEX leg appended into a zap's shared `Transaction` (the swap side of
 * an atomic swap→supply). Injected by the compiler so the DEX SDK stays in
 * the swap layer and the lending adapter owns only its deposit leg.
 */
export interface ZapSwapLeg {
  outputCoin: import("@mysten/sui/transactions").TransactionObjectArgument;
  leftoverCoins: import("@mysten/sui/transactions").TransactionObjectArgument[];
  expectedOut: bigint;
  priceImpact: number;
  toCoinType: string;
  poolObjectId?: string;
}

export interface ZapSupplyArgs {
  wallet: TWallet;
  chain: SuiChainConfig;
  /** Symbol of the asset to swap INTO and then supply (e.g. "USDC"). */
  supplyAssetSymbol: string;
  /**
   * Server-resolved pool target for the exact pool the user picked (§7). Lets
   * the zap deposit into a SPECIFIC pool (e.g. one Ember vault) instead of the
   * venue's canonical market — required by multi-vault venues (Ember), optional
   * for single-market ones (Scallop). Same opaque target the plain-supply path
   * threads; the venue reads its concrete ids from here, never from the LLM.
   */
  target?: DepositTarget;
  /**
   * Appends the swap leg to the shared `Transaction` and returns its output
   * coin + leftovers. Injected so the DEX SDK stays in the swap layer — the
   * adapter owns only the supply (lending) leg (space-docking).
   */
  appendSwap: (
    tx: import("@mysten/sui/transactions").Transaction,
  ) => Promise<ZapSwapLeg | null>;
}

export interface ZapSupplyResult {
  ptbBase64: string;
  expectedOut: bigint;
  priceImpact: number;
  toCoinType: string;
  poolObjectId?: string;
}

/**
 * One adapter per (protocol, chain) deployment. AaveV3 on Ethereum is
 * one, AaveV3 on Base is another. Solana / Sui protocols implement
 * the same interface; chain-specific submission lives in the
 * `UnsignedCall` discriminant and the WalletKitAdapter method the
 * caller picks. Shared code never branches on protocolSlug.
 */
export interface DefiProtocolAdapter {
  readonly slug: string; // e.g. "aave-v3-base"
  readonly namespace: Namespace; // discriminator for UnsignedCall
  readonly kind: StrategyKind;
  readonly chainId: number | string;
  readonly displayName: string;

  /** Pure builds — no signer required. Caller submits via WalletKit. */
  buildDeposit(args: BuildDepositArgs): Promise<UnsignedCall>;
  buildWithdraw(args: BuildWithdrawArgs): Promise<UnsignedCall>;

  /**
   * Pure read — no signer required. `ctx` (optional) carries the resolved pool
   * target for adapters without a fixed per-asset deployment (Sui); EVM adapters
   * ignore it and resolve from their own address-book.
   */
  readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null>;

  // ── Optional capabilities (presence-checked, never namespace-checked) ──
  /** Rewards claim where the protocol has a separate accrual primitive. */
  buildClaim?(args: BuildDepositArgs): Promise<UnsignedCall>;
  /** wstETH wrap / unwrap, jitoSOL stake-account merge, etc. */
  buildWrap?(args: BuildDepositArgs): Promise<UnsignedCall>;
  /** Adapter-level safety override; falls back to server-computed score. */
  staticSafetyScore?: number; // 0–100
  /** Per-deployment minimum deposit in raw asset units. */
  minDepositRaw?: bigint;

  /**
   * External catalog slugs this adapter fulfills — e.g. the DeFiLlama
   * `pool.project` ("scallop-lend") that `defi_list_opportunities`
   * surfaces. Lets a discovered opportunity slug (or a venue named by the
   * agent) resolve to this adapter without a central per-protocol map —
   * the next protocol docks by declaring its own aliases here, never by a
   * branch in shared code. Matched case-insensitively alongside `slug`.
   */
  readonly externalSlugs?: readonly string[];
  /**
   * `DepositTarget.kind`s this adapter fulfills (pool-level deposits §7).
   * When a resolved `depositTarget` is present, shared code routes to the
   * adapter whose `targetKinds` includes `target.kind` — the standard-family
   * dispatch that lets ONE `Erc4626Adapter` cover every Morpho/Yearn vault.
   * A new `kind` docks by declaring it here, never by a branch. Bespoke
   * per-deployment adapters that only resolve by slug omit this.
   */
  readonly targetKinds?: readonly DepositTargetKind[];
  /**
   * `true` when `buildDeposit` CANNOT build without a resolved
   * `depositTarget` — i.e. the adapter throws rather than falling back to a
   * canonical market.
   *
   * This exists because `externalSlugs` is consulted as a fallback when no
   * target was resolved (`getDefiAdapter(slug)`), and for a kind-routed family
   * adapter that fallback is a lie: `CurveLpAdapter`, `SolidlyLpAdapter`,
   * `CompoundV2Adapter`, `CometV3Adapter`, `BalancerLpAdapter`,
   * `RouterCallAdapter` and `LstStakeAdapter` all open with
   * `if (!target) throw`. A pool of theirs with no target was being reported
   * agent-executable and would have failed at build time — measured on device
   * 2026-08-21: 5 Aerodrome, 2 Curve, 2 Benqi and 1 ether.fi pool badged
   * "Deposit in-app" with nothing able to execute them.
   *
   * The Sui single-market adapters (Scallop, NAVI, Ember) are the opposite
   * case and stay unflagged on purpose: they read `target?.kind` and keep
   * their canonical market when it is absent, which is the backward-compatible
   * behaviour the pool-level spec §6 describes.
   *
   * The adapter is the authority on this, so it declares it rather than
   * shared code inferring it from `targetKinds` — both families declare those.
   */
  readonly requiresTarget?: boolean;
  /**
   * Atomic swap→supply zap composer (Sui Intent Engine §4.7): one PTB that
   * swaps into the supply asset and supplies it, all-or-nothing. Optional —
   * only venues that support single-PTB zap-in expose it; the compiler
   * presence-checks it rather than branching on the venue name.
   */
  buildZapSupply?(args: ZapSupplyArgs): Promise<ZapSupplyResult>;
  /**
   * Best-effort supply-preview enrichment (APY / resolved input coinType)
   * for the intent preview card. Optional and must never throw.
   */
  readSupplyMeta?(
    assetSymbol: string,
    ownerAddress: string,
  ): Promise<{ apy?: string; inputCoinType?: string }>;
  /**
   * True when this target's preview dry-run can't be trusted — a KNOWN simulator
   * false-positive (a version-gated Sui pool whose `assert_version` aborts in
   * dry-run but succeeds in real execution, verified). The intent executor uses
   * this to SCOPE its dry-run-revert exemption to that exact case (an
   * `assert_version` abort on such a target is downgraded from block to
   * non-block; any other abort still blocks). MUST verify the precondition the
   * on-chain gate checks (e.g. read the pool's `version` and confirm it matches
   * the pinned package) so it returns true ONLY when real execution would pass —
   * i.e. this replaces the broken simulation with a reliable on-chain read, it
   * does not blindly ignore the revert. Fail-safe: return false when it can't
   * verify. Optional (presence-checked); absent ⇒ the dry-run is authoritative.
   */
  isDryRunUnreliable?(target?: DepositTarget): Promise<boolean>;

  // ── Tier 4: asynchronous (ERC-7540) vaults ────────────────────────────────
  // docs/defi-evm-protocol-expansion-spec.md §7.
  //
  // An async vault cannot settle in one transaction: deposit and redeem are
  // `request → (off-chain fulfil) → claim`. That breaks `buildDeposit`'s
  // one-shot contract outright, so rather than overload `amount` with a
  // two-phase meaning, the phases dock in as OPTIONAL methods
  // (presence-checked, never namespace- or kind-checked — the same
  // space-docking rule as every other capability here).
  //
  // An adapter that implements these is async; one that doesn't is
  // synchronous, and shared code asks by presence instead of knowing which is
  // which. Until an `async-vault` resolver ships (§7 forbids registering one
  // before this interface is proven end to end), nothing calls them.

  /** Phase 1 of a deposit: `requestDeposit(assets, controller, owner)`. */
  buildRequestDeposit?(args: BuildDepositArgs): Promise<UnsignedCall>;
  /** Phase 2: `deposit`/`mint` once `claimableDepositRequest` is non-zero. */
  buildClaimDeposit?(args: BuildDepositArgs): Promise<UnsignedCall>;
  /** Phase 1 of an exit: `requestRedeem(shares, controller, owner)`. */
  buildRequestRedeem?(args: BuildWithdrawArgs): Promise<UnsignedCall>;
  /** Phase 2: `withdraw`/`redeem` once `claimableRedeemRequest` is non-zero. */
  buildClaimRedeem?(args: BuildWithdrawArgs): Promise<UnsignedCall>;
  /**
   * Readiness of an outstanding request, for the pending-claims tracker and
   * the "pending settlement" position state. Returns `null` when the adapter
   * cannot read it — treated as "still pending", never as "ready".
   */
  readAsyncRequest?(
    walletAddress: string,
    ctx: PositionReadContext,
  ): Promise<AsyncRequestState | null>;
}

/**
 * Where an ERC-7540 request stands. `pending` and `claimable` are in the
 * vault's own units (assets for a deposit request, shares for a redeem), and
 * both can be non-zero at once while a request is partially fulfilled.
 */
export interface AsyncRequestState {
  phase: "deposit" | "redeem";
  requestId: string;
  pending: bigint;
  claimable: bigint;
}

/**
 * `UnsignedCall` carries everything submission needs *except* a
 * signer. The discriminant maps 1:1 to the `WalletKitAdapter` write
 * method the caller will pick:
 *
 *   "evm-call"   → walletKit.sendContractTransaction()
 *                  (or sendUserOpWithUsdcPaymaster() on Base/Arb)
 *   "solana-ix"  → walletKit.sendAnchorInstruction()
 *   "sui-ptb"    → walletKit.<sui send method>      (when a Sui DeFi adapter ships)
 *
 * The `needsApproval` field on the EVM variant tells the caller it
 * must inject an ERC-20 approve preamble before the target call.
 * Same shape the gasless paymaster path already consumes
 * (`services/walletKit/types.ts:189-218`), so we can route either
 * branch through it.
 */

/**
 * One ERC-20 approve preamble. Always scoped to the EXACT amount and the exact
 * spender — never infinite (§8.4, §11 Layer-4 "approval scoping").
 */
export interface ApprovalRequirement {
  token: `0x${string}`;
  spender: `0x${string}`;
  amount: bigint;
}

export type UnsignedCall =
  | {
      kind: "evm-call";
      to: `0x${string}`;
      data: `0x${string}`;
      value?: bigint;
      /**
       * One approve, or several. Two-sided LP adds (Solidly `addLiquidity`)
       * pull BOTH tokens in a single call, so one approval is not enough to
       * describe what the transaction needs. Kept as a union rather than
       * changing the field to an array so every existing adapter and consumer
       * is untouched — normalise with `approvalsOf()` instead of reading it
       * directly.
       */
      needsApproval?: ApprovalRequirement | readonly ApprovalRequirement[];
    }
  | {
      kind: "solana-ix";
      instructions: import("@solana/web3.js").TransactionInstruction[];
      additionalSigners?: import("@solana/web3.js").Signer[];
    }
  | {
      kind: "sui-ptb";
      transactionBlockBase64: string;
    };

/**
 * Every approve a built call needs, as a list. The single-approval shape is by
 * far the common case, so `needsApproval` stays a bare object there; callers
 * that must actually submit the preambles go through here so a two-sided LP add
 * cannot silently drop its second approve.
 */
export function approvalsOf(
  call: UnsignedCall,
): readonly ApprovalRequirement[] {
  if (call.kind !== "evm-call" || !call.needsApproval) return [];
  return Array.isArray(call.needsApproval)
    ? call.needsApproval
    : [call.needsApproval as ApprovalRequirement];
}
