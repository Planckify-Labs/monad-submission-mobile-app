import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Exact-specifier match, checked before the "@" prefix alias below —
      // keeps posthog-react-native (RN/Flow syntax, unparseable by esbuild)
      // out of pure-logic executor tests. See services/analytics/posthog.mock.ts.
      "@/services/analytics/posthog": path.resolve(
        __dirname,
        "services/analytics/posthog.mock.ts",
      ),
      // `react-native-quick-crypto` is a Nitro native module and cannot load
      // outside the app runtime. The Node twin is real Argon2id + AES-GCM, so
      // the envelope tests still exercise genuine crypto.
      "@/services/backup/primitives": path.resolve(
        __dirname,
        "services/backup/primitives.node.ts",
      ),
      // Native cookie module (RN NativeModules) — mocked for any pure-logic
      // test that transitively reaches services/chains/evm/dappCookies.ts.
      "@react-native-cookies/cookies": path.resolve(
        __dirname,
        "services/chains/evm/rnCookies.mock.ts",
      ),
      // `react-native-mmkv` is a Nitro native module. Stubbed at OUR module
      // boundary so persistence-backed logic (the agent's confirmed
      // destinations) stays testable; mirrored on the node side by the
      // resolver hook's mmkv-storage stub.
      "@/lib/storage/mmkv": path.resolve(__dirname, "lib/storage/mmkv.mock.ts"),
      "@": path.resolve(__dirname, "."),
    },
  },
  // Metro injects `__DEV__`; under vitest it is simply absent, so any
  // module using the bare (unguarded) form throws a ReferenceError on
  // its first dev-log line. Define it as `false` so production-path code
  // runs verbatim and dev logging stays out of test output.
  define: { __DEV__: "false" },
  test: {
    include: [
      "services/rpc/proxyAuth.test.ts",
      "services/chains/addressCompare.test.ts",
      "services/agent-executors/sui.test.ts",
      "services/chains/solana/takumiPay/pda.test.ts",
      "services/chains/stellar/takumiPay/encoding.test.ts",
      "services/chains/stellar/takumiPay/depositPoints.test.ts",
      "services/chains/sui/codec.test.ts",
      "services/chains/sui/coinTransferService.test.ts",
      "services/chains/sui/derivation.test.ts",
      "services/chains/sui/errorCodes.transferErrors.test.ts",
      "services/chains/sui/tokenKind.test.ts",
      "services/chains/sui/transferService.test.ts",
      "services/nanopay/solana/__tests__/*.test.ts",
      // Sui Intent Engine (Sui Overflow 2026 Phase 1)
      "services/chains/sui/intent/intentSchema.test.ts",
      "services/chains/sui/intent/intentStore.test.ts",
      "services/chains/sui/intent/compileIntentToPtb.test.ts",
      "services/chains/sui/intent/guardian/guardian.test.ts",
      "services/swap/sui/venueSelector.test.ts",
      "services/swap/sui/appendIntentReceipt.test.ts",
      "services/swap/sui/intentReceiptPackageId.test.ts",
      "services/agent-executors/defi/intentExecutors.test.ts",
      "services/agent-executors/defi/opportunityScope.test.ts",
      "services/agent-executors/defi/intentSchemaParity.test.ts",
      "services/agent-executors/parseInput.test.ts",
      // Cross-repo registry parity (server TOOL_REGISTRY ⇄ EXPECTED_MOBILE_TOOLS).
      // Runnable now that the expected list lives in an import-free module.
      "services/agent-executors/registryParity.test.ts",
      // Known-destination envelope: every write tool must declare whether
      // it has a user-supplied counterparty, so none skips the check.
      "services/agent-executors/counterparty.test.ts",
      // The confirmed-destination store + the own-wallet rule that keeps
      // the envelope from prompting on the user's own addresses.
      "services/confirmedCounterpartyStore.test.ts",
      // Bridge capability (docs/bridge-capability-spec.md). Pure CAIP
      // parsing + the adapter-registry seam, and the card formatters
      // whose per-token decimals handling §6 depends on.
      "services/bridgeRoutes/caip.test.ts",
      // The destination-wallet interlock: what stops a `bridge_execute`
      // signing an address the user has already replaced (§7.4).
      "services/bridgeRoutes/destinationChoice.test.ts",
      "components/home/TakumiAgent/StructuredUI/cards/bridgeFormat.test.ts",
      // Facts-first approval text — the surface a confirmation is
      // recorded against, so it must state amount + destination.
      "components/home/TakumiAgent/StructuredUI/approvalSummary.test.ts",
      // Once-per-turn consolidation of repeated list-tool cards.
      "components/home/TakumiAgent/StructuredUI/mergeToolParts.test.ts",
      // Pool-level DeFi deposits (docs/defi-pool-level-deposits-spec.md)
      "services/defi/opportunityDisplay.test.ts",
      "services/defi/registry.test.ts",
      "services/defi/errors/defiErrors.test.ts",
      // Stellar chain support (docs/stellar-chain-support-spec.md)
      "services/chains/stellar/amount.test.ts",
      "services/chains/stellar/derivation.test.ts",
      "services/chains/stellar/strkey.test.ts",
      "services/chains/stellar/errorCodes.test.ts",
      "services/chains/stellar/accountState.test.ts",
      "services/chains/stellar/trustlineService.test.ts",
      "services/chains/stellar/transferService.test.ts",
      "services/chains/stellar/assetTransferService.test.ts",
      "services/chains/stellar/base64.test.ts",
      "services/chains/stellar/sep53.test.ts",
      "services/chains/stellar/horizonClient.test.ts",
      // StellarWalletKit.test.ts runs under node:test (not vitest) —
      // it transitively imports walletService.ts, which needs the EVM
      // resolver's expo-secure-store/mmkv stubs. Mirrors
      // SuiWalletKit.test.ts's setup.
      // Stellar dApp bridge (docs/stellar-dapp-bridge-spec.md) — these
      // files have no RN-only transitive imports, so they run under
      // vitest directly (StellarAdapter.ts/signer.ts/injectedScript.ts
      // themselves are covered by grep-style node:test files instead,
      // same split as the Sui dApp-bridge tests).
      "services/chains/stellar/payloads.test.ts",
      "services/chains/stellar/xdrDecode.test.ts",
      "services/chains/stellar/agentContext.test.ts",
      "services/bridge/inspectors/StellarPreflightInspector.test.ts",
      // PPOB catalog categorization (space-docked per fulfillment partner)
      "services/ppob/vcgamer.test.ts",
      // Encrypted seed backup (docs/encrypted-seed-backup-spec.md)
      "services/backup/seedBackupCrypto.test.ts",
      "services/backup/bytes.test.ts",
      "services/backup/passphrasePolicy.test.ts",
    ],
  },
});
