/**
 * Token symbol + decimals for a CAIP-19 asset, from the `/blockchains`
 * catalogue already cached on device.
 *
 * Approval surfaces (`PreviewCard`, `ApprovalSheet`) see only RAW TOOL
 * ARGS, and amounts there are in smallest units. Without decimals the
 * approval either omits the amount or prints "5000000" for 5 USDC — and
 * the second is worse than the first, because the user approves against
 * that string. This is the lookup that lets it state the real number.
 *
 * Reads the same MMKV-seeded catalogue `ChainIcon` uses, so it adds no
 * network round trip on the approval path.
 */

import type { TBlockchain } from "@/api/types/blockchain";

export interface AssetMeta {
  symbol?: string;
  decimals?: number;
}

/**
 * Split a CAIP-19 into its chain id and asset reference without pulling
 * in the bridge CAIP parser (which reaches the wallet-kit registry).
 * `eip155:8453/erc20:0x833…` → `{ chain: "eip155:8453", reference: "0x833…" }`.
 */
function splitCaip19(
  caip19: string,
): { chain: string; namespace: string; reference: string } | null {
  const slash = caip19.indexOf("/");
  if (slash <= 0) return null;
  const chain = caip19.slice(0, slash);
  const rest = caip19.slice(slash + 1);
  const colon = rest.indexOf(":");
  return {
    chain,
    namespace: colon === -1 ? rest : rest.slice(0, colon),
    reference: colon === -1 ? "" : rest.slice(colon + 1),
  };
}

/** Native-asset namespaces carry no contract — the chain's own coin. */
const NATIVE_ASSET_NAMESPACES = new Set(["slip44", "native"]);

export function resolveAssetMeta(
  blockchains: TBlockchain[] | undefined,
  caip19: string | undefined,
): AssetMeta | undefined {
  if (!caip19 || !blockchains?.length) return undefined;
  const parsed = splitCaip19(caip19);
  if (!parsed) return undefined;

  const chain = blockchains.find((b) => b.caip2Id === parsed.chain);
  const tokens = chain?.tokens;
  if (!tokens?.length) return undefined;

  if (NATIVE_ASSET_NAMESPACES.has(parsed.namespace)) {
    const native = tokens.find((t) => t.isNativeCurrency);
    return native
      ? { symbol: native.symbol, decimals: native.decimals }
      : undefined;
  }

  // Contract addresses are compared case-insensitively here on purpose:
  // this is a DISPLAY lookup, and a miss only costs us the amount in the
  // summary. Authorization comparisons use the per-namespace rules in
  // `addressesEqual` instead (`feedback_address_case_per_encoding`).
  const wanted = parsed.reference.toLowerCase();
  const token = tokens.find(
    (t) => (t.contractAddress ?? "").toLowerCase() === wanted,
  );
  return token ? { symbol: token.symbol, decimals: token.decimals } : undefined;
}
