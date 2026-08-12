#!/usr/bin/env bash
#
# TWV-2026-021 companion guard.
#
# `pollyfills.ts` calls `Object.freeze(Object.prototype)` to kill the
# prototype-pollution class. The cost is a sharp edge: a module that
# exports a binding named after an `Object.prototype` member compiles to
# `exports.toString = ...`, which assigns *through* the frozen prototype
# and throws in strict mode. Metro's `inlineRequires` defers the module
# to its first use, so the throw lands on an arbitrary screen rather than
# at boot. Full write-up + failure signatures:
# `docs/prototype-freeze-crash-retrospective.md`.
#
# This guard has itself been wrong three times. Each blind spot is now a
# named check below, because "the guard passed" was the reason each bad
# fix shipped:
#
#   1. It grepped the raw polyfill, so commented-out pre-loads counted.
#   2. It assumed CJS was safe. tsc emits `"use strict"` in CJS output,
#      so `ox/_cjs/**` throws exactly like the ESM build.
#   3. It only saw top-level packages. The offender that actually shipped
#      the crash lived in `node_modules/viem/node_modules/ox`, and a bare
#      `ox` specifier cannot reach it.
#
# Exit 1 when an installed copy of an offending package is not pre-loaded.

set -uo pipefail

cd "$(dirname "$0")/.."

POLYFILL="pollyfills.ts"
PROTO_MEMBERS="toString|hasOwnProperty|valueOf|toLocaleString|isPrototypeOf|propertyIsEnumerable"

if ! command -v rg >/dev/null 2>&1; then
  echo "proto-freeze check: SKIPPED (ripgrep not installed)"
  exit 0
fi

# Blind spot 1: match code only. The rationale comments quote pre-load
# lines verbatim, and a commented-out pre-load is the exact regression
# this exists to catch.
POLYFILL_CODE="$(grep -vE '^[[:space:]]*(//|\*|/\*)' "$POLYFILL")"

# Only hoisted `import "…"` statements count as a pre-load. The canary
# further down re-`require`s the same paths to verify they were warmed,
# but it runs AFTER the freeze, so it proves nothing about coverage.
# Matching it as if it did let a missing pre-load pass this guard.
POLYFILL_IMPORTS="$(grep -E '^[[:space:]]*import[[:space:]]+"' <<<"$POLYFILL_CODE")"

# Blind spot 3: `-uu` disables gitignore handling so nested
# `node_modules/<pkg>/node_modules/...` trees are searched. Without it rg
# skips them and the guard reports a clean tree that is not clean.
#
# Blind spot 2: both `export <decl> <name>` (ESM) and `exports.<name> =`
# (strict CJS) are fatal. Aliased re-exports (`export { x as toString }`)
# count too.
# ESM: always fatal. Metro compiles ESM with "use strict", so the
# assignment throws.
mapfile -t ESM_HITS < <(
  rg -l -uu --no-messages -g '*.js' -g '!*.min.js' -g '!*.map' -g '!*.d.ts' \
    -e "^\s*export (function|const|let|var) ($PROTO_MEMBERS)\b" \
    -e "^\s*export \{[^}]*\bas ($PROTO_MEMBERS)\b" \
    node_modules 2>/dev/null | sort -u
)

# CJS: fatal ONLY when the file opts into strict mode. Sloppy-mode CJS
# silently no-ops instead of throwing, which is a correctness bug in that
# package (its export is missing) but never a crash. `qrcode` is the
# standing example: `QRCode.toString` is quietly undefined and nothing
# in this app calls it.
mapfile -t CJS_ALL < <(
  rg -l -uu --no-messages -g '*.js' -g '!*.min.js' -g '!*.map' -g '!*.d.ts' \
    -e "^\s*exports\.($PROTO_MEMBERS)\s*=" \
    node_modules 2>/dev/null | sort -u
)
CJS_STRICT=()
CJS_SLOPPY=()
for f in "${CJS_ALL[@]}"; do
  [[ -z "$f" ]] && continue
  if head -5 "$f" 2>/dev/null | grep -q '"use strict"\|'"'"'use strict'"'"''; then
    CJS_STRICT+=("$f")
  else
    CJS_SLOPPY+=("$f")
  fi
done

HITS=("${ESM_HITS[@]}" "${CJS_STRICT[@]}")

# Reachability / transitive-coverage allowlist, with reasons. Same shape
# as the allowlist in `scripts/check-chain-agnostic.sh`. Only add an entry
# you can justify in one line, and prefer a real pre-load over an excuse.
declare -A ALLOWLIST=(
  # Warmed transitively by the `posthog-react-native` pre-load already in
  # pollyfills.ts (that pre-load exists for exactly this package).
  ["@posthog/core"]="covered by the posthog-react-native pre-load"
  # No package declares a dependency on it and no app code imports it, so
  # Metro never reaches it from the entry point and it is never bundled.
  ["lodash-es"]="unreachable: nothing imports it, so Metro never bundles it"
)

