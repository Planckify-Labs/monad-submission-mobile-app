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

import { Sparkles } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ApprovalIntent } from "@/services/bridge/approval";
import type { Namespace } from "@/services/chains/types";
import { resolveClearSigningSummary } from "@/services/decoders/clearSigning";
import { summarizeClearSigningDescriptor } from "@/services/decoders/summarize";
import { EMOJI_HASH_ROWS } from "@/services/security/emojiHash";
import { walletKitRegistry } from "@/services/walletKit/registry";
import type {
  ClearSigningDescriptor,
  ComputeSigningDigestArgs,
  SigningDigest,
} from "@/services/walletKit/types";
import { DetailCard, DetailCardTitle, DetailRow } from "./DetailCard";
import { EmojiHashGrid } from "./EmojiHashGrid";

type DigestView = "hex" | "emoji";

/** Pick a spot-check row different from the current one (when possible). */
function pickDifferentRow(current: number, rowCount: number): number {
  if (rowCount <= 1) return current;
  let next = Math.floor(Math.random() * (rowCount - 1));
  if (next >= current) next += 1;
  return next;
}

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
  /**
   * Where the signing-digest block renders.
   *
   * `"inline"` (default) keeps it inside this card, which is what every
   * sheet that has no technical drawer of its own wants. `"off"` hides
   * it here so a sheet can place `<SigningDigestBlock>` itself — the
   * EVM transaction sheet files it under "Advanced details", next to
   * the raw calldata it is a fingerprint of, rather than mid-sheet
   * between two human-readable cards.
   *
   * Hiding it never means dropping it: a sheet that passes `"off"` is
   * asserting it renders the block somewhere else.
   */
  digestPlacement?: "inline" | "off";
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

/**
 * Computes the namespace's signing digest for `args`.
 *
 * Extracted from `ClearSigningSection` so a sheet can render the digest
 * somewhere else (a technical drawer, a second column) without the
 * digest being computed twice: whichever side is not showing it passes
 * `null` and does no work.
 */
