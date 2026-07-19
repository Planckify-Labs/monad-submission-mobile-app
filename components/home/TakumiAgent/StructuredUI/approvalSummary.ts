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

  if (amount || to) {
    const action = nonEmptyString(facts.action) ?? "Send";
    const asset = nonEmptyString(facts.asset);
    const parts: string[] = [action];
    if (amount) parts.push(asset ? `${amount} ${asset}` : amount);
    if (to) {
      const addr = truncateAddress(to);
      const label = nonEmptyString(facts.toLabel);
      parts.push(label ? `to ${label} (${addr})` : `to ${addr}`);
    }
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
