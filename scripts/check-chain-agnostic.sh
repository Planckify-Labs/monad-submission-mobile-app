#!/usr/bin/env bash
# check-chain-agnostic.sh
#
# Fails when "shared" code — components/, hooks/, app/ — branches on a
# chain namespace string literal. The rule: chain-specific knowledge
# lives on the `WalletKitAdapter`, and shared code dispatches through
# `walletKitRegistry` / `services/walletKit/chainInfo.ts` helpers. An
# `if (namespace === "eip155")` in shared code means a new chain will
# silently take the wrong branch — exactly the bug class that broke
# EVM when Solana was added.
#
# Allowlist (below): files where namespace branching is intentional
# (dispatch tables, per-namespace import flows, the chain picker). Each
# entry must carry a one-line reason; reviewers delete entries when the
# underlying code is refactored.
#
# Run via `pnpm check:chains`. Exits 0 on clean, 1 with the offending
# lines otherwise.
set -euo pipefail

SEARCH_ROOTS=(components hooks app)

PATTERN='namespace === "(eip155|solana|sui|stellar)"|namespace === '"'"'(eip155|solana|sui|stellar)'"'"''

# File-level allowlist. Paths are relative to the repo root. Each entry
# has a comment explaining *why* namespace branching is correct there —
# without a justification, new entries should go on the refactor list
# instead of being silenced.
ALLOWLIST=(
  # Approval sheet dispatch — the table IS the routing logic per
  # (namespace, kind). Centralising further would only hide intent.
  "components/dapps-browser/approvals/renderers.ts"

  # Wallet account grouping + per-namespace address derivation: these
  # helpers exist specifically to translate between namespaces (one
  # mnemonic → one EVM + one Solana wallet). Namespace-aware is the
  # whole contract.
  "hooks/useWallet.helpers.ts"

  # Seed-phrase / private-key import flows are inherently per-chain:
  # different curves, different validators, different copy.
  "components/wallet/create/ImportSeedPhraseSheet.helpers.ts"
  "components/wallet/create/ImportPrivateKeySheet.helpers.ts"
  "components/wallet/create/ImportPrivateKeySheet.tsx"

  # Chain picker UI — surfacing namespaces is the picker's job. The list
  # itself now lives in `ChainSelectorSheet` (shared by the home-screen
  # pill and the agent's conversation list, which used to each have their
  # own copy); `ChainSelector` is just the pill trigger.
  "components/common/ChainSelector.tsx"
  "components/common/ChainSelectorSheet.tsx"

  # Wallet selector + details show namespace-specific chips/accents.
  # Should eventually read `kit.brandColor`; leave allowlisted until
  # that refactor lands so the script flags genuinely new violations.
  "components/wallet/WalletSelectorModal.tsx"
  "components/wallet/WalletDetails.tsx"

  # Receive / balance / switch-chain sheets render cross-namespace
  # compatibility messaging that is still chain-shaped. Allowlist
  # each with a TODO pointer — these remain the top refactor targets.
  "components/home/Main/RecievePaymentModal.tsx"   # TODO: kit hook for "can wallet receive on chain"
  "components/home/TakumiAgent/ConversationHistory.tsx"    # EVM-only chain list render

  # Screens that still reach into viem `nativeCurrency` / EVM-specific
  # paths. Each should eventually consume a `getNativeCurrency` kit
  # hook; listed here as known debt.
  "app/send.tsx"
  "app/dapps-browser.tsx"
  "app/transfer-thresholds.tsx"
  "hooks/useWallet.ts"
  "hooks/deposit/useDepositState.ts"

)

if ! command -v rg >/dev/null 2>&1; then
  echo "check-chain-agnostic: ripgrep (rg) not found; install it or skip this check." >&2
  exit 0
fi

# Build the rg exclude args from ALLOWLIST.
EXCLUDES=()
for f in "${ALLOWLIST[@]}"; do
  EXCLUDES+=("--glob" "!$f")
done

HITS=$(rg --no-heading --line-number "$PATTERN" "${SEARCH_ROOTS[@]}" \
  --glob '!**/*.test.ts' \
  --glob '!**/*.test.tsx' \
  "${EXCLUDES[@]}" \
  || true)

if [ -z "$HITS" ]; then
  echo "chain-agnostic check: OK — no new namespace branches in shared code."
  exit 0
fi

echo "chain-agnostic check: FAIL"
echo
echo "Found namespace === \"...\" branches in shared code. Each of these"
echo "will silently take the wrong branch when a new chain (Sui, Bitcoin,"
echo "...) is added. Move the chain-specific logic onto the kit via"
echo "services/walletKit/chainInfo.ts helpers or a new WalletKitAdapter"
echo "hook; shared code should dispatch through walletKitRegistry."
echo
echo "If the branch is genuinely intentional (dispatch table, per-chain"
echo "import UX), add the file to ALLOWLIST in this script with a one-"
echo "line justification."
echo
echo "Offending lines:"
echo "$HITS"
exit 1