export function useSigningDigest(
  ns: Namespace,
  args: ComputeSigningDigestArgs | null | undefined,
): SigningDigest | null {
  const [digest, setDigest] = useState<SigningDigest | null>(null);
  useEffect(() => {
    if (!args) {
      setDigest(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        if (!walletKitRegistry.has(ns)) return;
        const kit = walletKitRegistry.get(ns);
        const d = await kit.computeSigningDigest?.(args);
        if (alive) setDigest(d ?? null);
      } catch {
        if (alive) setDigest(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [ns, args]);
  return digest;
}

/**
 * The labelled, byte-grouped digest rows plus the Hex/Emoji spot-check.
 * A display value, never a gate — nothing here touches approve/reject.
 */
export function SigningDigestBlock({
  digest,
  variant = "card",
}: {
  digest: SigningDigest | null;
  /** `"bare"` drops the card chrome, for nesting inside another card. */
  variant?: "card" | "bare";
}): React.ReactElement | null {
  const [revealed, setRevealed] = useState(false);
  const [digestView, setDigestView] = useState<DigestView>("hex");
  // The emoji spot-check row is owned here (not in EmojiHashGrid) so it
  // survives the Hex<->Emoji toggle. Picked once at random; only "Check
  // another row" moves it. The emoji grid itself never changes for a
  // given digest.
  const [spotCheckRow, setSpotCheckRow] = useState(() =>
    Math.floor(Math.random() * EMOJI_HASH_ROWS),
  );
  const rerollSpotCheckRow = useCallback(
    () => setSpotCheckRow((cur) => pickDifferentRow(cur, EMOJI_HASH_ROWS)),
    [],
  );

  const digestRows = useMemo(() => digest?.values ?? [], [digest]);
  // The canonical row is the actual signing digest (the last value in
  // every scheme: EIP-712 digest, calldata digest, tx hash). That is the
  // one worth fingerprinting for a cross-device spot-check.
  const canonicalRow = digestRows[digestRows.length - 1];

  if (digestRows.length === 0) return null;

  return (
    <View
      className={
        variant === "card"
          ? "bg-white border border-gray-100 rounded-2xl p-4 mb-3"
          : ""
      }
    >
      <View className="flex-row items-center justify-between mb-2">
        <Text className="text-xs text-light-matte-black/50 flex-1 pr-2">
          Signing digest · verify on a second device
        </Text>
        <View className="flex-row bg-light-main-container rounded-lg p-0.5">
          {(["hex", "emoji"] as const).map((mode) => {
            const on = digestView === mode;
            return (
              <Pressable
                key={mode}
                onPress={() => setDigestView(mode)}
                className={`px-2.5 py-1 rounded-md ${on ? "bg-white" : ""}`}
              >
                <Text
                  className={`text-[11px] font-semibold ${
                    on ? "text-light-primary-red" : "text-light-matte-black/50"
                  }`}
                >
                  {mode === "hex" ? "Hex" : "Emoji"}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {digestView === "hex" ? (
        <Pressable onPress={() => setRevealed((r) => !r)}>
          {digestRows.map((row) => (
            <View key={row.label} className="mt-1">
              <Text className="text-[10px] text-light-matte-black/50">
                {row.label}
              </Text>
              <Text
                className="text-xs font-mono text-light-matte-black"
                selectable
              >
                {revealed ? groupDigest(row.value) : truncateDigest(row.value)}
              </Text>
            </View>
          ))}
          <Text className="text-[10px] text-light-matte-black/40 mt-2">
            {revealed ? "Tap to shorten" : "Tap to show the full value"}
          </Text>
        </Pressable>
      ) : (
        canonicalRow && (
          <EmojiHashGrid
            value={canonicalRow.value}
            label={canonicalRow.label}
            activeRow={spotCheckRow}
            onCheckAnotherRow={rerollSpotCheckRow}
          />
        )
      )}
    </View>
  );
}

/**
 * Resolves the Stage-2 descriptor for a call. `undefined` while
 * resolving, `null` when nothing recognized it, a descriptor on a hit.
 *
 * Split out of `ClearSigningSection` so a sheet that wants to lay the
 * pieces out itself (the EVM transaction sheet folds them into its own
 * summary card) shares one resolution path with every sheet that just
 * drops the whole section in.
 */
export function useClearSigningDescriptor(
  ns: Namespace,
  args: {
    call?: unknown;
    network?: string;
    signer?: string;
    onResolved?: (d: ClearSigningDescriptor | null) => void;
  },
): ClearSigningDescriptor | null | undefined {
  const { call, network, signer, onResolved } = args;
  const [descriptor, setDescriptor] = useState<
    ClearSigningDescriptor | null | undefined
  >(call === undefined ? null : undefined);

  // Phase B — descriptor resolution (automatic, on mount).
  useEffect(() => {
    if (call === undefined) {
      setDescriptor(null);
      onResolved?.(null);
      return;
    }
    let alive = true;
    void resolveClearSigningSummary(ns, {
      call,
      network,
      // From the intent, never `useWallet()` — the dApp-bridge
      // isolation rule. This is also the address a marketplace decoder
      // checks consideration recipients against (spec §17.6): the
      // order's own `offerer` field is attacker-set and proves nothing.
      signer,
    }).then(
      (d) => {
        if (!alive) return;
        setDescriptor(d);
        onResolved?.(d);
      },
      () => {
        if (!alive) return;
        setDescriptor(null);
        onResolved?.(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [ns, call, network, signer, onResolved]);

  return descriptor;
}

/**
 * Phase D AI one-liner for a resolved descriptor. `undefined` while it
 * loads, `null` when there is nothing to say or the call failed —
 * fail-silent by rule, the row simply never appears.
 */
export function useClearSigningSummary(
  descriptor: ClearSigningDescriptor | null | undefined,
): string | null | undefined {
  const [summary, setSummary] = useState<string | null | undefined>(undefined);
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
  return summary;
}

/**
 * Decoder-declared cautions. Rendered above the descriptor so they are
 * read before the reassuring detail rather than after it, and kept out
 * of any host card: these are alerts, and an alert nested inside the
 * card it is warning about reads as part of the reassurance.
 *
 * Generic by design — the copy is written by whichever decoder claimed
 * the payload, so a newly docked standard raises a warning without this
 * component learning it exists.
 */
export function ClearSigningWarnings({
  descriptor,
}: {
  descriptor: ClearSigningDescriptor | null | undefined;
}): React.ReactElement | null {
  if (!descriptor?.warnings?.length) return null;
  return (
    <>
      {descriptor.warnings.map((w) => (
        <View
          key={w.title}
          className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-3"
        >
          <Text className="text-xs font-bold text-red-800 uppercase tracking-wider">
            {w.title}
          </Text>
          <Text className="text-sm text-red-900 mt-1">{w.detail}</Text>
        </View>
      ))}
    </>
  );
}

/**
 * The descriptor itself, without card chrome, so a host can place it
 * inside its own group.
 *
 * `showFields` exists because the fields are sometimes already on
 * screen: an `approve` descriptor's fields are exactly the spender and
 * allowance the EVM sheet renders as its headline rows, and printing
 * them again two lines lower is the duplication this layout removed.
 * The provenance line always stays — where a claim came from is never
 * redundant.
 */
export function ClearSigningBody({
  descriptor,
  showFields = true,
}: {
  descriptor: ClearSigningDescriptor;
  showFields?: boolean;
}): React.ReactElement {
  return (
    <View>
      <Text className="text-base font-semibold text-light-matte-black">
        {descriptor.intent}
      </Text>
      {descriptor.functionName && (
        <Text className="text-xs text-light-matte-black/50 mt-0.5" selectable>
          {descriptor.functionName}
        </Text>
      )}
      {showFields &&
        descriptor.fields.map((f, i) => (
          <DetailRow key={`${f.label}-${i}`} label={f.label} value={f.value} />
        ))}
      <Text className="text-[10px] text-light-matte-black/40 mt-2">
        {SOURCE_LABEL[descriptor.source]}
      </Text>
    </View>
  );
}

/** The "we could not identify this call" notice. */
export function UnrecognizedCallNotice(): React.ReactElement {
  return (
    <View className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-3">
      <Text className="text-xs font-semibold text-amber-800">
        Unrecognized contract call
      </Text>
      <Text className="text-xs text-amber-800 mt-1">
        We could not identify what this call does. Review the raw data below
        before signing.
      </Text>
    </View>
  );
}

/**
 * The AI one-liner. Chrome-free: a tinted box of its own turned a
 * one-sentence aside into the loudest thing on the sheet, above the
 * numbers it was describing.
 */
export function ClearSigningAiSummary({
  summary,
}: {
  summary: string | null | undefined;
}): React.ReactElement | null {
  if (summary === undefined) {
    return <View className="bg-light-matte-black/5 rounded-lg h-4 mt-1" />;
  }
  if (typeof summary !== "string") return null;
  return (
    <View className="flex-row items-start gap-1.5">
      <Sparkles size={12} color="#20222c" opacity={0.4} />
      <Text className="text-xs text-light-matte-black/60 flex-1 leading-4">
        {summary}
      </Text>
    </View>
  );
}

export function ClearSigningSection({
  intent,
  call,
  network,
  digestArgs,
  showUnrecognizedCard = false,
  onDescriptorResolved,
  digestPlacement = "inline",
}: Props): React.ReactElement | null {
  const ns = intent.namespace;
  const descriptor = useClearSigningDescriptor(ns, {
    call,
    network,
    signer: intent.wallet?.address,
    onResolved: onDescriptorResolved,
  });
  const summary = useClearSigningSummary(descriptor);
  // `null` when the host sheet renders the block itself, so the digest
  // is computed exactly once no matter where it ends up on screen.
  const digest = useSigningDigest(
    ns,
    digestPlacement === "off" ? null : digestArgs,
  );

  return (
    <View>
      <ClearSigningWarnings descriptor={descriptor} />
      {descriptor && (
        <DetailCard>
          <DetailCardTitle>What this does</DetailCardTitle>
          <ClearSigningBody descriptor={descriptor} />
          {(summary === undefined || typeof summary === "string") && (
            <View className="mt-2">
              <ClearSigningAiSummary summary={summary} />
            </View>
          )}
        </DetailCard>
      )}

      {showUnrecognizedCard && descriptor === null && (
        <UnrecognizedCallNotice />
      )}

      <SigningDigestBlock digest={digest} />
    </View>
  );
}
