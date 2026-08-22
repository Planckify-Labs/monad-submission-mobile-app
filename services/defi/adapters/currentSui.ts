/**
 * Current Finance adapter — a `DefiProtocolAdapter` for pool-level Sui
 * deposits (docs/defi-pool-level-deposits-spec.md §7, Phase 3). Built
 * 2026-08-22. DEPOSIT-ONLY — see `current.resolver.ts` / `types.ts`'s
 * `current-market` entry for why withdraw isn't wired (a genuine live-Pyth
 * requirement, not a resolver gap or a repeat of Suilend's false alarm).
 *
 * Current is an isolated-market money market shaped like a CDP: depositing
 * requires an `ObligationOwnerCap` (the position/capability object), created
 * via `enter_market::enter_market_return<M>` if the wallet doesn't already
 * own one for this market. Both calls chain atomically in ONE PTB —
 * device-verified 2026-08-22 via `sui_devInspectTransactionBlock` against
 * live mainnet (create an obligation for MainMarket, deposit 1 SUI into it).
 * Neither call touches an oracle. **A debt-free obligation cannot be
 * liquidated** — this adapter never builds a `borrow` call (this codebase
 * never builds one for ANY protocol, §1 non-goals), so depositing here
 * carries the same risk profile as any other single-asset deposit, despite
 * the CDP shape.
 *
 *   enter_market::enter_market_return<M>(app, &mut Market<M>, ctx)
 *     -> ObligationOwnerCap             (only when no existing cap is found)
 *   deposit::deposit<M,T>(app, &mut Market<M>, &ObligationOwnerCap,
 *     Coin<T>, &Clock, ctx)             -> ()  (shares tracked inside Market)
 *
 * The moveCall package is PINNED, not fetched (`current.config.ts`) — Current
 * has no MVR entry, no address API, and no public source; read that file's
 * header before assuming it's still correct.
 *
 * `app` (ProtocolApp) + `market` (per isolated market) are stable shared
 * objects on the resolved target; `marketType` (the phantom type M) is
 * needed for both moveCalls' type arguments.
 *
 * MAINNET-ONLY (`chainId:"mainnet"`). Every failure maps to a curated
 * `DefiError`, never a raw RPC string (CLAUDE.md).
 */

import { toBase64 } from "@mysten/bcs";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import type { SuiChainConfig } from "@/constants/configs/chainConfig";
import { classifySuiMoveError, DefiError } from "../errors/defiErrors";
import type {
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  DepositTarget,
  UnsignedCall,
} from "../types";
import { CURRENT_PACKAGE } from "./current.config";
import { prepareInputCoin } from "./sui/coins";

