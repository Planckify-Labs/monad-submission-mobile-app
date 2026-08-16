/**
 * Facts-first approval summaries — prompt-injection defense for every
 * agent write card.
 *
 * `human_summary` / `description` on a write tool's input are authored by
 * the MODEL, and the model can be steered by injected content it read
 * earlier in the turn (token names, pool names, dApp copy, memos). The
 * approval gate (WriteApprovalGate → PreviewCard / ApprovalSheet) renders
 * exactly one summary string, so if that string comes from the model, an
 * injected prompt can describe a drain as something harmless and the
 * user approves a lie.
 *
 * Rule enforced here: when the tool input carries structured facts
 * (recipient, amount, asset), the summary is BUILT FROM THE FACTS and the
 * model's prose is ignored. Model prose is only used when there are no
 * facts to show (e.g. a tool whose input is a free-form plan id), where
 * it is cosmetic rather than authoritative.
 */

import { prettyProtocol } from "@/services/defi/opportunityDisplay";

export function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Human label for a CAIP-2 chain id, by TABLE LOOKUP.
 *
 * `eip155:8453` on an approval sheet tells the user nothing. Unlike the
 * bridge cards, this surface sees only raw tool ARGS and has no
 * backend-resolved display name to read, so it keeps a small static map.
 *
 * Deliberately a lookup and not a set of namespace comparisons: shared UI
 * must not branch on the chain family (CLAUDE.md hard rule, enforced by
 * `pnpm check:chains`). An unknown chain falls back to the CAIP-2 id,
 * which is honest rather than wrong.
 */
// Also the last-resort fallback for `bridgeFormat.ts`'s `chainLabel` when
// the backend's own resolved name is unavailable (cold LI.FI chains cache
// - see lifi.adapter.ts `chainNameFor`). One table, so the approval gate
// and the display cards never disagree on a chain's name.
export const CHAIN_NAMES: Record<string, string> = {
  "eip155:1": "Ethereum",
  "eip155:10": "OP Mainnet",
  "eip155:56": "BNB Chain",
  "eip155:137": "Polygon",
  "eip155:8453": "Base",
  "eip155:42161": "Arbitrum",
  "eip155:43114": "Avalanche",
  "eip155:59144": "Linea",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "Solana Devnet",
  "sui:mainnet": "Sui",
  "sui:testnet": "Sui Testnet",
  "stellar:pubnet": "Stellar",
  "stellar:testnet": "Stellar Testnet",
};

function chainName(caip2: string): string {
  return CHAIN_NAMES[caip2] ?? caip2;
}

/**
 * Last path segment of a CAIP-19 is the contract / mint / coin type, not
 * a symbol, so there is no symbol to recover for a token asset. Native
 * assets DO carry one structurally, and naming them beats showing a raw
 * `slip44:60`.
 */
function assetSymbolFromCaip19(asset: string | undefined): string | undefined {
  if (!asset) return undefined;
  if (asset.includes("/slip44:60")) return "ETH";
  if (asset.includes("/slip44:501")) return "SOL";
  if (asset.endsWith("::sui::SUI")) return "SUI";
  if (asset.includes("/native")) return "XLM";
  return undefined;
}

/**
 * Smallest-units → human amount, but ONLY when the decimals are actually
 * known. Returns `undefined` otherwise so the caller omits the number
 * entirely: on an approval screen, no amount is recoverable ("check the
 * card"), while a wrong amount is actively dangerous — "5000000" and "5"
 * are the same argument rendered with and without this information.
 *
 * bigint arithmetic, not `Number`: a 78-digit raw amount loses precision
 * through a float, and this string is what the user approves against.
 */
