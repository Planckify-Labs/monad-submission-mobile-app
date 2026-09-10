import { storage } from "@/lib/storage/mmkv";

const UUID_KEY = "dapp_bridge.eip6963_uuid";

// UUIDv4 shape per RFC 4122 §4.4 — EIP-6963 requires this form, and
// strict consumers (web3-onboard, wagmi's mipd with strict validation,
// some custom pickers) drop announcements whose uuid doesn't match.
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// TWV-2026-031 — UUID generation uses the OS CSPRNG via the polyfill
// installed in `pollyfills.ts`, not `Math.random`. The UUID is stored
// per-install (not baked at build time) on purpose: a build-time
// constant fingerprints every install of the wallet, which is a
// privacy regression; the strong defence against malicious-wallet
// impersonation is the `rdns` value (verified by `assertOurRdns`),
// not the UUID itself. See `docs/design-notes/eip6963-identity.md`.
function generateUuidV4(): string {
  const buf = new Uint8Array(16);
  globalThis.crypto.getRandomValues(buf);
  buf[6] = (buf[6] & 0x0f) | 0x40; // version 4
  buf[8] = (buf[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * TWV-2026-031 — runtime invariant. Our `rdns` MUST be the package's
 * reverse-DNS (the iOS bundle ID / Android package, also the Play Store
 * listing ID). Any other value is either a build mistake or an
 * impersonation attempt; surface it loudly.
 */
export const OUR_RDNS = "com.planckify.takumiwallet" as const;
export function assertOurRdns(rdns: string): void {
  if (rdns !== OUR_RDNS) {
    if (__DEV__) {
      console.error(
        `[TWV-2026-031] eip6963 rdns drift — expected "${OUR_RDNS}", got "${rdns}"`,
      );
    }
  }
}

/**
 * Stable per-install identifier for EIP-6963 announce. Must be a valid
 * UUIDv4 (spec requirement — consumers reject otherwise) and must survive
 * app relaunch so dApp "remember this wallet" flows keep working. MMKV is
 * native-backed sync K/V — the right tool here since the injected script
 * needs the real value on first page load.
 *
 * Older builds stored a non-v4 identifier (`takumi-<base36>-<base36>-…`);
 * this hydrate step migrates silently.
 */
export function getInstallUuid(): string {
  const existing = storage.getString(UUID_KEY);
  if (existing && UUID_V4_REGEX.test(existing)) return existing;
  const generated = generateUuidV4();
  storage.set(UUID_KEY, generated);
  return generated;
}

export interface Eip6963Info {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

/**
 * Returns a JS snippet that, when evaluated in a WebView, announces an
 * EIP-6963 provider. Must be concatenated *after* `window.ethereum` has
 * been installed by `getInjectedScript`.
 *
 * Note: EIP-6963 says the `detail` object SHOULD be frozen, but NOT the
 * provider itself. Freezing the provider breaks mutation of internal state
 * (selectedAddress, _isConnectedState) so events like `accountsChanged`
 * never fire — which silently breaks dApp libraries that listen for them
 * (wagmi, web3modal, ConnectKit, RainbowKit).
 */
export function buildAnnounceScript(info: Eip6963Info): string {
  const json = JSON.stringify(info);
  return `
(function() {
  var info = ${json};

  // Always produce a one-off announce on every injection — cheap, and
  // lets late-mount SPAs catch us when we re-inject on \`onLoadEnd\`.
  // Prefer the captured private ref — dApps sometimes overwrite
  // \`window.ethereum\` with their own proxy, but we still want 6963
  // listeners to receive OUR provider object.
  var announceProvider = function() {
    var p = window.__takumi_evm_provider || window.ethereum;
    if (!p) return;
    try {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({
          info: Object.freeze(info),
          provider: p
        })
      }));
    } catch (e) {}
  };

  // If the provider-spec path is already wired up from a prior injection,
  // just re-announce once more and exit so we don't stack intervals.
  if (window.__takumi_eip6963_installed) {
    announceProvider();
    return;
  }
  window.__takumi_eip6963_installed = true;

  try {
    // 1. Respond to explicit discovery requests (the EIP-6963 spec path).
    //    This is the load-bearing listener — mipd/wagmi dispatches
    //    \`eip6963:requestProvider\` AFTER installing its own
    //    \`eip6963:announceProvider\` listener, so our synchronous
    //    response is always caught regardless of mount timing.
    window.addEventListener('eip6963:requestProvider', announceProvider);

    // 2. Announce immediately — handles any already-installed listener.
    announceProvider();

    // 3. Re-announce at DOM milestones.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', announceProvider, { once: true });
    }
    window.addEventListener('load', announceProvider, { once: true });

    // 4. SPA route changes — React Router / Next.js client-side
    //    navigation doesn't trigger a page load but some dApps re-run
    //    wallet discovery on route change (wallet-connect modal lazy
    //    init, etc).
    window.addEventListener('hashchange', announceProvider);
    window.addEventListener('popstate', announceProvider);
    // Patch pushState/replaceState to fire a synthetic route event we
    // can hook. Standard pattern — used by mipd itself in some flows.
    ['pushState', 'replaceState'].forEach(function(m) {
      var original = history[m];
      history[m] = function() {
        var r = original.apply(this, arguments);
        setTimeout(announceProvider, 0);
        return r;
      };
    });

    // 5. Long-tail schedule for SPAs that mount slowly. mipd and the
    //    wagmi injected-connector both dedupe by \`info.uuid\`, so
    //    repeating the same announcement is free. Schedule is chosen
    //    to cover: Next.js hydration (~500ms–2s), React lazy-loaded
    //    routes (~2–5s), and slow-device hydration (up to ~20s).
    [100, 300, 600, 1000, 1500, 2500, 4000, 6000, 10000, 15000, 20000, 30000].forEach(
      function(ms) { setTimeout(announceProvider, ms); }
    );

    // 6. Dispatch our own \`requestProvider\` — some libs with a
    //    one-shot listener will pick us up, and anyone else ignores it.
    setTimeout(function() {
      try { window.dispatchEvent(new CustomEvent('eip6963:requestProvider')); }
      catch (e) {}
    }, 0);
  } catch (e) {
    console.error('[takumi-eip6963] announce failed', e);
  }
})();
`;
}
