/**
 * Read-only mobile tool executors.
 *
 * None of these require a signer — they all use the `publicClient`
 * from `chainRouter.resolveChainClients`. The agent protocol treats
 * these as `capability: "read"` tools: they are silent (no approval
 * UX) and may be emitted in parallel across different chain_ids.
 *
 * Tools implemented here:
 *   - get_balance            — arbitrary address balance lookup
 *   - get_wallet_balance     — connected wallet's own balance
 *   - read_contract          — view/pure contract call
 *   - get_transaction        — fetch tx receipt by hash
 *   - get_wallet_address     — return connected wallet address
 *   - get_supported_chains   — enumerate mobile's chain registry
 *   - get_wallet_tokens      — list wallet's known tokens (with optional balances)
 */

import { type Abi, erc20Abi, formatUnits } from "viem";
import { blockchainApi } from "@/api/endpoints/blockchains";
import { portfolioApi } from "@/api/endpoints/portfolio";
import { tokenApi } from "@/api/endpoints/tokens";
import type { TBlockchain } from "@/api/types/blockchain";
import type { TToken } from "@/api/types/token";
import { resolveNamespace } from "@/hooks/useWallet.helpers";
import { storage } from "@/lib/storage/mmkv";
import { pendingTxStore } from "../../pendingTxStore";
import {
  type BalanceGroup,
  type BalanceTokenRow,
  type GroupError,
  toAgentSlice,
  type WalletBalancesPayload,
} from "../balancePayload";
import { resolveChainClients } from "../chainRouter";
import {
  ExecutorError,
  ExecutorErrorCode,
  type MobileToolExecutor,
  requireAddress,
  requireString,
  requireTxHash,
  resolveChainId,
  safeExecute,
} from "../types";

/**
 * Resolve the native currency metadata (symbol, name, decimals) for a
 * given chainId from the app-wide blockchain cache. Returns sensible
 * EVM defaults if the chain isn't in the cache or the cache is missing
 * the native row — the balance value is still usable, just with a
 * generic "ETH / 18" label.
 *
 * Native-currency metadata is needed by `get_balance` / `get_wallet_balance`
 * so they can return a pre-formatted `balance_display` string alongside
 * the raw wei — the LLM is unreliable at big-number arithmetic and will
 * slip decimal places if asked to convert wei → ETH itself.
 */
function resolveNativeCurrency(
  chainId: number,
  context: Parameters<MobileToolExecutor>[1],
): {
  symbol: string;
  name: string;
  decimals: number;
  logoUrl?: string;
  chainLabel: string;
} {
  const chain = context.blockchains.find(
    (b) => b.chainId === chainId && b.isEVM,
  );
  const nativeRow = chain?.tokens?.find((t) => t.isNativeCurrency);
  return {
    symbol: nativeRow?.symbol ?? "ETH",
    name: nativeRow?.name ?? chain?.name ?? "Ether",
    decimals: nativeRow?.decimals ?? 18,
    ...(nativeRow?.logoUrl ? { logoUrl: nativeRow.logoUrl } : {}),
    chainLabel: chain?.name ?? `Chain ${chainId}`,
  };
}

/**
 * Build a one-group / one-native-row `WalletBalancesPayload` for the
 * single-balance read tools (`get_balance`, `get_wallet_balance`).
 * Extracted so both executors emit the byte-identical shape the
 * `BalancesCard` consumes.
 */
function singleEvmNativePayload(
  chainId: number,
  native: ReturnType<typeof resolveNativeCurrency>,
  balance: bigint,
): WalletBalancesPayload {
  const tokenRow: BalanceTokenRow = {
    symbol: native.symbol,
    name: native.name,
    address: "0x0000000000000000000000000000000000000000",
    decimals: native.decimals,
    is_native: true,
    is_stable_coin: false,
    ...(native.logoUrl ? { logo_url: native.logoUrl } : {}),
    balance_raw: balance.toString(),
    balance_display: formatUnits(balance, native.decimals),
  };
  return {
    groups: [
      {
        namespace: "evm",
        chain_id: chainId,
        chain_label: native.chainLabel,
        chain_symbol: native.symbol,
        ...(native.logoUrl ? { chain_logo_url: native.logoUrl } : {}),
        tokens: [tokenRow],
      },
    ],
  };
}

