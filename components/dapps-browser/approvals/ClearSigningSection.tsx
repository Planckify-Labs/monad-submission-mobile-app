/**
 * Clear-signing section — task 65 (TWV-2026-066) Phases B/C/D UI.
 *
 * One shared block every sign sheet drops in. Renders, top to bottom:
 *
 *   1. Structured "what this does" card — automatic, no button — when
 *      the namespace's adapter (or a bespoke decoder) resolved a
 *      descriptor. When nothing resolved and the sheet opted in via
 *      `showUnrecognizedCard`, an explicit "Unrecognized contract
 *      call" card renders instead of a blank space or a guess.
 *   2. AI one-line summary — automatic, progressive. A one-line
 *      shimmer while the sentence loads; the row simply never appears
 *      when Phase B found nothing or the AI call fails (fail-silent,
 *      CLAUDE.md user-facing-errors rule).
 *   3. Signing digest block — labelled, monospace, byte-grouped,
 *      truncated with a single-tap reveal. Rendered even when the
 *      descriptor is null: that is the case where independent
 *      verification matters most. The digest is a display value, never
 *      a gate — nothing here touches approve/reject.
 *
 * Everything resolves through `walletKitRegistry` presence checks —
 * no `namespace ===` branches (`pnpm check:chains`).
 */

import React, { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ApprovalIntent } from "@/services/bridge/approval";
import { resolveClearSigningSummary } from "@/services/decoders/clearSigning";
import { summarizeClearSigningDescriptor } from "@/services/decoders/summarize";
import { walletKitRegistry } from "@/services/walletKit/registry";
import type {
  ClearSigningDescriptor,
  ComputeSigningDigestArgs,
  SigningDigest,
} from "@/services/walletKit/types";

interface Props {
  intent: ApprovalIntent;
  /**
   * Stage-1 structural call for descriptor resolution. Omit to skip
   * Phases B/D for this sheet (digest-only mode).
   */
  call?: unknown;
  /** Network hint (cluster / network / passphrase) for pinned reads. */
  network?: string;
  /**
   * Digest input. Memoize in the sheet (`useMemo`) — a fresh object
   * every render would re-run the digest effect. `null`/omitted hides
   * the digest block.
   */
  digestArgs?: ComputeSigningDigestArgs | null;
  /**
   * Render the explicit "Unrecognized contract call" card when
   * nothing resolves. Sheets whose raw fallback already fills that
   * role leave it off.
   */
  showUnrecognizedCard?: boolean;
  /**
   * Fires once resolution settles (with `null` on no-match) so the
   * sheet can feed the structured intent into independent cross-checks
   * (task 65 Phase F claim-vs-delta). Keep the callback stable
   * (useCallback) — it's an effect dependency.
   */
  onDescriptorResolved?: (descriptor: ClearSigningDescriptor | null) => void;
}

const SOURCE_LABEL: Record<ClearSigningDescriptor["source"], string> = {
  erc7730: "Matched against the bundled ERC-7730 registry snapshot",
  "onchain-idl": "Read from the program's own on-chain IDL",
  "normalized-move": "Read from the package's on-chain Move interface",
  "soroban-spec": "Read from the contract's on-chain Soroban spec",
  bespoke: "Recognized by a built-in decoder",
};

/** Group a digest for scanability: 4-byte (8-hex-char) chunks. */
function groupDigest(value: string): string {
  const prefixed = value.startsWith("0x");
  const body = prefixed ? value.slice(2) : value;
  const chunks = body.match(/.{1,8}/g) ?? [body];
  return (prefixed ? "0x" : "") + chunks.join(" ");
}

function truncateDigest(value: string): string {
  const prefixed = value.startsWith("0x");
  const body = prefixed ? value.slice(2) : value;
  if (body.length <= 20) return groupDigest(value);
  const head = body.slice(0, 8);
  const tail = body.slice(-8);
  return `${prefixed ? "0x" : ""}${head} … ${tail}`;
}

