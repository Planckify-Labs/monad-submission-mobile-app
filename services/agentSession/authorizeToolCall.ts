/**
 * `authorizeToolCall()` — the SINGLE authorization decision for every
 * agent tool call (deny-layer spec §6.1).
 *
 * This is the one place that answers "is the agent allowed to run this
 * tool?". The dispatcher switches purely on the `decision` this returns;
 * no other code makes that call. It is pure and unit-testable — it reads
 * the wallet's grant store + approval policy (via the existing
 * `resolveUxTreatment` resolver) and folds them into one of three
 * outcomes:
 *
 *   - `authorized` — the agent already has permission. Writes still show
 *     the 6 s run-down veto (`treatment: "rundown"`); reads run silently
 *     (`treatment: "silent"`).
 *   - `ask`        — no standing permission; the user must make a
 *     deliberate two-step choice (proposal card → approval sheet).
 *   - `deny`       — hard reject. `reason` records why (for `__DEV__`
 *     logs only — the wire reason the agent sees is the fixed
 *     `permission_denied` token, per the user-facing-error rule).
 *
 * The model is the spec's `Scope → {Auto | Ask | Never}` (§4.0):
 *   - `Never` (`always_deny` grant) → `deny`. Deny-overrides-allow is
 *     enforced inside `resolveGrant`.
 *   - `Auto` (permanent/session/timed grant) → `authorized`.
 *   - `Ask` (`always_ask`, or the safe default) → `ask`.
 *   - watch-only wallet → `deny`.
 *   - headless (`interactive === false`) + would-be-`ask` → `deny`
 *     (`approval_unavailable`): fail closed when no human can approve.
 */

import {
  extractCounterparty,
  type ToolCounterparty,
} from "../agent-executors/counterparty.ts";
import { MOBILE_WRITE_TOOLS } from "../agent-executors/expectedMobileTools.ts";
import type { ToolInput } from "../agent-executors/types.ts";
import type { Namespace } from "../chains/types.ts";
import { resolveGrant, type ToolCapability } from "../permissionGrantStore.ts";
import {
  type ConnectedWallet,
  resolveUXTreatment,
} from "../resolveUxTreatment.ts";

export type PermissionDecision = "authorized" | "ask" | "deny";

/**
 * Why an otherwise-authorized call was pulled back to `ask`. Escalation is
 * NOT a denial — the grant is still valid, the user is just brought back
 * into the loop for something the grant never spoke to.
 */
export type PermissionEscalationReason = "unknown_counterparty";

export type PermissionDenyReason =
  | "policy_denied" // always_deny grant (the `Never` rule), or policy = blocked
  | "watch_only" // wallet cannot sign
  | "approval_unavailable"; // headless: ask required, no human present

/**
 * Presentation hint for the dispatcher / UI:
 *   - `rundown` — authorized write: 6 s auto-execute veto card.
 *   - `silent`  — authorized read (or a deliberately-silent override like
 *     x402 micropayments).
 *   - `ask`     — proposal card → approval sheet, no timer.
 *
 * `deny` decisions carry `treatment: "silent"` as an inert placeholder —
 * the dispatcher never renders a card for a deny, it rejects.
 */
export type PermissionTreatment = "rundown" | "silent" | "ask";

/**
 * Opaque, branded authorization token. The ONLY constructor is the
 * private `mintToken()` below — a value of this type cannot be produced
 * outside this module, so any code path calling `executeToolWithRetry`
 * (which now requires one) must have gone through `authorizeToolCall`.
 * This upgrades "single source of truth" from convention to a
 * compile-time guarantee (spec §6.4 / INV-3).
 */
declare const authorizationTokenBrand: unique symbol;
export type AuthorizationToken = {
  readonly [authorizationTokenBrand]: "agent-tool-authorization";
};

function mintToken(): AuthorizationToken {
  // The brand is a phantom type only — at runtime the token is an inert
  // marker. Its value carries no authority; the compile-time brand is the
  // guarantee.
  return Object.freeze({}) as unknown as AuthorizationToken;
}

export interface ToolAuthorization {
  decision: PermissionDecision;
  treatment: PermissionTreatment;
  reason?: PermissionDenyReason;
  /** Set when a grant was overridden by the envelope (§4.0 extension). */
  escalated?: PermissionEscalationReason;
  /**
   * The counterparty this call points value at, when it has one. Passed
   * back so the approval sheet can DISPLAY it and, on an explicit
   * approval, record it as confirmed.
   */
  counterparty?: ToolCounterparty;
  /** Required by `executeToolWithRetry`. Minted only here. */
  token: AuthorizationToken;
}

export interface AuthorizeToolCallArgs {
  capability: ToolCapability;
  toolName: string;
  wallet: ConnectedWallet;
  sessionId: string;
  /**
   * Whether a human is present to approve. `true` for the chat screen.
   * `false` for any future headless/autonomous run — a would-be `ask`
   * then fails closed to `deny(approval_unavailable)`.
   */
  interactive: boolean;
  /** The tool's arguments — read only to locate the counterparty. */
  input?: ToolInput;
  /**
   * Namespace of the paying wallet, for the chain-agnostic send
   * capabilities whose destination chain is the wallet's own.
   */
  walletNamespace?: Namespace;
  /**
   * Has the user explicitly confirmed this counterparty before?
   *
   * INJECTED rather than imported so this gate stays pure and
   * synchronous — the real implementation reads MMKV and canonicalises
   * addresses through the wallet-kit registry, neither of which belongs
   * inside a unit-testable decision function (same reasoning as
   * `ConnectedWallet.grantStore`).
   *
   * Omitted → the envelope is not applied and behaviour is exactly as
   * before. Callers that move funds MUST supply it.
   */
  isCounterpartyConfirmed?: (counterparty: ToolCounterparty) => boolean;
}

