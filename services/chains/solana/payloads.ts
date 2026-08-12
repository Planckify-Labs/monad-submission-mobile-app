// Per solana-adapter-spec.md §4.3.

export type SolanaCluster = "mainnet-beta" | "devnet" | "testnet";

/**
 * Wallet Standard `chain` identifiers accepted on the wire. Short form
 * is primary; genesis-hash form is accepted from legacy dApps and
 * normalised via `canonicalizeChain`.
 */
export type SolanaChain =
  | "solana:mainnet"
  | "solana:devnet"
  | "solana:testnet"
  | "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
  | "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
  | "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";

const CHAIN_GENESIS_TO_SHORT: Record<string, SolanaChain> = {
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "solana:mainnet",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "solana:devnet",
  "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z": "solana:testnet",
};

const SHORT_CHAINS = new Set<SolanaChain>([
  "solana:mainnet",
  "solana:devnet",
  "solana:testnet",
]);

/** Normalise a dApp-supplied chain identifier to the canonical short form. */
export function canonicalizeChain(input: string): SolanaChain {
  if (SHORT_CHAINS.has(input as SolanaChain)) return input as SolanaChain;
  const mapped = CHAIN_GENESIS_TO_SHORT[input];
  if (mapped) return mapped;
  const err = new Error(`invalid Solana chain identifier: ${input}`);
  (err as Error & { code?: number }).code = -32602;
  throw err;
}

/** Convert short-form SolanaChain to SolanaCluster for internal RPC routing. */
export function chainToCluster(chain: SolanaChain): SolanaCluster {
  const short = SHORT_CHAINS.has(chain) ? chain : CHAIN_GENESIS_TO_SHORT[chain];
  switch (short) {
    case "solana:mainnet":
      return "mainnet-beta";
    case "solana:devnet":
      return "devnet";
    case "solana:testnet":
      return "testnet";
    default: {
      const err = new Error(`invalid Solana chain identifier: ${chain}`);
      (err as Error & { code?: number }).code = -32602;
      throw err;
    }
  }
}

/** Convert a SolanaCluster to the canonical short-form SolanaChain. */
export function clusterToChain(cluster: SolanaCluster): SolanaChain {
  switch (cluster) {
    case "mainnet-beta":
      return "solana:mainnet";
    case "devnet":
      return "solana:devnet";
    case "testnet":
      return "solana:testnet";
  }
}

export type SolanaConnectPayload = {
  cluster: SolanaCluster;
  onlyIfTrusted: boolean;
};

/** Sign In With Solana — EIP-4361-derived. */
export type SolanaSignInPayload = {
  domain: string;
  address?: string;
  statement?: string;
  uri?: string;
  version?: "1";
  chainId?: SolanaCluster;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
};

export type SolanaSignMessagePayload = {
  address: string;
  message: string;
  display: "utf8" | "base64";
};

export type SolanaTxVersion = "legacy" | 0;

export type SolanaSendOptions = {
  commitment?: "processed" | "confirmed" | "finalized";
  skipPreflight?: boolean;
  maxRetries?: number;
  preflightCommitment?: "processed" | "confirmed" | "finalized";
  minContextSlot?: number;
};

export type SolanaSimulationWarning =
  | { code: "writable.system-program"; program: string }
  | { code: "writable.unknown-program"; program: string }
  | { code: "nonce.authority-mismatch"; expected: string; got: string }
  | {
      code: "lookup-table.expanded";
      table: string;
      addedAccounts: number;
    }
  | { code: "token2022.transfer-fee"; mint: string; basisPoints: number }
  | {
      code: "token2022.permanent-delegate";
      mint: string;
      delegate: string;
    }
  | {
      code: "token2022.confidential-transfer-pending-balance";
      mint: string;
    }
  | {
      code: "ata.close-authority-change";
      ata: string;
      newAuthority: string;
    }
  | { code: "setAuthority"; account: string; to: string };

