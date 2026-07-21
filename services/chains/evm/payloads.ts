import type { AccessList, TypedDataDefinition } from "viem";
import type { DecodedCalldata } from "@/services/decoders/calldata";

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
  typedData: TypedDataDefinition;
  address: `0x${string}`;
  method: "eth_signTypedData" | "eth_signTypedData_v3" | "eth_signTypedData_v4";
};

type EvmTxCommon = {
  to: `0x${string}`;
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
  version: "1.0";
  chainId: number;
  from: `0x${string}`;
  calls: Array<{
    to: `0x${string}`;
    value?: bigint;
    data?: `0x${string}`;
    gas?: bigint;
  }>;
  capabilities?: Record<string, unknown>;
  /**
   * Per-call structural decode patched in by
   * `EvmCalldataDecoderInspector` — index-aligned with `calls`
   * (`null` where a call has no/undecodable data).
   */
  decodedCalls?: Array<DecodedCalldata | null>;
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
