/**
 * What is this contract, read off the init-code being deployed.
 *
 * A deployment sheet that says only "Contract deployment" is technically
 * true and practically useless: deploying an NFT collection, a token,
 * and an arbitrary program are three different acts and the user was
 * shown one label for all of them. Everything needed to tell them apart
 * is already in the bytes being signed, so no RPC call is involved.
 *
 * ### Two independent signals
 *
 * 1. **The dispatcher's selector table.** Solidity compiles a public
 *    function's 4-byte selector into the runtime code's entry jump
 *    table, and the runtime code sits inside the init-code. If every
 *    mandatory selector of a standard is present, the contract almost
 *    certainly implements it.
 * 2. **The ERC-165 interface id.** `supportsInterface` compares against
 *    a constant (`0x80ac58cd` for ERC-721), which the compiler embeds
 *    literally.
 *
 * The two are derived from each other by definition — an interface id
 * **is** the XOR of its members' selectors — which gives a free
 * self-check: the selector lists below XOR to exactly the published ids,
 * and the test asserts it. A typo'd selector cannot survive that.
 *
 * ### This is a legibility aid, not a verification
 *
 * Byte-string matching proves the selectors are *present*, not that the
 * functions behave. Nothing stops a contract embedding an ERC-721
 * interface id while doing something else entirely. So the caller must
 * phrase the result as a resemblance and never as a guarantee, the same
 * rule `CounterpartyLabel` follows for ENS names.
 *
 * The exposure here is genuinely low, which is why a heuristic is worth
 * shipping: deploying a contract moves no assets except gas, and the
 * user is deploying *their own* code. The value is telling someone who
 * clicked "Deploy NFTs" that they are about to deploy an NFT contract,
 * and — more usefully — telling someone who did **not** expect a
 * deployment that a token contract is what they are being asked for.
 */

/** Every mandatory ERC-721 function (EIP-721). XOR = 0x80ac58cd. */
const ERC721_SELECTORS = [
  "70a08231", // balanceOf(address)
  "6352211e", // ownerOf(uint256)
  "b88d4fde", // safeTransferFrom(address,address,uint256,bytes)
  "42842e0e", // safeTransferFrom(address,address,uint256)
  "23b872dd", // transferFrom(address,address,uint256)
  "095ea7b3", // approve(address,uint256)
  "a22cb465", // setApprovalForAll(address,bool)
  "081812fc", // getApproved(uint256)
  "e985e9c5", // isApprovedForAll(address,address)
] as const;

/** Every mandatory ERC-1155 function (EIP-1155). XOR = 0xd9b67a26. */
const ERC1155_SELECTORS = [
  "f242432a", // safeTransferFrom(address,address,uint256,uint256,bytes)
  "2eb2c2d6", // safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)
  "00fdd58e", // balanceOf(address,uint256)
  "4e1273f4", // balanceOfBatch(address[],uint256[])
  "a22cb465", // setApprovalForAll(address,bool)
  "e985e9c5", // isApprovedForAll(address,address)
] as const;

/**
 * Every mandatory ERC-20 function (EIP-20).
 *
 * ERC-20 has no ERC-165 id, so selectors are the only signal. It shares
 * `balanceOf`, `approve` and `transferFrom` with ERC-721, but `transfer`,
 * `allowance` and `totalSupply` together are not an ERC-721 shape — and
 * ERC-721 is checked first regardless.
 */
const ERC20_SELECTORS = [
  "18160ddd", // totalSupply()
  "70a08231", // balanceOf(address)
  "a9059cbb", // transfer(address,uint256)
  "23b872dd", // transferFrom(address,address,uint256)
  "095ea7b3", // approve(address,uint256)
  "dd62ed3e", // allowance(address,address)
] as const;

/** ERC-165 interface ids, embedded as constants by `supportsInterface`. */
const INTERFACE_IDS = {
  erc721: "80ac58cd",
  erc1155: "d9b67a26",
  erc721Metadata: "5b5e139f",
  erc721Enumerable: "780e9d63",
} as const;

const TRAIT_SELECTORS = {
  /** name() + symbol() + tokenURI(uint256) */
  metadata: ["06fdde03", "95d89b41"],
  tokenUri: ["c87b56dd"],
  /** ERC-1155 uri(uint256) */
  uri: ["0e89341c"],
  /** The common public mint entry points. */
  mint: [
    "40c10f19", // mint(address,uint256)
    "1249c58b", // mint()
    "a0712d68", // mint(uint256)
    "6a627842", // mint(address)
  ],
  /** Ownable — `owner()`. */
  ownable: ["8da5cb5b"],
} as const;

export type DeployedContractKind = "erc20" | "erc721" | "erc1155" | "unknown";

