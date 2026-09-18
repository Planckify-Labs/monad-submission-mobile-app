/**
 * Monad chain facts the app needs at code level
 * (docs/monad-metropolis-2026-spec.md §1, §2.1, §4.1).
 *
 * Everything else about Monad (RPC, explorer, native token, the AUSD
 * token row) comes from the backend `/blockchains` + tokens feeds, same
 * as every other chain. This file exists for the one thing a feed
 * cannot express: a per-call-shape gas limit.
 *
 * Monad bills `gas_bid * gas_limit`, not `gas_used`
 * (docs.monad.xyz/developer-essentials/gas-pricing). An estimate-then-pad
 * fallback therefore overcharges the user for gas that is never used.
 * For the one call shape the remittance flow makes — AUSD `transfer` on
 * mainnet — we pin a known-good limit instead of estimating at all.
 *
 * Measured live against the public Monad RPC on 2026-09-16 with
 * `eth_estimateGas` from a real AUSD holder:
 *   - transfer to a cold recipient (new balance slot): 72,918 gas
 *   - transfer to a warm recipient:                    55,850 gas
 * 80,000 covers the cold case with ~10% headroom; at the ~102 gwei
 * observed gas price that is ~0.008 MON per send.
 *
 * Any other token / chain pair returns `undefined` so the caller keeps
 * viem's default (a plain `eth_estimateGas`, which viem does NOT pad).
 */

export const MONAD_MAINNET_CHAIN_ID = 143;
export const MONAD_TESTNET_CHAIN_ID = 10143;

/** Agora AUSD on Monad mainnet — verified on-chain (spec §2.1). */
export const AUSD_MONAD_MAINNET_ADDRESS =
  "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" as const;

const AUSD_MONAD_TRANSFER_GAS_LIMIT = 80_000n;

export function isMonadChainId(chainId: number | undefined | null): boolean {
  return (
    chainId === MONAD_MAINNET_CHAIN_ID || chainId === MONAD_TESTNET_CHAIN_ID
  );
}

export type FixedTransferGasParams = {
  chainId: number;
  contractAddress: string;
};

/**
 * Pinned gas limit for a known ERC-20 `transfer` call shape, or
 * `undefined` to let the client estimate.
 */
export function fixedErc20TransferGasLimit({
  chainId,
  contractAddress,
}: FixedTransferGasParams): bigint | undefined {
  if (
    chainId === MONAD_MAINNET_CHAIN_ID &&
    contractAddress.toLowerCase() === AUSD_MONAD_MAINNET_ADDRESS.toLowerCase()
  ) {
    return AUSD_MONAD_TRANSFER_GAS_LIMIT;
  }
  return undefined;
}
