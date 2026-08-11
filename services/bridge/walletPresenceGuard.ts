/**
 * "The user has no wallet on this chain" — decided once, for every
 * chain adapter.
 *
 * Each adapter's `pick<X>WalletForOrigin` already returns `null` when the
 * device holds nothing on its namespace, and each adapter then failed the
 * request at the protocol layer (`PROVIDER_ERRORS.disconnected()`,
 * `rpcError(4100, "no Sui wallet available")`, …). That is correct as
 * protocol behaviour and useless as product behaviour: the rejection is
 * handed to the dApp's own JavaScript, so Takumi renders nothing at all
 * and the user is left reading whatever generic "no wallet found" string
 * the site happens to show. They are never told the actual problem, and
 * never offered the one action that fixes it.
 *
 * Rather than teach four adapters the same lesson (and a fifth later),
 * the decision lives here. Adapters keep their own `makeIntent` and
 * payload shapes — those genuinely differ per namespace — but the rule
 * for *when* a missing wallet becomes a user-facing prompt is written
 * once.
 *
 * Returning a `needs-approval` intent with `wallet: null` is deliberate:
 * it reuses the approval pipeline that already exists
 * (`DappBridge` → `ApprovalHost` → `ConnectSheet`) with no new plumbing.
 * `ConnectSheet` derives its wallet list reactively from `useWallet()`
 * rather than from `intent.wallet`, so a null wallet renders its
 * (previously unreachable) empty state, and the moment the user imports
 * a wallet the sheet flips to the normal picker without a round trip.
 */

import type {
  AdapterContext,
  ChainResult,
  Namespace,
} from "@/services/chains/types";
import { hasWalletForNamespace } from "@/services/walletPresence";
import type { ApprovalIntent } from "./approval";

/**
 * @param silent  The dApp's eager/`onlyIfTrusted` reconnect probe. dApps
 *   fire these unprompted on every mount, so they must stay silent
 *   protocol errors — surfacing a sheet here would pop an unrequested
 *   modal on page load. Callers keep their own early-return for this.
 * @returns `null` when the caller should proceed as normal; a
 *   `needs-approval` result when the user should be told instead.
 */
export function guardWalletPresence(
  ctx: AdapterContext,
  namespace: Namespace,
  silent: boolean,
  buildIntent: () => ApprovalIntent,
): ChainResult | null {
  if (silent) return null;
  if (hasWalletForNamespace(ctx.wallets, namespace)) return null;
  return { status: "needs-approval", intent: buildIntent() };
}
