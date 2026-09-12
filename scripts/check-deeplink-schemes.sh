#!/usr/bin/env bash
# check-deeplink-schemes.sh — deep-link spec invariant S-16.
#
# Chain knowledge for deep links lives in `services/chains/<ns>/deeplinks.ts`
# and the per-transport handlers; the kernel (`services/deeplinks/`),
# screens (`app/`), hooks and components dispatch through the scheme
# registry and never name a scheme. This fails when a scheme literal
# shows up where it does not belong.
#
# Exempt on purpose: `services/deeplinks/paths/` (the universal-link
# path handlers unwrap chain URIs by design), the registry/boot files
# (they list registrations), and tests.
#
# Run via `pnpm check:deeplinks`. Exits 0 on clean, 1 with the offending
# lines otherwise.
set -euo pipefail

SEARCH_ROOTS=(app hooks components services/deeplinks)

# `"solana:"` / `"ethereum:"` as a bare scheme prefix (a CAIP-2 chain id
# such as `"solana:5eykt…"` is not a scheme use and is allowed).
PATTERN='(ethereum|solana):["'"'"']|"web\+stellar|"sui:pay|"wc:|"solana-wallet'

ALLOWLIST=(
  # Universal-link path handlers unwrap the inner chain URI (spec §4.4).
  "services/deeplinks/paths/mwa.ts"
  # The registry / boot list registrations by handler id, not scheme.
  "services/deeplinks/boot.ts"
  "services/deeplinks/schemeRegistry.ts"
)

if ! command -v rg >/dev/null 2>&1; then
  echo "check-deeplink-schemes: ripgrep (rg) not found; install it or skip this check." >&2
  exit 0
fi

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
  echo "deeplink-scheme check: OK — no scheme literals outside the chain handlers."
  exit 0
fi

echo "deeplink-scheme check: FAIL"
echo
echo "A deep-link scheme literal appeared in shared code. Register a"
echo "DeepLinkSchemeHandler in services/chains/<ns>/deeplinks.ts (or the"
echo "transport's deeplinks.ts) and let the registry dispatch instead."
echo
echo "Offending lines:"
echo "$HITS"
exit 1