export function ClearSigningSection({
  intent,
  call,
  network,
  digestArgs,
  showUnrecognizedCard = false,
  onDescriptorResolved,
}: Props): React.ReactElement | null {
  const ns = intent.namespace;

  // undefined = resolving, null = unrecognized, value = resolved.
  const [descriptor, setDescriptor] = useState<
    ClearSigningDescriptor | null | undefined
  >(call === undefined ? null : undefined);
  const [summary, setSummary] = useState<string | null | undefined>(undefined);
  const [digest, setDigest] = useState<SigningDigest | null>(null);
  const [revealed, setRevealed] = useState(false);

  // Phase B — descriptor resolution (automatic, on mount).
  useEffect(() => {
    if (call === undefined) {
      setDescriptor(null);
      onDescriptorResolved?.(null);
      return;
    }
    let alive = true;
    void resolveClearSigningSummary(ns, { call, network }).then(
      (d) => {
        if (!alive) return;
        setDescriptor(d);
        onDescriptorResolved?.(d);
      },
      () => {
        if (!alive) return;
        setDescriptor(null);
        onDescriptorResolved?.(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [ns, call, network, onDescriptorResolved]);

  // Phase D — AI summary, only ever fed a resolved descriptor.
  useEffect(() => {
    if (!descriptor) {
      setSummary(null);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    setSummary(undefined);
    void summarizeClearSigningDescriptor(descriptor, {
      signal: controller.signal,
    }).then(
      (s) => {
        if (alive) setSummary(s);
      },
      () => {
        if (alive) setSummary(null);
      },
    );
    return () => {
      alive = false;
      controller.abort();
    };
  }, [descriptor]);

  // Phase C — digest (independent of descriptor resolution, by rule).
  useEffect(() => {
    if (!digestArgs) {
      setDigest(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        if (!walletKitRegistry.has(ns)) return;
        const kit = walletKitRegistry.get(ns);
        const d = await kit.computeSigningDigest?.(digestArgs);
        if (alive) setDigest(d ?? null);
      } catch {
        if (alive) setDigest(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [ns, digestArgs]);

  const digestRows = useMemo(() => digest?.values ?? [], [digest]);

  return (
    <View>
      {descriptor && (
        <View className="bg-white border border-gray-200 rounded-xl p-3 mb-3">
          <Text className="text-xs text-gray-500 mb-1">What this does</Text>
          <Text className="text-sm font-semibold text-gray-900">
            {descriptor.intent}
          </Text>
          {descriptor.functionName && (
            <Text className="text-xs text-gray-500 mt-0.5" selectable>
              {descriptor.functionName}
            </Text>
          )}
          {descriptor.fields.map((f, i) => (
            <View key={`${f.label}-${i}`} className="flex-row mt-1">
              <Text className="text-xs text-gray-500 w-28">{f.label}</Text>
              <Text className="text-xs text-gray-900 flex-1" selectable>
                {f.value}
              </Text>
            </View>
          ))}
          <Text className="text-[10px] text-gray-400 mt-2">
            {SOURCE_LABEL[descriptor.source]}
          </Text>
        </View>
      )}

      {showUnrecognizedCard && descriptor === null && (
        <View className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3">
          <Text className="text-xs font-semibold text-amber-800">
            Unrecognized contract call
          </Text>
          <Text className="text-xs text-amber-800 mt-1">
            We could not identify what this call does. Review the raw data below
            before signing.
          </Text>
        </View>
      )}

      {descriptor && summary === undefined && (
        <View className="bg-gray-100 rounded-lg h-5 mb-3" />
      )}
      {descriptor && typeof summary === "string" && (
        <View className="bg-blue-50 border border-blue-100 rounded-xl p-3 mb-3">
          <Text className="text-xs text-blue-600 font-semibold mb-0.5">
            AI summary
          </Text>
          <Text className="text-sm text-blue-900">{summary}</Text>
        </View>
      )}

      {digestRows.length > 0 && (
        <Pressable
          onPress={() => setRevealed((r) => !r)}
          className="bg-gray-50 border border-gray-200 rounded-xl p-3 mb-3"
        >
          <Text className="text-xs text-gray-500 mb-1">
            Signing digest · verify on a second device
          </Text>
          {digestRows.map((row) => (
            <View key={row.label} className="mt-1">
              <Text className="text-[10px] text-gray-500">{row.label}</Text>
              <Text className="text-xs font-mono text-gray-900" selectable>
                {revealed ? groupDigest(row.value) : truncateDigest(row.value)}
              </Text>
            </View>
          ))}
          <Text className="text-[10px] text-gray-400 mt-2">
            {revealed ? "Tap to shorten" : "Tap to show the full value"}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
