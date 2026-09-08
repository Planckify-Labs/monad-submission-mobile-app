/**
 * Solana-native mobile tool executors.
 *
 * Kept in a dedicated file so EVM executors stay untouched — parallel
 * surfaces rather than retrofitting viem-shaped tools with chain
 * dispatch. Each executor routes through `SolanaWalletKit` via the
 * `walletKitRegistry` so shared code stays chain-agnostic per the
 * space-docking rule (§4.5).
 *
 * Tools implemented here:
 *   - get_wallet_sol_balance  — connected wallet's SOL balance
 *   - get_sol_balance         — arbitrary Solana address balance
 *   - send_sol                — native SOL transfer
 *
 * The agent selects between these and the EVM siblings by reading
 * `wallet_context.namespace` — the tool descriptions on the server
 * spell this out (see `agent-api/src/tools/registry.ts`).
 */

import { formatUnits, parseUnits } from "viem";
import { portfolioApi } from "@/api/endpoints/portfolio";
import { tokenApi } from "@/api/endpoints/tokens";
import type { TToken } from "@/api/types/token";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { resolveNamespace } from "@/hooks/useWallet.helpers";
import { storage } from "@/lib/storage/mmkv";
import { walletKitRegistry } from "@/services/walletKit/registry";
import {
  type BalanceGroup,
  type BalanceTokenRow,
  toAgentSlice,
  type WalletBalancesPayload,
} from "../balancePayload";
import {
  ExecutorError,
  ExecutorErrorCode,
  type MobileToolExecutor,
  optionalString,
  requireString,
  safeExecute,
} from "../types";
import { recordTransferHistory } from "./recordTransferHistory";

const SOLANA_NAMESPACE = "solana" as const;

/**
 * Pull the currently-active chain from the same MMKV slot that
 * `useWallet` writes to. Executors can't read the React Query cache
 * directly, so we deserialize the persisted `ChainConfig` here.
 *
 * Narrow to Solana with a predictable error so callers that fire
 * while the active chain is EVM fail fast instead of crashing inside
 * the kit.
 */
function getActiveSolanaChain(): Extract<ChainConfig, { namespace: "solana" }> {
  const raw = storage.getString("active_chain");
  if (!raw) {
    throw new ExecutorError(
      ExecutorErrorCode.UnsupportedChain,
      "no_active_chain",
    );
  }
  const parsed = JSON.parse(raw) as ChainConfig;
  if (parsed.namespace !== SOLANA_NAMESPACE) {
    throw new ExecutorError(
      ExecutorErrorCode.UnsupportedChain,
      "active_chain_is_not_solana",
    );
  }
  return parsed;
}

function getSolanaKit() {
  if (!walletKitRegistry.has(SOLANA_NAMESPACE)) {
    throw new ExecutorError(
      ExecutorErrorCode.NotImplemented,
      "solana_kit_not_registered",
    );
  }
  return walletKitRegistry.get(SOLANA_NAMESPACE);
}

function requireSolanaAddress(value: string, key: string): string {
  const kit = getSolanaKit();
  if (!kit.validateAddress(value)) {
    throw new ExecutorError(ExecutorErrorCode.InvalidInput, `invalid_${key}`);
  }
  return value;
}

/**
 * Resolve the active Solana blockchain row from context — used to
 * pull the native token's logo / name / decimals so single-balance
 * cards render the SOL icon instead of the generic Coins fallback.
 */
function resolveSolanaNativeMeta(
  chain: Extract<ChainConfig, { namespace: "solana" }>,
  context: Parameters<MobileToolExecutor>[1],
): { symbol: string; name: string; decimals: number; logoUrl?: string } {
  const isTestnet = chain.cluster !== "mainnet-beta";
  const blockchain = context.blockchains.find(
    (b) =>
      resolveNamespace(b) === "solana" &&
      b.isActive &&
      b.isTestnet === isTestnet,
  );
  const nativeRow = blockchain?.tokens?.find((t) => t.isNativeCurrency);
  return {
    symbol: nativeRow?.symbol ?? "SOL",
    name: nativeRow?.name ?? "Solana",
    decimals: nativeRow?.decimals ?? 9,
    ...(nativeRow?.logoUrl ? { logoUrl: nativeRow.logoUrl } : {}),
  };
}