# Package root for a path, keeping the nesting prefix so two copies of
# the same package are distinct entries:
#   node_modules/ox/_esm/core/Hex.js                     -> ox
#   node_modules/viem/node_modules/ox/_cjs/core/Hex.js   -> viem/node_modules/ox
pkg_root_of() {
  local p="${1#node_modules/}" out=""
  while [[ "$p" == *node_modules/* ]]; do
    out+="${p%%node_modules/*}node_modules/"
    p="${p#*node_modules/}"
  done
  if [[ "$p" == @* ]]; then
    out+="$(cut -d/ -f1-2 <<<"$p")"
  else
    out+="$(cut -d/ -f1 <<<"$p")"
  fi
  printf '%s' "$out"
}

FAILED=0
declare -A REPORTED=()

for hit in "${HITS[@]}"; do
  [[ -z "$hit" ]] && continue
  rel="${hit#node_modules/}"

  # Build-time-only tooling never reaches a device bundle.
  case "$rel" in
    @expo/prebuild-config/*|@expo/config-plugins/*|expo-modules-autolinking/*|*/prebuild-config/*) continue ;;
  esac

  pkg="$(pkg_root_of "$hit")"

  bare_pkg="${pkg##*node_modules/}"
  if [[ -n "${ALLOWLIST[$bare_pkg]:-}" ]]; then
    if [[ -z "${REPORTED[$pkg]:-}" ]]; then
      REPORTED[$pkg]=1
      echo "  allowed: $bare_pkg (${ALLOWLIST[$bare_pkg]})"
    fi
    continue
  fi

  # Coverage is per *module file*, per *copy* — not per package name.
  # Both halves of that matter, and each was a hole that shipped:
  #   - per copy: `import "ox"` reaches only the hoisted ox@0.8.1 and
  #     leaves viem's nested ox@0.9.6 cold.
  #   - per module: a subpath warms one module, and the next consumer
  #     reaches a different one.
  # Exact file, not "some build of this module". `_cjs` and `_esm` are
  # DIFFERENT Metro modules and only one of them is the one the app
  # loads — which one depends on package-exports resolution and is not
  # worth predicting. Accepting either build is how a fix that warmed
  # only `_esm` passed this guard while the `_cjs` twin the app actually
  # imports stayed cold and kept throwing. Both must be pre-loaded.
  if grep -qF "\"./$hit\"" <<<"$POLYFILL_IMPORTS"; then
    continue
  fi

  FAILED=1
  # One line per package copy, not per build variant: `_esm` and `_cjs`
  # of the same module would otherwise report twice.
  [[ -n "${REPORTED[$pkg]:-}" ]] && continue
  REPORTED[$pkg]=1
  echo "proto-freeze check: FAIL — '$pkg' exports an Object.prototype name and is not pre-loaded"
  echo "    first uncovered: $rel"
done

if [[ "$FAILED" == "1" ]]; then
  cat <<'EOF'

Why this fails the build:

  `exports.toString = ...` throws once Object.prototype is frozen. With
  inlineRequires the throw is deferred to the first screen that touches
  the module, so it presents as an unrelated UI crash (or, worse, as a
  security feature that silently stopped working).

Fix: pre-load the offending FILE in pollyfills.ts ABOVE the
`Object.freeze(Object.prototype)` call, by exact path, one line per
offending module per installed copy:

  import "./node_modules/<pkg>/<path-to-module>.js";
  import "./node_modules/<parent>/node_modules/<pkg>/<path-to-module>.js";

The path form is deliberate. Every tidier spelling has already failed on
device:
  - `require("pkg/sub")` and `import "pkg/sub"` can resolve to DIFFERENT
    module instances via a condition-split "exports" map.
  - A package subpath only warms what is on that one path; the next
    consumer reaches a different module.
  - A barrel warms everything but drags the whole package through
    startup, and its `export * as X from` re-exports can become lazy
    getters under inlineRequires, warming nothing.
  - A bare specifier only ever reaches the hoisted copy. Nested copies
    (two exact pins on one package) need their own line.

Prefer `_esm` over `_cjs`: Metro resolves the `import` condition.

Then verify ON DEVICE. This guard proves the pre-load exists; only the
device proves it warmed the right module. "First attempt after a cold JS
context fails, later ones succeed" means it did not.
EOF
  exit 1
fi

echo "proto-freeze check: OK — every installed Object.prototype-shadowing package is pre-loaded."

if [[ "${#CJS_SLOPPY[@]}" -gt 0 ]]; then
  mapfile -t SLOPPY_PKGS < <(for f in "${CJS_SLOPPY[@]}"; do pkg_root_of "$f"; echo; done | sort -u)
  echo "  note: sloppy-mode CJS, export silently vanishes rather than throwing: ${SLOPPY_PKGS[*]}"
fi
