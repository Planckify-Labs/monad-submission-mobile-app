import { useLocalSearchParams } from "expo-router";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, Keyboard, View } from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, WebViewMessageEvent } from "react-native-webview";
import BrowserBlockedSite from "@/components/dapps-browser/BrowserBlockedSite";
import BrowserPageError from "@/components/dapps-browser/BrowserPageError";
import DappLoadingOverlay from "@/components/dapps-browser/DappLoadingOverlay";
import {
  type PageLoadErrorInput,
  shouldIgnorePageLoadError,
} from "@/services/dappsBrowser/pageError";

// TWV-2026-015 — generate a per-session nonce from the OS CSPRNG via
// the polyfill installed in `pollyfills.ts`. 16 random bytes → 32 hex
// chars; uniqueness across navigations is what matters.
function generateSessionNonce(): string {
  const buf = new Uint8Array(16);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Bare hostname for the branded loading overlay ("https://jup.ag/" →
// "jup.ag"). Falls back to undefined so the loader omits the label rather
// than showing a half-parsed URL.
function hostFromUrl(url: string): string | undefined {
  return displayHost(url) || undefined;
}

// Known third-party log spam that some dApps ship (Datadog RUM double-
// init, pino history restore, Amplitude telemetry retries, etc.) —
// not signals from our bridge, forwarded through the WebView console
// bridge.
//
// We substring-match across ALL joined args (not just args[0]) because
// these libraries often call `console.error("LibName:", "actual message", {extra})`
// — the matchable text is in args[1] or later, not always at index 0.
//
// `CONTEXT_NOISE_PATTERNS` handles pino-style structured log objects
// like `{context: "core/history", level: 50, ...}` where the message
// may be absent (a "follow-up" entry with only context+level+time).
const WEBVIEW_NOISE_PATTERNS: readonly string[] = [
  "DD_RUM is already initialized",
  "Restore will override",
  "WalletConnect Core is already initialized",
  "Amplitude Logger",
  "Failed to fetch remote configuration",
  "Failed to fetch (cca-lite.coinbase.com)",
  "Datadog Browser SDK",
];

const CONTEXT_NOISE_PREFIXES: readonly string[] = ["core/history", "core/rum"];

/**
 * Reads the icon the page declares for itself and hands it back so the
 * address bar can show a real logo for sites the dApp catalogue does not
 * carry (see `services/dappsBrowser/faviconStore.ts`).
 *
 * Read out of the DOM rather than guessed at `/favicon.ico`, so there is
 * no extra request and no wrong answer for the many sites that serve
 * their icon from a CDN. `link.href` is the resolved absolute URL, which
 * is what saves us from re-implementing relative-URL resolution against a
 * base tag. Largest declared size wins, since these end up on a 42px tile
 * on a high-density screen.
 *
 * Reports nothing when the page declares nothing, which the store reads as
 * "no news" and not as "delete what you had".
 */
const REPORT_FAVICON = `
  (function() {
    try {
      if (window.top !== window) return;
      var links = document.querySelectorAll("link[rel]");
      var best = null;
      var bestSize = -1;
      for (var i = 0; i < links.length; i++) {
        var link = links[i];
        var rel = (link.getAttribute("rel") || "").toLowerCase();
        // "mask-icon" is Safari's monochrome pinned-tab glyph, which is a
        // silhouette rather than the site's logo.
        if (rel.indexOf("icon") === -1 || rel.indexOf("mask") !== -1) continue;
        var href = link.href;
        if (!href) continue;
        var sizes = (link.getAttribute("sizes") || "").toLowerCase();
        var matched = sizes.match(/(\\d+)x(\\d+)/);
        var size = matched
          ? parseInt(matched[1], 10)
          : (rel.indexOf("apple") !== -1 ? 180 : 32);
        if (size > bestSize) { bestSize = size; best = href; }
      }
      if (!best) return;
      window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: "takumi_favicon", href: best })
      );
    } catch (e) {}
  })();
`;

function serialiseArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a === null || a === undefined) return "";
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function isWebviewThirdPartyNoise(args: readonly unknown[]): boolean {
  if (args.length === 0) return false;
  const joined = args.map(serialiseArg).join(" ");
  for (const p of WEBVIEW_NOISE_PATTERNS) {
    if (joined.includes(p)) return true;
  }
  // Structured log objects without a msg field — match by context.
  for (const a of args) {
    if (a && typeof a === "object" && !Array.isArray(a)) {
      const ctx = (a as { context?: unknown }).context;
      if (typeof ctx === "string") {
        for (const prefix of CONTEXT_NOISE_PREFIXES) {
          if (ctx.startsWith(prefix)) return true;
        }
      }
    }
  }
  return false;
}

import type { Chain } from "viem";
import { mainnet } from "viem/chains";
import type { TBlockchain } from "@/api/types/blockchain";
import BrowserAddressBar from "@/components/dapps-browser/BrowserAddressBar";
import BrowserNavigationControls from "@/components/dapps-browser/BrowserNavigationControls";
import BrowserSuggestions from "@/components/dapps-browser/BrowserSuggestions";
import ConnectionManagerSheet from "@/components/dapps-browser/connections/ConnectionManagerSheet";
import DAppsHub from "@/components/dapps-browser/DAppsHub";
import { useOmniboxSuggestions } from "@/hooks/dapps-browser/useOmniboxSuggestions";
import { useBlockchainsWithStorage } from "@/hooks/useBlockchainsWithStorage";
import { useDappConnections } from "@/hooks/useDappConnections";
import { useWallet } from "@/hooks/useWallet";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import { bootBridge } from "@/services/bridge/boot";
import { ChainAdapterRegistry } from "@/services/chains/registry";
import type { AdapterContext } from "@/services/chains/types";
import { FaviconStore } from "@/services/dappsBrowser/faviconStore";
import { BrowserHistoryStore } from "@/services/dappsBrowser/historyStore";
import { displayHost, parseOmnibox } from "@/services/dappsBrowser/omnibox";
import type { Suggestion } from "@/services/dappsBrowser/suggest";
import { intakeFromWebView } from "@/services/deeplinks/entry";
import { isFlaggedHost } from "@/services/security/scamDomainFeed";
import { getAccountForWallet } from "@/services/walletService";

interface TBrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

/**
 * RPC isolation seam (item 5). The dApp-browser surface should read from
 * an RPC endpoint/quota separate from the app's internal features, but on
 * one the project still trusts (never the dApp's own RPC for a supported
 * chain). Today the backend feed exposes a single `rpcUrl`, so this returns
 * it unchanged; it is the ONE place to point at a browser-scoped endpoint
 * (e.g. a distinct key/quota, or a future `row.dappRpcUrl`) once infra
 * provisions it, without touching the add/switch handlers.
 */
function browserRpcForRow(row: TBlockchain): string {
  return row.rpcUrl;
}

export default function DappsBrowser() {
  const { activeWallet, wallets, activeChain } = useWallet();
  // Optional initial URL — e.g. the DeFi card's "Manual" deep-link pushes
  // `router.push({ pathname: "/dapps-browser", params: { url } })` so the
  // user completes a deposit through the protocol's own UI (still on the
  // Takumi wallet via the DappBridge; pool-level deposits spec §9.1).
  const { url: initialUrl } = useLocalSearchParams<{ url?: string }>();
  const webViewRef = useRef<WebView>(null);
  // What the user is typing. Separate from `browserState.url` on purpose:
  // the committed URL changes constantly as a page redirects and routes,
  // and merging the two is what used to overwrite a half-typed address.
  const [draft, setDraft] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [showHub, setShowHub] = useState(true);
  const [showConnections, setShowConnections] = useState(false);
  const [browserState, setBrowserState] = useState<TBrowserState>({
    url: "",
    title: "Web3 Ecosystem Hub",
    canGoBack: false,
    canGoForward: false,
    loading: false,
  });
  // Last failed page load, or null when the page is fine. Set from the
  // WebView's `onError`, cleared the moment a new load starts, so it is
  // always in step with the WebView's own internal ERROR state.
  const [pageError, setPageError] = useState<PageLoadErrorInput | null>(null);
  // A real page finished loading. Set only from the success-only `onLoad`
  // callback, so the emerald shield is proof of a completed load rather
  // than the absence of a failure we may not have heard about yet.
  const [pageLoaded, setPageLoaded] = useState(false);
  // TWV-2026-051 — URL the scam-domain feed refused, or null. Held apart
  // from `browserState.url`: the WebView is parked on about:blank while
  // this is set, but the address bar keeps showing the blocked host,
  // because a warning that hides which site it is about teaches nothing.
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  // Hosts the user chose to open anyway. A ref, never persisted: the
  // warning comes back the next time the browser is opened, and a bypass
  // can never outlive the session that granted it.
  const bypassedHosts = useRef<Set<string>>(new Set());

  // TWV-2026-015 — per-session nonce. Rotated on every top-frame nav
  // (see `handleNavigate` below). Stamped into the injected provider's
  // closure scope so sub-frame postMessage forgery is rejected by the
  // bridge.
  const [sessionNonce, setSessionNonce] = useState<string>(() =>
    generateSessionNonce(),
  );

  const ctxRef = useRef<AdapterContext>({
    activeWallet: null,
    wallets: [],
    getAccount: getAccountForWallet,
    sessionNonce,
  });
  ctxRef.current = {
    activeWallet: activeWallet && activeWallet.address ? activeWallet : null,
    wallets,
    getAccount: getAccountForWallet,
    sessionNonce,
  };

  // Backend `/blockchains` feed — the authoritative source for each EVM
  // chain's RPC URL. Held in a ref (reassigned every render, same pattern
  // as `ctxRef`) so the `resolveEvmChain` closure below always reads the
  // latest feed, even though the feed loads asynchronously after the
  // bridge is first booted.
  const { data: blockchains } = useBlockchainsWithStorage({ isActive: true });
  const blockchainsRef = useRef<TBlockchain[] | undefined>(blockchains);
  blockchainsRef.current = blockchains;

  // Resolve an EVM chain config from the backend feed by numeric chainId.
  // Returns `null` when the feed hasn't loaded or has no matching EVM row
  // with a usable RPC, letting callers fall back. This is what keeps dApp
  // traffic on the project's own RPC instead of viem's rate-limited public
  // default (`eth.merkle.io`).
  const resolveBackendEvmChain = useCallback(
    (chainId: number): { chain: Chain; rpcUrl: string } | null => {
      const row = blockchainsRef.current?.find(
        (b) => b.chainId === chainId && Boolean(b.rpcUrl),
      );
      if (!row) return null;
      const cfg = buildChainConfigFromBlockchain(row);
      if (cfg.namespace !== "eip155") return null;
      return { chain: cfg.chain, rpcUrl: browserRpcForRow(row) };
    },
    [],
  );

  // The chain a dApp starts on before it switches (Phase 2 isolation, no
  // dependence on the home-screen active chain): Ethereum mainnet from the
  // feed if present, else the first EVM feed row with a usable RPC. Served on
  // the project RPC.
  const resolveDefaultEvmChain = useCallback((): {
    chain: Chain;
    rpcUrl: string;
  } | null => {
    const byMainnet = resolveBackendEvmChain(mainnet.id);
    if (byMainnet) return byMainnet;
    const row = blockchainsRef.current?.find(
      (b) => b.isEVM && typeof b.chainId === "number" && Boolean(b.rpcUrl),
    );
    if (!row) return null;
    const cfg = buildChainConfigFromBlockchain(row);
    if (cfg.namespace !== "eip155") return null;
    return { chain: cfg.chain, rpcUrl: browserRpcForRow(row) };
  }, [resolveBackendEvmChain]);

  const bridge = useMemo(
    () =>
      bootBridge({
        getContext: () => ctxRef.current,
        getWebView: () => webViewRef.current,
        // TODO(task-17): route chain resolution through the kit adapter
        // registry so the Solana bridge signer can mount alongside EVM.
        resolveEvmChain: (ctx) => {
          // Route by REQUEST namespace, not by global UI active chain.
          // The bridge has already routed an EIP-155 request to us; our
          // job is to serve it with a sensible EVM chain. When the UI
          // happens to have a Solana chain active (user flipped into
          // a Solana wallet earlier), we fall back to mainnet — the
          // dApp can `wallet_switchEthereumChain` after connect if it
          // wants a different chain. Returning `null` here forced every
          // EVM `eth_requestAccounts` to fail with 4901 "Chain not
          // connected", even though the user has perfectly good EVM
          // wallets in `ctx.wallets`.
          void ctx;
          if (activeChain.namespace === "eip155") {
            // Prefer the backend feed's RPC for the active EVM chain. Its
            // `chain` object is usually already backend-built (carrying the
            // project RPC), but re-resolving by chainId guarantees we never
            // fall through to a viem chain's baked-in public default.
            const backend = resolveBackendEvmChain(activeChain.chain.id);
            if (backend) return backend;
            return {
              chain: activeChain.chain,
              rpcUrl:
                activeChain.chain.rpcUrls?.default?.http?.[0] ??
                activeChain.chain.rpcUrls?.public?.http?.[0] ??
                "",
            };
          }
          // UI is on a non-EVM chain but an EVM dApp made a request. Serve
          // it on mainnet, sourced from the backend feed (project RPC).
          // Only if the feed has no mainnet row do we fall back to viem's
          // `mainnet`, whose default RPC (`eth.merkle.io`) is a shared,
          // rate-limited public endpoint.
          const backendMainnet = resolveBackendEvmChain(mainnet.id);
          if (backendMainnet) return backendMainnet;
          return {
            chain: mainnet,
            rpcUrl: mainnet.rpcUrls?.default?.http?.[0] ?? "",
          };
        },
        // Feed-backed lookup by numeric chainId, independent of the active
        // chain. Lets the add/switch handlers treat a network the project
        // supports as first-class (switched to, served on the project RPC)
        // rather than a dApp-defined custom chain whose RPC we'd persist.
        resolveSupportedEvmChain: (chainId) => resolveBackendEvmChain(chainId),
        // Phase 2 isolation: a dApp's chain is per-origin and NEVER touches
        // the home-screen active chain, so switching is applied inside the
        // adapter (OriginChainStore) with no `changeActiveChain` here. This
        // is the default chain a fresh origin starts on: Ethereum mainnet
        // from the feed, else the first EVM feed row, on the project RPC.
        resolveDefaultEvmChain: () => resolveDefaultEvmChain(),
      }),
    // Re-binding fires on wallet/chain change so the bridge always has a live
    // context reference; the inner state guards against double-boot.
    [activeChain, resolveBackendEvmChain, resolveDefaultEvmChain],
  );

  /**
   * The single navigation path: everything (address-bar submit, suggestion
   * tap, dApp card, deep link, connection manager) funnels through here.
   *
   * Navigating is purely a state change. `browserState.url` feeds the
   * WebView's `source`, and both platforms no-op when the requested URL
   * already matches what the WebView is showing, which is the documented
   * way to drive it. The previous implementation ALSO injected
   * `window.location.href = '<url>'` into the live page: that raced the
   * source change into a double load, ran the navigation in the page's own
   * JS context rather than the browser's, and interpolated the URL into a
   * single-quoted string with no escaping, so a URL containing an
   * apostrophe executed arbitrary script inside the currently open dApp.
   */
  // True when the scam-domain feed flags this URL and the user has not
  // already accepted the risk for that host in this session.
  const isBlockedSite = useCallback((url: string) => {
    const host = displayHost(url);
    if (host && bypassedHosts.current.has(host)) return false;
    return isFlaggedHost(url);
  }, []);

  const navigateToUrl = useCallback(
    (input: string) => {
      const intent = parseOmnibox(input);
      // Empty or whitespace-only input: stay put rather than navigating to
      // an empty search.
      if (!intent) return;

      setIsEditing(false);
      setDraft("");
      setShowHub(false);
      setPageError(null);
      setPageLoaded(false);
      // TWV-2026-051 — first of the two block points. This one catches the
      // address bar, the hub, suggestions and deep links; the WebView's
      // `onShouldStartLoadWithRequest` catches redirects and in-page links
      // that never come through here.
      setBlockedUrl(isBlockedSite(intent.url) ? intent.url : null);
      setBrowserState((prev) => ({
        ...prev,
        url: intent.url,
        // Drop the previous page's title immediately; it is attached to
        // every bridge message as `origin.title` and shown in the connection
        // manager, so carrying it across a navigation mislabels the new site.
        title: "",
        loading: true,
      }));
      Keyboard.dismiss();
    },
    [isBlockedSite],
  );

  // Leaves the open dApp and returns to the hub. Shared by the navigation
  // bar's home button and the error page's escape hatch.
  const goHome = useCallback(() => {
    setShowHub(true);
    setDraft("");
    setIsEditing(false);
    setPageError(null);
    setPageLoaded(false);
    setBlockedUrl(null);
    setBrowserState({
      url: "",
      title: "Web3 Ecosystem Hub",
      canGoBack: false,
      canGoForward: false,
      loading: false,
    });
  }, []);

  const startEditing = useCallback(() => {
    // Editing always starts from the committed URL, never a stale draft.
    setDraft(browserState.url);
    setIsEditing(true);
  }, [browserState.url]);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
    setDraft("");
    Keyboard.dismiss();
  }, []);

  const suggestions = useOmniboxSuggestions(draft, isEditing);

  const handleSelectSuggestion = useCallback(
    (suggestion: Suggestion) => {
      // Suggestion URLs come from the catalogue and from history, so they
      // go through the same parser as typed input rather than being
      // trusted: a bad `websiteUrl` row can't become a navigation.
      navigateToUrl(suggestion.url);
    },
    [navigateToUrl],
  );

  /**
   * Forgets one visited site, from the row that shows it.
   *
   * Confirmed rather than immediate: a long press is easy to trigger by
   * accident while scrolling a list, and the row vanishing under the
   * finger with no way back reads as a bug rather than as an action. The
   * dialog also answers the question the gesture raises in a wallet, which
   * is whether this touches the site's connection. It does not.
   */
  const handleForgetSite = useCallback((host: string) => {
    Alert.alert(
      "Remove from suggestions?",
      `${host} will stop appearing in the address bar as you type. Your wallet connections are not affected.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => BrowserHistoryStore.remove(host),
        },
      ],
    );
  }, []);

  // Open the initial deep-link URL (if any) by mounting the WebView on it.
  useEffect(() => {
    const raw = typeof initialUrl === "string" ? initialUrl : "";
    const intent = parseOmnibox(raw);
    if (!intent) return;
    setShowHub(false);
    setBrowserState((prev) => ({
      ...prev,
      url: intent.url,
      title: "",
      loading: true,
    }));
  }, [initialUrl]);

  const handleMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;

      // Diagnostic channel — injected script pipes state back here so we
      // can see it in Metro logs without needing remote WebView devtools.
      const type = (parsed as { type?: string }).type;
      if (type === "takumi_diagnostic") {
        console.log("[takumi-diagnostic]", parsed);
        return;
      }
      // The page's own icon, keyed by the host WE are showing rather than
      // any host the page names: the message only supplies the artwork,
      // never which site it belongs to.
      if (type === "takumi_favicon") {
        const host = displayHost(browserState.url);
        if (host) {
          FaviconStore.record({
            host,
            url: (parsed as { href?: unknown }).href,
          });
        }
        return;
      }
      if (type === "takumi_console") {
        const c = parsed as {
          level?: "log" | "warn" | "error";
          args?: unknown[];
        };
        const args = c.args ?? [];
        // Downgrade known-noisy third-party spam (NOT bridge signal) to
        // log-level. Each pattern below is a library shipped by dApps we
        // don't control, re-initialised by their own code when their
        // app boots or re-boots. They're not actionable from our side.
        //
        // If a pattern here ever hides a real issue, delete the entry —
        // the full message still reaches Metro, just at the right level.
        if (c.level === "error" && isWebviewThirdPartyNoise(args)) {
          console.log("[webview:noise]", ...args);
          return;
        }
        if (c.level === "error") console.error("[webview]", ...args);
        else if (c.level === "warn") console.warn("[webview]", ...args);
        else console.log("[webview]", ...args);
        return;
      }

      // Attach the current URL as origin; the dApp doesn't set this itself.
      (parsed as Record<string, unknown>).origin = {
        url: browserState.url,
        title: browserState.title,
      };
      void bridge.dispatch(parsed);
    },
    [bridge, browserState.title, browserState.url],
  );

  const injectedJavaScript = useMemo(() => {
    const adapters = ChainAdapterRegistry.list();
    // TWV-2026-064 — neutralise the JS fullscreen API BEFORE any dApp
    // script runs. Without this a hostile dApp can `requestFullscreen`
    // and paint a pixel-perfect signer-prompt spoof over the whole
    // screen. Signer UI is rendered as a native RN modal above the
    // WebView (`ApprovalHost`), so a dApp should never need fullscreen
    // anyway. Return a rejected promise so polyfills behave.
    const disableFullscreen = `
      (function() {
        try {
          var reject = function() {
            return Promise.reject(new Error("fullscreen disabled by wallet"));
          };
          var proto = Element && Element.prototype;
          if (proto) {
            proto.requestFullscreen = reject;
            proto.webkitRequestFullscreen = reject;
            proto.mozRequestFullScreen = reject;
            proto.msRequestFullscreen = reject;
          }
          Object.defineProperty(document, "fullscreenEnabled", { get: function(){ return false; } });
          Object.defineProperty(document, "webkitFullscreenEnabled", { get: function(){ return false; } });
        } catch (e) {}
      })();
    `;
    if (adapters.length === 0) {
      return `${disableFullscreen}\n${REPORT_FAVICON}\ntrue;`;
    }
    return `${disableFullscreen}\n${adapters.map((a) => a.getInjectedScript(ctxRef.current)).join("\n")}\n${REPORT_FAVICON}\ntrue;`;
    // TWV-2026-015 — `sessionNonce` in the dep list so a fresh nonce
    // (rotated by `handleNavigate`) actually re-renders the script and
    // gets re-injected on the next nav.
  }, [
    activeWallet?.address,
    // TODO(task-17): include non-EVM chain discriminants here too.
    activeChain.namespace === "eip155"
      ? activeChain.chain.id
      : activeChain.namespace === "solana"
        ? activeChain.cluster
        : activeChain.network,
    sessionNonce,
  ]);

  const handleNavigate = useCallback(
    (navState: {
      url: string;
      title?: string;
      canGoBack: boolean;
      canGoForward: boolean;
      loading: boolean;
    }) => {
      setBrowserState((prev) => ({
        ...prev,
        url: navState.url,
        title: navState.title ?? prev.title,
        canGoBack: navState.canGoBack,
        canGoForward: navState.canGoForward,
        loading: navState.loading,
      }));
      // The draft is deliberately NOT written here. This callback fires on
      // every redirect and every client-side route change, so pushing the
      // URL into the input overwrote whatever the user was mid-way through
      // typing.
      bridge.onNavigate(navState.url, navState.title);
      // Record only committed loads, so a redirect chain leaves one entry
      // for the page the user actually landed on.
      if (!navState.loading) {
        BrowserHistoryStore.record({
          url: navState.url,
          title: navState.title,
        });
      }
      // TWV-2026-015 — rotate the session nonce on every top-frame nav.
      const nextNonce = generateSessionNonce();
      setSessionNonce(nextNonce);
      bridge.setSessionNonce(nextNonce);
    },
    [bridge],
  );

  // No imperative focus here on purpose. The address bar's TextInput mounts
  // only in edit mode and raises the keyboard via its own `autoFocus`, which
  // both platforms apply from the window-attach callback. A `ref.focus()`
  // from this effect runs in the same commit the input mounts, before the
  // native view is attached, and Android's `showSoftInput()` no-ops on an
  // unattached view: the caret appeared but the keyboard did not.

  // TWV-2026-015 — seed the bridge with the initial nonce on mount so
  // the first page load (before any nav callback fires) is gated too.
  useEffect(() => {
    bridge.setSessionNonce(sessionNonce);
  }, [bridge, sessionNonce]);

  // Connection state for the address-bar indicator + the manager sheet.
  // `null` origin on the hub puts the sheet into its global "connected
  // sites" mode; a live URL scopes it to the open dApp.
  const currentOrigin = showHub ? null : browserState.url || null;
  const { isConnected } = useDappConnections({
    origin: currentOrigin,
    wallets,
  });

  return (
    <SafeAreaView className="flex-1 bg-white" edges={[]}>
      <SystemBars style="dark" />
      <View className="flex-1 bg-light-main-container">
        <BrowserAddressBar
          // While an interstitial is up the WebView is parked on
          // about:blank, so the bar reads from the blocked URL instead.
          pageUrl={blockedUrl ?? browserState.url}
          draft={draft}
          onChangeDraft={setDraft}
          isEditing={isEditing}
          onStartEditing={startEditing}
          onCancelEditing={cancelEditing}
          onSubmit={() => navigateToUrl(draft)}
          isWalletConnected={isConnected}
          onPressWallet={() => setShowConnections(true)}
          // Emerald shield only once the load has actually landed. `loading`
          // clears on the WebView's `onLoadEnd`, which is the document-
          // complete signal both platforms give us; a failed load clears it
          // too, so the error state has to be excluded explicitly or the
          // shield would go green over an error page.
          isPageLoaded={!showHub && pageLoaded && !pageError && !blockedUrl}
          isBlocked={blockedUrl !== null}
        />
        {/* Everything below the address bar. The suggestion overlay
            absolutely fills THIS wrapper, so it covers the page and the
            navigation controls alike. Keeping the controls mounted while
            editing is deliberate: unmounting them resized the content area,
            which reflowed the WebView at the exact moment the overlay
            appeared and read as the whole screen jumping. */}
        <View className="flex-1">
          {showHub ? (
            <DAppsHub onNavigateToDapp={navigateToUrl} />
          ) : (
            <View className="flex-1 mx-2 mb-2- rounded-3xl overflow-hidden border-4 border-light-matte-black bg-light-main-container">
              <WebView
                ref={webViewRef}
                // A blocked site is never fetched. Parking on about:blank
                // rather than just covering the page with the interstitial
                // also tears down whatever was loaded before, so no dApp
                // keeps a live provider session behind the warning.
                source={{ uri: blockedUrl ? "about:blank" : browserState.url }}
                onMessage={handleMessage}
                // UA suffix so dApps that fall back to user-agent sniffing (or
                // want to branch on "in-app wallet browser") can detect us by
                // matching /TakumiPay/.
                applicationNameForUserAgent="TakumiPay/1.0"
                // Inject BEFORE the page's own scripts run. `injectedJavaScript`
                // fires after load, which is too late for EIP-6963 — dApps have
                // already dispatched `eip6963:requestProvider` during startup
                // and decided nobody answered. Running pre-load guarantees our
                // `window.ethereum` and 6963 listener are in place when the
                // dApp's bundle wakes up.
                injectedJavaScriptBeforeContentLoaded={injectedJavaScript}
                // TWV-2026-013 — never install the EIP-1193 provider into
                // cross-origin iframes. CVE-2020-6506-class universal-XSS
                // makes any sub-frame an attacker-controlled JS context;
                // restricting injection to the top frame keeps the provider
                // out of their reach.
                injectedJavaScriptForMainFrameOnly={true}
                // Also replay on every DOM load — SPAs with client-side routing
                // don't re-inject the pre-content script between route changes,
                // and our provider script is idempotent (guarded by
                // `window.__takumi_evm_installed`).
                injectedJavaScript={injectedJavaScript}
                onLoadStart={() => {
                  // Deliberately does NOT clear `pageError`. When a load
                  // fails, Android's WebView renders its own "Web page not
                  // available" document and commits it to history, and
                  // `RNCWebViewClient.doUpdateVisitedHistory` dispatches a
                  // TopLoadingStartEvent for it — a start event for a page
                  // the user never asked for, arriving milliseconds after
                  // the failure. Clearing here wiped the error state we had
                  // just set, which left the native Android page visible
                  // and turned the address-bar shield green over it.
                  setPageLoaded(false);
                  setBrowserState((p) => ({ ...p, loading: true }));
                }}
                // Success only: `onLoadingFinish` skips this when the load
                // failed (the Android client gates it on `mLastLoadFailed`),
                // so this is the one callback that means "a real page is up".
                // The shield turns emerald from this signal alone, never
                // from "no error seen yet", so a failure state it has not
                // heard about cannot be painted as a healthy page.
                onLoad={() => {
                  setPageError(null);
                  setPageLoaded(true);
                }}
                // TWV-2026-051 — second block point, and the one that
                // matters: drainers arrive by redirect off an ad or a
                // Discord link, not by someone typing the domain. Every
                // top-frame navigation the page initiates passes through
                // here, so a flagged host is refused before a single
                // request goes out.
                onShouldStartLoadWithRequest={(request) => {
                  // Deep-link spec §4.2: a page that navigates to `wc:`,
                  // `ethereum:` or our own link stays in-app and goes to
                  // the kernel as an `internal` link. Letting the WebView
                  // hand it to the OS would bounce it back into us as an
                  // external link (wallet chooser, "return to caller").
                  if (intakeFromWebView(request.url)) return false;
                  if (!isBlockedSite(request.url)) return true;
                  setBlockedUrl(request.url);
                  return false;
                }}
                // Replaces react-native-webview's `defaultRenderError`,
                // which paints the raw platform triple ("Domain: undefined
                // / Error Code: -2 / Description:
                // net::ERR_INTERNET_DISCONNECTED") straight at the user.
                // `preventDefault()` keeps the WebView out of its ERROR
                // state for loads that were merely cancelled or superseded,
                // the way a real browser stays silent about those.
                onError={(event) => {
                  const { code, description, domain } = event.nativeEvent;
                  if (__DEV__) {
                    console.warn("[dapps-browser] page load failed", {
                      code,
                      description,
                      domain,
                      url: browserState.url,
                    });
                  }
                  if (
                    shouldIgnorePageLoadError({ code, description, domain })
                  ) {
                    event.preventDefault();
                    return;
                  }
                  setPageError({ code, description, domain });
                  setPageLoaded(false);
                  // The page that asked for an approval no longer exists,
                  // so any sheet still on screen for it is signing into a
                  // void. `bridge.onNavigate` only clears intents from a
                  // DIFFERENT origin, which is exactly the case a failed
                  // same-origin load is not.
                  bridge.onPageUnavailable(browserState.url);
                }}
                // Rendered from the arguments the WebView hands us, NOT from
                // our own `pageError` state. RN calls this only while its
                // internal viewState is ERROR and always passes the real
                // failure, so there is no window where the two disagree.
                // Reading state here meant that Android's post-failure
                // history commit (see `onLoadStart`) could blank it a beat
                // later, and the fallback branch rendered a transparent
                // View — through which the WebView's own green-robot "Web
                // page not available" document was perfectly visible. This
                // must always return a real, opaque page.
                renderError={(domain, code, description) => (
                  <BrowserPageError
                    error={{ domain, code, description }}
                    host={hostFromUrl(browserState.url)}
                    canGoBack={browserState.canGoBack}
                    onRetry={() => {
                      setPageError(null);
                      webViewRef.current?.reload();
                    }}
                    onGoBack={() => webViewRef.current?.goBack()}
                    onGoHome={goHome}
                  />
                )}
                onLoadEnd={() => {
                  setBrowserState((p) => ({ ...p, loading: false }));
                  // Active re-injection of the full provider + announce +
                  // diagnostic bundle. `injectedJavaScriptBeforeContentLoaded`
                  // is racy on Android (evaluateJavascript inside
                  // onPageStarted); this guarantees every page load gets a
                  // deterministic injection from the RN side. The provider
                  // script's `__takumi_evm_installed` guard makes it safe to
                  // re-run against an already-installed page.
                  webViewRef.current?.injectJavaScript(
                    `${injectedJavaScript}\ntrue;`,
                  );
                }}
                onNavigationStateChange={handleNavigate}
                javaScriptEnabled
                domStorageEnabled
                scalesPageToFit
                allowsInlineMediaPlayback
                // TWV-2026-064 — video stays inline; dApps cannot take over
                // the full screen to paint a fake signer prompt. The JS
                // fullscreen API is also neutralised (see injection above).
                allowsFullscreenVideo={false}
                mediaPlaybackRequiresUserAction={false}
                allowsBackForwardNavigationGestures
                // TWV-2026-013 — only https. http and file schemes are
                // banned wholesale; mixed content is never loaded.
                originWhitelist={["https://*"]}
                mixedContentMode="never"
                sharedCookiesEnabled={false}
                thirdPartyCookiesEnabled={false}
                androidLayerType="hardware"
                setSupportMultipleWindows={false}
                cacheEnabled
                cacheMode="LOAD_DEFAULT"
                className="flex-1"
              />
              {browserState.loading && !pageError && !blockedUrl && (
                <DappLoadingOverlay host={hostFromUrl(browserState.url)} />
              )}
              {/* Sits outside the WebView's own `renderError` because
                  nothing was ever loaded to fail: we refused the request,
                  so the WebView is idle on about:blank underneath. */}
              {blockedUrl && (
                <BrowserBlockedSite
                  host={hostFromUrl(blockedUrl) ?? blockedUrl}
                  onLeave={goHome}
                  onProceed={() => {
                    const host = hostFromUrl(blockedUrl);
                    if (host) bypassedHosts.current.add(host);
                    const target = blockedUrl;
                    setBlockedUrl(null);
                    navigateToUrl(target);
                  }}
                />
              )}
            </View>
          )}
          {!showHub && (
            <BrowserNavigationControls
              browserState={browserState}
              onGoBack={() =>
                browserState.canGoBack && webViewRef.current?.goBack()
              }
              onGoForward={() =>
                browserState.canGoForward && webViewRef.current?.goForward()
              }
              onSearch={startEditing}
              onRefresh={() => webViewRef.current?.reload()}
              onStop={() => webViewRef.current?.stopLoading()}
              onHome={goHome}
            />
          )}
          {isEditing && (
            <BrowserSuggestions
              items={suggestions}
              onSelect={handleSelectSuggestion}
              onRemove={handleForgetSite}
            />
          )}
        </View>
      </View>
      {/* `ApprovalHost` is mounted once at the root (`app/_layout.tsx`,
          deep-link spec F3); this screen only rebinds the bridge. */}
      <ConnectionManagerSheet
        visible={showConnections}
        onClose={() => setShowConnections(false)}
        currentOrigin={currentOrigin}
        dappTitle={browserState.title}
        wallets={wallets}
        onVisitSite={(origin) => {
          setShowConnections(false);
          navigateToUrl(origin);
        }}
      />
    </SafeAreaView>
  );
}