export function formatSmallestUnits(
  amountRaw: string | undefined,
  decimals: number | undefined,
): string | undefined {
  if (!amountRaw || typeof decimals !== "number" || decimals < 0) {
    return undefined;
  }
  if (!/^[0-9]+$/.test(amountRaw)) return undefined;

  let value: bigint;
  try {
    value = BigInt(amountRaw);
  } catch {
    return undefined;
  }

  const base = 10n ** BigInt(decimals);
  const whole = (value / base).toLocaleString("en-US");
  const fraction = value % base;
  if (decimals === 0 || fraction === 0n) return whole;

  const trimmed = fraction
    .toString()
    .padStart(decimals, "0")
    .slice(0, 6)
    .replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export type ApprovalFacts = {
  /** Leading verb, defaults to "Send". */
  action?: string;
  /** Human-readable amount, verbatim from the tool args. */
  amount?: string;
  /** Asset label (symbol / code); derived from args, never model prose. */
  asset?: string;
  /** Recipient / spender address, verbatim from the tool args. */
  to?: string;
  /** Optional trusted label rendered next to the address, e.g. a name. */
  toLabel?: string;
  /**
   * Trailing clause appended verbatim, e.g. "from Base to Solana" for a
   * bridge. Built from tool args like everything else here, never prose.
   */
  suffix?: string;
};

type ModelProse = {
  human_summary?: unknown;
  description?: unknown;
};

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/**
 * Build the approval-gate line. Facts win; model prose is a fallback for
 * fact-less inputs only; `fallback` is the terminal default.
 */
export function factsFirstSummary(
  facts: ApprovalFacts,
  prose: ModelProse,
  fallback: string,
): string {
  const amount = nonEmptyString(facts.amount);
  const to = nonEmptyString(facts.to);

  const suffix = nonEmptyString(facts.suffix);

  if (amount || to || suffix) {
    const action = nonEmptyString(facts.action) ?? "Send";
    const asset = nonEmptyString(facts.asset);
    const parts: string[] = [action];
    if (amount) parts.push(asset ? `${amount} ${asset}` : amount);
    else if (asset) parts.push(asset);
    if (to) {
      const addr = truncateAddress(to);
      const label = nonEmptyString(facts.toLabel);
      parts.push(label ? `to ${label} (${addr})` : `to ${addr}`);
    }
    if (suffix) parts.push(suffix);
    return parts.join(" ");
  }

  return (
    nonEmptyString(prose.human_summary) ??
    nonEmptyString(prose.description) ??
    fallback
  );
}

/**
 * Generic facts-first summary for an arbitrary write-tool input, used by
 * the surfaces that see every tool (the run-down PreviewCard and the
 * ApprovalSheet) rather than a per-tool card. Probes the union of fact
 * fields the write executors accept across namespaces; falls back to the
 * server's `human_summary` only when the input carries no facts at all.
 */
export function approvalSummaryFromToolInput(
  input: Record<string, unknown>,
  serverSummary: string | undefined,
  fallback = "This action",
  /**
   * Token metadata the raw tool args cannot carry. Amounts arrive as
   * SMALLEST UNITS, so without decimals the only honest options are to
   * omit the number or print "5000000" for 5 USDC. Callers that can reach
   * the token catalogue (see `resolveAssetMeta`) supply it so the
   * approval can state the real amount.
   */
  assetMeta?: { symbol?: string; decimals?: number },
): string {
  const str = (k: string): string | undefined =>
    typeof input[k] === "string" && (input[k] as string).trim().length > 0
      ? (input[k] as string)
      : undefined;

  const spender = str("spender");
  const to = str("to") ?? spender ?? str("destination") ?? str("recipient");

  // Bridge writes (bridge-capability-spec §8.1). A bridge's identity is
  // the ROUTE, not a recipient — but the DESTINATION ADDRESS is still
  // load-bearing and must appear: it is what the known-destination
  // envelope asks the user to confirm, and an approval that hides the
  // address would record a confirmation for something never seen.
  const fromChain = str("from_chain");
  const toChain = str("to_chain");
  if (fromChain && toChain) {
    const symbol =
      assetMeta?.symbol ?? assetSymbolFromCaip19(str("from_asset"));
    const amount = formatSmallestUnits(str("amount_raw"), assetMeta?.decimals);
    const toAddress = str("to_address");
    const route = `from ${chainName(fromChain)} to ${chainName(toChain)}`;
    return factsFirstSummary(
      {
        action: "Bridge",
        amount,
        asset: symbol,
        suffix: toAddress
          ? `${route}, arriving at ${truncateAddress(toAddress)}`
          : route,
      },
      {},
      `Bridge ${route}`,
    );
  }

  // DeFi writes (`defi_deposit`, `defi_withdraw`, `defi_rebalance`). None of
  // their facts live in the fields probed above — the amount is
  // `amount_raw`, the asset is `asset_symbol`, the counterparty is a POOL
  // rather than an address — so this input used to carry no facts at all.
  // That had two costs: the approval line fell through to the model's own
  // prose (exactly what this module exists to prevent), and the card read
  // "Transaction", which tells a user nothing about the thing they are
  // being asked to approve.
  const protocolSlug = str("protocol_slug");
  const depositSymbol = str("asset_symbol");
  const moveSymbol = str("from_asset_symbol");
  // `defi_withdraw`'s `protocol_slug`/`asset_symbol` are OPTIONAL display
  // hints (never routing — see writes.ts `assertWithdrawHintsMatchPosition`),
  // present alongside `position_id`. Their presence, not the chain family,
  // is what tells "Withdraw" apart from "Deposit" here — chain-agnostic by
  // construction, same as the `chainName()` CAIP-2 lookup below.
  const isWithdraw = !!str("position_id");
  if (protocolSlug && (depositSymbol || moveSymbol)) {
    const venue = prettyProtocol(protocolSlug);
    const chainId = input.chain_id;
    const chain =
      typeof chainId === "number" ? chainName(`eip155:${chainId}`) : undefined;
    const preposition = isWithdraw ? "from" : "into";
    const where = chain
      ? `${preposition} ${venue} on ${chain}`
      : `${preposition} ${venue}`;
    const action = moveSymbol ? "Move" : isWithdraw ? "Withdraw" : "Deposit";
    return factsFirstSummary(
      {
        action,
        // Smallest units without decimals stays omitted rather than printed
        // raw — "200000000" would read as a wildly different amount than the
        // 2 the user asked for.
        amount: formatSmallestUnits(str("amount_raw"), assetMeta?.decimals),
        asset: assetMeta?.symbol ?? moveSymbol ?? depositSymbol,
        suffix: where,
      },
      {},
      `${action} ${where}`,
    );
  }

  const nativeAmount =
    str("amount_xlm") ?? str("amount_sol") ?? str("amount_sui");
  const nativeAsset = str("amount_xlm")
    ? "XLM"
    : str("amount_sol")
      ? "SOL"
      : str("amount_sui")
        ? "SUI"
        : undefined;

  const coinTail = str("coin_type")?.split("::").pop();
  const amount = nativeAmount ?? str("amount") ?? str("token_amount");
  const asset =
    nativeAsset ??
    str("symbol") ??
    str("token_symbol") ??
    str("code") ??
    coinTail;

  return factsFirstSummary(
    {
      action: spender ? "Approve" : "Send",
      amount,
      asset,
      to,
      toLabel: spender ? str("spender_name") : undefined,
    },
    { human_summary: serverSummary },
    serverSummary && serverSummary.trim().length > 0 ? serverSummary : fallback,
  );
}
