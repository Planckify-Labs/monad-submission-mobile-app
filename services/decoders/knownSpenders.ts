// TWV-2026-008 — curated known-safe spender allowlist. A `Permit` /
// `Permit2` approval for an address NOT on this list is a red-banner
// warning in the signer UI. The wallet does NOT block the signature
// (§7 signable-tx parity) — the user can proceed, but only after an
// explicit acknowledgement.
//
// Addresses are lowercased at runtime; lookup is case-insensitive.
// Every entry should name the contract + chain so a reviewer can verify
// the deployment source. When extending this list, require a second
// reviewer per the spec §9 "Signatures" row.

export interface KnownSpender {
  address: `0x${string}`;
  name: string;
  chainIds: number[];
}

export const KNOWN_SPENDERS: ReadonlyArray<KnownSpender> = [
  // Uniswap Universal Router v2 (widely deployed; per-chain deployments).
  {
    address: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
    name: "Uniswap Universal Router",
    chainIds: [1],
  },
  {
    address: "0x5E325eDA8064b456f4781070C0738d849c824258",
    name: "Uniswap Universal Router",
    chainIds: [10],
  },
  {
    address: "0x643770E279d5D0733F21d6DC03A8efbABf3255B4",
    name: "Uniswap Universal Router",
    chainIds: [137],
  },
  {
    address: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
    name: "Uniswap Universal Router",
    chainIds: [8453],
  },
  {
    address: "0xb555edF5dcF85f42cEeF1f3630a52A108E55A654",
    name: "Uniswap Universal Router",
    chainIds: [42161],
  },

  // Permit2 itself is canonical across chains.
  {
    address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    name: "Permit2",
    chainIds: [1, 10, 137, 8453, 42161],
  },

  // 1inch v6 router.
  {
    address: "0x111111125421cA6dc452d289314280a0f8842A65",
    name: "1inch v6 Router",
    chainIds: [1, 10, 137, 8453, 42161],
  },

  // CoW Protocol GPv2VaultRelayer.
  {
    address: "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110",
    name: "CoW VaultRelayer",
    chainIds: [1],
  },

  // ── NFT marketplaces (spec phase F item a) ──────────────────────────
  //
  // Until these landed, `setApprovalForAll` to OpenSea's conduit rendered
  // as a bare hex address — visually identical to approving a drainer.
  // The user had no way to tell the most-used marketplace on the chain
  // from an attacker's contract, which made the existing "unknown
  // spender" warning noise rather than signal.
  //
  // Seaport is deployed at the same address on every chain it ships to
  // (deterministic deployment), as are the ConduitController and the
  // canonical OpenSea conduit. Addresses verified against
  // ProjectOpenSea/seaport's README and seaport-js `constants.ts`
  // (`OPENSEA_CONDUIT_ADDRESS`, keyed by conduit key
  // 0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000).
  {
    address: "0x0000000000000068F116a894984e2DB1123eB395",
    name: "Seaport 1.6",
    chainIds: [1, 10, 137, 8453, 42161],
  },
  {
    address: "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC",
    name: "Seaport 1.5",
    chainIds: [1, 10, 137, 8453, 42161],
  },
  {
    // Spec phase P. `maliciousSeaport` signs against 1.1, so without it
    // the most-used order format in the dapp's adversarial suite renders
    // its marketplace as a bare address. Verified 2026-08-12 against the
    // deployment table in ProjectOpenSea/seaport's README, the same
    // primary source the 1.5 and 1.6 entries above came from.
    address: "0x00000000006c3852cbEf3e08E8dF289169EdE581",
    name: "Seaport 1.1",
    chainIds: [1, 10, 137, 8453, 42161],
  },
  {
    address: "0x00000000F9490004C11Cef243f5400493c00Ad63",
    name: "Seaport ConduitController",
    chainIds: [1, 10, 137, 8453, 42161],
  },
  {
    // The conduit is the address users actually grant `setApprovalForAll`
    // to — Seaport itself pulls tokens through it rather than directly.
    address: "0x1E0049783F008A0085193E00003D00cd54003c71",
    name: "OpenSea Conduit",
    chainIds: [1, 10, 137, 8453, 42161],
  },
  // Blur and LooksRare v2 are deliberately ABSENT. Their addresses could
  // not be confirmed against a primary source at the time this landed,
  // and a wrong entry here is far worse than a missing one: it would
  // print a trusted marketplace name next to an address that is not that
  // marketplace, which is precisely the attack this table defends
  // against. Add them only with a verified deployment source, per the
  // second-reviewer rule at the top of this file.
];

const ALLOW = new Set(
  KNOWN_SPENDERS.map(
    (s) => `${s.chainIds.join(",")}:${s.address.toLowerCase()}`,
  ),
);

const ADDR_ONLY = new Set(KNOWN_SPENDERS.map((s) => s.address.toLowerCase()));

export function isKnownSpender(
  address: string,
  chainId?: number,
): KnownSpender | null {
  const a = address.toLowerCase();
  if (chainId !== undefined) {
    // Exact match on (chainId, address) first.
    for (const s of KNOWN_SPENDERS) {
      if (s.address.toLowerCase() === a && s.chainIds.includes(chainId)) {
        return s;
      }
    }
    return null;
  }
  // Fallback when chainId unknown — match on address only.
  if (!ADDR_ONLY.has(a)) return null;
  return KNOWN_SPENDERS.find((s) => s.address.toLowerCase() === a) ?? null;
}
