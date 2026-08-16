/**
 * Live position enrichment — on-chain balance read + USD spot price +
 * PnL math, in one place so the chat executor (`defi_list_positions`) and
 * the native Strategies tab (`useStrategyPositions`) show the same numbers
 * instead of diverging (the chat path used to do a live on-chain read while
 * the Strategies tab showed only the frozen DB snapshot).
 *
 * `computePnl` (`services/defi/positions/pnl.ts`) existed but was never
 * called from anywhere — this is what wires it up. Best-effort throughout:
 * any failure (unsupported chain, no price, adapter returns null) degrades
 * to `null` fields so the caller falls back to the DB snapshot, never
 * throws.
 */

import { strategiesApi } from "@/api/endpoints/strategies";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { decimalsForSymbol } from "@/services/defi/assetDecimals";
import { computePnl } from "@/services/defi/positions/pnl";
import { readPosition } from "@/services/defi/positions/reader";

export interface PositionForEnrichment {
  protocolSlug: string;
  chainId: number;
  poolId: string | null;
  assetSymbol: string;
  assetContract: string | null;
  amountAtDeposit: string;
  amountAtDepositUsd: number;
  status: string;
}

export interface EnrichedPositionAmounts {
  currentAmountRaw: string | null;
  currentAmountUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
}

const NO_ENRICHMENT: EnrichedPositionAmounts = {
  currentAmountRaw: null,
  currentAmountUsd: null,
  pnlUsd: null,
  pnlPct: null,
};

export async function enrichPositionLive(
  position: PositionForEnrichment,
  walletAddress: string,
  chain: ChainConfig | undefined,
): Promise<EnrichedPositionAmounts> {
  // Closed positions never need a live read — the close tx is the terminal
  // state, and reading would just return 0 (or dust), which is more
  // misleading than the historical exit value already on the row.
  if (position.status === "closed") return NO_ENRICHMENT;

  try {
    const live = await readPosition({
      protocolSlug: position.protocolSlug,
      chainId: position.chainId,
      walletAddress,
      assetSymbol: position.assetSymbol,
      assetContract: position.assetContract ?? undefined,
      poolId: position.poolId ?? undefined,
      chain,
    });
    if (!live) return NO_ENRICHMENT;

    const currentAmountRaw = live.currentAmount.toString();

    const [price] = await strategiesApi
      .getAssetPrices([
        {
          chainId: position.chainId,
          assetSymbol: position.assetSymbol,
          assetContract: position.assetContract ?? undefined,
        },
      ])
      .catch(() => []);
    const spotUsdPerUnit = price?.usd;
    if (spotUsdPerUnit === undefined || spotUsdPerUnit === null) {
      // Live balance is still useful without a price — report the raw
      // amount, leave the $ figures null rather than showing a wrong $0.
      return { ...NO_ENRICHMENT, currentAmountRaw };
    }

    const pnl = computePnl({
      amountAtDepositRaw: BigInt(position.amountAtDeposit || "0"),
      amountAtDepositUsd: position.amountAtDepositUsd,
      currentAmountRaw: live.currentAmount,
      spotUsdPerUnit,
      decimals: decimalsForSymbol(position.assetSymbol),
    });

    return {
      currentAmountRaw,
      currentAmountUsd: pnl.currentAmountUsd,
      pnlUsd: pnl.pnlUsd,
      pnlPct: pnl.pnlPct,
    };
  } catch {
    return NO_ENRICHMENT;
  }
}