function singleSolanaNativePayload(
  chain: Extract<ChainConfig, { namespace: "solana" }>,
  native: ReturnType<typeof resolveSolanaNativeMeta>,
  lamports: bigint,
): WalletBalancesPayload {
  const tokenRow: BalanceTokenRow = {
    symbol: native.symbol,
    name: native.name,
    address: "",
    decimals: native.decimals,
    is_native: true,
    is_stable_coin: false,
    ...(native.logoUrl ? { logo_url: native.logoUrl } : {}),
    balance_raw: lamports.toString(),
    balance_display: formatUnits(lamports, native.decimals),
  };
  const clusterName =
    chain.cluster === "devnet" ? "Solana Devnet" : "Solana Mainnet";
  return {
    groups: [
      {
        namespace: "solana",
        chain_id: chain.cluster,
        chain_label: clusterName,
        chain_symbol: native.symbol,
        ...(native.logoUrl ? { chain_logo_url: native.logoUrl } : {}),
        tokens: [tokenRow],
      },
    ],
  };
}

/**
 * `get_wallet_sol_balance` — connected wallet's SOL balance on the
 * active Solana cluster. Returns raw lamports alongside a pre-
 * formatted human string so the LLM never has to divide by 1e9.
 */
export const getWalletSolBalance: MobileToolExecutor = (_input, context) =>
  safeExecute(async () => {
    const address = context.wallet?.address;
    if (!address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    if (context.wallet.namespace !== SOLANA_NAMESPACE) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_solana",
      );
    }
    const chain = getActiveSolanaChain();
    const kit = getSolanaKit();
    const lamports = await kit.getNativeBalance(address, chain);
    const native = resolveSolanaNativeMeta(chain, context);
    const display = singleSolanaNativePayload(chain, native, lamports);
    return {
      status: "success",
      data: toAgentSlice(display),
      display,
    };
  });

/**
 * `get_sol_balance` — SOL balance for an arbitrary address. Falls
 * back to the connected wallet when the agent omits `address`,
 * mirroring the EVM `get_balance` ergonomics.
 */
export const getSolBalance: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const kit = getSolanaKit();
    const chain = getActiveSolanaChain();

    const explicit = optionalString(input, "address");
    const address = explicit ?? context.wallet?.address;
    if (!address) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "missing_or_invalid_address",
      );
    }
    requireSolanaAddress(address, "address");

    const lamports = await kit.getNativeBalance(address, chain);
    const native = resolveSolanaNativeMeta(chain, context);
    const display = singleSolanaNativePayload(chain, native, lamports);
    return {
      status: "success",
      data: toAgentSlice(display),
      display,
    };
  });

/**
 * `send_sol` — native SOL transfer from the connected wallet. The
 * dispatcher gates on the approval sheet (`capability: "write"`)
 * before this runs, so by the time we're called the user has
 * confirmed. Returns the tx signature as `tx_hash` for symmetry with
 * EVM writes — the protocol field is chain-agnostic even though its
 * type hint is `0x${string}` on EVM.
 */
export const sendSol: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    if (!context.wallet?.address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    if (context.wallet.namespace !== SOLANA_NAMESPACE) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_solana",
      );
    }

    const to = requireString(input, "to");
    requireSolanaAddress(to, "to");

    const amountHuman = requireString(input, "amount_sol");
    const amountFloat = parseFloat(amountHuman);
    if (!Number.isFinite(amountFloat) || amountFloat <= 0) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "invalid_amount_sol",
      );
    }

    const kit = getSolanaKit();
    const chain = getActiveSolanaChain();
    const lamports = kit.parseNativeAmount(amountHuman, chain);
    const signature = await kit.sendNativeTransfer({
      wallet: context.wallet,
      to,
      amount: lamports,
      chain,
    });

    // Record history (best-effort) — mirrors send.tsx Solana path so
    // agent-driven transfers show up in the Activity tab alongside
    // UI-driven ones.
    const transaction_id = await recordTransferHistory({
      blockchains: context.blockchains,
      namespace: "solana",
      chainSlug: `solana-${chain.cluster}`,
      type: "TRANSFER",
      amount: lamports.toString(),
      txHash: signature,
      fromAddress: context.wallet.address,
      toAddress: to,
    });

    // NOTE: `tx_hash` is typed `0x${string}` and the server's
    // `toolResultPayloadSchema` validates it against a hex regex, so we
    // deliberately do NOT put the Solana base58 signature there. It
    // lives on `data.signature` instead — the pendingTxCard can branch
    // on tool name (`send_sol`) to render/link it correctly.
    return {
      status: "success",
      tx_confirmed: true,
      transaction_id,
      data: {
        signature,
        to,
        cluster: chain.cluster,
        amount_lamports: lamports.toString(),
        amount_sol: amountHuman,
      },
    };
  });

