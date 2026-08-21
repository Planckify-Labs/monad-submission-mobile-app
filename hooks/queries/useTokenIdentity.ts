import { useQuery } from "@tanstack/react-query";
import { tokenApi } from "@/api/endpoints/tokens";
import type { TTokenIdentity } from "@/api/types/token";

const EMPTY: TTokenIdentity = { symbol: null, logo: null, decimals: null };

/**
 * Symbol, icon and decimals for a token contract, so a sheet holding only an
 * address can say "6 USDT" with its logo instead of 42 hex characters and a
 * raw integer.
 *
 * Read-only decoration on top of an address that stays on screen regardless
 * — the same rule `CounterpartyLabel` follows for ENS names, and for the same
 * reason: a label anyone can set is a legibility aid, never an identity
 * claim, and the exact value has to stay checkable next to it.
 *
 * Metadata is near-immutable, so this is cached hard. It never returns an
 * error state: a failure resolves to `{ symbol: null, logo: null }` and the
 * caller simply renders nothing extra.
 */
export function useTokenIdentity(
  chainId: number | undefined,
  address: string | undefined,
): TTokenIdentity {
  const enabled =
    typeof chainId === "number" &&
    Number.isFinite(chainId) &&
    typeof address === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(address);

  const { data } = useQuery({
    queryKey: ["token-identity", chainId, address?.toLowerCase()],
    queryFn: () =>
      tokenApi.getTokenIdentity(chainId as number, address as string),
    enabled,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 0,
  });

  return data ?? EMPTY;
}
