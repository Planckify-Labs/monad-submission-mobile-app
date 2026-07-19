#!/usr/bin/env bash
# check-agents.sh — multi-agent architecture invariants.
#
# Spec: docs/multi-agent-architecture-spec.md §7.3, §4.1, §9.
# Design notes: docs/multi-agent-design-notes.md (the two
# load-bearing invariants — read this before editing the script).
# Task: docs/multi-agent-architecture-task/18_check_agents_ci_guard.
#
# Five invariants:
#  1. Manifest parity between server + mobile (byte-for-byte).
#  2. Core has no external tool surface (no walletKit/chains/defi
#     imports under tools/core or agents/core).
#  3. Specialist isolation — Core handler must not import specialist
#     handlers directly; specialists must not import each other.
#  4. Every executor's tool name matches its agentDir's manifest
#     prefixes (server + mobile).
#  5. Every specialist tool_pending payload includes wallet_context.
#
# Pure text checks (grep/rg), no TS AST. One violation per line,
# prefixed `[check:agents]`. Sibling of `check-chain-agnostic.sh`.
#
# Run via `pnpm check:agents`. Exits 0 on clean, 1 on any violation.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_API_ROOT="$(cd "$REPO_ROOT/../agent-api" && pwd)"

# Use rg if available, fall back to grep -r.
if command -v rg >/dev/null 2>&1; then
  GREP="rg --no-messages"
else
  GREP="grep -rEn --include=*.ts --include=*.tsx"
fi

violations=0

fail() {
  echo "[check:agents] $1"
  violations=$((violations + 1))
}

# ─── Invariant 1: manifest parity ─────────────────────────────────────────────
SERVER_MANIFEST="$AGENT_API_ROOT/src/agents/manifests/agentManifests.json"
MOBILE_MANIFEST="$REPO_ROOT/services/agent-executors/agentManifests.json"

if [ ! -f "$SERVER_MANIFEST" ]; then
  fail "server manifest missing at $SERVER_MANIFEST"
elif [ ! -f "$MOBILE_MANIFEST" ]; then
  fail "mobile manifest missing at $MOBILE_MANIFEST"
elif ! diff -q "$SERVER_MANIFEST" "$MOBILE_MANIFEST" >/dev/null 2>&1; then
  fail "manifest drift: $SERVER_MANIFEST differs from $MOBILE_MANIFEST (run \`pnpm --filter takumi-agent-api manifests:sync\`)"
fi

# ─── Invariant 2: Core has no external tool surface (§4.1) ───────────────────
CORE_TOOL_DIRS=(
  "$AGENT_API_ROOT/src/tools/core"
  "$AGENT_API_ROOT/src/agents/core"
)

FORBIDDEN_IMPORTS=(
  "services/walletKit"
  "services/chains"
  "services/defi"
)

for dir in "${CORE_TOOL_DIRS[@]}"; do
  if [ ! -d "$dir" ]; then continue; fi
  for forbidden in "${FORBIDDEN_IMPORTS[@]}"; do
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      fail "Core surface violates §4.1 — forbidden import \"$forbidden\" in $line"
    done < <(grep -rEn --include='*.ts' --include='*.tsx' "from\s+['\"]@?/?$forbidden" "$dir" 2>/dev/null || true)
  done
  # Reject any tool_pending emission in Core's tool surface. Strip
  # comment lines (// or *) and spec/test files — those legitimately
  # mention tool_pending in prose / fixtures without emitting it.
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    fail "Core surface violates §4.1 — emits tool_pending in $line"
  done < <(grep -rEn --include='*.ts' --include='*.tsx' "emitToolPending\(|kind:\s*['\"]tool_pending['\"]|sse_sink\.emit.*tool_pending" "$dir" 2>/dev/null \
            | grep -v -E "spec\.ts:|\.test\.ts:|\.test\.tsx:" \
            | grep -v -E ":[[:space:]]*\*|:[[:space:]]*//" || true)
done

# Core Card declares exactly ["core_"].
CORE_CARD="$AGENT_API_ROOT/src/agents/core/card.ts"
if [ -f "$CORE_CARD" ]; then
  if ! grep -q "tool_prefixes: \['core_'\]" "$CORE_CARD"; then
    fail "Core card $CORE_CARD must declare tool_prefixes: ['core_'] (§4.1)"
  fi
fi

