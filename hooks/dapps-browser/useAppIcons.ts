import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useDappCatalog } from "@/hooks/dapps-browser/useDappCatalog";
import { FaviconStore } from "@/services/dappsBrowser/faviconStore";
import { hostOfUrl } from "@/services/dappsBrowser/suggest";

/**
 * The icon to draw for a host, resolved the way the dApps hub does it:
 * the catalogue's curated `logoUrl` first, then an icon the app declared
 * about itself (`own`, e.g. WalletConnect peer metadata), then the site's
 * own favicon as recorded from the page on an earlier visit
 * (`FaviconStore`, MMKV). No guessing at `/favicon.ico` and no third-party
 * icon service, for the same reasons the store itself gives: a guess is a
 * request that names the host to someone, and a wrong guess is a broken
 * image.
 *
 * Returns a stable resolver; `undefined` means "nothing known, use the
 * fallback". Hosts are matched with a leading `www.` stripped, which is
 * how both the catalogue and the favicon store key them.
 */
export function useAppIcons(): (
  host: string,
  own?: string,
) => string | undefined {
  const catalog = useDappCatalog(true);
  const favicons = useSyncExternalStore(
    FaviconStore.subscribe,
    FaviconStore.map,
  );

  const curated = useMemo(() => {
    const byHost = new Map<string, string>();
    for (const entry of catalog) {
      if (!entry.logoUrl) continue;
      const host = hostOfUrl(entry.websiteUrl);
      if (host && !byHost.has(host)) byHost.set(host, entry.logoUrl);
    }
    return byHost;
  }, [catalog]);

  return useCallback(
    (host: string, own?: string) => {
      const key = host.replace(/^www\./, "");
      return curated.get(key) ?? own ?? favicons.get(key);
    },
    [curated, favicons],
  );
}
