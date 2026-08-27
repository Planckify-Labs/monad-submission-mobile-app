import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { MOBILE_WRITE_TOOLS } from "@/services/agent-executors/expectedMobileTools";

/**
 * Every write tool that HAS a card must render an approval gate in it.
 *
 * `capability: "write"` tagging alone surfaces no confirmation prompt
 * (`feedback_write_card_approval_gate_required`). When a tool has a
 * StructuredUI card, that card IS what the user sees — it paints over the
 * place a prompt would otherwise appear — so a card without a gate ships a
 * write the user can never decline. That is not hypothetical: it is
 * exactly how `bridge_execute` shipped once, and
 * docs/defi-quick-invest-spec.md §12.5 calls it out again by name when
 * scoping the DCA card.
 *
 * "Gated" means decision-aware, not literally importing one component:
 * either the shared `WriteApprovalGate`, or the equivalent inline pair
 * (read `decision`, report `user_decision`), which `RebalancePreviewCard`
 * implements by hand and predates the shared component.
 *
 * A write tool with NO card entry is out of scope here: `MessageContent`
 * renders nothing for it, so its approval comes from the dispatcher's
 * approval sheet rather than from a card that could hide one.
 */

const UI_DIR = __dirname;
const REGISTRY = join(UI_DIR, "registry.ts");

/**
 * Tools whose card is deliberately gate-less, with the reason. Mirrors the
 * allowlist discipline in `scripts/check-chain-agnostic.sh`: an entry here
 * is a decision on the record, not a silenced failure.
 */
const ALLOWLIST: Record<string, string> = {
  // Settles INSIDE a pre-signed on-chain allowance whose caveats are the
  // hard ceiling — the user approved the spending limit once, up front,
  // and there is no per-call address or amount left for them to vet. Same
  // reasoning that puts it in `TOOLS_WITHOUT_COUNTERPARTY`.
  x402_fetch:
    "spends within a pre-signed allowance; the ceiling was approved when the allowance was granted",
};

/**
 * Comments explain gates; only code implements one.
 *
 * Load-bearing, not tidiness: several helper modules DISCUSS
 * `WriteApprovalGate` in their headers, and matching that prose made this
 * guard pass on a card whose gate had been removed entirely. A guard that
 * cannot fail is worse than no guard.
 */
function read(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function resolveModule(fromDir: string, relative: string): string | null {
  for (const ext of [".tsx", ".ts"]) {
    const candidate = normalize(join(fromDir, relative + ext));
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // Not this extension.
    }
  }
  return null;
}

/**
 * Follows local imports a couple of hops: several cards delegate their
 * live/proposal half to a shared component (`PendingTxCard`'s
 * `LivePendingTxView`), and the gate legitimately lives there.
 */
function isGated(
  path: string | null,
  depth = 0,
  seen = new Set<string>(),
): boolean {
  if (!path || depth > 2 || seen.has(path)) return false;
  seen.add(path);
  const src = read(path);
  if (src.includes("WriteApprovalGate")) return true;
  if (src.includes("user_decision") && src.includes("decision")) return true;
  for (const rel of src.match(/from\s+"(\.[^"]+)"/g) ?? []) {
    const specifier = rel.slice(rel.indexOf('"') + 1, -1);
    const next = resolveModule(dirname(path), specifier);
    // Only follow delegation to ANOTHER CARD. A card may hand its live
    // half to a shared card component (`PendingTxCard`'s
    // `LivePendingTxView`), and the gate legitimately lives there — but a
    // formatter or a types module is never where an approval prompt is.
    if (next && /Card\.tsx$/.test(next) && isGated(next, depth + 1, seen)) {
      return true;
    }
  }
  return false;
}

function cardPathsByTool(): Map<string, string | null> {
  const registry = read(REGISTRY);
  const imports = new Map<string, string>();
  for (const match of registry.matchAll(
    /import\s+(\w+)\s+from\s+"(\.[^"]+)"/g,
  )) {
    imports.set(match[1], match[2]);
  }
  const out = new Map<string, string | null>();
  for (const match of registry.matchAll(
    /^ {2}([a-zA-Z0-9_]+):\s*([A-Z]\w+),/gm,
  )) {
    const specifier = imports.get(match[2]);
    out.set(match[1], specifier ? resolveModule(UI_DIR, specifier) : null);
  }
  return out;
}

describe("write cards render an approval gate", () => {
  const cards = cardPathsByTool();

  it("resolves the registry's tool → card map", () => {
    // Guards the guard: a parsing change that silently matched nothing
    // would make every assertion below vacuously pass.
    expect(cards.size).toBeGreaterThan(20);
    expect(cards.get("defi_withdraw")).toBeTruthy();
  });

  const gatedTools = [...MOBILE_WRITE_TOOLS].filter(
    (tool) => cards.has(tool) && !(tool in ALLOWLIST),
  );

  it("covers the write tools that have a card", () => {
    expect(gatedTools.length).toBeGreaterThan(10);
  });

  it.each(gatedTools)("%s's card is decision-aware", (tool) => {
    expect(isGated(cards.get(tool) ?? null)).toBe(true);
  });

  it("keeps the allowlist justified and minimal", () => {
    for (const [tool, reason] of Object.entries(ALLOWLIST)) {
      expect(MOBILE_WRITE_TOOLS.has(tool)).toBe(true);
      expect(reason.length).toBeGreaterThan(30);
    }
  });
});
