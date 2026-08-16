/**
 * Minimal symbol -> decimals fallback map, matching what the token registry
 * would resolve. Used wherever a raw on-chain amount needs to become a
 * human/USD figure but the caller only has an asset symbol (no on-chain
 * `decimals()` read done yet) — deposit-time snapshots and position
 * enrichment (`services/defi/positions/enrich.ts`).
 */
export function decimalsForSymbol(symbol: string): number {
  switch (symbol.toUpperCase()) {
    case "USDC":
    case "USDT":
    case "USDC.E":
      return 6;
    case "WBTC":
      return 8;
    default:
      return 18;
  }
}
