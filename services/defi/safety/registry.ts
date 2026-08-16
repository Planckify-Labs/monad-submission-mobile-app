/**
 * Safety registry + runner (spec §11.0c, §11.4).
 *
 * Space-docking, exactly like `registerResolver` / `registerDefiAdapter`: a
 * check registers itself and declares what it applies to; a chain registers its
 * provider. The runner knows nothing about any chain or any protocol — it
 * selects the checks whose `appliesTo` matches `(namespace, kind, stage)`, runs
 * them in layer order, and **short-circuits fail-closed** on the first failure.
 *
 * Every result is logged, pass and fail, because §11.6 #7 requires an incident
 * to be reconstructable: "which check let this through / blocked this" is not a
 * question you can answer after the fact from failures alone.
 */

import type { Namespace } from "@/services/chains/types";
import { DefiError, type DefiErrorCode } from "../errors/defiErrors";
import type {
  ChainSafetyProvider,
  PipelineResult,
  SafetyCheck,
  SafetyContext,
  SafetyResult,
} from "./types";

const checks: SafetyCheck[] = [];
const providers = new Map<Namespace, ChainSafetyProvider>();

export function registerSafetyCheck(check: SafetyCheck): void {
  // De-dupe by id so a double-bootstrap doesn't run a check twice.
  const idx = checks.findIndex((c) => c.id === check.id);
  if (idx >= 0) checks[idx] = check;
  else checks.push(check);
}

export function registerChainSafetyProvider(
  provider: ChainSafetyProvider,
): void {
  providers.set(provider.namespace, provider);
}

export function getChainSafetyProvider(
  namespace: Namespace,
): ChainSafetyProvider | null {
  return providers.get(namespace) ?? null;
}

export function listSafetyChecks(): readonly SafetyCheck[] {
  return [...checks];
}

/** Reset hook for tests — never called in app code. */
export function resetSafetyRegistry(): void {
  checks.length = 0;
  providers.clear();
}

/** The checks that apply to this context, in layer order. */
export function selectChecks(ctx: SafetyContext): SafetyCheck[] {
  return checks
    .filter((check) => {
      const a = check.appliesTo;
      if (!a) return true;
      if (a.namespaces && !a.namespaces.includes(ctx.namespace)) return false;
      if (a.kinds && !a.kinds.includes(ctx.target.kind)) return false;
      if (a.stages && !a.stages.includes(ctx.stage)) return false;
      if (a.actions && !a.actions.includes(ctx.action)) return false;
      return true;
    })
    .sort((x, y) => x.layer - y.layer);
}

/**
 * Immutable audit record for one check (§11.6 #7). Never logs secrets or raw
 * signer material; the detail field carries a curated reason, not a body.
 */
export interface SafetyAuditEntry {
  checkId: string;
  layer: number;
  verdict: "pass" | "fail" | "error";
  fail?: DefiErrorCode;
  detail?: string;
  target: string;
  wallet: string;
  chainId: number | string;
  ts: number;
}

type AuditSink = (entry: SafetyAuditEntry) => void;

let auditSink: AuditSink = (entry) => {
  // Default sink: dev-only console. Production wiring (analytics / an
  // append-only log) registers its own; either way the raw detail never
  // reaches a user-facing surface.
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn("[defi/safety]", entry);
  }
};

export function setSafetyAuditSink(sink: AuditSink): void {
  auditSink = sink;
}

/**
 * Run the pipeline. Returns on the FIRST failure — later layers are more
 * expensive and a failed cheap check means the target is already untrusted.
 *
 * A check that throws is treated as a failure, not as a pass: an exception is
 * exactly the case where we do not know whether the property holds, and "we
 * don't know" must never authorise moving funds.
 */
export async function runSafetyPipeline(
  ctx: SafetyContext,
): Promise<PipelineResult> {
  const selected = selectChecks(ctx);
  const ran: string[] = [];

  for (const check of selected) {
    let result: SafetyResult;
    try {
      result = await check.run(ctx);
    } catch (err) {
      result = {
        ok: false,
        fail: "unknown",
        detail: `check threw: ${err instanceof Error ? err.name : "error"}`,
      };
    }
    ran.push(check.id);
    auditSink({
      checkId: check.id,
      layer: check.layer,
      verdict: result.ok ? "pass" : "fail",
      fail: result.ok ? undefined : result.fail,
      detail: result.ok ? undefined : result.detail,
      target: ctx.target.kind,
      wallet: ctx.wallet,
      chainId: ctx.chainId,
      ts: Date.now(),
    });
    if (!result.ok) {
      return {
        ok: false,
        fail: result.fail,
        layer: check.layer,
        id: check.id,
        detail: result.detail,
        ran,
      };
    }
  }

  return { ok: true, ran };
}

/** Convenience for the common "throw a typed DefiError on failure" call site. */
export function assertSafetyResult(result: PipelineResult): void {
  if (result.ok) return;
  // Statically imported, deliberately. A lazy `require` here yields a SECOND
  // copy of the class under any ESM loader, so `err instanceof DefiError` in
  // the caller's classifier is false and every safety verdict — including
  // `insufficient_funds` — degrades to `unknown`. `defiErrors.ts` imports
  // nothing, so there is no cycle to dodge.
  throw new DefiError(
    result.fail,
    `${result.id} (layer ${result.layer})${result.detail ? `: ${result.detail}` : ""}`,
  );
}
