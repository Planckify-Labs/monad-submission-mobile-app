/**
 * Sui PTB semantic-pass dock.
 *
 * `SuiPtbDecoderInspector` produces a *structural* view of a PTB:
 * MoveCall, SplitCoins, TransferObjects, Publish, and so on. That view
 * is standard-agnostic and always correct, but it cannot tell a user
 * that the three commands in front of them are an NFT purchase with a
 * royalty payment.
 *
 * Standard-level readings dock here. A pass takes the structural
 * commands plus the decoded inputs and returns `SuiPtbSemantic` rows —
 * a generic `code` + hand-written label/value pairs. Because the output
 * is generic, adding a standard (DeepBook orders, closed-loop token
 * policies, a future NFT standard) touches exactly one new file plus a
 * `registerPtbSemanticPass` call: the payload types, the inspector and
 * the approval sheet all stay unchanged.
 *
 * Two rules every pass must hold to:
 *
 *   1. **Offline only.** Passes run inside a priority-15 decode
 *      inspector. No RPC, no async, no clock. Everything a pass reports
 *      must be derivable from the bytes the user is about to sign.
 *   2. **Silence over guessing.** A pass that cannot resolve a value
 *      omits the row or marks it unresolved. It must never interpolate
 *      a plausible number, because the row it renders is the thing the
 *      user is trusting instead of reading the raw PTB.
 */

import type {
  SuiDecodedCommand,
  SuiDecodedInput,
  SuiPtbSemantic,
} from "./payloads";

export interface PtbSemanticContext {
  commands: SuiDecodedCommand[];
  inputs: SuiDecodedInput[];
}

export interface PtbSemanticPass {
  /** Stable identifier, used only for dev logging. */
  name: string;
  /** Return `null` or `[]` when the PTB is not this pass's business. */
  run(ctx: PtbSemanticContext): SuiPtbSemantic[] | null;
}

const passes: PtbSemanticPass[] = [];

/** Dock a pass. Re-registering the same name replaces it. */
export function registerPtbSemanticPass(pass: PtbSemanticPass): void {
  const i = passes.findIndex((p) => p.name === pass.name);
  if (i >= 0) passes[i] = pass;
  else passes.push(pass);
}

/** Test seam. */
export function __resetPtbSemanticPasses(): void {
  passes.length = 0;
}

/**
 * Run every docked pass. A pass that throws is skipped: a broken
 * semantic reading must degrade to the structural view, never take down
 * the decode that the approval sheet depends on.
 */
export function runPtbSemantics(ctx: PtbSemanticContext): SuiPtbSemantic[] {
  const out: SuiPtbSemantic[] = [];
  for (const pass of passes) {
    try {
      const rows = pass.run(ctx);
      if (rows?.length) out.push(...rows);
    } catch (err) {
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn(`[ptbSemantics] pass "${pass.name}" failed`, err);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Shared helpers for passes.
// ---------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    if (typeof atob === "function") {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
}

/**
 * Read a BCS `u64` out of a pure input. Returns `null` unless the input
 * is exactly 8 bytes — anything else is a different Move type, and
 * coercing it would be the kind of guess rule 2 forbids.
 */
export function pureAsU64(input: SuiDecodedInput | undefined): bigint | null {
  if (!input || input.kind !== "pure") return null;
  const bytes = base64ToBytes(input.bytes);
  if (!bytes || bytes.length !== 8) return null;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

/** Format a MIST amount as SUI, trimming trailing zeros. */
export function formatMist(mist: bigint): string {
  const whole = mist / 1_000_000_000n;
  const frac = mist % 1_000_000_000n;
  if (frac === 0n) return `${whole.toString()} SUI`;
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr} SUI`;
}