/**
 * `get_wallet_spl_tokens` — list SPL tokens for the active Solana cluster.
 * Solana counterpart to the EVM `get_wallet_tokens`. Loads the cached token
 * list (same MMKV cache), filters by the Solana blockchain's id, and
 * optionally resolves live on-chain balances via `kit.getTokenBalance`.
 * Native SOL is prepended as a pseudo-row (is_native: true) unless excluded.
 */
/**
 * Solana asset discovery is gated: the upstream provider lists Solana as
 * early access, and its DeFi/NFT coverage is still incomplete, so this stays
 * opt-in until that settles.
 */
const SOLANA_DISCOVERY_ENABLED =
  process.env.EXPO_PUBLIC_SOLANA_ASSET_DISCOVERY === "true";

/** Cap per call: each discovered mint costs a balance read below. */
const MAX_DISCOVERED_MINTS = 50;

/**
 * Held-but-uncatalogued SPL mints, shaped as catalogue rows so the existing
 * filter + balance-read path treats them identically. Identity only: the
 * balance still comes from the on-chain read.
 *
 * Base58 mint addresses are case-SIGNIFICANT, so they are compared and stored
 * verbatim — never lowercased.
 */
async function loadDiscoveredSplTokens(
  blockchainId: string,
  known: Set<string>,
): Promise<TToken[]> {
  try {
    const result = await portfolioApi.getDiscoveredAssets({
      chains: ["solana"],
    });
    const now = new Date().toISOString();
    const rows: TToken[] = [];
    for (const asset of result.data) {
      if (rows.length >= MAX_DISCOVERED_MINTS) break;
      if (asset.namespace !== "solana" || !asset.address) continue;
      if (known.has(asset.address)) continue;
      known.add(asset.address);
      rows.push({
        id: `discovered-${asset.address}`,
        name: asset.name,
        symbol: asset.symbol,
        decimals: asset.decimals,
        blockchainId,
        contractAddress: asset.address,
        logoUrl: asset.logoUrl,
        isStablecoin: false,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        isNativeCurrency: false,
      });
    }
    return rows;
  } catch (err) {
    if (__DEV__) {
      console.warn("[solana] token discovery unavailable", err);
    }
    return [];
  }
}

