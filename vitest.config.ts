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
      // `services/tokens/tokenList.ts` persists through expo-sqlite, whose
      // build output ships JSX. EvmAdapter imports `isDefaultToken` from
      // it for the phase-D approve disambiguation, so any test reaching
      // the adapter pulls SQLite in. Twin of the `token-list` stub in
      // services/walletKit/evm/_test-resolver-hook.mjs.
      "@/services/tokens/tokenList": path.resolve(
        __dirname,
        "services/tokens/tokenList.mock.ts",
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
      // `expo-secure-store` is a native module. Stubbed in-memory so the
      // dApp bridge's pending-approval queue (spec phase Q) is testable;
      // mirrored on the node side by the resolver hook's own stub.
      "expo-secure-store": path.resolve(
        __dirname,
        "lib/storage/expoSecureStore.mock.ts",
      ),
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
      // Wallet-standards hardening spec
      // (docs/wallet-standards-hardening-spec.md) — phases B/C/D/F.
      "services/decoders/walletStandards.test.ts",
      // Round 2 (spec §17, phases L–R) — findings from running the bridge
      // against the MetaMask/test-dapp adversarial corpus.
      "services/decoders/walletStandardsRound2.test.ts",
      "services/chains/evm/eip5792.test.ts",
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
      "services/nanopay/pathOnchainSettlement.test.ts",
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
      // Wallet-namespace access layer: the signer / counterparty /
      // discovery role split every chain-touching surface dispatches on.
      "services/walletPresence/walletPresence.test.ts",
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
      // Failure-card copy + the add-wallet action offered alongside it.
      "components/home/TakumiAgent/StructuredUI/agentErrorCopy.test.ts",
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
      // Cold-start handling of the persisted approval queue — the
      // escalation path that turned one crashing sheet into a dApps
      // screen that could not be opened for five minutes.
      "services/bridge/pendingIntents.test.ts",
      // PPOB catalog categorization (space-docked per fulfillment partner)
      "services/ppob/vcgamer.test.ts",
      // Receipt amounts: exact rendering on detail screens, and the
      // float-truncation bug that showed 0.29 as 0.28.
      "utils/tokenAmount.test.ts",
      // vcGamer PLN voucher_code parsing: unit-suffix-less / comma-decimal
      // variants are what silently hid the Token Code card on real orders.
      "utils/vcGamerUtils.test.ts",
      // dApps-browser address bar: what the user types decides the origin
      // the bridge grants permissions against, so the scheme allowlist and
      // the userinfo/zero-width stripping are covered here rather than
      // trusted to RN's regex-shim `URL`.
      "services/dappsBrowser/omnibox.test.ts",
      "services/dappsBrowser/suggest.test.ts",
      // Hub directory: the chart order the rank numbers label, and the
      // one-host-one-chip rule the "Jump back in" strip depends on.
      "services/dappsBrowser/directory.test.ts",
      // Site-icon cache: the rule that a visit reporting no icon must
      // never erase the one already on screen.
      "services/dappsBrowser/faviconStore.test.ts",
      // Encrypted seed backup (docs/encrypted-seed-backup-spec.md)
      "services/backup/seedBackupCrypto.test.ts",
      "services/backup/bytes.test.ts",
      "services/backup/passphrasePolicy.test.ts",
    ],
  },
});
