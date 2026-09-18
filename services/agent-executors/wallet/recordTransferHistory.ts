/**
 * `recordTransferHistory` — backend recording of a completed transfer so
 * the activity tab picks it up and the recipient gets their push.
 *
 * Thin adapter from the executor's chain-picker arguments onto the
 * transfer-record outbox (`services/transfers/transferRecordOutbox.ts`),
 * which is the same path `app/send.tsx` and `wallet/writes.ts` use.
 * Failure NEVER fails the executor — the tx is already on chain, the
 * user-facing card still works; the outbox retries later. Raw errors
 * never bubble to the user (CLAUDE.md).
 */

// NOTE: the outbox is imported dynamically so this helper's static
// import graph stays free of RN-only modules — the Vitest harness for
// `wallet/sui` can otherwise choke on the `react-native` Flow source
// pulled in transitively via `ky`. The dynamic import lands lazily at
// the first call, which always happens inside a real RN runtime where
// the modules resolve cleanly.
import type { TBlockchain } from "@/api/types/blockchain";
import type { TTransactionType } from "@/api/types/transaction";

export type RecordTransferArgs = {
  blockchains: TBlockchain[];
  /** "solana" | "sui" | "stellar" | EVM chain_id picker. */
  namespace: "solana" | "sui" | "stellar" | "eip155";
  /**
   * For EVM: the numeric chain id.
   * For Solana / Sui / Stellar: the chain slug (e.g. `solana-devnet`,
   * `stellar-testnet`) — when omitted the helper falls back to the
   * first blockchain in the list for that namespace.
   */
  chainId?: number;
  chainSlug?: string | null;
  /**
   * Token identifier. For native transfers leave `contractAddress`
   * undefined — the helper picks the chain's native token.
   */
  contractAddress?: string;
  type: TTransactionType;
  amount: string;
  txHash: string;
  fromAddress: string;
  toAddress: string;
};

function findBlockchain(args: RecordTransferArgs): TBlockchain | undefined {
  const { blockchains, namespace, chainId, chainSlug } = args;
  if (namespace === "eip155") {
    return blockchains.find((b) => b.isEVM && b.chainId === chainId);
  }
  // Solana / Sui / Stellar — prefer chainSlug match, fall back to
  // first matching non-EVM row by namespace prefix.
  if (chainSlug) {
    const exact = blockchains.find((b) => b.chainSlug === chainSlug);
    if (exact) return exact;
  }
  const prefix = `${namespace}-`;
  return blockchains.find(
    (b) => !b.isEVM && (b.chainSlug ?? "").startsWith(prefix),
  );
}

export async function recordTransferHistory(
  args: RecordTransferArgs,
): Promise<string | undefined> {
  try {
    const blockchain = findBlockchain(args);
    if (!blockchain) return undefined;

    let token:
      | { tokenId: string }
      | { contractAddress: string; blockchainId: string }
      | undefined;
    if (args.contractAddress) {
      token = {
        contractAddress: args.contractAddress,
        blockchainId: blockchain.id,
      };
    } else {
      const nativeId = blockchain.tokens?.find((t) => t.isNativeCurrency)?.id;
      if (nativeId) token = { tokenId: nativeId };
    }
    if (!token) return undefined;

    // Durable: persisted before it is posted, retried on foreground /
    // sign-in if this wallet has no session right now. The recipient's
    // push hangs off this record, so "best-effort once" was not enough.
    // Invalidation of the Activity tab happens inside the outbox on
    // success. Lazy import keeps this helper's static graph RN-free.
    const { recordTransfer } = await import(
      "@/services/transfers/transferRecordOutbox"
    );
    return await recordTransfer({
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      amount: args.amount,
      txHash: args.txHash,
      token,
      type: args.type === "PAYMENT" ? "PAYMENT" : "TRANSFER",
    });
  } catch (err) {
    if (__DEV__) {
      console.warn(
        "[recordTransferHistory] best-effort recording failed:",
        err,
      );
    }
    return undefined;
  }
}