export type SolanaSimulationSummary = {
  unitsConsumed?: number;
  balanceChanges: Array<{ address: string; lamportsDelta: bigint }>;
  tokenChanges: Array<{
    owner: string;
    mint: string;
    decimals: number;
    rawDelta: bigint;
    uiDelta: string;
    tokenProgram: "spl-token" | "token-2022";
  }>;
  warnings: SolanaSimulationWarning[];
  logs: string[];
};

export type SolanaDecodedInstruction =
  | {
      program: "system";
      kind: "transfer" | "advanceNonce" | "createAccount";
      data: unknown;
    }
  | { program: "spl-token" | "token-2022"; kind: string; data: unknown }
  | {
      program: "compute-budget";
      kind: "setComputeUnitLimit" | "setComputeUnitPrice";
      value: number | bigint;
    }
  | { program: "memo"; data: string }
  | {
      program: string;
      kind: string;
      programName?: string;
      data?: unknown;
      /**
       * Hand-written label/value rows a decoder wants shown. Generic on
       * purpose: a new program decoder surfaces detail by filling these
       * in, without the approval sheet learning the program.
       */
      fields?: Array<{ label: string; value: string }>;
      /**
       * Set by a decoder when the instruction grants standing authority
       * over the user's assets, or replaces something already live.
       * `SolanaProgramDecoderInspector` turns this into a sheet banner
       * without knowing which program produced it, so declaring risk is
       * all a newly docked decoder has to do.
       */
      risk?: {
        severity: "warn";
        /** Hand-written heading. */
        title: string;
        /** Hand-written explanation. Never raw instruction data. */
        detail: string;
      };
    };

export interface SolanaAltReference {
  tableAddress: string;
  writableIndexes: number[];
  readonlyIndexes: number[];
}

export interface SolanaDurableNonceInfo {
  isDurableNonce: boolean;
  nonceAccount?: string;
  authority?: string;
}

export type SolanaSignTxPayload = {
  mode: "sign-only" | "sign-and-send";
  address: string;
  cluster: SolanaCluster;
  version: SolanaTxVersion;
  /** base64 wire-format tx — primary source of truth. */
  transaction: string;
  options?: SolanaSendOptions;
  simulation?: SolanaSimulationSummary;
  decoded?: SolanaDecodedInstruction[];
  /**
   * Structural fields populated by `SolanaProgramDecoderInspector`
   * for the sheet + the Takumi-AI on-demand inspector.
   */
  feePayer?: string;
  /**
   * Raw parsed instructions (index-aligned with `decoded`) — task 65
   * (TWV-2026-066): the Stage-2 on-chain-IDL resolver needs the
   * original instruction bytes, which the decoded view drops.
   */
  rawInstructions?: Array<{
    programId: string;
    accounts: string[];
    data: Uint8Array | string;
  }>;
  signerAddresses?: string[];
  writableAddresses?: string[];
  accountKeys?: string[];
  altReferences?: SolanaAltReference[];
  durableNonce?: SolanaDurableNonceInfo;
};

export type SolanaSignAllTransactionsPayload = {
  address: string;
  cluster: SolanaCluster;
  transactions: Array<{
    transaction: string;
    version: SolanaTxVersion;
    simulation?: SolanaSimulationSummary;
    decoded?: SolanaDecodedInstruction[];
  }>;
};

export type SolanaSwitchClusterPayload = {
  from: SolanaCluster;
  to: SolanaCluster;
};

export type SolanaWatchTokenPayload = {
  mint: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  image?: string;
  tokenStandard?: "spl-token" | "token-2022" | "metaplex-nft" | "metaplex-cnft";
  verified?: {
    mintOwner: "spl-token" | "token-2022";
    extensions?: string[];
  };
};

export type SolanaApprovalPayload =
  | ({ kind: "connect" } & SolanaConnectPayload)
  | ({ kind: "signIn" } & SolanaSignInPayload)
  | ({ kind: "signMessage" } & SolanaSignMessagePayload)
  | ({ kind: "signTransaction" } & SolanaSignTxPayload)
  | ({ kind: "signAllTransactions" } & SolanaSignAllTransactionsPayload)
  | ({ kind: "switchCluster" } & SolanaSwitchClusterPayload)
  | ({ kind: "watchAsset" } & SolanaWatchTokenPayload);
