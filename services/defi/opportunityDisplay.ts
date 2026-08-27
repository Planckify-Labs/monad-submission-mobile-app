/**
 * Opportunity grouping for the DeFi card (pool-level deposits spec §2.2 Diagram
 * D, §9). The scoring pipeline emits ONE OpportunityCache row per DeFiLlama
 * pool, so a multi-vault protocol (Morpho, Yearn, Ember…) shows up as several
 * "duplicate" rows for the same `(protocol, asset, chain)`. This collapses
 * those siblings into one grouped row and marks each sibling in-app vs manual —
 * removing the confusing mismatch where 5 indistinguishable pools all routed to
 * one canonical market.
 *
 * Pure + framework-free so it's unit-testable; the card renders the output.
 * The "checkable unit" stays a concrete executable pool (`inApp === true`) —
 * grouping only changes what a row *represents*, not that you check pools and
 * batch-deposit across them (§9.2).
 */

export interface RawOpportunity {
  id?: string;
  protocol_slug: string;
  chain_id?: number;
  chain_name?: string;
  namespace?: string;
  asset_symbol?: string;
  pool_id?: string;
  /** DeFiLlama vault/market name — the sibling disambiguator (§4.2). */
  pool_meta?: string | null;
  /** Protocol's own site for the manual deep-link (spec §9.1 layer 2). */
  app_url?: string | null;
  /** Executability: true ⇒ `depositTarget` resolved ⇒ AI-agent-executable
   *  in-app; false/undefined ⇒ "Manual" deep-link (§2.1). */
  in_app?: boolean;
  apy?: number | string;
  apy_7d_avg?: number | string;
  tvl_usd?: number | string;
  score?: number;
  tier?: string;
  il_exposure?: boolean;
}

export interface DisplayPool extends RawOpportunity {
  /** Stable per-pool identity for selection state; survives paging (§9.2). */
  rowKey: string;
  inApp: boolean;
  apyNum: number;
  scoreNum: number;
}

export interface OpportunityGroup {
  key: string;
  protocolSlug: string;
  assetSymbol?: string;
  chainName?: string;
  chainId?: number;
  namespace?: string;
  tier?: string;
  bestApy: number;
  bestScore: number;
  poolCount: number;
  inAppCount: number;
  /** Sorted: in-app first, then APY desc. */
  pools: DisplayPool[];
}

/**
 * Testnet chains, by numeric id. Shared with the Quick Invest card, which
 * re-fetches opportunities itself on a risk-dial change (quick-invest spec
 * §3.1) and has to apply the same filter the browse list does.
 */
const TESTNET_CHAIN_IDS = new Set<number>([
  11155111, // Ethereum Sepolia
  84532, // Base Sepolia
  421614, // Arbitrum Sepolia
  11155420, // Optimism Sepolia
  80002, // Polygon Amoy
  97, // BNB testnet
  43113, // Avalanche Fuji
  59141, // Linea Sepolia
  534351, // Scroll Sepolia
]);

export function isTestnetRow(row: {
  chain_id?: number;
  chain_name?: string;
}): boolean {
  if (
    row.chain_id !== undefined &&
    TESTNET_CHAIN_IDS.has(Number(row.chain_id))
  ) {
    return true;
  }
  const name = (row.chain_name ?? "").toLowerCase();
  return /sepolia|testnet|goerli|holesky|devnet|fuji|mumbai|amoy/.test(name);
}

