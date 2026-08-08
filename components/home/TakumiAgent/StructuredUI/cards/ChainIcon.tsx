/**
 * Small chain logo, resolved the same way the rest of the app does:
 * there is no per-chain icon field on `/blockchains`
 * (`reference_chain_icon_from_native_token`), so the icon is whichever
 * chain's row has a token with `isNativeCurrency: true`, and ITS
 * `logoUrl` is what renders. Mirrors `ChainSelector.tsx`'s lookup, just
 * keyed by CAIP-2 (what the bridge cards actually have) via each row's
 * enricher-computed `caip2Id` instead of a numeric EVM `chainId`.
 *
 * Reads `useBlockchainsWithStorage`, which is MMKV-seeded and already
 * warm elsewhere in the app by the time a bridge card renders, so this
 * adds no new network round trip in the common case.
 *
 * Renders nothing (not a placeholder) when no logo resolves — a wrong
 * generic icon next to a real chain name is worse than no icon, and
 * `chainLabel`'s own text fallback already covers "we don't know this
 * chain" on its own.
 */
import { Image } from "react-native";
import type { TBlockchain } from "@/api/types/blockchain";
import { useBlockchainsWithStorage } from "@/hooks/useBlockchainsWithStorage";

function findChainIconUrl(
  chains: TBlockchain[] | undefined,
  caip2: string | undefined,
): string | undefined {
  if (!caip2 || !chains) return undefined;
  // `caip2Id` is enricher-computed for every row, EVM included
  // (`api/src/blockchains/blockchain-enricher.ts`, `buildCaip2Id`), so this
  // needs no per-namespace fallback and no namespace comparison here.
  const blockchain = chains.find((b) => b.caip2Id === caip2);
  return (
    blockchain?.tokens?.find((t) => t.isNativeCurrency)?.logoUrl ?? undefined
  );
}

export function ChainIcon({
  caip2,
  size = 12,
}: {
  caip2: string | undefined;
  size?: number;
}) {
  const { data: chains } = useBlockchainsWithStorage({ isActive: true });
  const uri = findChainIconUrl(chains, caip2);
  if (!uri) return null;
  return (
    <Image
      source={{ uri }}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      defaultSource={require("@/assets/images/takumipay-logo.png")}
    />
  );
}