const SLUG = "current-sui";
const NETWORK = "mainnet" as const;

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[currentSui] ${scope}:`, err);
  }
}

function suiClientFor(chain: SuiChainConfig): SuiJsonRpcClient {
  return new SuiJsonRpcClient({ url: chain.rpcUrl, network: chain.network });
}

function requireCurrentTarget(
  target: DepositTarget | undefined,
): Extract<DepositTarget, { kind: "current-market" }> {
  if (target?.kind !== "current-market") {
    throw new DefiError(
      "deposit_failed",
      "current: a resolved pool target is required (app + market + type)",
    );
  }
  return target;
}

/**
 * Find the wallet's existing `ObligationOwnerCap` for this exact market, if
 * any — reusing it (rather than minting a fresh one per deposit) keeps a
 * user's Current position as ONE obligation per market, not fragmented
 * across many. Bounded pagination (mirrors `getClosedLoopTokenBalance`):
 * protects against a pathological account, not an expected case.
 *
 * The struct type is derived from `marketType`'s OWN package prefix, not
 * `CURRENT_PACKAGE` — `ObligationOwnerCap` is a type, and a type's on-chain
 * address is fixed at its original publish site, not wherever the current
 * upgraded package happens to live (the exact distinction that made the
 * first version of this adapter's deposit call abort in testing).
 */
async function findExistingObligationCap(
  client: SuiJsonRpcClient,
  owner: string,
  market: string,
  marketType: string,
): Promise<string | null> {
  const capType = `${marketType.split("::")[0]}::obligation::ObligationOwnerCap`;
  let cursor: string | null | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await client.getOwnedObjects({
      owner,
      filter: { StructType: capType },
      options: { showContent: true },
      cursor: cursor ?? undefined,
    });
    for (const item of res?.data ?? []) {
      const content = item?.data?.content;
      if (
        content &&
        typeof content === "object" &&
        "dataType" in content &&
        content.dataType === "moveObject"
      ) {
        const fields = (content as { fields?: Record<string, unknown> }).fields;
        const marketId = fields?.market_id;
        if (
          typeof marketId === "string" &&
          marketId.toLowerCase() === market.toLowerCase() &&
          item.data?.objectId
        ) {
          return item.data.objectId;
        }
      }
    }
    if (!res?.hasNextPage) break;
    cursor = res.nextCursor;
  }
  return null;
}

export const CurrentSuiAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "sui",
  kind: "stablecoin_lending",
  chainId: NETWORK, // string id → free network gate via listDefiAdaptersForChain
  displayName: "Current",
  staticSafetyScore: 60,
  externalSlugs: ["current"],
  targetKinds: ["current-market"],

  async buildDeposit({
    wallet,
    chain,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "sui") {
      throw new DefiError(
        "unsupported_chain",
        "current: requires sui namespace",
      );
    }
    const { app, market, marketType, coinType } = requireCurrentTarget(target);
    try {
      const client = suiClientFor(chain);
      const tx = new Transaction();
      tx.setSender(wallet.address);

      const depositCoin = await prepareInputCoin(
        tx,
        client,
        wallet.address,
        coinType,
        amount,
      );

      const existingCap = await findExistingObligationCap(
        client,
        wallet.address,
        market,
        marketType,
      );
      const cap = existingCap
        ? tx.object(existingCap)
        : (() => {
            const [newCap] = tx.moveCall({
              target: `${CURRENT_PACKAGE}::enter_market::enter_market_return`,
              typeArguments: [marketType],
              arguments: [tx.object(app), tx.object(market)],
            });
            return newCap;
          })();

      tx.moveCall({
        target: `${CURRENT_PACKAGE}::deposit::deposit`,
        typeArguments: [marketType, coinType],
        arguments: [
          tx.object(app),
          tx.object(market),
          cap,
          depositCoin,
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      });
      // Only a freshly-minted cap needs transferring — an existing one is
      // already owned by the sender and was only borrowed by reference.
      if (!existingCap) {
        tx.transferObjects([cap], tx.pure.address(wallet.address));
      }

      const bytes = await tx.build({ client });
      return { kind: "sui-ptb", transactionBlockBase64: toBase64(bytes) };
    } catch (err) {
      if (err instanceof DefiError) throw err;
      devWarn("buildDeposit", err);
      throw classifySuiMoveError(err, "deposit_failed");
    }
  },

  async buildWithdraw(_args: BuildWithdrawArgs): Promise<UnsignedCall> {
    // Genuinely Pyth-gated (see file header + types.ts) — a live price must
    // be pushed in the same tx, a subsystem this codebase hasn't built for
    // any protocol yet. Fail closed with a curated message rather than a
    // confusing on-chain abort.
    throw new DefiError(
      "withdraw_failed",
      "In-app withdrawal isn't available for Current yet. Withdraw at current.finance.",
    );
  },

  async readPosition(): Promise<DefiPosition | null> {
    // Not implemented: reading a live position value needs the same oracle
    // price current.finance's own UI reads for LTV/health, which this
    // adapter doesn't fetch (deposit-only, no oracle dependency by design).
    // The position still shows its recorded deposit amount via the generic
    // fallback.
    return null;
  },
};