/**
 * `get_balance` — native token balance for an arbitrary address on a
 * specific chain. The server passes `{ address, chain_id }`.
 *
 * Returns `balance_wei` + a pre-formatted `balance_display` so the
 * agent never has to do wei→ETH arithmetic itself (LLMs slip decimal
 * places on 18-digit divisions — that's the root cause of the
 * "0.2833 ETH instead of 0.000283 ETH" bug).
 */
export const getBalance: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const chainId = resolveChainId(input, context);
    const address = requireAddress(input, "address");
    const { publicClient } = resolveChainClients(chainId, context);
    const balance = await publicClient.getBalance({ address });
    const native = resolveNativeCurrency(chainId, context);
    const display = singleEvmNativePayload(chainId, native, balance);
    return {
      status: "success",
      data: toAgentSlice(display),
      display,
    };
  });

/**
 * `get_wallet_balance` — connected wallet's own native token balance on
 * the requested chain. Server input: `{ chain_id }` (address comes from
 * the wallet context).
 *
 * Returns a pre-formatted `balance_display` alongside raw `balance_wei`
 * for the same reason as `get_balance`: the LLM must not be asked to
 * divide an 18-digit integer in its head.
 */
export const getWalletBalance: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    if (context.wallet.namespace !== "eip155") {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_evm",
      );
    }
    const chainId = resolveChainId(input, context);
    const address = context.wallet.address as `0x${string}`;
    if (!address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    const { publicClient } = resolveChainClients(chainId, context);
    const balance = await publicClient.getBalance({ address });
    const native = resolveNativeCurrency(chainId, context);
    const display = singleEvmNativePayload(chainId, native, balance);
    return {
      status: "success",
      data: toAgentSlice(display),
      display,
    };
  });

/**
 * `read_contract` — generic view/pure call. Server sends:
 *   { chain_id, contract_address, abi, function_name, args? }
 */
export const readContract: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const chainId = resolveChainId(input, context);
    const contractAddress = requireAddress(input, "contract_address");
    const functionName = requireString(input, "function_name");
    const abi = input.abi;
    if (!Array.isArray(abi)) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "missing_or_invalid_abi",
      );
    }
    const args = Array.isArray(input.args) ? (input.args as unknown[]) : [];

    const { publicClient } = resolveChainClients(chainId, context);
    const result = await publicClient.readContract({
      address: contractAddress,
      abi: abi as Abi,
      functionName,
      args,
    });

    return {
      status: "success",
      data: {
        chain_id: chainId,
        contract_address: contractAddress,
        function_name: functionName,
        // viem may return bigint / nested bigints — JSON.stringify with
        // a bigint replacer so the SSE dispatcher can forward this.
        result: safeSerialize(result),
      },
    };
  });

/**
 * `get_transaction` — fetch a tx receipt by hash. Server input:
 *   { chain_id, tx_hash }
 *
 * Returns partial info if the tx is still pending (receipt missing).
 */
export const getTransaction: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const chainId = resolveChainId(input, context);
    const hash = requireTxHash(input, "tx_hash");
    const { publicClient } = resolveChainClients(chainId, context);

    // Try the receipt first — if it's missing, fall back to the tx
    // object so the agent can at least report "pending".
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });

      // --- Task 15: flip the matching pending card ------------------
      // Per AGENT_PROTOCOL.md §1, confirmation is a read-path fact,
      // not a write-path one. This is the single place the mobile
      // decides a tx is confirmed / reverted. Unknown hashes are a
      // no-op inside the store, so fetching a receipt for a tx the
      // store never saw does not crash.
      if (receipt.status === "success") {
        pendingTxStore.markConfirmed(hash, Number(receipt.blockNumber));
      } else {
        // viem reports reverted receipts as `status: "reverted"`.
        // The error string is the literal the spec calls out.
        pendingTxStore.markFailed(hash, "Transaction reverted");
      }

      // Pre-format the total gas fee so the agent can report it as
      // "fee: 0.00042 ETH" instead of doing 18-digit division in its
      // head. viem receipts expose `effectiveGasPrice` (in wei) — the
      // total fee in wei is `gas_used × effective_gas_price`.
      const native = resolveNativeCurrency(chainId, context);
      const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;

      return {
        status: "success",
        tx_hash: hash,
        tx_confirmed: true,
        data: {
          chain_id: chainId,
          status: receipt.status,
          block_number: receipt.blockNumber.toString(),
          gas_used: receipt.gasUsed.toString(),
          effective_gas_price_wei: receipt.effectiveGasPrice.toString(),
          fee_wei: feeWei.toString(),
          fee_display: formatUnits(feeWei, native.decimals),
          decimals: native.decimals,
          symbol: native.symbol,
          from: receipt.from,
          to: receipt.to,
        },
      };
    } catch {
      const tx = await publicClient.getTransaction({ hash });
      // Pre-format the native-currency transfer value. Same rule:
      // never hand raw wei to the LLM when we have the decimals.
      const native = resolveNativeCurrency(chainId, context);
      return {
        status: "success",
        tx_hash: hash,
        tx_confirmed: false,
        data: {
          chain_id: chainId,
          pending: true,
          from: tx.from,
          to: tx.to,
          value_wei: tx.value.toString(),
          value_display: formatUnits(tx.value, native.decimals),
          decimals: native.decimals,
          symbol: native.symbol,
        },
      };
    }
  });

