/**
 * ERC-165 interface probe — spec phase D.
 *
 * ERC-20's `approve(address spender, uint256 amount)` and ERC-721's
 * `approve(address to, uint256 tokenId)` share selector `0x095ea7b3`
 * *and* the identical ABI encoding. The calldata decoder's roundtrip
 * gate cannot separate them, because both re-encode to exactly the same
 * bytes. Disambiguation therefore cannot come from the calldata at all;
 * it has to come from the contract.
 *
 * Why this matters beyond wrong copy: the risk classifier reads the
 * second argument as an allowance and flags it unlimited above
 * `type(uint256).max / 2`. On an ERC-721 that argument is a token id,
 * so a high token id false-flags as an unlimited approval, and a real
 * NFT approval is scored on a scale that does not apply to it.
 */

import type { PublicClient } from "viem";

/** ERC-165 interface ids. */
const ERC721_INTERFACE = "0x80ac58cd";
const ERC1155_INTERFACE = "0xd9b67a26";

const SUPPORTS_INTERFACE_ABI = [
  {
    name: "supportsInterface",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "interfaceId", type: "bytes4" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export type AssetInterface = "erc20" | "erc721" | "erc1155" | "unknown";

/**
 * `unknown` is a first-class answer, not a failure to be smoothed over.
 * Defaulting to ERC-20 is what produces today's wrong copy; defaulting
 * to ERC-721 would suppress a genuine unlimited-allowance warning. The
 * caller must render indeterminate rather than pick a side.
 */
export async function probeAssetInterface(
  client: PublicClient,
  address: `0x${string}`,
): Promise<AssetInterface> {
  try {
    const [is721, is1155] = await Promise.all([
      client
        .readContract({
          address,
          abi: SUPPORTS_INTERFACE_ABI,
          functionName: "supportsInterface",
          args: [ERC721_INTERFACE],
        })
        .catch(() => false),
      client
        .readContract({
          address,
          abi: SUPPORTS_INTERFACE_ABI,
          functionName: "supportsInterface",
          args: [ERC1155_INTERFACE],
        })
        .catch(() => false),
    ]);
    if (is721) return "erc721";
    if (is1155) return "erc1155";
    // A contract that answers `supportsInterface` with false for both is
    // not thereby an ERC-20 — plenty of contracts implement neither
    // ERC-165 nor a token standard. Only the token registry can assert
    // ERC-20 positively, so stay unknown here.
    return "unknown";
  } catch {
    return "unknown";
  }
}

const ERC20_FACTS_ABI = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "totalSupply",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** What the supply probe could establish. Either field may be absent. */
export interface Erc20Facts {
  decimals?: number;
  totalSupply?: bigint;
}

/**
 * Read `decimals()` and `totalSupply()` — spec phase N.
 *
 * The unlimited-approval threshold was `type(uint256).max / 2`, an
 * absolute number applied to a quantity that has no absolute meaning.
 * The test-dapp's malicious approval uses `0xffffffffffffffff`:
 *
 *   as an 18-decimal token       18.45 tokens          unremarkable
 *   as USDC (6 decimals)         18,446,744,073,710    more than exists
 *
 * The same integer is a rounding error or an infinite allowance
 * depending entirely on `decimals()`, and their payload sits precisely
 * in the gap where the threshold says nothing at all. Total supply turns
 * the heuristic into a fact: an allowance at or above everything that
 * exists is unbounded in practice, whatever the token's scale.
 *
 * `decimals` earns its place separately. Rendering "18,446,744,073,710
 * USDC" instead of a 20-digit integer is what makes the attack legible
 * with no warning attached at all.
 *
 * Each read fails independently; a partial answer is more useful than
 * none, and a total failure degrades to the offline threshold rather
 * than removing a warning.
 */
export async function probeErc20Facts(
  client: PublicClient,
  address: `0x${string}`,
): Promise<Erc20Facts> {
  const [decimals, totalSupply] = await Promise.all([
    client
      .readContract({
        address,
        abi: ERC20_FACTS_ABI,
        functionName: "decimals",
      })
      .catch(() => undefined),
    client
      .readContract({
        address,
        abi: ERC20_FACTS_ABI,
        functionName: "totalSupply",
      })
      .catch(() => undefined),
  ]);
  const facts: Erc20Facts = {};
  // A nonsensical `decimals` from a hostile token must not reach the
  // formatter; dropping it renders the raw integer, which is honest.
  if (typeof decimals === "number" && decimals >= 0 && decimals <= 36) {
    facts.decimals = decimals;
  }
  if (typeof totalSupply === "bigint" && totalSupply > 0n) {
    facts.totalSupply = totalSupply;
  }
  return facts;
}
