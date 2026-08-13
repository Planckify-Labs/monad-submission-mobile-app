import { useEffect, useMemo, useState } from "react";
import { hostOfUrl } from "@/services/dappsBrowser/suggest";
import {
  type PermissionGrant,
  PermissionStore,
} from "@/services/permissions/store";

/**
 * The hosts that currently hold at least one wallet connection.
 *
 * This is the hub's read-only view of `PermissionStore`: enough to put a
 * green dot on a "Jump back in" chip, and nothing more. The connection
 * manager's `useDappConnections` joins grants to wallets to build rows it
 * can disconnect; the hub only needs to know a site is live, so it skips
 * that work and stays independent of `useWallet`.
 *
 * Grants are keyed by `originKey` (`https://host[:port]`), so the host is
 * recovered with the same parser the address bar uses.
 */
export function useConnectedHosts(): ReadonlySet<string> {
  const [grants, setGrants] = useState<PermissionGrant[]>(() =>
    PermissionStore.listAll(),
  );

  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (active) setGrants(PermissionStore.listAll());
    };
    // Grants persist across launches, so the first read may precede
    // hydration; subscribe covers every connect/disconnect after that.
    void PermissionStore.hydrate().then(refresh);
    const unsubscribe = PermissionStore.subscribe(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return useMemo(() => {
    const hosts = new Set<string>();
    for (const grant of grants) {
      const host = hostOfUrl(grant.origin);
      if (host) hosts.add(host);
    }
    return hosts;
  }, [grants]);
}
