import { SuiJsonRpcClient as SuiClient } from "@mysten/sui/jsonRpc";
import { createSolanaRpc } from "@solana/kit";
import type { WebView } from "react-native-webview";
import { evmRenderers } from "@/components/dapps-browser/approvals/renderers";
import { createEvmAdapter } from "@/services/chains/evm/EvmAdapter";
import { ChainAdapterRegistry } from "@/services/chains/registry";
import { createSolanaAdapter } from "@/services/chains/solana/SolanaAdapter";
import { installSolanaSigner } from "@/services/chains/solana/signer";
import { getHorizonClient } from "@/services/chains/stellar/horizonClient";
import { createStellarAdapter } from "@/services/chains/stellar/StellarAdapter";
import { installStellarSigner } from "@/services/chains/stellar/signer";
import type { SuiNetwork } from "@/services/chains/sui/payloads";
import { createSuiAdapter } from "@/services/chains/sui/SuiAdapter";
import { installSuiSigner } from "@/services/chains/sui/signer";
import type { AdapterContext } from "@/services/chains/types";
import { PermissionStore } from "@/services/permissions/store";
import { walletKitRegistry } from "@/services/walletKit/registry";
import { initDappBridge } from "./DappBridge";
import { bridgeEventBus } from "./events";
import { InspectorRegistry } from "./inspector";
import { EvmCalldataDecoderInspector } from "./inspectors/EvmCalldataDecoderInspector";
import { HeuristicInspector } from "./inspectors/HeuristicInspector";
import { HttpsInspector } from "./inspectors/HttpsInspector";
import { SolanaProgramDecoderInspector } from "./inspectors/SolanaProgramDecoderInspector";
import { SolanaSimulationInspector } from "./inspectors/SolanaSimulationInspector";
import { SolanaSiwsInspector } from "./inspectors/SolanaSiwsInspector";
import { StellarPreflightInspector } from "./inspectors/StellarPreflightInspector";
import { StellarXdrDecoderInspector } from "./inspectors/StellarXdrDecoderInspector";
import { SuiPtbDecoderInspector } from "./inspectors/SuiPtbDecoderInspector";
import { SuiSimulationInspector } from "./inspectors/SuiSimulationInspector";
import { SuiSiwsInspector } from "./inspectors/SuiSiwsInspector";
import { pendingIntentsStore } from "./pendingIntents";
import { registerRenderer } from "./renderers";
import { AnalyticsSink } from "./sinks/AnalyticsSink";
import { ConsoleSink } from "./sinks/ConsoleSink";
import { TelemetrySink } from "./sinks/TelemetrySink";

interface BootOpts {
  getContext: () => AdapterContext;
  getWebView: () => WebView | null;
  resolveEvmChain: Parameters<typeof createEvmAdapter>[0]["resolveChainConfig"];
  resolveSupportedEvmChain?: Parameters<
    typeof createEvmAdapter
  >[0]["resolveSupportedChain"];
  resolveDefaultEvmChain?: Parameters<
    typeof createEvmAdapter
  >[0]["resolveDefaultChain"];
  onWatchAsset?: Parameters<typeof createEvmAdapter>[0]["onWatchAsset"];
  onShowCallsStatus?: Parameters<
    typeof createEvmAdapter
  >[0]["onShowCallsStatus"];
}

let booted = false;

/**
 * One-shot boot — registers adapters, inspectors, renderers, and the
 * DappBridge. Safe to call more than once: the guard short-circuits repeat
 * calls, but re-binds the per-screen getters.
 */