function isReadCapability(capability: ToolCapability): boolean {
  return capability === "read" || capability === "defi_read";
}

/**
 * The single source of truth for agent-tool authorization.
 */
export function authorizeToolCall(
  args: AuthorizeToolCallArgs,
): ToolAuthorization {
  const { toolName, wallet, sessionId, interactive } = args;

  // Fund-safety cross-check (defense-in-depth): `args.capability` is the
  // server's `meta.capability` label, which travels over the network. NEVER
  // let a tool the mobile KNOWS is a write (`MOBILE_WRITE_TOOLS`) be treated as
  // a read just because the wire said so — a mislabeled write would otherwise
  // run silently with no approval card (the "agent moved funds without asking"
  // class). Coerce to the more restrictive capability; a mismatch is a real
  // drift/tamper signal, so log it (dev only — raw detail never reaches users).
  let capability = args.capability;
  if (capability === "read" && MOBILE_WRITE_TOOLS.has(toolName)) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(
        `[authorizeToolCall] wire labeled known-write "${toolName}" as read — ` +
          "coercing to write (approval required). Possible registry drift or tampered stream.",
      );
    }
    capability = "write";
  }

  const token = mintToken();

  // Located ONCE, up front, and reported on every non-deny outcome — not
  // just the escalated one. The plain `ask` path (no grant at all) is
  // where most approvals happen, and its sheet is exactly the surface
  // that legitimises a confirmation; skipping it would mean a user who
  // approves ten sends by hand still gets re-prompted for every one of
  // them the day they turn a grant on.
  const counterparty =
    extractCounterparty(toolName, args.input, args.walletNamespace) ??
    undefined;

  // Resolve the effective grant once so we can tell a `Never`
  // (`always_deny`) apart from a watch-only block — both surface as the
  // `blocked` treatment, but the agent-facing distinction matters for
  // `__DEV__` logs and future on-chain tiering.
  const grant = resolveGrant(
    toolName,
    capability,
    wallet.address,
    sessionId,
    wallet.grantStore,
  );

  if (grant.type === "always_deny") {
    return {
      decision: "deny",
      treatment: "silent",
      reason: "policy_denied",
      token,
    };
  }

  // Reuse the existing resolver for the grant ⊕ policy fold.
  // It returns silent | preview | confirm | blocked.
  const ux = resolveUXTreatment(capability, toolName, wallet, sessionId);

  if (ux === "blocked") {
    // Not an `always_deny` (handled above) → a watch-only / unsignable
    // wallet.
    return {
      decision: "deny",
      treatment: "silent",
      reason: "watch_only",
      token,
    };
  }

  if (ux === "confirm") {
    // No standing permission → Ask. Fail closed when no human can approve.
    if (!interactive) {
      return {
        decision: "deny",
        treatment: "silent",
        reason: "approval_unavailable",
        token,
      };
    }
    return { decision: "ask", treatment: "ask", counterparty, token };
  }

  // ux === "silent" | "preview" → the agent already has permission.
  if (isReadCapability(capability)) {
    return { decision: "authorized", treatment: "silent", token };
  }

  // --- Known-destination envelope (§4.0 extension) ------------------
  // A grant answers "may the agent act unattended?", never "do I accept
  // THIS destination?". The first time value is pointed at an address the
  // user has not confirmed, hand the decision back — the grant stays
  // intact, this one call just needs a human. Guards the case a standing
  // permission cannot: an address the user has never laid eyes on.
  if (counterparty && args.isCounterpartyConfirmed) {
    let known = false;
    try {
      known = args.isCounterpartyConfirmed(counterparty);
    } catch (err) {
      // Fail CLOSED: an unreadable confirmation store means "not known",
      // which asks. Treating a lookup failure as "confirmed" would turn a
      // storage bug into silent authorization.
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn(
          `[authorizeToolCall] counterparty lookup threw for "${toolName}": ${String(err)}`,
        );
      }
      known = false;
    }
    if (!known) {
      // Headless has nobody to confirm to, so the same fail-closed rule as
      // any other `ask` applies.
      if (!interactive) {
        return {
          decision: "deny",
          treatment: "silent",
          reason: "approval_unavailable",
          counterparty,
          token,
        };
      }
      return {
        decision: "ask",
        treatment: "ask",
        escalated: "unknown_counterparty",
        counterparty,
        token,
      };
    }
  }

  // Authorized WRITE. Per §D-1 every authorized write shows the run-down
  // veto — never silent — INCLUDING "Full auto" (a global permanent
  // grant) and threshold-covered writes (`preview`). The lone exception
  // is a deliberately-silent policy override (x402 micropayments settle
  // within a pre-signed allowance with no prompt) — honour that so we
  // don't regress the x402 "no user prompt" contract.
  const silentOverride =
    wallet.approvalPolicy.tool_overrides?.[toolName] === "silent";
  return {
    decision: "authorized",
    treatment: silentOverride ? "silent" : "rundown",
    counterparty,
    token,
  };
}
