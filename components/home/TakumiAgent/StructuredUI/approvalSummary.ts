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
const CHAIN_NAMES: Record<string, string> = {
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
): string {
  const str = (k: string): string | undefined =>
    typeof input[k] === "string" && (input[k] as string).trim().length > 0
      ? (input[k] as string)
      : undefined;

  const spender = str("spender");
  const to = str("to") ?? spender ?? str("destination") ?? str("recipient");

  // Bridge writes (bridge-capability-spec §8.1). A bridge's identity is
  // the ROUTE, not a recipient — the destination address is usually the
  // user's own wallet on another chain, so "Send X to 0xab…cd" reads as a
  // transfer to a stranger. Build the route clause from the args instead,
  // and never fall back to the model's `human_summary` for a write that
  // moves value across chains.
  const fromChain = str("from_chain");
  const toChain = str("to_chain");
  if (fromChain && toChain) {
    return factsFirstSummary(
      {
        action: "Bridge",
        amount: str("amount_raw"),
        asset: assetSymbolFromCaip19(str("from_asset")),
        suffix: `from ${chainName(fromChain)} to ${chainName(toChain)}`,
      },
      {},
      `Bridge from ${chainName(fromChain)} to ${chainName(toChain)}`,
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