export const getSolanaWalletTokens: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const kit = getSolanaKit();
    const chain = getActiveSolanaChain();

    const walletAddress = context.wallet?.address;
    if (!walletAddress) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    if (context.wallet.namespace !== SOLANA_NAMESPACE) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_solana",
      );
    }

    // Match the Solana blockchain row the same way BalanceSection does:
    // filter by !isEVM AND isTestnet matching the active cluster so devnet
    // wallets don't accidentally query mainnet token mints (which would
    // cause getTokenBalance to return 0 for every token).
    const isTestnet = chain.cluster !== "mainnet-beta";
    const solanaBlockchain = context.blockchains.find(
      (b) =>
        resolveNamespace(b) === "solana" &&
        b.isActive &&
        b.isTestnet === isTestnet,
    );
    if (!solanaBlockchain) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "solana_blockchain_not_found_in_registry",
      );
    }

    // Load SPL tokens for this blockchain using the same search path the
    // send screen uses — tokenApi.searchTokens({ blockchainId }) — with a
    // per-blockchain MMKV cache so repeated calls within 5 minutes are free.
    const SPL_CACHE_KEY = `cached_spl_tokens_${solanaBlockchain.id}`;
    const SPL_CACHE_TS_KEY = `cached_spl_tokens_ts_${solanaBlockchain.id}`;
    const SPL_STALE_MS = 5 * 60 * 1000;

    let allTokens: TToken[];
    try {
      const cachedRaw = storage.getString(SPL_CACHE_KEY);
      const tsRaw = storage.getString(SPL_CACHE_TS_KEY);
      const ts = tsRaw ? parseInt(tsRaw, 10) : 0;
      if (cachedRaw && Date.now() - ts < SPL_STALE_MS) {
        const parsed = JSON.parse(cachedRaw);
        allTokens = Array.isArray(parsed) ? (parsed as TToken[]) : [];
      } else {
        allTokens = await tokenApi.searchTokens({
          blockchainId: solanaBlockchain.id,
          isActive: true,
        });
        storage.set(SPL_CACHE_KEY, JSON.stringify(allTokens));
        storage.set(SPL_CACHE_TS_KEY, Date.now().toString());
      }
    } catch (err) {
      // Offline fallback: serve stale cache if available.
      const cachedRaw = storage.getString(SPL_CACHE_KEY);
      if (cachedRaw) {
        try {
          const parsed = JSON.parse(cachedRaw);
          allTokens = Array.isArray(parsed) ? (parsed as TToken[]) : [];
        } catch {
          throw new ExecutorError(
            ExecutorErrorCode.NetworkError,
            `failed to fetch SPL token list: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        throw new ExecutorError(
          ExecutorErrorCode.NetworkError,
          `failed to fetch SPL token list: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Held-but-uncatalogued mints. Solana discovery is behind a flag because
    // the upstream provider still treats Solana as early access; when it is
    // off, this is exactly the catalogue-only behaviour that shipped before.
    if (SOLANA_DISCOVERY_ENABLED) {
      const known = new Set(
        allTokens
          .map((t) => t.contractAddress)
          .filter((a): a is string => Boolean(a)),
      );
      allTokens = [
        ...allTokens,
        ...(await loadDiscoveredSplTokens(solanaBlockchain.id, known)),
      ];
    }

    const symFilter =
      typeof input.symbol === "string" && input.symbol.length > 0
        ? input.symbol.toLowerCase()
        : null;

    const nativeToken = allTokens.find(
      (t) => t.isNativeCurrency && t.isActive !== false,
    );

    const splTokens = allTokens.filter((t) => {
      if (t.isActive === false) return false;
      if (t.isNativeCurrency) return false; // native handled separately
      if (
        typeof input.is_stable_coin === "boolean" &&
        t.isStablecoin !== input.is_stable_coin
      ) {
        return false;
      }
      if (symFilter) {
        const s = t.symbol.toLowerCase();
        if (s !== symFilter && !s.startsWith(symFilter)) return false;
      }
      return true;
    });

    const includeNative = input.is_native_currency !== false;
    const includeBalance = input.include_balance === true;

    // Resolve live SOL balance if needed.
    let solLamports: bigint | undefined;
    if (includeBalance) {
      try {
        solLamports = await kit.getNativeBalance(walletAddress, chain);
      } catch {
        // balance unavailable — omit fields but keep going
      }
    }

    // Build the token rows with optional live SPL balances.
    const splRows: BalanceTokenRow[] = await Promise.all(
      splTokens.map(async (t): Promise<BalanceTokenRow> => {
        let balance_display: string | undefined;
        let balance_raw: string | undefined;

        if (includeBalance && t.contractAddress) {
          try {
            const raw = await kit.getTokenBalance(
              walletAddress,
              chain,
              t.contractAddress,
            );
            balance_raw = raw.toString();
            balance_display = formatUnits(raw, t.decimals);
          } catch {
            // per-token failure — omit balance fields
          }
        }

        return {
          symbol: t.symbol,
          name: t.name,
          address: t.contractAddress ?? "",
          decimals: t.decimals,
          is_native: false,
          is_stable_coin: t.isStablecoin ?? false,
          ...(t.logoUrl ? { logo_url: t.logoUrl } : {}),
          ...(t.peggedCurrency ? { pegged_currency: t.peggedCurrency } : {}),
          ...(balance_raw !== undefined ? { balance_raw } : {}),
          ...(balance_display !== undefined ? { balance_display } : {}),
        };
      }),
    );

    // Prepend native SOL row.
    const nativeSymbol = nativeToken?.symbol ?? "SOL";
    const nativeName = nativeToken?.name ?? "Solana";
    const nativeDecimals = nativeToken?.decimals ?? 9;
    const nativePasses =
      !symFilter ||
      nativeSymbol.toLowerCase() === symFilter ||
      nativeSymbol.toLowerCase().startsWith(symFilter);
    const stablePasses = input.is_stable_coin !== true;

    const nativeRow: BalanceTokenRow | null =
      includeNative && nativePasses && stablePasses
        ? {
            symbol: nativeSymbol,
            name: nativeName,
            address: "",
            decimals: nativeDecimals,
            is_native: true,
            is_stable_coin: false,
            ...(nativeToken?.logoUrl ? { logo_url: nativeToken.logoUrl } : {}),
            ...(solLamports !== undefined
              ? {
                  balance_raw: solLamports.toString(),
                  balance_display: formatUnits(solLamports, nativeDecimals),
                }
              : {}),
          }
        : null;

    const tokens: BalanceTokenRow[] = nativeRow
      ? [nativeRow, ...splRows]
      : splRows;

    const clusterName =
      chain.cluster === "devnet" ? "Solana Devnet" : "Solana Mainnet";

    const group: BalanceGroup = {
      namespace: "solana",
      chain_id: chain.cluster,
      chain_label: clusterName,
      chain_symbol: nativeSymbol,
      ...(nativeToken?.logoUrl ? { chain_logo_url: nativeToken.logoUrl } : {}),
      tokens,
    };

    const display: WalletBalancesPayload = { groups: [group] };

    return {
      status: "success",
      data: toAgentSlice(display),
      display,
    };
  });

/**
 * `send_spl_token` — SPL token transfer (classic Token Program and
 * Token-2022) from the connected wallet. The kit's `sendTokenTransfer`
 * auto-detects the token program via the mint's on-chain account owner,
 * so no discriminator is needed here. Mirrors the `kit.sendTokenTransfer`
 * path in `app/send.tsx` for token transfers on Solana.
 */
export const sendSplToken: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    if (!context.wallet?.address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    if (context.wallet.namespace !== SOLANA_NAMESPACE) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_solana",
      );
    }

    const to = requireString(input, "to");
    requireSolanaAddress(to, "to");

    const mintAddress = requireString(input, "mint_address");
    requireSolanaAddress(mintAddress, "mint_address");

    const tokenAmountHuman = requireString(input, "token_amount");

    const rawDecimals = input.token_decimals;
    const decimals =
      typeof rawDecimals === "number"
        ? rawDecimals
        : parseInt(String(rawDecimals), 10);
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "invalid_token_decimals",
      );
    }

    let amountRaw: bigint;
    try {
      amountRaw = parseUnits(tokenAmountHuman, decimals);
    } catch {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "invalid_token_amount",
      );
    }
    if (amountRaw <= 0n) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "token_amount_must_be_positive",
      );
    }

    const kit = getSolanaKit();
    const chain = getActiveSolanaChain();
    const signature = await kit.sendTokenTransfer({
      wallet: context.wallet,
      to,
      amount: amountRaw,
      chain,
      contractAddress: mintAddress,
      decimals,
    });

    const transaction_id = await recordTransferHistory({
      blockchains: context.blockchains,
      namespace: "solana",
      chainSlug: `solana-${chain.cluster}`,
      contractAddress: mintAddress,
      type: "TRANSFER",
      amount: amountRaw.toString(),
      txHash: signature,
      fromAddress: context.wallet.address,
      toAddress: to,
    });

    return {
      status: "success",
      tx_confirmed: true,
      transaction_id,
      data: {
        signature,
        to,
        mint_address: mintAddress,
        cluster: chain.cluster,
        amount_raw: amountRaw.toString(),
        token_amount: tokenAmountHuman,
        decimals,
      },
    };
  });

export const SOLANA_EXECUTORS: Record<string, MobileToolExecutor> = {
  get_wallet_sol_balance: getWalletSolBalance,
  get_sol_balance: getSolBalance,
  send_sol: sendSol,
  get_wallet_spl_tokens: getSolanaWalletTokens,
  send_spl_token: sendSplToken,
};