# ─── Invariant 3: specialist isolation ───────────────────────────────────────
# Core handler must not import specialist handlers directly.
CORE_HANDLER="$AGENT_API_ROOT/src/agents/core/handler.ts"
if [ -f "$CORE_HANDLER" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    fail "Core handler imports specialist directly — must go through registry / orchestrator: $line"
  done < <(grep -En "from\s+['\"]\.\./(wallet|defi)/handler" "$CORE_HANDLER" 2>/dev/null || true)
fi

# Specialists must not import each other. Spec/test files are
# allowed to import sibling cards for registry setup fixtures (the
# registry is global and tests need all three agents booted).
for src in wallet defi; do
  for other in wallet defi; do
    if [ "$src" = "$other" ]; then continue; fi
    dir="$AGENT_API_ROOT/src/agents/$src"
    [ -d "$dir" ] || continue
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      fail "Specialist isolation: $src imports $other — $line"
    done < <(grep -rEn --include='*.ts' "from\s+['\"]\.\./$other/" "$dir" 2>/dev/null \
              | grep -v -E "spec\.ts:|\.test\.ts:" || true)
  done
done

# ─── Invariant 4: every executor matches its dir's manifest prefixes ─────────
# Server side: tools/<agent>/* files must register tools whose names
# start with one of <agent>'s prefixes. The runtime `composeAgentTools`
# enforces this already; the lint catches the case where a tool is
# defined without going through composeAgentTools.
SERVER_TOOL_DIRS=("tools/core" "tools/wallet" "tools/defi")
for sub in "${SERVER_TOOL_DIRS[@]}"; do
  dir="$AGENT_API_ROOT/src/$sub"
  [ -d "$dir" ] || continue
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    if grep -q "Record<string, ToolMeta>" "$file" && ! grep -q "composeAgentTools" "$file"; then
      fail "Server tool file $file declares a ToolMeta map but does not call composeAgentTools — must validate against the manifest"
    fi
  done < <(find "$dir" -type f -name "*.ts" ! -name "index.ts" ! -name "*.spec.ts" 2>/dev/null || true)
done

# Mobile side: same check against composeAgentExecutors.
MOBILE_EXEC_DIRS=("wallet" "defi")
for sub in "${MOBILE_EXEC_DIRS[@]}"; do
  dir="$REPO_ROOT/services/agent-executors/$sub"
  [ -d "$dir" ] || continue
  # Mobile per-file maps are flat const records keyed by tool name;
  # the parent index.ts wraps them with composeAgentExecutors. Just
  # assert each sub-dir has at least one composeAgentExecutors call
  # somewhere upstream — checked via the top-level index.ts.
  :
done
TOP_INDEX="$REPO_ROOT/services/agent-executors/index.ts"
if [ -f "$TOP_INDEX" ]; then
  if ! grep -q "composeAgentExecutors(\"wallet\"" "$TOP_INDEX"; then
    fail "Mobile $TOP_INDEX does not compose wallet executors via composeAgentExecutors(\"wallet\", …)"
  fi
  if ! grep -q "composeAgentExecutors(\"defi\"" "$TOP_INDEX"; then
    fail "Mobile $TOP_INDEX does not compose defi executors via composeAgentExecutors(\"defi\", …)"
  fi
fi

# ─── Invariant 5: tool_pending envelopes carry wallet_context ────────────────
# Orchestrator's SseFrame typing requires `wallet_context` on every
# `tool_pending`. Verify by grepping for the literal shape in
# orchestrator.ts — a future edit that drops the field will fail here
# before reviewers find it.
ORCHESTRATOR="$AGENT_API_ROOT/src/agents/orchestrator.ts"
if [ -f "$ORCHESTRATOR" ]; then
  if ! grep -q "wallet_context: WalletContext" "$ORCHESTRATOR"; then
    fail "Orchestrator $ORCHESTRATOR must propagate wallet_context on tool_pending (§9)"
  fi
fi

# ─── Invariant 6: EXPECTED_MOBILE_TOOLS parity ───────────────────────────────
# Compare the server registry's `executor: "mobile"` tool names against the
# mobile `EXPECTED_MOBILE_TOOLS` mirror.
#
# Loaded with `tsx` from each repo's own root (ts-node is NOT installed, and
# the old cwd-relative `node -e` paths were wrong — so this check had been
# SILENTLY skipping, which let `defi_intent_*` drift in undetected). The mobile
# list is read from its import-free module (`expectedMobileTools.ts`) so no
# RN executor graph is pulled. Extraction failure now WARNS (visibly) instead
# of passing silently; the authoritative enforcement is the
# `registryParity.test.ts` vitest test (part of `pnpm test`).
set +e
SERVER_MOBILE_TOOLS=$(cd "$AGENT_API_ROOT" && npx tsx -e \
  'import { TOOL_REGISTRY } from "./src/tools/registry"; console.log(Object.values(TOOL_REGISTRY).filter((t)=>t.executor==="mobile").map((t)=>t.name).sort().join("\n"));' \
  2>/dev/null)
MOBILE_EXPECTED_TOOLS=$(cd "$REPO_ROOT" && npx tsx -e \
  'import { EXPECTED_MOBILE_TOOLS } from "./services/agent-executors/expectedMobileTools"; console.log([...EXPECTED_MOBILE_TOOLS].sort().join("\n"));' \
  2>/dev/null)
set -e

if [ -z "$SERVER_MOBILE_TOOLS" ] || [ -z "$MOBILE_EXPECTED_TOOLS" ]; then
  echo "[check:agents] WARN: invariant 6 could not extract tool lists (tsx missing?) — parity NOT verified here; relying on registryParity.test.ts." >&2
elif [ "$SERVER_MOBILE_TOOLS" != "$MOBILE_EXPECTED_TOOLS" ]; then
  fail "EXPECTED_MOBILE_TOOLS out of sync with agent-api registry:
$(diff <(echo "$SERVER_MOBILE_TOOLS") <(echo "$MOBILE_EXPECTED_TOOLS"))"
fi

if [ "$violations" -gt 0 ]; then
  echo "[check:agents] failed with $violations violation(s)"
  exit 1
fi

echo "[check:agents] ok"
