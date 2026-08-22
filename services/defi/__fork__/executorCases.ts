/**
 * The Gate-4 case table — one row per execution shape proven end to end
 * through the real agent executors.
 *
 * Kept in its own module rather than inside `executor.fork.test.ts` so that
 * `forkCoverage.test.ts` can read it WITHOUT booting anvil. That matters: the
 * coverage gate has to run on every CI build, including builds with no fork
 * RPC and no foundry, or it is not a gate.
 *
 * ## Adding a protocol
 *
 * Append a row. If the family's execution shape (`DepositTarget.kind`) is new,
 * the coverage gate will already have failed the build for you.
 */

import type { Address } from "viem";
import { CometV3Adapter } from "../adapters/cometV3";
import { Erc4626Adapter } from "../adapters/erc4626";
import type { DefiProtocolAdapter, DepositTarget } from "../types";

export interface ExecutorForkCase {
  /** Shown in the test name. */
  name: string;
  chainId: number;
  /**
   * What the AGENT emits. For a bespoke single-market venue that is the
   * adapter's own slug; for a generic family it is the DeFiLlama project slug
   * that no adapter claims, and routing happens on `target.kind`. Use the one
   * production would actually carry — the difference is a real code path.
   */
  protocolSlug: string;
  assetSymbol: string;
  /** The underlying the wallet is funded with and deposits. */
  assetContract: Address;
  amount: bigint;
  /** What the backend would have resolved for `poolId`. */
  target: DepositTarget;
  /** Any DeFiLlama-shaped id; only its identity matters, never its content. */
  poolId: string;
  /** Adapters this case needs registered. */
  adapters: DefiProtocolAdapter[];
  /**
   * Dust permitted after a `"MAX"` withdraw, in the RECEIPT token's units.
   * An exchange-rate or accruing receipt can leave a correct wei-scale
   * remainder; a whole unit is not.
   */
  maxDust: bigint;
  /**
   * The spender the deposit's approve should have been scoped to. Usually the
   * target contract itself, but a router-mediated family approves the router,
   * so it is stated per case rather than guessed.
   */
  approvalSpender: Address;
}

export const EXECUTOR_FORK_CASES: ExecutorForkCase[] = [
  {
    /**
     * The exact flow that was being tested by hand with real USDT: Compound
     * III's USDT market on Arbitrum. Arbitrum had NO fork pin at all before
     * 2026-08-22, so the path most recently exercised in production was the
     * least covered one in the repo.
     *
     * `cUSDTv3` is `COMET_MARKETS[42161]` in the backend book. Its
     * `baseToken()` was read on chain as
     * `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` (USDT, 6 dp) rather than
     * taken from a symbol table — which is also what Layer 1's
     * `underlying-matches` will independently re-derive at deposit time.
     */
    name: "Compound III cUSDTv3 on Arbitrum (USDT)",
    chainId: 42161,
    protocolSlug: "compound-v3",
    assetSymbol: "USDT",
    assetContract: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    amount: 1_000_000_000n, // 1,000 USDT (6 dp)
    target: {
      kind: "compound-v3",
      comet: "0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07",
      asset: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    },
    poolId: "fork-arbitrum-cusdtv3",
    adapters: [CometV3Adapter],
    approvalSpender: "0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07",
    // Comet's base balance accrues per second, so a MAX computed one block
    // before it lands can leave a few base units behind.
    maxDust: 1_000n,
  },
  {
    /**
     * sDAI — the generic ERC-4626 family, which is the single most common
     * shape in the catalogue: one `Erc4626Adapter` serves every Morpho, Yearn,
     * Euler, Sky and Spark vault a resolver returns.
     *
     * **`protocolSlug` is deliberately the DeFiLlama project slug, not
     * `"erc4626"`.** That is what the agent actually emits, and it is the
     * difference between this case and Gate 3: `getDefiAdapterForTarget`
     * routes by `target.kind` and finds the adapter, while `getDefiAdapter`
     * (slug only) does not. Writing `"erc4626"` here would have made the case
     * pass through a path production never takes — and would have hidden the
     * `readPosition` gap this case exists to have caught.
     */
    name: "sDAI ERC-4626 vault on Ethereum (DAI)",
    chainId: 1,
    protocolSlug: "sky-lending",
    assetSymbol: "DAI",
    assetContract: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    amount: 1_000n * 10n ** 18n, // 1,000 DAI (18 dp)
    target: {
      kind: "erc4626",
      vault: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      asset: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    },
    poolId: "fork-ethereum-sdai",
    adapters: [Erc4626Adapter],
    approvalSpender: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
    // A 4626 redeem burns the exact share balance, so a correct MAX leaves
    // nothing. Shares are 18 dp; allow rounding only.
    maxDust: 10n,
  },
];

/**
 * EVM execution shapes that do NOT yet have a Gate-4 case, each with the
 * reason it is acceptable for now.
 *
 * This list is a RATCHET, not a permanent exemption. Its purpose is to let the
 * gate be green on the day it lands while still failing the moment a NEW
 * execution shape appears — the recurring failure this whole exercise is
 * about is a family shipping with nobody having run the path a user takes.
 *
 * Every kind here is already covered at Gate 3 (`tier*.fork.test.ts`), i.e.
 * its calldata is proven to move a position. What it lacks is proof that the
 * ~1,900-line executor around that calldata behaves — the guards, the approve
 * preamble, the submit path, the position registration.
 *
 * **Shrink this list.** A kind moves out of it by gaining a row in
 * `EXECUTOR_FORK_CASES`, never by being deleted from it.
 */
export const GATE4_BACKLOG: Readonly<Record<string, string>> = {
  "aave-v3": "Gate 3: tier1 round trip on Aave v3 and SparkLend.",
  "morpho-blue":
    "Gate 3: tier2 supply/withdraw against a real market, plus the altered-params refusal.",
  "compound-v2": "Gate 3: tier2 cToken round trip.",
  "curve-lp": "Gate 3: tier2, both the classic (3pool) and NG generations.",
  "solidly-lp": "Gate 3: tier3 Aerodrome two-sided add, both approvals scoped.",
  "uniswap-v2":
    "Gate 3: committed 2026-08-22 (6644684), fork-proven as a full round trip. Wiring it found a latent solidly-lp Layer-5 bug — readPositionDelta was reading the ROUTER's balance, not the pair's, so a successful LP deposit reported no position change. That is precisely a Gate-4 assertion, so this family and solidly-lp are the strongest argument for the next two rows here.",
  "balancer-lp":
    "Family withheld: `BalancerQueries` is not pinned, so `minimumBPT` cannot be priced (runbook §12.4).",
  "lst-stake":
    "Gate 3: tier3 (Rocket Pool, ether.fi) plus Lido/mETH/Kelp min-out shapes in the onboarding suite.",
  "router-call":
    "Family withheld: the router-quote proxy has no live integration test (runbook §12.4).",
  "async-vault":
    "In flight — 5a171b9 wired the claim path and registered the adapter (§7 requirements 1-3). Deliberately NOT restating the remaining gaps here: runbook §11.3's row is the live list and was already corrected twice on 2026-08-22, so a copy in this file would go stale a third time. A Gate-4 case needs the two-phase request→claim to be durable end to end, and is the right proof that it is.",
};
