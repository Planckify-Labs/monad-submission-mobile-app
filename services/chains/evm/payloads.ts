import type { AccessList, TypedDataDefinition } from "viem";
import type {
  ApproveTargetKind,
  DecodedCalldata,
} from "@/services/decoders/calldata";

export type EvmConnectPayload = {
  requestedAccounts: number;
  chainId: number;
};

export type EvmSignMessagePayload = {
  message: string;
  display: "utf8" | "hex";
  address: `0x${string}`;
};

export type EvmSignTypedDataPayload = {
  /**
   * Validated and normalised by `validateTypedData` at the adapter
   * boundary (spec phase O), so consumers can rely on: every referenced
   * type resolving, `address`-declared fields being checksummed hex, a
   * numeric `chainId`, and `message` containing **only** fields declared
   * in `types[primaryType]`. That last one is the display/sign fix:
   * anything rendered from here is by construction in the signed hash.
   */
  typedData: TypedDataDefinition;
  address: `0x${string}`;
  /**
   * Keys the dApp put in `message` that are absent from
   * `types[primaryType]` (`signExtraDataNotTyped`). They are stripped
   * from `typedData` because they are not signed; the sheet warns that
   * the request carried them, because a payload shaped this way is
   * trying to show the user something the signature will not cover.
   */
  undeclaredMessageKeys?: string[];
  method: "eth_signTypedData_v3" | "eth_signTypedData_v4";
  /**
   * The chain this dApp session is on, resolved by the adapter from the
   * per-origin chain config — **never** from an RPC `eth_chainId` and
   * never from the home-screen active chain (TWV-2026-016, and the
   * dApp-bridge isolation rule).
   *
   * The sheet compares `typedData.domain.chainId` against this to detect
   * a replay-bait domain. It is stamped here rather than read in the
   * sheet because the adapter is the only place that knows which chain
   * the *origin* is on.
   */
  activeChainId?: number;
  /** Display name for `activeChainId`, from the same resolution. */
  activeChainName?: string;
};

type EvmTxCommon = {
  /**
   * Absent for a **contract creation** transaction — a missing recipient
   * is what defines one at the protocol level. `normalizeTx` accepts a
   * missing `to` only when `data` is non-empty, so an absent `to` here
   * always means "deploy this init-code", never "send to nowhere".
   *
   * Consumers must branch rather than assume an address: the approval
   * sheet renders a deployment row instead of a recipient, and the
   * calldata decoder skips (constructor init-code is not a function call
   * and would mis-hit a 4-byte selector).
   */
  to?: `0x${string}`;
  from: `0x${string}`;
  value?: bigint;
  data?: `0x${string}`;
  gas?: bigint;
  nonce?: number;
  chainId: number;
  /**
   * Structural decode patched in by `EvmCalldataDecoderInspector`
   * (priority 15) — same contract as the Solana/Sui/Stellar payloads'
   * `decoded` fields. Absent when the calldata is empty or the
   * inspector pipeline didn't run.
   */
  decoded?: DecodedCalldata;
  /**
   * What `to` is, when the adapter could resolve it. Only meaningful
   * for the shared `approve` selector. Absent means unresolved, which
   * the decoder renders as indeterminate rather than guessing.
   */
  approveTarget?: ApproveTargetResolution;
};

/**
 * The adapter's on-chain answer about an `approve` target.
 *
 * `kind` comes from the token registry first, then an ERC-165 probe, and
 * separates an ERC-20 allowance from an ERC-721 approval — the two are
 * byte-identical in calldata, so nothing in the request can tell them
 * apart (spec phase D).
 *
 * `decimals` / `totalSupply` are the phase-N addition. An absolute
 * "unlimited" threshold cannot express a quantity whose meaning depends
 * on the token's scale; total supply can, and decimals is what turns a
 * 20-digit integer into a number a person can judge.
 */
export type ApproveTargetResolution = {
  kind: ApproveTargetKind;
  decimals?: number;
  totalSupply?: bigint;
};