/**
 * `get_wallet_address` — returns the connected wallet address. Does not
 * touch the chain, so `chain_id` is optional here.
 */
export const getWalletAddress: MobileToolExecutor = (_input, context) =>
  safeExecute(async () => {
    const address = context.wallet.address;
    if (!address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    return {
      status: "success",
      data: { address },
    };
  });

/**
 * `get_supported_chains` — enumerate the mobile's chain registry so the
 * agent can fan out cross-chain reads (protocol §3) and pick the right
 * namespace-specific tools for the connected wallet.
 *
 * Surfaces both EVM and non-EVM (Solana) rows from the live
 * `blockchains` list. Each entry is tagged with `namespace` so the
 * agent can distinguish — EVM rows carry `chain_id` (numeric, EIP-155),
 * non-EVM rows carry `caip2_id` instead. Solana has no numeric chainId,
 * so we never fabricate one (see `feedback_solana_no_chain_id`).
 *
 * `wallet_namespace` echoes the connected wallet's namespace so the
 * agent can immediately filter to compatible tools without a second
 * round-trip.
 */
export const getSupportedChains: MobileToolExecutor = (_input, context) =>
  safeExecute(async () => {
    const rows: TBlockchain[] = context.blockchains.filter((b) => b.isActive);

    const chains = rows.map((row) => {
      // The chain-level `nativeCurrency` field is the authoritative
      // source; the legacy path is the token row flagged `isNativeCurrency`.
      // Active chains are always seeded with their native token, so we
      // trust the invariant and read whichever source is present.
      const native =
        row.nativeCurrency ?? row.tokens?.find((t) => t.isNativeCurrency);

      const namespace = resolveNamespace(row);
      const base = {
        name: row.name,
        namespace,
        is_testnet: row.isTestnet,
        rpc_url: row.rpcUrl,
        block_explorer: row.blockExplorer || null,
        native_symbol: native?.symbol,
        native_decimals: native?.decimals,
      };
      if (namespace === "eip155" && typeof row.chainId === "number") {
        return { ...base, chain_id: row.chainId };
      }
      return { ...base, caip2_id: row.caip2Id ?? null };
    });

    return {
      status: "success",
      data: { chains, wallet_namespace: context.wallet.namespace },
    };
  });

/**
 * `get_wallet_tokens` — return the list of tokens the wallet knows about
 * for a given chain (from the live `TBlockchain.tokens[]` registry
 * surfaced via `ExecutorContext.blockchains`). Optionally filters by
 * symbol / stablecoin / native flag and optionally fetches live on-chain
 * balances via the same public client used by `get_balance`.
 *
 * Per protocol §4, the native currency (ETH, MATIC, BNB, …) is returned
 * as a pseudo-token with `address = 0x0000…` and `is_native = true`
 * unless `is_native_currency: false` is passed. This lets one call
 * answer "what are all my token balances including ETH?" without a
 * separate `get_wallet_balance`.
 */
/**
 * Internal shape the executor operates on before projecting to the
 * wire-format row. Keeps native and ERC20 rows uniform so filters /
 * balance fetch only have one code path.
 */
interface NormalizedToken {
  token_id?: string;
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  is_native: boolean;
  is_stable_coin: boolean;
  logo_url?: string;
  pegged_currency?: string;
  /**
   * True when this row came from wallet discovery rather than the curated
   * catalogue. Surfaced so the model can caveat it: nobody has vetted the
   * token, only observed that the wallet touches it.
   */
  is_discovered?: boolean;
}

const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as `0x${string}`;

/**
 * Resolve `chainId` → backend `TBlockchain` row so we can read the
 * native currency row (which `/blockchains` eagerly includes) and grab
 * the backend `blockchain.id` UUID for filtering the token list.
 *
 * CACHE-FIRST: `context.blockchains` is the app-wide blockchain cache
 * populated by `useBlockchainsWithStorage` (24h TTL + 5-min background
 * refresh). Always prefer it. Only fall back to a live API lookup if
 * the chain isn't in the cache — same cache-first pattern the rest of
 * the app uses. A live fetch per tool call would be pure waste.
 */
async function resolveBlockchain(
  chainId: number,
  context: Parameters<MobileToolExecutor>[1],
): Promise<TBlockchain | undefined> {
  const cached = context.blockchains.find(
    (b) => b.chainId === chainId && b.isEVM,
  );
  if (cached) return cached;

  // Cache miss — fall back to a live API lookup. This happens when
  // the user has just added a chain that the background refresh
  // hasn't picked up yet.
  try {
    const fresh = await blockchainApi.searchBlockchains({
      chainId,
      isActive: true,
    });
    return fresh.find((b) => b.chainId === chainId && b.isEVM);
  } catch {
    return undefined;
  }
}

// ---- MMKV-cached token list loaders --------------------------------
// `loadCachedTokens` (bare list, all chains) is kept for callers that
// genuinely want the full catalogue (e.g. `points.ts` redemption tool).
// For per-chain reads, prefer `loadCachedTokensForChain(blockchainId)`
// which fans out via the server-filtered search endpoint — the bare
// `/tokens` list is paginated and silently drops tokens past its
// cutoff, so client-side `blockchainId` filtering on it can return an
// incomplete view (Arbitrum USDT was the symptom that exposed this).
// The Solana executor (`solana.ts::getSolanaWalletTokens`) follows the
// same per-chain caching pattern.
const TOKEN_STORAGE_KEY = "cached_tokens";
const TOKEN_TIMESTAMP_KEY = "cached_tokens_timestamp";
const TOKEN_STALE_TIME = 5 * 60 * 1000; // 5 min — mirrors useTokens

export async function loadCachedTokens(): Promise<TToken[]> {
  const cachedRaw = storage.getString(TOKEN_STORAGE_KEY);
  const timestampStr = storage.getString(TOKEN_TIMESTAMP_KEY);
  const now = Date.now();
  const timestamp = timestampStr ? parseInt(timestampStr, 10) : 0;

  // Fast path: cache is fresh (< 5 min) — no network call.
  if (cachedRaw && now - timestamp < TOKEN_STALE_TIME) {
    try {
      const parsed = JSON.parse(cachedRaw);
      if (Array.isArray(parsed)) return parsed as TToken[];
    } catch {
      // Corrupt cache — fall through and refetch.
    }
  }

  // Cache is stale, missing, or corrupt — fetch fresh and write back.
  try {
    const fresh = await tokenApi.getTokenList();
    storage.set(TOKEN_STORAGE_KEY, JSON.stringify(fresh));
    storage.set(TOKEN_TIMESTAMP_KEY, Date.now().toString());
    return fresh;
  } catch (err) {
    // Offline fallback: serve any cached data regardless of age, same
    // as `useTokens` does on API failure.
    if (cachedRaw) {
      try {
        const parsed = JSON.parse(cachedRaw);
        if (Array.isArray(parsed)) return parsed as TToken[];
      } catch {
        // fall through to throw
      }
    }
    throw err;
  }
}

async function loadCachedTokensForChain(
  blockchainId: string,
): Promise<TToken[]> {
  const KEY = `cached_tokens_${blockchainId}`;
  const TS_KEY = `cached_tokens_${blockchainId}_ts`;
  const cachedRaw = storage.getString(KEY);
  const tsRaw = storage.getString(TS_KEY);
  const now = Date.now();
  const ts = tsRaw ? parseInt(tsRaw, 10) : 0;

  if (cachedRaw && now - ts < TOKEN_STALE_TIME) {
    try {
      const parsed = JSON.parse(cachedRaw);
      if (Array.isArray(parsed)) return parsed as TToken[];
    } catch {}
  }

  try {
    const fresh = await tokenApi.searchTokens({ blockchainId, isActive: true });
    storage.set(KEY, JSON.stringify(fresh));
    storage.set(TS_KEY, Date.now().toString());
    return fresh;
  } catch (err) {
    if (cachedRaw) {
      try {
        const parsed = JSON.parse(cachedRaw);
        if (Array.isArray(parsed)) return parsed as TToken[];
      } catch {}
    }
    throw err;
  }
}

/**
 * Cap on discovered rows per chain. Each one costs a `balanceOf` in the scan
 * below, so an airdrop-spammed wallet must not be able to turn one question
 * into hundreds of RPC reads.
 */
const MAX_DISCOVERED_PER_CHAIN = 50;

/**
 * Held-but-uncatalogued tokens for this chain, as `NormalizedToken` rows.
 *
 * Identity only — the balance still comes from the on-chain read below, same
 * as every catalogued row. Best-effort: discovery failing just means the
 * agent sees the catalogue, which is what it saw before this existed.
 */
async function loadDiscoveredTokensForChain(
  chainId: number,
  known: Set<string>,
): Promise<NormalizedToken[]> {
  try {
    const result = await portfolioApi.getDiscoveredAssets({
      chains: [chainId],
    });
    const rows: NormalizedToken[] = [];
    for (const asset of result.data) {
      if (rows.length >= MAX_DISCOVERED_PER_CHAIN) break;
      // Native is added separately, and non-EVM rows can't be read by the
      // EVM scan that consumes this.
      if (!asset.address || asset.namespace !== "eip155") continue;
      const address = asset.address.toLowerCase();
      if (known.has(address)) continue;
      known.add(address);
      rows.push({
        symbol: asset.symbol,
        name: asset.name,
        address: address as `0x${string}`,
        decimals: asset.decimals,
        is_native: false,
        is_stable_coin: false,
        logo_url: asset.logoUrl || undefined,
        is_discovered: true,
      });
    }
    return rows;
  } catch (err) {
    if (__DEV__) {
      console.warn("[reads] token discovery unavailable", err);
    }
    return [];
  }
}

/**
 * Run the full single-chain token scan for one chainId and return the
 * wire-format `{ chain_id, tokens }` pair. Extracted so multi-chain
 * (`chain_ids: [...]`) calls can fan out in parallel with `Promise.all`.
 */
async function scanChainTokens(
  chainId: number,
  input: Parameters<MobileToolExecutor>[0],
  context: Parameters<MobileToolExecutor>[1],
): Promise<BalanceGroup> {
  // Resolve chainId → backend blockchain row. We need this for two
  // reasons: (a) to grab the native currency row (the /blockchains
  // endpoint eagerly includes only isNativeCurrency=true rows), and
  // (b) to get the backend `blockchain.id` UUID so we can client-side
  // filter the token list by blockchainId — the same pattern
  // `app/send.tsx` uses via `useTokens({ blockchainId })`.
  const blockchain = await resolveBlockchain(chainId, context);
  if (!blockchain) {
    throw new ExecutorError(
      ExecutorErrorCode.UnsupportedChain,
      `chain_id ${chainId} is not supported by this wallet`,
    );
  }

  const includeNative = input.is_native_currency !== false; // default true

  // ---- Native row comes from /blockchains eager include ------------
  const nativeRow = (blockchain.tokens ?? []).find((t) => t.isNativeCurrency);

  // ---- ERC20 rows come from the per-chain server-filtered search
  //      (`tokens/search?blockchainId=…&isActive=true`). The unfiltered
  //      `/tokens` endpoint is paginated server-side and silently drops
  //      tokens past its cutoff, so chains whose tokens fall outside
  //      the first page (Arbitrum was the symptom — USDT was cut)
  //      ended up missing entries. Per-chain search returns the full
  //      list for the requested blockchain. Cache key is per-chain so
  //      switching wallets/chains doesn't invalidate every chain's
  //      cache at once.
  let chainTokens: TToken[] = [];
  try {
    chainTokens = await loadCachedTokensForChain(blockchain.id);
  } catch (err) {
    throw new ExecutorError(
      ExecutorErrorCode.NetworkError,
      `failed to fetch token list for chain_id ${chainId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // The server already filtered by `blockchainId` + `isActive: true`.
  // Local pass only handles native exclusion + symbol / stablecoin
  // filters from the tool input.
  const symFilter =
    typeof input.symbol === "string" && input.symbol.length > 0
      ? input.symbol.toLowerCase()
      : null;

  const erc20Rows: TToken[] = chainTokens.filter((t) => {
    if (t.isNativeCurrency) return false;
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

  // ---- Normalize + optionally prepend native -----------------------
  let tokens: NormalizedToken[] = erc20Rows.map((t) => ({
    token_id: t.id,
    symbol: t.symbol,
    name: t.name,
    address: (t.contractAddress || ZERO_ADDRESS) as `0x${string}`,
    decimals: t.decimals,
    is_native: false,
    is_stable_coin: t.isStablecoin ?? false,
    logo_url: t.logoUrl || undefined,
    pegged_currency: t.peggedCurrency ?? undefined,
  }));

  // Held-but-uncatalogued tokens extend the list the balance fan-out below
  // already works through. The catalogue stays the source of truth for known
  // tokens; this only stops a held token from being invisible because nobody
  // registered it.
  const discovered = await loadDiscoveredTokensForChain(
    chainId,
    new Set(tokens.map((t) => t.address.toLowerCase())),
  );
  if (discovered.length > 0) {
    const passesFilters = (t: NormalizedToken) => {
      // Discovery carries no stablecoin flag, so an explicit
      // `is_stable_coin` request can only be answered from the catalogue.
      if (typeof input.is_stable_coin === "boolean") return false;
      if (!symFilter) return true;
      const s = t.symbol.toLowerCase();
      return s === symFilter || s.startsWith(symFilter);
    };
    tokens = [...tokens, ...discovered.filter(passesFilters)];
  }

  if (includeNative) {
    // Only include native if it survives the symbol filter (e.g. the
    // user asked "ETH" → yes; "IDRX" → no). Reuses `symFilter` declared
    // above for the ERC20 filter pass.
    const nativeSymbol = nativeRow?.symbol ?? "ETH";
    const nativePasses =
      !symFilter ||
      nativeSymbol.toLowerCase() === symFilter ||
      nativeSymbol.toLowerCase().startsWith(symFilter);

    // Also respect `is_stable_coin` — native is never a stablecoin, so
    // if the caller explicitly asked for stablecoins only, skip native.
    const stablePasses = input.is_stable_coin !== true;

    if (nativePasses && stablePasses) {
      const nativeToken: NormalizedToken = {
        symbol: nativeSymbol,
        name: nativeRow?.name ?? nativeRow?.symbol ?? "Ether",
        address: ZERO_ADDRESS,
        decimals: nativeRow?.decimals ?? 18,
        is_native: true,
        is_stable_coin: false,
        logo_url: nativeRow?.logoUrl || undefined,
      };
      tokens = [nativeToken, ...tokens];
    }
  }

  // ---- Optionally resolve live balances ----------------------------
  // Same pattern `app/send.tsx` uses: publicClient.getBalance for
  // native, publicClient.readContract({ abi: erc20Abi, functionName:
  // "balanceOf" }) for ERC20.
  const includeBalance = input.include_balance === true;
  const walletAddress = context.wallet.address as `0x${string}` | undefined;

  if (includeBalance && !walletAddress) {
    throw new ExecutorError(
      ExecutorErrorCode.WalletCannotExecute,
      "no connected wallet",
    );
  }

  const publicClient = includeBalance
    ? resolveChainClients(chainId, context).publicClient
    : null;

  const rows: BalanceTokenRow[] = await Promise.all(
    tokens.map(async (token): Promise<BalanceTokenRow> => {
      let balance_raw: string | undefined;
      let balance_display: string | undefined;

      if (publicClient && walletAddress) {
        try {
          if (token.is_native) {
            const raw = await publicClient.getBalance({
              address: walletAddress,
            });
            balance_raw = raw.toString(10);
            balance_display = formatUnits(raw, token.decimals);
          } else if (token.address && token.address !== ZERO_ADDRESS) {
            const raw = (await publicClient.readContract({
              address: token.address,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [walletAddress],
            })) as bigint;
            balance_raw = raw.toString(10);
            balance_display = formatUnits(raw, token.decimals);
          }
        } catch {
          // Per-token balanceOf revert — omit balance fields for that
          // row but keep going. Matches `app/send.tsx` pattern.
        }
      }

      return {
        symbol: token.symbol,
        name: token.name,
        address: token.address,
        decimals: token.decimals,
        is_native: token.is_native,
        is_stable_coin: token.is_stable_coin,
        ...(token.logo_url !== undefined ? { logo_url: token.logo_url } : {}),
        ...(token.pegged_currency !== undefined
          ? { pegged_currency: token.pegged_currency }
          : {}),
        ...(balance_raw !== undefined ? { balance_raw } : {}),
        ...(balance_display !== undefined ? { balance_display } : {}),
      };
    }),
  );

  return {
    namespace: "evm",
    chain_id: chainId,
    chain_label: blockchain.name,
    chain_symbol: nativeRow?.symbol,
    ...(nativeRow?.logoUrl ? { chain_logo_url: nativeRow.logoUrl } : {}),
    tokens: rows,
  };
}

export const getWalletTokens: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    if (context.wallet.namespace !== "eip155") {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_evm",
      );
    }
    // ---- Decide which chains to scan --------------------------------
    // Priority:
    //   1. explicit `chain_ids: number[]`     → multi-chain parallel
    //   2. explicit `chain_id: number`         → single chain
    //   3. `wallet_context.chain_id` fallback  → single chain (active)
    const rawChainIds = (input as Record<string, unknown>).chain_ids;
    const chainIds: number[] = Array.isArray(rawChainIds)
      ? rawChainIds.filter(
          (n): n is number => Number.isInteger(n) && (n as number) > 0,
        )
      : [resolveChainId(input, context)];

    if (chainIds.length === 0) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "no chain_id(s) provided and wallet_context.chain_id is missing",
      );
    }

    // Fan out across chains in parallel. Per-chain failures (unsupported
    // chain, API error, etc.) are captured into `group_errors` so a
    // single bad chain can't poison a multi-chain query.
    const settled = await Promise.allSettled(
      chainIds.map((id) => scanChainTokens(id, input, context)),
    );

    const groups: BalanceGroup[] = [];
    const group_errors: GroupError[] = [];

    settled.forEach((res, i) => {
      if (res.status === "fulfilled") {
        groups.push(res.value);
      } else {
        group_errors.push({
          namespace: "evm",
          chain_id: chainIds[i],
          chain_label: `Chain ${chainIds[i]}`,
          error:
            res.reason instanceof Error
              ? res.reason.message
              : String(res.reason),
        });
      }
    });

    // `data` is the compact agent-facing slice — just enough for the
    // model to reason ("does the user hold USDC on polygon?"). The
    // rich per-token rows go in `display`, which the server strips
    // before feeding the result to the LLM. See `protocol.ts::ToolResult`.
    // `address` and `decimals` stay so the agent can construct ERC20
    // transfers / approvals without a second round-trip.
    const display: WalletBalancesPayload = {
      groups,
      ...(group_errors.length > 0 ? { group_errors } : {}),
    };

    return {
      status: "success",
      data: toAgentSlice(display),
      display,
    };
  });

/**
 * Recursively convert bigints (and nested bigints inside arrays /
 * objects) into base-10 strings so that the SSE dispatcher can safely
 * JSON.stringify the tool result without exploding on "Do not know how
 * to serialize a BigInt".
 */
function safeSerialize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(safeSerialize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = safeSerialize(v);
    }
    return out;
  }
  return value;
}

/**
 * Exported so the index can re-export a stable surface. The map here is
 * keyed on the server's canonical tool names from `TOOL_REGISTRY`.
 */
export const READ_EXECUTORS: Record<string, MobileToolExecutor> = {
  get_balance: getBalance,
  get_wallet_balance: getWalletBalance,
  read_contract: readContract,
  get_transaction: getTransaction,
  get_wallet_address: getWalletAddress,
  get_supported_chains: getSupportedChains,
  get_wallet_tokens: getWalletTokens,
};
