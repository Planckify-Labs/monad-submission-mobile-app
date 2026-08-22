#!/usr/bin/env node
/**
 * Print fork pins read from the chains themselves.
 *
 * `harness.ts` insists a pinned block is a deliberate, written-down number and
 * never `latest`. That is right, and it left a gap: the only way to GET a
 * correct number was to hand-roll an `eth_blockNumber` call, so the tempting
 * shortcut was to guess one. A guessed pin fails for a reason that has nothing
 * to do with the adapter under test, which is the most expensive kind of red.
 *
 * So: this reads the head from every chain you have a `FORK_RPC_URL_<id>` for
 * and prints the constants to paste into `FORK_BLOCKS_RECENT`, along with how
 * far the current pins have drifted.
 *
 *   FORK_RPC_URL_42161=https://... pnpm defi:fork:pins
 *
 * It writes nothing. Bumping a pin stays a deliberate edit.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../services/defi/__fork__/harness.ts",
);

/** `{ 1: 23_000_000n, ... }` → Map(chainId → bigint), read as text. */
function extractPins(source, name) {
  const start = source.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`${name} not found in harness.ts`);
  const body = source.slice(start, source.indexOf("\n};", start));
  const out = new Map();
  for (const [, id, value] of body.matchAll(/^\s*(\d+):\s*([\d_]+)n\s*,/gm)) {
    out.set(Number(id), BigInt(value.replaceAll("_", "")));
  }
  return out;
}

/** How many blocks a day is, per chain — mirrors PIN_STALE_AFTER_BLOCKS. */
function extractStale(source) {
  return extractPins(source, "PIN_STALE_AFTER_BLOCKS");
}

async function head(url) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_blockNumber",
      params: [],
    }),
  });
  const body = await res.json();
  if (!body?.result) {
    throw new Error(body?.error?.message ?? "no result");
  }
  return BigInt(body.result);
}

const source = readFileSync(HARNESS, "utf8");
const stable = extractPins(source, "FORK_BLOCKS");
const recent = extractPins(source, "FORK_BLOCKS_RECENT");
const stale = extractStale(source);

const liveMatch = source.match(
  /export const DEFI_LIVE_CHAINS: readonly number\[\] = \[([^\]]*)\]/,
);
const live = liveMatch
  ? liveMatch[1]
      .split(",")
      .map((s) => Number(s.trim()))
      .filter(Number.isFinite)
  : [];

const configured = Object.keys(process.env)
  .map((k) => /^FORK_RPC_URL_(\d+)$/.exec(k)?.[1])
  .filter(Boolean)
  .map(Number);

if (configured.length === 0) {
  console.error(
    "No FORK_RPC_URL_<chainId> in the environment.\n" +
      `Chains DeFi is live on: ${live.join(", ")}\n` +
      "Set at least one and re-run, e.g. FORK_RPC_URL_42161=https://…",
  );
  process.exit(1);
}

const suggestions = [];
for (const chainId of configured.sort((a, b) => a - b)) {
  const url = process.env[`FORK_RPC_URL_${chainId}`];
  try {
    const h = await head(url);
    // Sit a few hundred blocks back so a reorg or an archive endpoint's
    // indexing lag cannot make a run flaky — the rule harness.ts states.
    const suggested = ((h - 200n) / 1_000n) * 1_000n;
    const current = recent.get(chainId);
    const limit = stale.get(chainId);
    const drift = current === undefined ? null : h - current;
    const flag =
      drift !== null && limit !== undefined && drift > limit ? " << STALE" : "";
    console.log(
      `chain ${chainId}: head ${h}` +
        (current === undefined
          ? "  (no FORK_BLOCKS_RECENT pin)"
          : `  pinned ${current}  drift ${drift}${flag}`),
    );
    suggestions.push(`  ${chainId}: ${suggested.toString()}n,`);
  } catch (err) {
    console.log(`chain ${chainId}: UNREACHABLE — ${err.message}`);
  }
}

const unpinned = live.filter((id) => !stable.has(id));
if (unpinned.length > 0) {
  console.log(
    `\nChains with no FORK_BLOCKS pin at all: ${unpinned.join(", ")} ` +
      "(forkCoverage.test.ts fails on these)",
  );
}

if (suggestions.length > 0) {
  console.log("\nPaste into FORK_BLOCKS_RECENT in harness.ts:\n");
  console.log(suggestions.join("\n"));
  console.log(
    `\nRecord the date and the heads you read them at, the way the ` +
      "existing entries do — a pin with no provenance cannot be reviewed.",
  );
}
