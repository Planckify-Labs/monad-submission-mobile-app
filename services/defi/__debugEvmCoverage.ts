/**
 * ⚠️ TEMPORARY DEBUG HELPER — DELETE ME.
 *
 * Dumps a namespace slice of a `defi_list_opportunities` result to the Metro
 * console, split into what the agent can execute in-app vs what stays Manual,
 * so the output can be copy-pasted into a chat for analysis. `logEvmCoverage`
 * and `logSolanaCoverage` are thin wrappers over the same generic reporter.
 *
 * Lives in `services/` on purpose: `pnpm check:chains` forbids
 * `namespace === "eip155" | "solana" | "sui"` under `components/`, `hooks/`
 * and `app/`, and this genuinely needs to filter by namespace. Chain-agnostic
 * code should never do this — that is why the helper is temporary.
 *
 * To remove: delete this file, its import, and the calls in
 * `components/home/TakumiAgent/StructuredUI/cards/OpportunityListCard.tsx`.
 */

import type { RawOpportunity } from "./opportunityDisplay";

interface ProtocolBucket {
  slug: string;
  chains: Set<string>;
  assets: Set<string>;
  inApp: number;
  manual: number;
  /** A few concrete manual pools, for tracing why they failed to resolve. */
  manualSamples: string[];
  bestApy: number;
  tvl: number;
}

function isEvmRow(row: RawOpportunity): boolean {
  if (row.namespace) return row.namespace === "eip155";
  // Older rows may omit namespace; every non-EVM chain in the directory has a
  // null chainId, so a numeric one is a reliable fallback discriminator.
  return Number.isFinite(Number(row.chain_id)) && Number(row.chain_id) > 0;
}

function isSolanaRow(row: RawOpportunity): boolean {
  // Every Solana opportunity is freshly resolved (§14 of the pool-resolver
  // runbook) and always carries `namespace` — no legacy fallback needed,
  // unlike the EVM predicate above.
  return row.namespace === "solana";
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function line(b: ProtocolBucket): string {
  const chains = [...b.chains].sort().join(",");
  const assets = [...b.assets].sort().slice(0, 6).join(",");
  const total = b.inApp + b.manual;
  return `  ${b.slug.padEnd(24)} ${String(`${b.inApp}/${total}`).padEnd(7)} ${chains.padEnd(22)} apy=${b.bestApy.toFixed(2)}%  tvl=${fmtUsd(b.tvl)}  [${assets}]`;
}

/** Shared reporter — `label` names the namespace in the printed banner. */
function logCoverage(
  rows: readonly RawOpportunity[],
  label: string,
  isMatch: (row: RawOpportunity) => boolean,
): void {
  if (!__DEV__) return;

  const matched = rows.filter(isMatch);
  const byProtocol = new Map<string, ProtocolBucket>();

  for (const row of matched) {
    const slug = row.protocol_slug ?? "(unknown)";
    let b = byProtocol.get(slug);
    if (!b) {
      b = {
        slug,
        chains: new Set(),
        assets: new Set(),
        inApp: 0,
        manual: 0,
        manualSamples: [],
        bestApy: 0,
        tvl: 0,
      };
      byProtocol.set(slug, b);
    }
    b.chains.add(`${row.chain_name ?? "?"}(${row.chain_id ?? "?"})`);
    if (row.asset_symbol) b.assets.add(row.asset_symbol);
    b.bestApy = Math.max(b.bestApy, num(row.apy));
    b.tvl += num(row.tvl_usd);
    if (row.in_app === true) {
      b.inApp++;
    } else {
      b.manual++;
      if (b.manualSamples.length < 6) {
        b.manualSamples.push(
          `${(row.chain_name ?? "?").padEnd(10)} ${row.asset_symbol ?? "?"}${row.pool_meta ? ` "${row.pool_meta}"` : ""} pool_id=${row.pool_id ?? "?"}`,
        );
      }
    }
  }

  const all = [...byProtocol.values()].sort((a, b) => b.tvl - a.tvl);
  const executable = all.filter((b) => b.manual === 0 && b.inApp > 0);
  const manual = all.filter((b) => b.inApp === 0);
  const mixed = all.filter((b) => b.inApp > 0 && b.manual > 0);

  const poolsIn = all.reduce((s, b) => s + b.inApp, 0);
  const poolsMan = all.reduce((s, b) => s + b.manual, 0);

  const out: string[] = [];
  out.push("");
  out.push(`═══════════ ${label} DEFI COVERAGE (copy-paste this) ═══════════`);
  out.push(
    `rows: ${rows.length} total · ${matched.length} ${label} · ${rows.length - matched.length} non-${label} (skipped)`,
  );
  out.push(
    `protocols: ${all.length} ${label} · pools: ${poolsIn} agent-executable / ${poolsMan} manual`,
  );
  out.push(
    "format: <slug> <inApp/total pools> <chains> apy=best tvl=sum [assets]",
  );

  out.push("");
  out.push(
    `───── ✅ AGENT-EXECUTABLE (every pool in-app) — ${executable.length} protocols ─────`,
  );
  if (!executable.length) out.push("  (none)");
  for (const b of executable) out.push(line(b));

  out.push("");
  out.push(
    `───── ⚠️ MIXED (some pools in-app, some Manual) — ${mixed.length} protocols ─────`,
  );
  if (!mixed.length) out.push("  (none)");
  for (const b of mixed) {
    out.push(line(b));
    for (const s of b.manualSamples) out.push(`       manual: ${s}`);
  }

  out.push("");
  out.push(
    `───── ❌ MANUAL ONLY (agent cannot execute any pool) — ${manual.length} protocols ─────`,
  );
  if (!manual.length) out.push("  (none)");
  for (const b of manual) {
    out.push(line(b));
    for (const s of b.manualSamples) out.push(`       manual: ${s}`);
  }

  out.push(`═══════════ END ${label} DEFI COVERAGE ═══════════`);
  out.push("");

  console.log(out.join("\n"));
}

export function logEvmCoverage(rows: readonly RawOpportunity[]): void {
  logCoverage(rows, "EVM", isEvmRow);
}

export function logSolanaCoverage(rows: readonly RawOpportunity[]): void {
  logCoverage(rows, "SOLANA", isSolanaRow);
}