export function bootBridge(opts: BootOpts) {
  const bridge = initDappBridge({
    getContext: opts.getContext,
    getWebView: opts.getWebView,
  });

  if (booted) return bridge;
  booted = true;

  InspectorRegistry.register(HttpsInspector);
  InspectorRegistry.register(HeuristicInspector);
  InspectorRegistry.register(EvmCalldataDecoderInspector);
  InspectorRegistry.register(SolanaProgramDecoderInspector);
  InspectorRegistry.register(SolanaSimulationInspector);
  InspectorRegistry.register(SolanaSiwsInspector);
  InspectorRegistry.register(SuiPtbDecoderInspector);
  InspectorRegistry.register(SuiSimulationInspector);
  InspectorRegistry.register(SuiSiwsInspector);
  InspectorRegistry.register(StellarXdrDecoderInspector);
  InspectorRegistry.register(StellarPreflightInspector);

  bridgeEventBus.subscribe(ConsoleSink);
  bridgeEventBus.subscribe(TelemetrySink);
  bridgeEventBus.subscribe(AnalyticsSink);

  for (const r of evmRenderers) registerRenderer(r);

  const evmAdapter = createEvmAdapter({
    resolveChainConfig: opts.resolveEvmChain,
    resolveSupportedChain: opts.resolveSupportedEvmChain,
    resolveDefaultChain: opts.resolveDefaultEvmChain,
    onWatchAsset: opts.onWatchAsset,
    onShowCallsStatus: opts.onShowCallsStatus,
  });
  ChainAdapterRegistry.register(evmAdapter);

  // Solana is zero-config until a wallet with namespace "solana" exists;
  // registering lets dApps see the Wallet Standard announcement.
  const solanaAdapter = createSolanaAdapter();
  ChainAdapterRegistry.register(solanaAdapter);

  // Task 17 (spec §7.8) — wire the SolanaAdapter scaffold's
  // `registerSolanaSigner` to the first-party `SolanaWalletKit`. The kit
  // is resolved once inside `installSolanaSigner`; this install must
  // happen AFTER `createSolanaAdapter()` so the signer slot exists, and
  // AFTER `bootWalletKits()` (called at app boot in `app/_layout.tsx`) so
  // the kit registry is populated.
  //
  // `getRpcForCluster` uses Solana's public endpoints. The UI-facing
  // per-user rpcUrl is sourced from the backend `/blockchains` feed
  // (see `ChainSelector` / `buildChainConfigFromBlockchain`) and threads
  // into the kit's `sendNativeTransfer` via `activeChain`. The bridge
  // signer runs in a non-React context and services a dApp-supplied
  // cluster hint — public defaults are the correct fallback there.
  // `rpcSubs` is omitted: public RPCs rate-limit WS subscriptions;
  // private subscription URLs are future work.
  // Boot-order precondition. Any kit whose adapter is registered above
  // MUST have its `WalletKitAdapter` in `walletKitRegistry` before we
  // reach this point, otherwise signer installation (here and for any
  // future chain) silently degrades to "no signer registered" runtime
  // errors when a dApp tries to sign. Check explicitly so the failure
  // mode is a loud dev-time warning tied to the offending chain, not
  // a `-32603` at first signMessage.
  //
  // Fast Refresh corner case: the registry module can be re-evaluated
  // (and cleared) while this module's `booted` flag is still `true`.
  // When the kit is missing, we reset `booted` so the next mount retries
  // — no throw, because retry is the correct behaviour.
  if (walletKitRegistry.has("solana")) {
    installSolanaSigner({
      getWalletByAddress: (addr) =>
        opts.getContext().wallets.find((w) => w.address === addr),
      getRpcForCluster: (cluster) => {
        const url =
          cluster === "devnet"
            ? "https://api.devnet.solana.com"
            : "https://api.mainnet-beta.solana.com";
        return { rpc: createSolanaRpc(url) };
      },
    });
  } else {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(
        "[bridge] Solana kit not registered in walletKitRegistry; " +
          "Solana dApp signing disabled until next bootBridge. " +
          "Did `bootWalletKits()` run before `bootBridge()`?",
      );
    }
    booted = false;
  }

  // Sui dApp bridge — full Wallet Standard implementation per
  // `docs/sui-dapp-bridge-spec.md`. Flipped ON in Task 20 once all
  // upstream tasks (00–19) and the security gate (TWV-2026-YYY,
  // `docs/wallet-security-task/66_sui_dapp_bridge_design_note.md`)
  // landed.
  //
  // Boot-order precondition: the Sui WalletKit must be registered in
  // `walletKitRegistry` before `installSuiSigner` lands a signer. When
  // the kit is missing we leave the adapter registered (so dApp
  // discovery sees the Wallet Standard announcement) but
  // `executeApproval` will return `-32603 "no Sui signer registered"`
  // — same loud-failure pattern Solana uses.
  //
  // `getRpcForNetwork` falls back to public Sui Foundation full nodes;
  // private endpoints will ride here once the project provisions them.
  // `dryRunTransactionBlock` rate-limits on public endpoints — the
  // simulation inspector tolerates `null` from a rate-limited dry-run.
  const FEATURE_SUI_DAPP_BRIDGE = true;
  if (FEATURE_SUI_DAPP_BRIDGE) {
    ChainAdapterRegistry.register(createSuiAdapter());
    if (walletKitRegistry.has("sui")) {
      installSuiSigner({
        getWalletByAddress: (addr) =>
          opts.getContext().wallets.find((w) => w.address === addr),
        getRpcForNetwork: (network: SuiNetwork) => {
          const url =
            network === "testnet"
              ? "https://fullnode.testnet.sui.io:443"
              : network === "devnet"
                ? "https://fullnode.devnet.sui.io:443"
                : "https://fullnode.mainnet.sui.io:443";
          return { client: new SuiClient({ url, network }) };
        },
      });
    } else {
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn(
          "[bridge] Sui kit not registered in walletKitRegistry; " +
            "Sui dApp signing disabled until next bootBridge. " +
            "Did `bootWalletKits()` run before `bootBridge()` and include Sui?",
        );
      }
      booted = false;
    }
  }

  // Stellar dApp bridge — real implementation
  // (docs/stellar-dapp-bridge-spec.md). SEP-0043 via Freighter's
  // concrete `postMessage` transport (§1). Boot-order precondition, same
  // shape as Solana/Sui: the Stellar kit must be registered in
  // `walletKitRegistry` before `installStellarSigner` lands a signer.
  // `stellar-chain-support-spec.md` task 09 already registers it
  // unconditionally, so this guard is defensive (Fast Refresh,
  // boot-order regressions) rather than an expected steady-state branch
  // — same posture the Solana/Sui blocks already have for their own
  // already-registered kits.
  //
  // `installStellarSigner`'s deps needs less than Solana's/Sui's
  // `install*Signer` calls: `getHorizonClient` is only reached down the
  // `submit === true` branch (§1.8), and it's the same per-chain client
  // `stellar-chain-support-spec.md` already built
  // (`services/chains/stellar/horizonClient.ts`) — no new RPC plumbing,
  // no client resolved at all on the (default, more common) sign-only
  // path.
  //
  // Flipped ON for task 16's manual live-dApp smoke test (§15, roll-out
  // step 10). Flip back to `false` if the smoke test surfaces a
  // blocking issue; leave it `true` once §16's dApp-quirks doc is
  // written and task 17 (ship) is ready.
  const FEATURE_STELLAR_DAPP_BRIDGE = true;
  if (FEATURE_STELLAR_DAPP_BRIDGE) {
    ChainAdapterRegistry.register(createStellarAdapter());
    if (walletKitRegistry.has("stellar")) {
      installStellarSigner({
        getWalletByAddress: (addr) =>
          opts.getContext().wallets.find((w) => w.address === addr),
        getHorizonClient,
      });
    } else {
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn(
          "[bridge] Stellar kit not registered in walletKitRegistry; " +
            "Stellar dApp signing disabled until next bootBridge. " +
            "Did `bootWalletKits()` run before `bootBridge()` and include Stellar?",
        );
      }
      booted = false;
    }
  }

  void PermissionStore.hydrate();
  void pendingIntentsStore.hydrate();

  return bridge;
}