export type EvmSendTxPayload =
  | (EvmTxCommon & { type: 0; gasPrice?: bigint })
  | (EvmTxCommon & { type: 1; gasPrice?: bigint; accessList?: AccessList })
  | (EvmTxCommon & {
      type: 2;
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
      accessList?: AccessList;
    });

export type EvmSwitchChainPayload = {
  chainId: number;
  /**
   * Chain the dApp session is on when the switch is requested, resolved
   * from the bridge ctx — NOT the home-screen active chain. The approval
   * sheet must render "From" off these fields so it stays isolated from
   * `useWallet()` state (same rule as intent.wallet).
   */
  fromChainId?: number;
  fromChainName?: string;
  /**
   * Display name of the target chain, stamped by the adapter from the
   * backend feed (registered chains) or `UserChainStore` (custom chains)
   * so the sheet never shows a bare "Chain 1". Same isolation rule as
   * `fromChainName`: resolved in the bridge, not from `useWallet()`.
   */
  toChainName?: string;
  /**
   * True when the target is a dApp-added custom network (present only in
   * `UserChainStore`, not the backend feed). The sheet uses this to show
   * an "unverified network" warning.
   */
  toIsCustom?: boolean;
};

export type EvmAddChainPayload = {
  chainId: number;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
  iconUrls?: string[];
};

export type EvmWatchAssetPayload =
  | {
      standard: "ERC20";
      address: `0x${string}`;
      symbol: string;
      decimals: number;
      image?: string;
      chainId: number;
    }
  | {
      standard: "ERC721" | "ERC1155";
      address: `0x${string}`;
      tokenId?: string;
      symbol?: string;
      image?: string;
      chainId: number;
    };

export type EvmBatchCallsPayload = {
  /**
   * What the dApp sent. `"1.0"` is the withdrawn draft, still accepted
   * on the request path for dApps that have not migrated; `"2.0.0"` is
   * the finalized EIP-5792. Responses are always emitted in 2.0.0 shape
   * regardless of this value — it is kept for the sheet and telemetry.
   */
  version: "1.0" | "2.0.0";
  chainId: number;
  from: `0x${string}`;
  /**
   * Set by the dApp to demand all-or-nothing execution. When true and
   * the wallet cannot guarantee atomicity, `wallet_sendCalls` rejects at
   * request time rather than silently falling back to sequential sends —
   * a partial batch can leave an approve mined with its swap reverted.
   */
  atomicRequired: boolean;
  calls: Array<{
    /** Absent for a contract-creation call. */
    to?: `0x${string}`;
    value?: bigint;
    data?: `0x${string}`;
    gas?: bigint;
    /**
     * EIP-5792 per-call capabilities. Carried so the required-capability
     * check (error 5700) sees a requirement declared on one call, not
     * only the batch-level object.
     */
    capabilities?: Record<string, unknown>;
  }>;
  capabilities?: Record<string, unknown>;
  /**
   * Per-call structural decode patched in by
   * `EvmCalldataDecoderInspector` — index-aligned with `calls`
   * (`null` where a call has no/undecodable data).
   */
  decodedCalls?: Array<DecodedCalldata | null>;
  /**
   * Per-call `approve`-target resolution, index-aligned with `calls` —
   * the batch counterpart of `EvmTxCommon.approveTarget` (spec phase L).
   * Present so a batched `approve` reaches the same risk variant a
   * standalone one does; `undefined` at an index means unresolved, which
   * renders as indeterminate rather than a guess.
   */
  approveTargets?: Array<ApproveTargetResolution | undefined>;
};

export type EvmAuthorizationPayload = {
  delegator: `0x${string}`;
  chainId: number;
  nonce: number;
  expiresAt?: number;
};

export type GasEstimate = {
  dApp: {
    gas?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    gasPrice?: bigint;
  };
  wallet: {
    gas: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    gasPrice?: bigint;
  };
  recommended: "wallet" | "dApp";
  rationale: string;
};

export type FeeSource = "native" | "sponsored" | { erc20: `0x${string}` };
