/**
 * Bundled ERC-7730 registry snapshot — task 65 (TWV-2026-066) Phase B.
 *
 * Pinned, in-bundle compile of a subset of the community clear-signing
 * registry (`github.com/ethereum/clear-signing-erc7730-registry`,
 * schema v1, snapshot taken 2026-07-20). NEVER fetched live at sign
 * time: a compromised / MITM'd registry endpoint must not be able to
 * change what a user sees at the moment of signing (same rationale as
 * the Permit2 address book, task 21). Updating this snapshot is a code
 * change that goes through review; a scheduled build-time refresh is a
 * separate infra task (spec "Out of scope").
 *
 * Entry shape is a flattened compile of the registry's
 * `display.formats` sections: the human-readable ABI fragment key, the
 * descriptor's `intent`, and the field list. `deployments: null` marks
 * a standard-level descriptor (ERC-20 / ERC-721 function shapes) that
 * binds by selector + roundtrip rather than by pinned address — the
 * wording of those intents stays mechanism-neutral ("Transfer token
 * amount") because the target contract is not identity-verified.
 */

export interface Erc7730FieldSpec {
  /** Parameter name inside the format fragment (`to`, `value`, …). */
  param: string;
  /** Human label rendered next to the interpolated value. */
  label: string;
  /**
   * Render a bigint param for humans rather than as bare digits:
   * "Unlimited" once the value is at or above the unlimited-allowance
   * threshold (decimals are unknown at this layer so it cannot be
   * scaled, but at that magnitude decimals stop mattering anyway),
   * otherwise the same digits comma-grouped so the magnitude is
   * scannable.
   *
   * The label keeps its "(raw units)" qualifier either way. Grouping
   * `1000000` into `1,000,000` makes it readable, not scaled, and a
   * six-decimal token would make that same number mean one — dropping
   * the qualifier here would turn a legibility aid into a wrong claim.
   *
   * Exact digits and the hex form are not this card's job; the sheet's
   * technical drawer carries both, unmodified.
   */
  encoding?: "readable";
}

export interface Erc7730CalldataEntry {
  kind: "calldata";
  /**
   * Human-readable ABI fragment exactly as the registry's
   * `display.formats` key carries it — parameter names included.
   * Selector derivation (strip names → keccak → 4 bytes) happens at
   * resolve time per the ERC-7730 wallet algorithm.
   */
  format: string;
  intent: string;
  fields: Erc7730FieldSpec[];
  /** `null` = standard-level descriptor, applies to any deployment. */
  deployments: Array<{ chainId: number; address: string }> | null;
}

export interface Erc7730Eip712Entry {
  kind: "eip712";
  /**
   * Canonical EIP-712 `encodeType` output for the bound struct — the
   * registry's TYPE_KEY. Matching is `keccak256(encodeType(typeOf(s)))
   * === keccak256(TYPE_KEY)` per the spec.
   */
  typeKey: string;
  intent: string;
  fields: Erc7730FieldSpec[];
  deployments: Array<{ chainId: number; address: string }> | null;
}

export type Erc7730SnapshotEntry = Erc7730CalldataEntry | Erc7730Eip712Entry;

export const ERC7730_SNAPSHOT: readonly Erc7730SnapshotEntry[] = [
  // ── ERC-20 standard functions (registry: erc20 common formats) ──────
  {
    kind: "calldata",
    format: "transfer(address to,uint256 value)",
    intent: "Transfer",
    fields: [
      { param: "to", label: "To" },
      { param: "value", label: "Amount (raw units)", encoding: "readable" },
    ],
    deployments: null,
  },
  {
    kind: "calldata",
    format: "approve(address spender,uint256 value)",
    intent: "Approve spending",
    fields: [
      { param: "spender", label: "Spender" },
      { param: "value", label: "Allowance (raw units)", encoding: "readable" },
    ],
    deployments: null,
  },
  {
    kind: "calldata",
    format: "transferFrom(address from,address to,uint256 value)",
    intent: "Transfer from",
    fields: [
      { param: "from", label: "From" },
      { param: "to", label: "To" },
      { param: "value", label: "Amount (raw units)", encoding: "readable" },
    ],
    deployments: null,
  },
  // ── ERC-721 ──────────────────────────────────────────────────────────
  {
    kind: "calldata",
    format: "safeTransferFrom(address from,address to,uint256 tokenId)",
    intent: "Transfer NFT",
    fields: [
      { param: "from", label: "From" },
      { param: "to", label: "To" },
      { param: "tokenId", label: "Token ID" },
    ],
    deployments: null,
  },
  {
    kind: "calldata",
    format: "setApprovalForAll(address operator,bool approved)",
    intent: "Set collection-wide approval",
    fields: [
      { param: "operator", label: "Operator" },
      { param: "approved", label: "Approved" },
    ],
    deployments: null,
  },
  // ── WETH (registry: weth/calldata-wrap) — deployment-pinned ─────────
  {
    kind: "calldata",
    format: "deposit()",
    intent: "Wrap ETH",
    fields: [],
    deployments: [
      // WETH9 mainnet + the L2 canonical WETH at the same role.
      { chainId: 1, address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" },
      { chainId: 8453, address: "0x4200000000000000000000000000000000000006" },
      { chainId: 10, address: "0x4200000000000000000000000000000000000006" },
    ],
  },
  {
    kind: "calldata",
    format: "withdraw(uint256 wad)",
    intent: "Unwrap WETH",
    fields: [{ param: "wad", label: "Amount (wei)", encoding: "readable" }],
    deployments: [
      { chainId: 1, address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" },
      { chainId: 8453, address: "0x4200000000000000000000000000000000000006" },
      { chainId: 10, address: "0x4200000000000000000000000000000000000006" },
    ],
  },
  // ── EIP-712: ERC-2612 Permit (registry: erc20 permit format) ────────
  {
    kind: "eip712",
    typeKey:
      "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)",
    intent: "Permit token spending",
    fields: [
      { param: "owner", label: "Owner" },
      { param: "spender", label: "Spender" },
      { param: "value", label: "Allowance (raw units)", encoding: "readable" },
      { param: "deadline", label: "Deadline (unix)" },
    ],
    deployments: null,
  },
];