export interface DeployedContractGuess {
  kind: DeployedContractKind;
  /**
   * Why we think so. `"selectors"` means every mandatory function of the
   * standard is in the dispatcher; `"interfaceId"` means the ERC-165
   * constant is present. Both is the strongest case, and either alone is
   * still worth surfacing.
   */
  evidence: Array<"selectors" | "interfaceId">;
  /** Extras worth naming: `metadata`, `enumerable`, `mint`, `ownable`. */
  traits: string[];
}

function normalize(initCode: string | null | undefined): string | null {
  if (!initCode || typeof initCode !== "string") return null;
  const body = initCode.startsWith("0x") ? initCode.slice(2) : initCode;
  // Too short to hold a dispatcher; not worth guessing about.
  if (body.length < 64) return null;
  return body.toLowerCase();
}

function hasAll(code: string, selectors: readonly string[]): boolean {
  return selectors.every((s) => code.includes(s));
}

function hasAny(code: string, selectors: readonly string[]): boolean {
  return selectors.some((s) => code.includes(s));
}

/**
 * Best-effort read of what an init-code payload deploys. Pure, offline,
 * and never throws — an unrecognised payload returns `"unknown"`, which
 * is a real answer rather than a failure to smooth over.
 */
export function guessDeployedContractKind(
  initCode: string | null | undefined,
): DeployedContractGuess {
  const code = normalize(initCode);
  const none: DeployedContractGuess = {
    kind: "unknown",
    evidence: [],
    traits: [],
  };
  if (!code) return none;

  const build = (
    kind: DeployedContractKind,
    selectorsMatched: boolean,
    interfaceMatched: boolean,
  ): DeployedContractGuess => {
    const evidence: Array<"selectors" | "interfaceId"> = [];
    if (selectorsMatched) evidence.push("selectors");
    if (interfaceMatched) evidence.push("interfaceId");
    const traits: string[] = [];
    if (kind !== "erc1155" && hasAll(code, TRAIT_SELECTORS.metadata)) {
      traits.push("metadata");
    }
    if (kind === "erc721" && hasAny(code, TRAIT_SELECTORS.tokenUri)) {
      traits.push("tokenURI");
    }
    if (kind === "erc1155" && hasAny(code, TRAIT_SELECTORS.uri)) {
      traits.push("uri");
    }
    if (code.includes(INTERFACE_IDS.erc721Enumerable)) {
      traits.push("enumerable");
    }
    if (hasAny(code, TRAIT_SELECTORS.mint)) traits.push("mint");
    if (hasAny(code, TRAIT_SELECTORS.ownable)) traits.push("ownable");
    return { kind, evidence, traits };
  };

  // ERC-1155 first: its mandatory set is disjoint enough from ERC-721's
  // that a contract matching both is a multi-standard token, and the
  // 1155 reading is the more specific one.
  const is1155Selectors = hasAll(code, ERC1155_SELECTORS);
  const is1155Interface = code.includes(INTERFACE_IDS.erc1155);
  if (is1155Selectors || is1155Interface) {
    return build("erc1155", is1155Selectors, is1155Interface);
  }

  const is721Selectors = hasAll(code, ERC721_SELECTORS);
  const is721Interface = code.includes(INTERFACE_IDS.erc721);
  if (is721Selectors || is721Interface) {
    return build("erc721", is721Selectors, is721Interface);
  }

  // ERC-20 last and selectors-only: it predates ERC-165, so there is no
  // interface id to corroborate with.
  if (hasAll(code, ERC20_SELECTORS)) return build("erc20", true, false);

  return none;
}

/**
 * One line of user-facing copy for a guess, or `null` when we have
 * nothing to say.
 *
 * Deliberately hedged in every branch. We matched byte patterns in code
 * nobody has audited, so "looks like" is the strongest honest verb, and
 * the deployment card keeps its "not reviewed by TakumiPay" line either
 * way.
 */
export function describeDeployedContract(
  guess: DeployedContractGuess,
): string | null {
  switch (guess.kind) {
    case "erc721":
      return guess.traits.includes("mint")
        ? "This looks like an NFT collection (ERC-721) that can mint new items."
        : "This looks like an NFT collection (ERC-721).";
    case "erc1155":
      return guess.traits.includes("mint")
        ? "This looks like a multi-token contract (ERC-1155) that can mint new items."
        : "This looks like a multi-token contract (ERC-1155), used for NFTs and semi-fungible items.";
    case "erc20":
      return guess.traits.includes("mint")
        ? "This looks like a token contract (ERC-20) that can mint new supply."
        : "This looks like a token contract (ERC-20).";
    default:
      return null;
  }
}

/** Short label for the deployment card's heading row. */
export function deployedContractLabel(kind: DeployedContractKind): string {
  switch (kind) {
    case "erc721":
      return "NFT collection (ERC-721)";
    case "erc1155":
      return "Multi-token contract (ERC-1155)";
    case "erc20":
      return "Token contract (ERC-20)";
    default:
      return "Contract deployment";
  }
}