function toNum(value: number | string | undefined | null): number {
  if (value === undefined || value === null) return Number.NEGATIVE_INFINITY;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

/** Stable per-pool key — poolId is `@@unique` on the backend; never the index. */
export function poolRowKey(row: RawOpportunity): string {
  return (
    row.pool_id ??
    row.id ??
    `${row.protocol_slug}|${row.asset_symbol ?? ""}|${row.pool_meta ?? ""}`
  );
}

function groupKey(row: RawOpportunity): string {
  const chain =
    row.chain_name ??
    (row.chain_id !== undefined ? `#${row.chain_id}` : (row.namespace ?? ""));
  return `${row.protocol_slug.toLowerCase()}|${(
    row.asset_symbol ?? ""
  ).toUpperCase()}|${chain.toLowerCase()}`;
}

/**
 * Group rows by `(protocol, asset, chain)` and sort:
 *   - pools within a group: in-app first, then APY desc (the executable,
 *     best-yield pool leads);
 *   - groups: safest first (best score desc), then best APY desc — mirroring
 *     the card's existing ranking so the grouping is a drop-in.
 */
export function groupOpportunities(rows: RawOpportunity[]): OpportunityGroup[] {
  const groups = new Map<string, OpportunityGroup>();

  for (const row of rows) {
    const key = groupKey(row);
    const pool: DisplayPool = {
      ...row,
      rowKey: poolRowKey(row),
      inApp: row.in_app === true,
      apyNum: toNum(row.apy),
      scoreNum: toNum(row.score),
    };
    const existing = groups.get(key);
    if (existing) {
      existing.pools.push(pool);
    } else {
      groups.set(key, {
        key,
        protocolSlug: row.protocol_slug,
        assetSymbol: row.asset_symbol,
        chainName: row.chain_name,
        chainId: row.chain_id,
        namespace: row.namespace,
        tier: row.tier,
        bestApy: Number.NEGATIVE_INFINITY,
        bestScore: Number.NEGATIVE_INFINITY,
        poolCount: 0,
        inAppCount: 0,
        pools: [pool],
      });
    }
  }

  const result: OpportunityGroup[] = [];
  for (const group of groups.values()) {
    group.pools.sort((a, b) => {
      if (a.inApp !== b.inApp) return a.inApp ? -1 : 1;
      return b.apyNum - a.apyNum;
    });
    group.poolCount = group.pools.length;
    group.inAppCount = group.pools.filter((p) => p.inApp).length;
    group.bestApy = Math.max(...group.pools.map((p) => p.apyNum));
    group.bestScore = Math.max(...group.pools.map((p) => p.scoreNum));
    // Prefer the tier of the leading (executable, best) pool for the header.
    group.tier = group.pools[0]?.tier ?? group.tier;
    result.push(group);
  }

  result.sort((a, b) => {
    if (b.bestScore !== a.bestScore) return b.bestScore - a.bestScore;
    return b.bestApy - a.bestApy;
  });
  return result;
}

/**
 * Protocol slug -> the venue name a person recognises. DeFiLlama slugs are
 * machine keys (`aave-v3`, `morpho-blue`, `yearn-finance`) and several of them
 * carry a chain suffix that means nothing to a user.
 *
 * Lives here rather than in the card because the approval surfaces need the
 * same name: a user who picked "Aave V3" from the list must be asked to
 * approve "Aave V3", not "aave-v3".
 */
const PROTOCOL_DISPLAY_NAMES: Record<string, string> = {
  "aave-v3": "Aave V3",
  "aave-v2": "Aave V2",
  aave: "Aave",
  "fluid-lending": "Fluid",
  fluid: "Fluid",
  "centrifuge-protocol": "Centrifuge",
  centrifuge: "Centrifuge",
  maple: "Maple",
  "morpho-vault": "Morpho",
  "morpho-blue": "Morpho",
  morpho: "Morpho",
  "compound-v3": "Compound V3",
  "compound-v2": "Compound V2",
  spark: "Spark",
  "sky-lending": "Sky",
  sky: "Sky",
  "ethena-usde": "Ethena",
  ethena: "Ethena",
  lido: "Lido",
  "jito-solana": "Jito",
  jito: "Jito",
  "jito-liquid-staking": "Jito",
  "jupiter-staked-sol": "Jupiter Staked SOL",
  "drift-staked-sol": "Drift Staked SOL",
  "marinade-liquid-staking": "Marinade",
  marinade: "Marinade",
  "yearn-finance": "Yearn",
  "yearn-v3": "Yearn",
  yearn: "Yearn",
  "curve-dex": "Curve",
  curve: "Curve",
  scallop: "Scallop",
  navi: "Navi",
};

const CHAIN_SUFFIXES = [
  "-base-sepolia",
  "-arbitrum-sepolia",
  "-optimism-sepolia",
  "-ethereum-sepolia",
  "-sepolia",
  "-base",
  "-arbitrum",
  "-optimism",
  "-polygon",
  "-ethereum",
  "-mainnet",
];

export function prettyProtocol(slug: string): string {
  const lower = slug.trim().toLowerCase();
  if (PROTOCOL_DISPLAY_NAMES[lower]) return PROTOCOL_DISPLAY_NAMES[lower];
  let base = lower;
  for (const suffix of CHAIN_SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  if (PROTOCOL_DISPLAY_NAMES[base]) return PROTOCOL_DISPLAY_NAMES[base];
  return (
    base
      .split(/[-_]/)
      .filter(Boolean)
      .map((word) =>
        /^v\d+$/i.test(word)
          ? word.toUpperCase()
          : word.charAt(0).toUpperCase() + word.slice(1),
      )
      .join(" ") || slug
  );
}
