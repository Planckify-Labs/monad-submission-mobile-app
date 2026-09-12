/**
 * Pure helpers behind the "Connected apps" list: how browser grants and
 * transport sessions fold into one entry per app, and the per-session
 * facts the rows display. No React here so the shaping is unit-testable.
 */

import type { DappConnectionSite } from "@/hooks/useDappConnections";
import type { Namespace } from "@/services/chains/types";
import { originHost } from "@/services/permissions/caip";
import type { TransportSession } from "@/services/transports/types";
import { canonicalizeAddress } from "@/services/walletKit/chainInfo";

const DAY_MS = 86_400_000;

/**
 * One app as the user thinks of it: everything connected to a host,
 * whether the wallet reached it through the in-app browser (a grant on
 * the WebView origin), a WalletConnect / MWA / app-link session, or both
 * at once. Keyed by host, the same join `useDappConnections` uses to
 * match a session to the open site, so the two never appear as separate
 * cards.
 */
export interface ConnectedApp {
  /** Host (`pancakeswap.finance`); a session's peer name when it has no URL. */
  key: string;
  /** The browser grant for this host, if any. */
  site?: DappConnectionSite;
  /** Sessions for this host, most recently active first. */
  sessions: TransportSession[];
  /** First session's peer icon, when one is present. */
  icon?: string;
}

/**
 * Sites keep their order (most recently connected first) and sessions of
 * the same host fold into them; hosts that only have sessions follow, most
 * recently active first.
 */
export function buildConnectedApps(
  sites: DappConnectionSite[],
  sessions: TransportSession[],
): ConnectedApp[] {
  const apps = new Map<string, ConnectedApp>();
  for (const site of sites) {
    const key = originHost(site.origin);
    apps.set(key, { key, site, sessions: [] });
  }
  for (const s of [...sessions].sort(byRecency)) {
    const host = s.peer.url ? originHost(s.peer.url) : "";
    const key = host || s.peer.name || `${s.transport}:${s.id}`;
    const app = apps.get(key) ?? { key, sessions: [] };
    app.sessions.push(s);
    if (!app.icon && s.peer.icon) app.icon = s.peer.icon;
    apps.set(key, app);
  }
  return [...apps.values()];
}

/**
 * Most recently active first. Expiry is the only recency signal every
 * transport carries: WalletConnect extends it on each request and reports
 * no creation time, MWA / app links set it from creation.
 */
function byRecency(a: TransportSession, b: TransportSession): number {
  return (
    (b.expiresAt ?? b.createdAt) - (a.expiresAt ?? a.createdAt) ||
    b.createdAt - a.createdAt
  );
}

/**
 * "Expires in 6 days" / "Expires tomorrow" / "Expires today" / "Expired".
 * Whole days only: WalletConnect sessions live 7 days from the last
 * extension (`SESSION_EXPIRY = SEVEN_DAYS` in `@walletconnect/sign-client`),
 * MWA and app-link sessions 30 days (D-16), so hours would be noise.
 * `null` when the transport has no expiry.
 */
export function sessionExpiryLabel(
  expiresAt: number | undefined,
  now: number = Date.now(),
): string | null {
  if (!expiresAt) return null;
  const remaining = expiresAt - now;
  if (remaining <= 0) return "Expired";
  const days = Math.floor(remaining / DAY_MS);
  if (days === 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  return `Expires in ${days} days`;
}

/**
 * The wallets a session can see, one entry per unique wallet. WalletConnect
 * accounts are CAIP-10 and one per approved chain (`eip155:1:0xabc`,
 * `eip155:56:0xabc`, ...), so the same wallet on eight EVM networks arrives
 * as eight accounts. Users think in wallets, so collapse to unique
 * addresses under the namespace's own case rule. The network count is
 * deliberately not surfaced: this wallet approves every supported chain of
 * a namespace on each pairing, so it would read "8 networks" on every EVM
 * row and tell the user nothing.
 */
export function sessionWallets(
  session: Pick<TransportSession, "accounts">,
): { namespace: Namespace; address: string }[] {
  const seen = new Set<string>();
  const out: { namespace: Namespace; address: string }[] = [];
  for (const account of session.accounts) {
    const [ns, , ...rest] = account.split(":");
    const address = rest.join(":");
    if (!ns || !address) continue;
    const namespace = ns as Namespace;
    const key = `${namespace}:${canonicalizeAddress(namespace, address)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ namespace, address });
  }
  return out;
}
