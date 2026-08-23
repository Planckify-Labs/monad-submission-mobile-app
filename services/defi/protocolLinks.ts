/**
 * Client-side protocol deep-link registry (pool-level deposits spec §9.1).
 *
 * The "Manual" badge opens the protocol's own UI in the in-app `dapps-browser`
 * (still on the Takumi wallet via the DappBridge). A manual pool has an
 * unresolved `depositTarget`, so there's no vault address to template a
 * pool-precise link with — we use the protocol's homepage (layer 2). This is a
 * pure static registry (no `OpportunityCache` column, no storage — spec's
 * cheapest option); unknown venues fall back to DeFiLlama's own protocol page,
 * which always resolves and links out to the protocol site.
 */

// Chain qualifiers stripped from a slug before lookup ("aave-v3-base" →
// "aave-v3"), mirroring the card's `prettyProtocol` normalisation.
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

// Top venues → their own app URL. Extend as venues surface; unknowns fall
// back to the DeFiLlama protocol page.
const PROTOCOL_APP_URLS: Record<string, string> = {
  "aave-v3": "https://app.aave.com",
  "aave-v2": "https://app.aave.com",
  aave: "https://app.aave.com",
  morpho: "https://app.morpho.org",
  "morpho-blue": "https://app.morpho.org",
  "morpho-vault": "https://app.morpho.org",
  yearn: "https://yearn.fi",
  "yearn-finance": "https://yearn.fi",
  "yearn-v3": "https://yearn.fi",
  lido: "https://stake.lido.fi",
  curve: "https://curve.fi",
  "curve-dex": "https://curve.fi",
  "compound-v3": "https://app.compound.finance",
  "compound-v2": "https://app.compound.finance",
  compound: "https://app.compound.finance",
  ethena: "https://app.ethena.fi",
  "ethena-usde": "https://app.ethena.fi",
  spark: "https://app.spark.fi",
  "sky-lending": "https://app.sky.money",
  sky: "https://app.sky.money",
  pendle: "https://app.pendle.finance",
  fluid: "https://fluid.instadapp.io",
  "fluid-lending": "https://fluid.instadapp.io",
  maple: "https://app.maple.finance",
  ethena_usde: "https://app.ethena.fi",
  // Sui / Solana venues
  scallop: "https://app.scallop.io",
  "scallop-lend": "https://app.scallop.io",
  navi: "https://app.naviprotocol.io",
  "navi-lending": "https://app.naviprotocol.io",
  jito: "https://www.jito.network/staking",
  "jito-solana": "https://www.jito.network/staking",
  "jito-liquid-staking": "https://www.jito.network/staking",
  "jupiter-staked-sol": "https://jup.ag/staking",
  "drift-staked-sol": "https://app.drift.trade/earn/dsol",
  marinade: "https://marinade.finance",
  "marinade-liquid-staking": "https://marinade.finance",
  kamino: "https://app.kamino.finance",
  "kamino-lend": "https://app.kamino.finance",
  marginfi: "https://app.marginfi.com",
};

function stripChainSuffix(slug: string): string {
  for (const suffix of CHAIN_SUFFIXES) {
    if (slug.endsWith(suffix)) return slug.slice(0, -suffix.length);
  }
  return slug;
}

/**
 * The manual deep-link URL for a protocol (spec §9.1 layer 2). Resolution order:
 *   1. Curated top-venue app URL — points at the *app* (app.aave.com), the best
 *      landing for a deposit.
 *   2. `appUrl` — the protocol's own site from DeFiLlama's `/protocol/{slug}.url`,
 *      surfaced server-side. Covers the long tail (e.g. YO Protocol) so we open
 *      the real dApp, not the DeFiLlama page.
 *   3. Last resort — the DeFiLlama protocol page (always resolves + links out),
 *      used only when we have neither a curated entry nor a server-provided URL.
 */
export function protocolAppUrl(slug: string, appUrl?: string | null): string {
  const lower = (slug ?? "").trim().toLowerCase();
  if (lower && PROTOCOL_APP_URLS[lower]) return PROTOCOL_APP_URLS[lower];
  const base = stripChainSuffix(lower);
  if (base && PROTOCOL_APP_URLS[base]) return PROTOCOL_APP_URLS[base];

  const fromApi = typeof appUrl === "string" ? appUrl.trim() : "";
  if (/^https?:\/\//i.test(fromApi)) return fromApi;

  if (!base) return "https://defillama.com/yields";
  return `https://defillama.com/protocol/${encodeURIComponent(base)}`;
}
