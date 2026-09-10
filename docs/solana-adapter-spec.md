# Solana Adapter — Engineering Spec (DApp Bridge)

**Status:** Draft
**Owner:** Wallet team
**Scope:** `takumiaiwallet/mobile-app` — `services/chains/solana/*`, `services/bridge/*` (no changes), `components/dapps-browser/approvals/Solana*`, one targeted diff to `services/bridge/approval.ts`
**Date:** 2026-04-17
**Companion docs:**
- `docs/dapp-bridge-spec.md` — the docking ports this adapter plugs into (read first).
- `docs/solana-chain-support-spec.md` — first-party Solana primitives (wallet creation, SOL transfer, `SolanaWalletKit`). This spec consumes those primitives; it does not re-specify them.

---

## 1. Goal

Ship a production-grade `SolanaAdapter` that makes TakumiAI a first-class in-app **Solana dApp wallet**, side-by-side with the EVM adapter on the exact same `DappBridge` spine. The adapter exposes every Solana Wallet Standard feature major dApps rely on (Jupiter, Magic Eden, Tensor, pump.fun, Drift, Marinade, Jito-Flow, Phantom's test page, Solana sign-in relying parties), with full compliance on versioned transactions, address lookup tables, durable nonces, priority fees, SIWS, and token-2022. **Zero changes** to `DappBridge`, `ApprovalHost`, `IntentInspector`, `BridgeEventBus`, or the EVM adapter. One surgical diff lands in `services/bridge/approval.ts` to add a missing `ApprovalKind` variant.

## 2. Guiding principles

1. **Namespace isolation.** Everything Solana-specific lives under `services/chains/solana/` or `components/dapps-browser/approvals/Solana*`. `app/dapps-browser.tsx`, the bridge router, the inspector pipeline, and the EVM adapter never learn Solana exists.
2. **Wallet Standard or bust.** The primary announce is `@wallet-standard/core`'s `registerWallet()` contract with the Anza-maintained `solana:*` feature set. `window.solana` is shipped only as a **minimal compatibility shim** for the legacy long-tail, and every method it exposes is re-implemented on top of the same bridge path — no second code path.
3. **No side channels.** Every signing decision, every cluster change, every SIWS auth flows through `DappBridge → InspectorPipeline → ApprovalHost`. No `window._pendingSolanaResolve`, no per-method resolvers on `globalThis`, no direct `Connection.sendRawTransaction` from the injected script.
4. **Simulation-first UX.** Solana's `simulateTransaction` is free, fast, and returns the exact pre-flight state the dApp expects. Every `signTransaction` / `signAndSendTransaction` intent is simulated before reaching the user; delta (SOL, SPL, rent, nonce) is surfaced in the sheet. A `SolanaSimulationInspector` is another `IntentInspector` implementation; it does not get bespoke plumbing.
5. **Versioned everything.** We declare `supportedTransactionVersions = ["legacy", 0]` from day one. Address Lookup Tables are resolved server-side via RPC, never re-broadcast to the user as opaque "unknown accounts." Legacy v1 transactions remain supported only for the long tail — every sheet renders a uniform post-resolution view.
6. **Single signer dwell.** `getSolanaSignerForWallet` in `services/walletService.ts` is and remains the **only** JS-heap dwell site for the 32-byte ed25519 seed (TWV-2026-070). The adapter never reconstructs a signer; it consumes the `KeyPairSigner` handed to it by `installSolanaSigner`.
7. **The screen stays dumb.** `app/dapps-browser.tsx` does not grow a Solana branch. The injected-script concatenation already routes through `ChainAdapterRegistry.list().map(a => a.getInjectedScript(ctx))`.

## 3. Current state audit

| Concern | File | Status |
|---|---|---|
| `Namespace = "solana"` declared | `services/chains/types.ts:4` | ✅ |
| `TWallet.namespace` non-optional; backfill stamps `"eip155"` | `constants/types/walletTypes.ts:38`, `services/walletService.ts:122` | ✅ |
| `SolanaAdapter` skeleton registered in boot | `services/bridge/boot.ts:63`, `services/chains/solana/SolanaAdapter.ts` | ⚠️ scaffold only — fake `window.solana` shim, no Wallet Standard announce, no cluster routing, no feature versioning |
| Payloads | `services/chains/solana/payloads.ts` | ⚠️ three shapes (`connect`/`signMessage`/`signTx`) — missing sign-all, SIWS, cluster-switch, watch-token, watch-nft |
| Signer wire-up (`installSolanaSigner`) | `services/chains/solana/signer.ts` | ✅ functional for `signMessage` / `signTransaction` / `signAndSendTransaction`. Missing: `signAllTransactions`, SIWS. Default `rpcSubs: undefined` → no WS confirmation fallback. |
| Wallet creation (SLIP-0010, base58, 32+64 byte import) | `services/chains/solana/derivation.ts`, `services/chains/solana/codec.ts`, `services/walletKit/solana/SolanaWalletKit.ts` | ✅ delivered by `solana-chain-support-spec.md` |
| Approval sheets | `components/dapps-browser/approvals/SolanaSignMessageSheet.tsx`, `SolanaTransactionSheet.tsx`, `ConnectSheet.tsx` (reused) | ⚠️ render raw base64 + raw utf-8, zero decoded context, no simulation results, no SIWS structured view, no Token-2022 extension warnings |
| `ApprovalKind` union | `services/bridge/approval.ts:6-16` | ❌ no `"signAllTransactions"` variant; the current Solana scaffold overloads `"signTransaction"` for all three tx-paths, so we can't distinguish approve-one-tx from approve-N-txs in the sheet |
| `solana:signIn` feature | none | ❌ not implemented — SIWS-gated dApps (Phantom demo, Drift onboarding, Step, early-access signups) silently fall back to `connect + signMessage` with no domain pinning |
| Cluster switching convention | ad-hoc `opts.cluster` string in `signAndSendTransaction` only | ❌ no user-visible "switch cluster" flow, no propagation to `useWallet.activeChain`, no `standard:events` `change` emission |
| Simulation / decoded deltas | none | ❌ sheets display raw base64; users blind-sign |
| Token-2022 awareness | none | ❌ transfer-fee / confidential-transfer / permanent-delegate extensions invisible to the user |
| Priority fee / compute budget UX | none | ❌ dApp-supplied compute-unit price flows through unchecked; user sees no fee estimate |
| Durable-nonce handling | none | ❌ nonce authority check absent; sheet shows recent-blockhash vs nonce identically |
| Partial/multi-signer flows | none | ❌ `signAllTransactions` missing; partial-signer delegation (fee payer elsewhere) unhandled |

**Conclusion:** the plumbing is in place — `handleRequest`/`executeApproval`/`registerSolanaSigner`/signer dwell — but the adapter today is a prototype. Wallet Standard compliance, SIWS, cluster routing, simulation, and safe-signing UX are all gap work for Phase 1.

## 4. Architecture — the Solana slice

Nothing new structurally. One adapter, one injected-script builder, one expanded payload union, one set of sheets, one inspector, one signer wiring module. Every arrow points into existing infrastructure.

```
        WebView (Jupiter, MagicEden, Drift, Phantom demo, …)
                  │
                  │ Wallet Standard feature call
                  ▼
        injected: registerWallet({TakumiSolanaWallet}) + window.solana shim
                  │
                  │ postMessage({type:"bridge_request", namespace:"solana", …})
                  ▼
         ┌──────────────────┐
         │    DappBridge    │  (unchanged)
         └────────┬─────────┘
                  │ adapter.handleRequest()
                  ▼
         ┌──────────────────────────────────┐
         │         SolanaAdapter            │
         │  route by method → payload kind  │
         │  attach cluster + fee payer      │
         └────────┬─────────────────────────┘
                  │ ChainResult.needs-approval
                  ▼
         ┌──────────────────────────────────┐
         │     IntentInspector pipeline     │
         │  - Https, Heuristic (ns-gated)   │
         │  - SolanaSimulationInspector ★   │
         │  - SolanaProgramDecoder ★        │
         │  - AgentInspector (on-demand)    │
         └────────┬─────────────────────────┘
                  │ annotated intent
                  ▼
         ┌──────────────────────────────────┐
         │     ApprovalHost + renderers     │
         │  Solana{Connect,SignIn,          │
         │        SignMessage,Transaction,  │
         │        SignAllTransactions,      │
         │        SwitchCluster,WatchToken} │
         └────────┬─────────────────────────┘
                  │ ApprovalDecision
                  ▼
         ┌──────────────────────────────────┐
         │ adapter.executeApproval()        │
         │   → SolanaBridgeSigner (kit)     │
         │   → rpc.sendTransaction | cached │
         │     send-and-confirm factory     │
         └──────────────────────────────────┘
              ★ = new in this spec, plug into existing InspectorRegistry
```

### 4.1 `SolanaAdapter` — method routing table

Adapter reads `ChainRequest.method` verbatim (the string the injected script / shim wrote on the wire) and produces either a `ChainResult.resolved`, `ChainResult.error`, or a typed `needs-approval` with a `SolanaApprovalPayload`. Full routing table in §10.1; shape below.

```ts
// services/chains/solana/SolanaAdapter.ts
async handleRequest(req, ctx): Promise<ChainResult> {
  const wallet = pickSolanaWallet(ctx, req);            // throws 4100 if none
  const cluster = resolveCluster(req, ctx);             // caip-2 narrow
  switch (req.method) {
    case "standard:connect":              return makeConnectIntent(…);
    case "standard:disconnect":           return { status: "resolved", value: null };
    case "solana:signIn":                 return makeSignInIntent(…);        // SIWS
    case "solana:signMessage":            return makeSignMessageIntent(…);
    case "solana:signTransaction":        return makeSignTxIntent(…, "sign-only");
    case "solana:signAndSendTransaction": return makeSignTxIntent(…, "sign-and-send");
    case "solana:signAllTransactions":    return makeSignAllIntent(…);
    case "takumi:switchCluster":          return makeSwitchClusterIntent(…); // see §4.5
    case "takumi:watchToken":             return makeWatchTokenIntent(…);    // see §4.7
    default:                              return { status: "error", code: 4200, … };
  }
}
```

### 4.2 Injected script — Wallet Standard announce

The `window.solana` shim stays, but it is now a **thin wrapper** over the same bridge path the Wallet Standard methods use. Both paths write the same `bridge_request` envelope; the adapter neither knows nor cares which one originated it.

`services/chains/solana/injectedScript.ts` builds a single IIFE that performs the **Wallet Standard registration handshake**, shims `window.solana`, and stamps the session nonce. Exact responsibilities in §4.2a–c.

**Key compliance note:** `supportedTransactionVersions` is published on both `solana:signTransaction` and `solana:signAndSendTransaction` as a **readonly literal tuple** `["legacy", 0]` — never a getter, never computed. dApps like Jupiter inspect the tuple via `wallet.features["solana:signTransaction"].supportedTransactionVersions.includes(0)` at connect time; a getter breaks deep-equality memoization in `@wallet-standard/react`. Omitting the tuple defaults dApps to legacy-only and silently blocks every Jupiter route that uses ALTs.

### 4.2a Handshake — the exact event contract

The Anza `@wallet-standard/core` `registerWallet()` helper dispatches **one** event and listens for **one**. Hand-rolling this in an injected IIFE (we can't run npm code inside a WebView) must use the exact same names; dApps bind to these strings with `addEventListener`, not to a shared package symbol.

```js
// The wallet dispatches this; the dApp's registration listener picks up the
// callback and calls it with an object containing { register }.
const event = new Event('wallet-standard:register-wallet');
event.detail = (api) => api.register(takumiSolanaWallet);
window.dispatchEvent(event);

// The wallet ALSO listens for `wallet-standard:app-ready` — fired by the
// dApp once its registration listener is bound. This handles the race where
// the wallet loaded after the dApp. The payload is the same `{ register }`.
window.addEventListener('wallet-standard:app-ready', (e) => e.detail.register(takumiSolanaWallet));
```

We **must** do both. Publishing only one half of the handshake leaves a race window where either (a) the wallet dispatches before the dApp registers its listener (fixed by `app-ready`) or (b) the dApp dispatches before the wallet script runs (fixed by us re-dispatching `register-wallet` on every injection including `onLoadEnd`). Idempotent install (`window.__takumi_solana_installed`) keeps re-injection cheap.

`injectedJavaScriptBeforeContentLoaded` + the `onLoadEnd` re-injection pattern (see `app/dapps-browser.tsx:297-324`) already covers both halves; the Solana adapter inherits it.

### 4.2b `TakumiSolanaWallet` — exact object shape

The object handed to `register` must conform to `Wallet` from `@wallet-standard/base`. Every field listed here is read at dApp connect time; fields with the wrong type or shape make the wallet **invisible** to `@solana/wallet-adapter-wallet-standard` (which filters on `features["solana:signAndSendTransaction"].version === "1.0.0"` among other predicates).

```ts
const takumiSolanaWallet: Wallet = {
  // Literal string `"1.0.0"` — the Wallet Standard version, NOT our app version.
  version: "1.0.0",
  name: "TakumiPay",
  // WalletIcon = `data:image/${"svg+xml"|"webp"|"png"|"gif"};base64,${string}`.
  // Must be ≤ 100KB; dApps render it in a wallet-picker list.
  icon: "data:image/svg+xml;base64,…takumi-logo…",
  // IdentifierArray of every chain the wallet supports, with both the short
  // form (@solana/wallet-standard-chains) and the CAIP-2 genesis-hash form
  // (what a few legacy dApps still read) — listing both is cheap and covers
  // the long tail.
  chains: [
    "solana:mainnet",
    "solana:devnet",
    "solana:testnet",
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", // mainnet genesis hash
    "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", // devnet genesis hash
    "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z", // testnet genesis hash
  ],
  features: { /* see §4.2c */ },
  // One WalletAccount per connected Solana wallet. Before connect, this is
  // []; after approve, populated from the active wallet. dApps read
  // account.publicKey as a raw 32-byte Uint8Array — we decode base58 once
  // at connect time and cache.
  accounts: [/* see §4.2d */],
};
```

### 4.2c `features` map — exact identifiers and shapes

Feature identifiers are `IdentifierString` (`<namespace>:<name>`). dApps feature-detect by key; miss-spelling a key means a silent "feature not available" on their side.

```ts
const features: IdentifierRecord<unknown> = {
  "standard:connect": {
    version: "1.0.0",
    connect: async (input?: { silent?: boolean }) => {
      // `silent: true` = `onlyIfTrusted` semantic. Resolve silently if a
      // PermissionGrant exists for this origin+cluster; reject `4100` if not.
      // Never surface a sheet on `silent: true`.
      return { accounts: [/* filtered by permission */] };
    },
  },
  "standard:disconnect": {
    version: "1.0.0",
    disconnect: async () => { /* clears PermissionGrant */ },
  },
  "standard:events": {
    version: "1.0.0",
    on: <E extends "change">(event: E, listener: (props: StandardEventsChangeProperties) => void) => {
      // Return an off-function. We fire `change` per §4.2e.
    },
  },
  "solana:signIn": {
    version: "1.0.0",
    signIn: async (...inputs: readonly SolanaSignInInput[]) => { /* SIWS */ },
  },
  "solana:signMessage": {
    version: "1.0.0",
    signMessage: async (...inputs: readonly SolanaSignMessageInput[]) => {
      // Input: { account, message: Uint8Array }. Output: { signedMessage, signature }.
    },
  },
  "solana:signTransaction": {
    version: "1.0.0",
    supportedTransactionVersions: ["legacy", 0] as const,
    signTransaction: async (...inputs: readonly SolanaSignTransactionInput[]) => {
      // Variadic at the feature level. A 1-tx call and an N-tx call both
      // route here; `SolanaSignAllTransactionsSheet` renders when N > 1,
      // `SolanaTransactionSheet` when N == 1.
      // Output: readonly SolanaSignTransactionOutput[] with { signedTransaction: Uint8Array }.
    },
  },
  "solana:signAndSendTransaction": {
    version: "1.0.0",
    supportedTransactionVersions: ["legacy", 0] as const,
    signAndSendTransaction: async (...inputs: readonly SolanaSignAndSendTransactionInput[]) => {
      // Input carries `chain: SolanaChain` and `options: { commitment, skipPreflight, maxRetries, preflightCommitment, minContextSlot }`.
      // Output: readonly { signature: Uint8Array }[].
    },
  },
  // Custom features. The Wallet Standard allows any `<namespace>:<name>` identifier
  // whose namespace is not `standard` or `experimental` (reserved). `takumi:` is
  // ours. dApps that don't know about them simply ignore them.
  "takumi:switchCluster": { version: "1.0.0", switchCluster: async (to: SolanaCluster) => {} },
  "takumi:watchToken":    { version: "1.0.0", watchToken: async (mint: string, hint?) => {} },
};
```

**Variadic signing is not `signAllTransactions`.** The `solana:signTransaction` feature is variadic at the protocol level: `signTransaction(tx)` and `signTransaction(tx1, tx2, tx3)` are both valid calls on the same feature and produce parallel arrays. There is no separate Wallet Standard `signAllTransactions` feature. The legacy `window.solana.signAllTransactions(txs)` maps to `signTransaction(...txs)` on the standard path. Our adapter treats a variadic call with `N > 1` as one `signAllTransactions` `ApprovalKind` (for sheet UX) and with `N == 1` as one `signTransaction` kind; both are fulfilled by the same `solana:signTransaction` feature on the wire.

### 4.2d `WalletAccount` — exact shape per connected wallet

```ts
const walletAccount: WalletAccount = {
  // base58 pubkey — what all dApps render.
  address: "9xyz…base58…",
  // Raw 32 bytes. @solana/wallet-adapter-wallet-standard expects a
  // Uint8Array; passing a base58 string here is a silent "invalid account"
  // rejection at dApp connect.
  publicKey: new Uint8Array(base58ToBytes(wallet.address)),
  // Cluster list this account is usable on. Listed as both short + CAIP-2
  // forms per §4.2b.
  chains: [
    "solana:mainnet", "solana:devnet", "solana:testnet",
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
  ],
  // Features this account supports — subset of the wallet's features. For
  // P1 everything is software-keys so every account supports everything.
  // Hardware accounts later will drop `solana:signAndSendTransaction` (can't
  // atomically broadcast during HW confirmation).
  features: [
    "solana:signIn",
    "solana:signMessage",
    "solana:signTransaction",
    "solana:signAndSendTransaction",
  ],
  label: wallet.name ?? "TakumiPay",
  icon: wallet.icon, // optional WalletIcon data URL per-account; we usually omit
};
```

### 4.2e `standard:events` — when we fire `change`

`StandardEventsChangeProperties` is `{ accounts?, chains?, features? }` where every field is optional and the wallet includes **only the fields that changed** (new value, not delta). Firing a change with unchanged fields trips `@wallet-standard/react` memo invalidation and can trigger dApp re-render storms.

| Trigger | Emits `change` with |
|---|---|
| User switches active wallet (another Solana wallet in the app) | `{ accounts: [newAccount] }` — only if dApp has a grant for the new wallet |
| User approves `takumi:switchCluster` | No `change` event. Per-request `chain:` routing makes this a UI-side concern; firing `change { chains: [...] }` would suggest our wallet *stopped supporting* the old cluster, which is not true. |
| User disconnects dApp (revokes grant) | `{ accounts: [] }` |
| User re-grants permission | `{ accounts: [account] }` |
| User adds a new feature (never happens post-boot) | `{ features: {...} }` — not expected; we boot with the full feature set |

`Wallet.chains` never changes post-boot; we always publish all three clusters. The narrowing to the current cluster happens per-request, not at the feature level.

### 4.2f `window.solana` shim — exact surface

Shim `window.solana` and `window.phantom.solana` (some long-tail dApps sniff `window.phantom` explicitly) with:

| Property | Value / behavior |
|---|---|
| `isPhantom` | `false` — do not impersonate Phantom. dApps that do "if isPhantom, show Phantom-only UX" stay honest. |
| `isTakumi` | `true` |
| `publicKey` | `{ toBytes(): Uint8Array; toBase58(): string; toString(): string }` — the PublicKey-ish duck-type Phantom exposes; `null` when not connected. |
| `isConnected` | Boolean mirroring `publicKey !== null` |
| `connect({ onlyIfTrusted })` | Routes `bridge_request` `standard:connect` |
| `disconnect()` | Routes `standard:disconnect` |
| `signMessage(bytes)` | Routes `solana:signMessage`; accepts `Uint8Array` or `string` (utf-8 encoded) |
| `signTransaction(tx)` | Routes `solana:signTransaction` with N=1 |
| `signAllTransactions(txs)` | Routes `solana:signTransaction` with N=txs.length |
| `signAndSendTransaction(tx, opts?)` | Routes `solana:signAndSendTransaction` |
| `request({ method, params })` | Method-dispatch map covering the above |
| `on(event, cb)` / `off(event, cb)` | Supports `connect`, `disconnect`, `accountChanged` |
| `signIn(input?)` | **Rejects `4200`** — dApps must use the Wallet Standard `solana:signIn` feature. Silent fallback here would skip domain pinning. |

No method on the shim talks to RPC directly. The shim script is ≤ 3 KB gzipped.

### 4.3 Payloads — `SolanaApprovalPayload` union

Tight, version-aware, every field narrowable.

```ts
// services/chains/solana/payloads.ts (expanded)

export type SolanaCluster = "mainnet-beta" | "devnet" | "testnet";

/**
 * Wallet Standard `chain` identifiers accepted on the wire. Two forms co-exist:
 *   - Short form (published by `@solana/wallet-standard-chains`, what 99% of
 *     modern dApps read): `solana:mainnet`, `solana:devnet`, `solana:testnet`.
 *   - CAIP-2 genesis-hash form (canonical per the CAIP-2 spec, still used by
 *     some legacy dApps and by WalletConnect v2): `solana:<genesis hash>`.
 *
 * We emit the short form as primary (in `Wallet.chains` + `WalletAccount.chains`)
 * and accept both on input. `canonicalizeChain()` normalises a mixed input to
 * the short form for routing.
 */
export type SolanaChain =
  | "solana:mainnet"
  | "solana:devnet"
  | "solana:testnet"
  | "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"   // mainnet-beta genesis hash
  | "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"   // devnet
  | "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z"; // testnet

export type SolanaConnectPayload = {
  cluster: SolanaCluster;
  /** Set when dApp passes `onlyIfTrusted: true`. Triggers silent-connect if granted. */
  onlyIfTrusted: boolean;
};

/**
 * Sign In With Solana — EIP-4361-derived. Structured so `SolanaSignMessageSheet`
 * never sees raw ABNF text; it sees parsed fields and renders each on its own row.
 */
export type SolanaSignInPayload = {
  domain: string;               // MUST match origin host (§10.4)
  address?: string;             // optional per spec; wallet fills if absent
  statement?: string;
  uri?: string;
  version?: "1";
  chainId?: SolanaCluster;
  nonce?: string;
  issuedAt?: string;            // ISO-8601
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
};

export type SolanaSignMessagePayload = {
  address: string;
  message: string;              // utf-8 where decodable, else base64 with `display:"base64"`
  display: "utf8" | "base64";
};

export type SolanaTxVersion = "legacy" | 0;

export type SolanaSignTxPayload = {
  mode: "sign-only" | "sign-and-send";
  address: string;
  cluster: SolanaCluster;
  version: SolanaTxVersion;
  /** base64 wire-format tx — primary source of truth. */
  transaction: string;
  /** Send opts mirror Wallet Standard `SolanaSignAndSendTransactionOptions`. */
  options?: {
    commitment?: "processed" | "confirmed" | "finalized";
    skipPreflight?: boolean;
    maxRetries?: number;
    preflightCommitment?: "processed" | "confirmed" | "finalized";
    minContextSlot?: number;
  };
  /** Populated by SolanaSimulationInspector (patch). Renderers consume this. */
  simulation?: SolanaSimulationSummary;
  /** Populated by SolanaProgramDecoder (patch). */
  decoded?: SolanaDecodedInstruction[];
};

export type SolanaSignAllTransactionsPayload = {
  address: string;
  cluster: SolanaCluster;
  /**
   * Produced when `solana:signTransaction` is called variadically with
   * `inputs.length > 1`. Not a separate feature on the wire — same feature,
   * same signer path, different sheet. N ≤ 20 enforced at the adapter.
   */
  transactions: Array<{
    transaction: string;
    version: SolanaTxVersion;
    simulation?: SolanaSimulationSummary;
    decoded?: SolanaDecodedInstruction[];
  }>;
};

export type SolanaSwitchClusterPayload = {
  from: SolanaCluster;
  to: SolanaCluster;
};

export type SolanaWatchTokenPayload = {
  mint: string;                 // base58
  symbol?: string;
  name?: string;
  decimals?: number;
  image?: string;
  tokenStandard?: "spl-token" | "token-2022" | "metaplex-nft" | "metaplex-cnft";
  /** Filled by the adapter via on-chain metadata lookup. Never trusted from dApp. */
  verified?: {
    mintOwner: "spl-token" | "token-2022";
    extensions?: string[];      // token-2022 extension names, see §10.4
  };
};

export type SolanaSimulationSummary = {
  unitsConsumed?: number;
  balanceChanges: Array<{ address: string; lamportsDelta: bigint }>;
  tokenChanges: Array<{
    owner: string;
    mint: string;
    decimals: number;
    rawDelta: bigint;
    uiDelta: string;
    tokenProgram: "spl-token" | "token-2022";
  }>;
  warnings: SolanaSimulationWarning[];
  logs: string[];
};

export type SolanaSimulationWarning =
  | { code: "writable.system-program"; program: string }
  | { code: "writable.unknown-program"; program: string }
  | { code: "nonce.authority-mismatch"; expected: string; got: string }
  | { code: "lookup-table.expanded"; table: string; addedAccounts: number }
  | { code: "token2022.transfer-fee"; mint: string; basisPoints: number }
  | { code: "token2022.permanent-delegate"; mint: string; delegate: string }
  | { code: "token2022.confidential-transfer-pending-balance"; mint: string }
  | { code: "ata.close-authority-change"; ata: string; newAuthority: string }
  | { code: "setAuthority"; account: string; to: string };

export type SolanaDecodedInstruction =
  | { program: "system"; kind: "transfer" | "advanceNonce" | "createAccount"; data: unknown }
  | { program: "spl-token" | "token-2022"; kind: string; data: unknown }
  | { program: "compute-budget"; kind: "setComputeUnitLimit" | "setComputeUnitPrice"; value: number | bigint }
  | { program: "memo"; data: string }
  | { program: string; kind: "unknown"; programName?: string };
```

The payload union is deliberately flat; every new kind gets its own renderer, and renderers pattern-match on `intent.kind + intent.namespace` via existing `renderers.ts` plumbing.

### 4.3a Required diff — `ApprovalKind`

```diff
 // services/bridge/approval.ts
 export type ApprovalKind =
   | "connect"
+  | "signIn"                // SIWS; EVM may adopt the same kind later for EIP-4361
   | "signMessage"
   | "signTypedData"
   | "signTransaction"
   | "sendTransaction"
+  | "signAllTransactions"   // Solana-only; sheet UX split — on the wire it's still `solana:signTransaction` with N>1 inputs
   | "switchChain"
+  | "switchCluster"         // Solana-only; EVM keeps switchChain semantics
   | "addChain"
   | "watchAsset"
   | "sendCalls"
   | "signAuthorization";
```

Three additions. Each is required by a real Wallet Standard feature with no EVM analog. `signIn` is a shared kind because SIWE support on EVM may re-use it in a follow-up spec — naming it Solana-specific now would force a rename later.

### 4.4 Execution paths — `@solana/kit` only

Decision locked: **`@solana/kit`** (the `anza-xyz/kit` functional successor to `@solana/web3.js`). Rationale:

- Already adopted across the codebase (`services/walletService.ts`, `services/chains/solana/{codec,transferService,signer}.ts`, `services/walletKit/solana/SolanaWalletKit.ts`).
- Tree-shakable — `@solana/web3.js` inflates the bundle by ~250 KB on a mobile app that already fights OTA size budgets.
- Typed wire formats (`Base64EncodedWireTransaction`, `Signature` brands) catch encoding bugs at compile time.
- Companion packages (`@solana-program/system`, `@solana-program/token`, `@solana-program/address-lookup-table`) cover every instruction we care about.
- `sendAndConfirmTransactionFactory` accepts `rpc` + optional `rpcSubscriptions` — the WS-free fallback is already wired in `installSolanaSigner` and `buildAndSendSolTransfer`.

**Do not** pull `@solana/web3.js` into the adapter even for "just parsing a legacy Transaction" — codec helpers in `services/chains/solana/codec.ts` round-trip both versions via `getTransactionDecoder` / `getTransactionEncoder`.

**Dependency additions** (new for this spec):

- `@wallet-standard/core` — for the `Wallet`, `WalletAccount`, `IdentifierString` contracts and the event plumbing.
- `@solana/wallet-standard-features` — canonical `SolanaSignTransactionFeature`, `SolanaSignAndSendTransactionFeature`, `SolanaSignMessageFeature`, `SolanaSignInFeature` type definitions. Consumed for type hygiene only; the actual wallet object is constructed by hand in the injected script (no npm package runs inside the WebView).
- `@solana-program/token` and `@solana-program/token-2022` — instruction decoders for the SPL Token program and Token-2022 program, used in `SolanaProgramDecoder` inspector.
- `@solana-program/address-lookup-table` — resolves ALT entries during simulation so the sheet shows real accounts, not raw indices.

**Wallet creation is out of scope** — `solana-chain-support-spec.md` already covers Ed25519 keypair generation, `m/44'/501'/0'/0'` SLIP-0010 derivation, 32- and 64-byte base58 import, CSPRNG polyfill, and TWV-2026-070 dwell invariants. The adapter consumes the `KeyPairSigner` that already comes from `getSolanaSignerForWallet`.

### 4.5 Cluster switching — the missing convention

Solana has no EIP-3326. Modern dApps read the current chain from the `standard:connect` response or from `Wallet.accounts[0].chains[]`; a few use a custom `chainChanged`-style event on the Wallet Standard `standard:events` feature.

We adopt the following convention, spec'd by this doc:

1. **Per-request cluster is authoritative.** Every `signTransaction` / `signAndSendTransaction` / `signIn` call carries a `chain: SolanaCaip2` field. The adapter routes RPC by that value; `useWallet.activeChain` is a *hint*, not a gate. This matches what Jupiter, Drift, and Tensor already do in practice.
2. **User-initiated switch** goes through a new `takumi:switchCluster` custom feature the injected wallet exposes on the Wallet Standard object. dApps can invoke it (we publish the shape); we also expose it in the wallet UI. Either path produces a `SolanaSwitchClusterPayload` intent rendered by `SwitchClusterSheet`.
3. **On approve**, adapter calls `ctx.setActiveChain(…)` (already threaded through `bootBridge` via `onSwitchChain`), then fires a `standard:events` `change` event with the new `accounts` list (addresses are cluster-independent, but `chains` on each account narrows to the new cluster). dApps subscribed via `wallet.features["standard:events"].on("change", …)` re-read state.
4. **If the dApp requests a cluster the user's wallet is not on** and the request is a signing method, we **do not** force a switch. We reject with `4901 "chain not connected"` and let the dApp decide whether to prompt the user to switch first. This is the Solana-mobile MWA convention and Phantom's current behavior; dApps that assume silent-switch are broken by design.

### 4.6 Fee payer, priority fees, compute budget

Three orthogonal concerns, all user-visible, all inspector-driven.

**Fee payer detection.** Every v0/legacy message declares its fee payer at index 0 of `message.staticAccountKeys`. If that address is *not* the active wallet, the intent is a **partial-sign** request (third-party paymaster scenario). The sheet renders a "Fees paid by {address}" row and skips the SOL-fee warning. If the fee-payer account has no SOL on-chain at simulation time, the sheet shows a `warn` annotation (`nonce.authority-mismatch`-style) — the tx will fail and the user should know before approving.

**Priority fee / compute budget.** The transaction may already carry `setComputeUnitLimit` and `setComputeUnitPrice` instructions (ComputeBudget program `11111111…99999`). `SolanaProgramDecoder` extracts them; the sheet shows:

- **Compute unit limit:** dApp-supplied (e.g. 300,000)
- **Compute unit price:** dApp-supplied micro-lamports/CU
- **Estimated priority fee:** `ceil(limit * price / 1_000_000)` lamports → UI
- **Network p90 (last 150 blocks):** `rpc.getRecentPrioritizationFees()` — for comparison only

If the dApp omitted both instructions, we annotate `info: "No priority fee — may drop during congestion"` but do not inject our own. Phantom's behavior (injecting a floor priority fee) breaks signature determinism for anyone who pre-signed the tx offline, and is not worth the footgun. Phase 1c can revisit a user-configurable "auto-boost" toggle.

**Compute unit limit < actual consumed.** If the simulation's `unitsConsumed` exceeds the dApp's declared `setComputeUnitLimit`, annotate `warn: "Compute limit too low — tx will fail"`. Catches a class of Jupiter route bugs.

### 4.7 `takumi:watchToken` — Solana's `wallet_watchAsset`

No EIP-747 analog exists on Solana. Modern dApps (Jupiter, pump.fun after a token launch) want to tell the wallet "remember this mint." We ship a custom feature under the `takumi:` namespace with the same UX as the EVM `WatchAssetSheet`:

- Payload carries `mint + symbol + decimals + image` as provided by the dApp.
- Adapter **always re-fetches** on-chain metadata (`getAccountInfo(mint)` to check whether the mint owner is `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` = classic SPL, or `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` = Token-2022, and to read decimals + extensions). Dapp-supplied values are displayed alongside on-chain values; mismatches raise a `warn` annotation.
- Token-2022 extensions are enumerated and surfaced: `transfer-fee: 5%`, `permanent-delegate: …`, `interest-bearing: rate 3.2%/yr`, `non-transferable`, `confidential-transfer`, etc. (See §10.4 inv 8.)
- On approve, writes into the same token list `useGroupedTokenBalances` already reads on the home screen. Persisted to the Solana-aware user-tokens store (lives in `services/tokens/tokenList.ts`; Solana-namespace support already exists per §3.1 of the chain-support spec).

### 4.8 SIWS — the actual SIWE-for-Solana flow

Solana Wallet Standard ships `solana:signIn` as a first-class feature. Relying parties (Phantom's reference demo, Drift onboarding, Step Finance, Magic Eden app-login) call it directly; fallback to `connect + signMessage` exists but produces a worse experience and no domain-pinning.

Shape (from `@solana/wallet-standard-features` `SolanaSignInInput`): domain, address?, statement?, uri?, version?, chainId?, nonce?, issuedAt?, expirationTime?, notBefore?, requestId?, resources?. Output: `{ account, signedMessage, signature, signatureType: "ed25519" }`.

**Adapter responsibilities:**

1. Parse the input. If any field is missing per spec ("the wallet must determine"), we do not invent it — we omit it from the constructed message, matching Phantom's behavior.
2. Construct the canonical message string (EIP-4361-derived ABNF, Solana variant — see `phantom/sign-in-with-solana` reference) and hand it to the user.
3. **Domain invariant (§10.4 inv 1):** if `input.domain !== originHost(origin.url)`, annotate `danger: "SIWS domain mismatch"` — same rule as SIWE.
4. **Address invariant:** if `input.address` is set and doesn't match `activeWallet.address`, reject with `4100 "address mismatch"` before the user sees the sheet. Silent signing of "any address" opens a class of confusion attacks.
5. On approve, signer returns the ed25519 signature over `signedMessage` (which is the exact bytes the wallet constructed — we do not accept dApp-supplied signing bytes). Response is the `SolanaSignInOutput` shape.
6. Emit a SIWS-specific `BridgeEvent` so the agent can reason about "the user just signed into foo.xyz with this wallet at T-30s" — never log the signature payload, only structural fields.

Renderer: new `SolanaSignInSheet` component. Mirrors `EvmSignMessageSheet`'s SIWE-structured block but under Solana chrome. Shows domain, statement, URI, chain, nonce, issuedAt, expirationTime, resources; uses `<RiskBanner>` for any `SolanaSignInInspector` annotations.

### 4.9 Simulation — a new inspector, not a new pipeline

`SolanaSimulationInspector` is one more `IntentInspector` in `services/bridge/inspectors/`. Contract:

- `name: "solana.simulation"`, `priority: 20`, `mode: "auto"`, `namespaces: ["solana"]`.
- Runs on `intent.kind in { "signTransaction", "sendTransaction", "signAllTransactions" }`.
- Calls `rpc.simulateTransaction(base64Tx, { sigVerify: false, commitment: "confirmed", replaceRecentBlockhash: true, innerInstructions: true, accounts: { encoding: "base64", addresses: writableAccounts } })`.
- From the `simulate` response, builds `SolanaSimulationSummary` (balance deltas via pre/post `accounts[].lamports`, SPL deltas via `postTokenBalances - preTokenBalances`, ALT-resolved account list).
- Emits `SolanaSimulationWarning[]` per §4.3 based on post-state.
- Returns `InspectionResult.patch` with the summary inserted into `intent.payload.simulation`. Per `inspector.ts:61-66`, `SECURITY_CRITICAL_FIELDS` already includes `"transaction"` — the raw base64 cannot be rewritten by any inspector. That guarantees simulation can only augment the view, never swap the tx.

`SolanaProgramDecoder` is a second inspector (`priority: 15`, `mode: "auto"`, `namespaces: ["solana"]`) that parses `transaction` into `SolanaDecodedInstruction[]` and stuffs that into `patch.decoded`. Pure local work, no network.

Both run before `ApprovalHost` renders, so the sheet opens with full context on first paint. 2-second pipeline timeout (inherited from `inspector.ts:53`) — on timeout the sheet still renders with an `info: "Simulation timed out"` annotation and the Approve button stays live (sim is advisory, not blocking).

**Decoded error contract.** When `simulateTransaction` returns `err`, the raw shape is typically `{ InstructionError: [instIdx, { Custom: errorCode }] }` — unreadable. The inspector decodes via a three-tier lookup:

1. **Program-by-program error tables** — for every program we decode (System, SPL Token, Token-2022, ComputeBudget, Memo, ATA program), ship a `programId → Record<errorCode, errorName>` map in `services/chains/solana/programErrors.ts`. System program's `0x1` → `"Custom program error: insufficient lamports"`. Token program's `0x1` → `"insufficient funds"`.
2. **Anchor error decoder** — Anchor emits errors in a uniform format (`AnchorError { errorCode: { code, number } }`) recognizable by reading `simulation.logs[]` for the `Program log: AnchorError caused by …` line. Parse the log, extract the human name, surface as the annotation title.
3. **Fallback** — when neither match, annotate `warn: "Program <programId> rejected the transaction (code 0x1771)"` with the raw log bundle in `data` for the "Show logs" expander. Never silently swallow.

Maintained alongside Solana program updates; out of CI scope.

### 4.10 Production broadcast path — `executeApproval` for `sendTransaction`

The current `installSolanaSigner` path either uses `sendAndConfirmTransactionFactory` (requires WebSocket subs we don't have) or fires one `sendTransaction` and returns — both broken for production. Real broadcast replaces both with the following deterministic state machine, living in `services/chains/solana/broadcast.ts`:

```ts
async function broadcastWithConfirmation(
  signedTxBase64: string,
  opts: { commitment, skipPreflight, maxRetries, preflightCommitment, minContextSlot },
  rpc: SolanaRpc,
): Promise<Uint8Array /* signature bytes */> {
  // 1. Preflight. If skipPreflight=false and we already ran simulation in the
  //    inspector at the dApp-requested preflightCommitment, re-use the
  //    cached result (keyed by sha256(signedTxBase64)). Otherwise run
  //    simulateTransaction once with { commitment: preflightCommitment }.
  //    On preflight error: reject `-32603 "preflight failed: <decoded>"`.

  // 2. Capture the tx's blockhash deadline. For recent-blockhash txs: fetch
  //    getBlockHeight at submit time; blockhash is valid for
  //    lastValidBlockHeight - currentBlockHeight slots (published by the
  //    node in the blockhash response, default ~150 slots ≈ 60s). For
  //    durable-nonce txs: no deadline — the nonce is the lifetime.

  // 3. Broadcast loop. Call rpc.sendTransaction(wire, { skipPreflight,
  //    maxRetries: 0, encoding: "base64" }) to submit. The node's own
  //    retry loop is disabled (maxRetries: 0) because we control retries
  //    client-side. On network error other than rate-limit, reject.

  // 4. Confirmation poll loop (until commitment reached OR deadline hit):
  //    - Every 1500ms, call rpc.getSignatureStatuses([sig], {
  //        searchTransactionHistory: false }).
  //    - If status.value[0].err !== null: reject with decoded error.
  //    - If status.value[0].confirmationStatus >= dApp-requested commitment:
  //        resolve with signature bytes.
  //    - If currentBlockHeight > lastValidBlockHeight:
  //        a. For recent-blockhash: resubmit the same tx up to 3 times
  //           (each resubmit is cheap — same signature, just re-gossipped).
  //           If after 3 resubmits we still haven't landed, reject
  //           `-32603 "blockhash expired before confirmation"`.
  //        b. For durable-nonce: resubmit indefinitely until the user's
  //           per-intent timeout (default 90s from approval).

  // 5. maxRetries budget. Each explicit dApp-requested retry costs one;
  //    when exhausted, reject even if we haven't hit the deadline. Honors
  //    the dApp's opts contract.
}
```

**Invariants**

- A single signature is produced once at approval time. Every retry re-broadcasts the **same signed tx**. We never re-sign with a newer blockhash silently — that would violate the dApp's assumption that the tx it got back is the tx that executed.
- `preflightCommitment` ≠ `commitment`: we honor both. Preflight runs at `preflightCommitment`; confirmation polls for `commitment`. A lazy default `preflightCommitment = commitment` is only applied when the dApp omits the field.
- `minContextSlot` is passed through on every `simulateTransaction` and `getSignatureStatuses` call to prevent racing reads against a stale RPC replica.
- Simulation result from the inspector stage is cached per-signature-hash and reused as the preflight answer, avoiding a redundant RPC round-trip (Jupiter's per-intent path drops from 4 sim calls to 1 with this).

**Confirmation without WebSocket.** The above is polling-only. `sendAndConfirmTransactionFactory` from `@solana/kit` is used *only* when an RPC subscriptions URL is configured (`EXPO_PUBLIC_SOLANA_*_RPC_SUBSCRIPTIONS`); default build ships polling. This is the opposite of the current `installSolanaSigner` which prefers WS — swap the priority per §4.12.

### 4.11 Partial signing — output format

`solana:signTransaction` must always return a `Uint8Array` whose bytes are a valid serialized transaction with **our signature slot filled in** and **all other signature slots preserved as-is** (typically zero-bytes for other signers' slots, OR already-populated bytes if another signer pre-signed before us). `@solana/kit`'s `signTransaction([signer], tx)` merges exactly one signature into `tx.signatures` without mutating the others — correct by construction.

Two edge cases to catch:

1. **We are not in `staticAccountKeys`.** If the active wallet's pubkey is not among the message's required signers, reject `-32602 "wallet is not a required signer"`. Don't produce a signature dApps can't use.
2. **All signature slots already filled.** The dApp handed us a fully-signed tx — no new signature needed. Return the tx unchanged with an `info: "Transaction was already fully signed"` annotation so the user understands what happened.

### 4.12 RPC architecture — proxy, pool, cache

Decision locked (moves from §8 Q4 to here): **all Solana RPC traffic from the adapter routes through `takumi-agent-api`** (or the separate `takumipay-api`'s Solana proxy if the agent-api doesn't own it). The mobile app never ships provider API keys in the binary.

`services/chains/solana/solanaRpcPool.ts` owns the routing:

- Accepts a `SolanaCluster`, returns a `Rpc<SolanaRpcApi>` that hits `https://api.takumipay.com/solana/{cluster}/rpc` (or equivalent).
- The server-side proxy keys into Helius / Triton / QuickNode via env — client sees only our URL.
- Client-side rate-limit backoff: 429 → exponential backoff starting at 250ms, max 3 retries.
- Client-side cache for **read-only** RPC methods only (`getLatestBlockhash` 1s, `getAccountInfo` 2s, `getMinimumBalanceForRentExemption` 5min). Never cache `simulateTransaction`, `getSignatureStatuses`, or anything tx-related.
- RpcSubscriptions (WebSocket): same pattern if/when we enable it — `wss://api.takumipay.com/solana/{cluster}/ws`. Default disabled; polling works fine in P1.

Dev override: `EXPO_PUBLIC_SOLANA_MAINNET_RPC` / `EXPO_PUBLIC_SOLANA_DEVNET_RPC` still read (and bypass the proxy). CI / E2E uses these against a local `solana-test-validator`.

### 4.10 Port fit — no new plumbing

Verifying the adapter lands inside existing ports:

| Bridge port | Solana touchpoint | New code? |
|---|---|---|
| `ChainAdapter` (`services/chains/types.ts:39`) | `SolanaAdapter` | Expanded from today's scaffold |
| `ApprovalIntent` (`services/bridge/approval.ts:18`) | `SolanaApprovalPayload` goes in `payload` | No bridge change; `ApprovalKind` +3 variants (§4.3a) |
| `IntentInspector` (`services/bridge/inspector.ts:22`) | `SolanaSimulationInspector`, `SolanaProgramDecoder`, `SolanaSiwsInspector` | No pipeline change; three new files |
| `BridgeEventBus` (`services/bridge/events.ts:5`) | Existing `request` / `intent` / `decision` / `result` events already namespace-tagged | No change |
| `ApprovalRenderer` (`services/bridge/approval.ts:35`) | `SolanaSignInSheet`, expanded `SolanaTransactionSheet`, `SolanaSignAllSheet`, `SolanaSwitchClusterSheet`, `SolanaWatchTokenSheet` | New renderers, registered in `renderers.ts` |
| `PermissionStore` (`services/permissions/store.ts`) | `PermissionGrant.chainId` typed `number` today; widen to `string \| number` OR reserve `0xS0` for Solana (see §8 Q1) | Minor change agreed in §8 |
| `DappBridge` | **No change.** The `HARD_REJECT_METHODS` set stays EVM-only. | No change |
| `app/dapps-browser.tsx` | **No change.** `ChainAdapterRegistry.list().map(a => a.getInjectedScript(ctx))` already concatenates the Solana script. | No change |

## 5. File layout

```
services/
  chains/
    solana/
      SolanaAdapter.ts              ← expanded from scaffold (was §4.1)
      injectedScript.ts             ← NEW — Wallet Standard registerWallet + window.solana shim
      payloads.ts                   ← expanded (§4.3)
      programDecoder.ts             ← NEW — SolanaProgramDecoder helpers
      simulate.ts                   ← NEW — wraps rpc.simulateTransaction + post-state diff
      siws.ts                       ← NEW — ABNF message builder + domain check
      altResolver.ts                ← NEW — resolve ALT entries for v0 txs
      token2022.ts                  ← NEW — mint-account parse + extension enumeration
      signer.ts                     ← extended: + signAllTransactions, + signIn handler
      derivation.ts                 ← unchanged (from chain-support spec)
      codec.ts                      ← unchanged (from chain-support spec)
      transferService.ts            ← unchanged (not used by adapter)
  bridge/
    inspectors/
      SolanaSimulationInspector.ts  ← NEW
      SolanaProgramDecoderInspector.ts ← NEW (thin wrapper around programDecoder.ts)
      SolanaSiwsInspector.ts        ← NEW (domain pinning, expiration sanity)
  rpc/
    solanaRpcPool.ts                ← NEW — cluster→rpc resolver, rate-limit-aware
components/
  dapps-browser/
    approvals/
      SolanaConnectSheet.tsx        ← NEW — replaces reuse of EVM ConnectSheet
      SolanaSignInSheet.tsx         ← NEW
      SolanaSignMessageSheet.tsx    ← expand from today's stub; utf-8 vs base64
      SolanaTransactionSheet.tsx    ← expand; show decoded + simulation + compute budget
      SolanaSignAllTransactionsSheet.tsx ← NEW
      SolanaSwitchClusterSheet.tsx  ← NEW
      SolanaWatchTokenSheet.tsx     ← NEW
      renderers.ts                  ← register new sheets
services/
  bridge/
    approval.ts                     ← SINGLE DIFF: +3 ApprovalKind variants (§4.3a)
    boot.ts                         ← register new inspectors; pass rpcSubs factory to installSolanaSigner
```

Everything else stays put.

## 6. Phased rollout

### Phase 1a — Wallet Standard compliance, no new signing methods

Ship the announce + routing surface; every signing method still lands on the existing scaffolded signer. Behavior-compatible with today's scaffold + an announce dApps can detect.

- [ ] Rewrite `services/chains/solana/injectedScript.ts` to emit the Wallet Standard `registerWallet` handshake with `standard:connect`, `standard:disconnect`, `standard:events`, `solana:signMessage`, `solana:signTransaction`, `solana:signAndSendTransaction`, `supportedTransactionVersions: ["legacy", 0]`. Keep the `window.solana` shim but re-point every method at the same `bridge_request` transport.
- [ ] Rename `SolanaAdapter.handleRequest` branches from today's `"solana:standard:connect"` to `"standard:connect"` (the real Wallet Standard identifier). Keep a legacy alias for the one `window.solana` case that uses the old string.
- [ ] Diff `services/bridge/approval.ts` per §4.3a (`+signIn, +signAllTransactions, +switchCluster`).
- [ ] Split today's overloaded `"signTransaction"` intent into `"signTransaction"` (sign-only) and `"sendTransaction"` (sign-and-send). Adapter's `handleRequest` picks the kind from the incoming method; `executeApproval` branches on `intent.payload.mode`.
- [ ] `TWallet` creation coverage — already in place per `solana-chain-support-spec.md`. No work here.
- [ ] `SolanaConnectSheet` — mirror `ConnectSheet` but carry `cluster` + write a `PermissionGrant` (see §8 Q1 for the chainId shape).
- [ ] QA: Phantom's official demo site connects, signs a message, sends a devnet transaction. Jupiter (devnet) route + swap completes. `wallet-standard:app-ready` handshake observed in `[takumi-diagnostic]`.

**1a exit criteria:** a dApp that uses `@solana/wallet-adapter-wallet-standard` detects the wallet automatically (no manual adapter). Every current scaffold scenario still works. No new signing methods yet.

### Phase 1b — Full signing surface + SIWS + simulation + decoded UX

- [ ] `solana:signAllTransactions` feature + `SolanaSignAllTransactionsSheet`. Batch size cap at 20 (Jupiter quotes bundle up to 5; MagicEden mints bundle up to 12; we leave headroom).
- [ ] `solana:signIn` feature end-to-end: `SolanaSignInSheet`, `siws.ts` message builder, `SolanaSiwsInspector` (domain + address + expiration), `BridgeEvent`-emitting a redacted `signIn` breadcrumb.
- [ ] `SolanaSimulationInspector` + `SolanaProgramDecoder` + `altResolver.ts`. Sheets consume `intent.payload.simulation` / `intent.payload.decoded`.
- [ ] Fee-payer detection, priority-fee extraction, compute-budget warnings (§4.6).
- [ ] Token-2022 extension enumeration (§4.7, §10.4 inv 8). `token2022.ts` parses mint-account extensions; sheets annotate.
- [ ] `takumi:switchCluster` custom feature + `SolanaSwitchClusterSheet` + `standard:events change` emission on approve.
- [ ] `takumi:watchToken` custom feature + `SolanaWatchTokenSheet`.
- [ ] Error-code contract: every error path returns one of §10.3 codes. Unit-tested branch by branch.
- [ ] EIP-2255 analog — `PermissionStore` extended to key by `(originHash, walletAddress, caip2Cluster)`. Grants enumerable via the existing settings screen (`app/settings/dapp-permissions.tsx`) once extended.
- [ ] `solanaRpcPool.ts` — central cluster→RPC resolver that falls back across Helius / Triton / Quicknode / public-default on rate-limit, keyed by `EXPO_PUBLIC_SOLANA_*_RPC` env.
- [ ] Smoke test matrix (§7) against live dApps; screenshot each approval.

**1b exit criteria:** every row in §10.1 and §10.2 tagged **P1b** is green. Compliance matrix §10.4 invariants covered by integration tests.

### Phase 1c — Advanced flows required for GA

Ship-blocking only if dApps we care about depend on them. Defer aggressively if not.

- [ ] **Durable nonce handling.** Detect `AdvanceNonceAccount` as first instruction → switch lifetime display from "recent blockhash" to "durable nonce, advances on sign"; show the nonce authority address; annotate `danger` if authority is not the signing wallet AND dApp has not pre-signed the authority's approval. (Applies to offline-signing flows; Phantom/Backpack currently support this.)
- [ ] **Partial / multi-signer transactions.** A v0 message whose fee payer is not the active wallet AND whose `staticAccountKeys` contains the active wallet's pubkey in a non-fee-payer position → `SolanaTransactionSheet` shows a "Signing as co-signer; {feePayer} must finalize" row. Execute returns a partially-signed tx (base64), not a signature. dApp finalizes. Gates: pump.fun, Jupiter Hybrid, Drift Vaults.
- [ ] **Jito bundle awareness (display-only).** If the tx carries a `SystemProgram::transfer` to any of Jito's known tip accounts (8 hard-coded mainnet addresses, published by jito.wtf), render a "Jito tip: 0.0042 SOL" row. We do not originate bundle submission — dApps continue posting to the Jito Block Engine directly — but we make the tip visible so the user knows what they're paying. Deferred if no dApp in the test matrix depends on it for rendering.
- [ ] **Confidential-transfer token-2022.** Out of P1c unless a dApp in our matrix requires it. We already annotate `warn` when a tx touches a confidential-transfer mint; full balance-shielded rendering needs the 2025 JS ZK-proof libs that Solana Labs shipped. Revisit if a user files a bug.
- [ ] **Versioned tx legacy-downgrade safety.** Always refuse to downgrade v0 → legacy. If a dApp sends a base64-legacy tx while declaring ALTs, reject with `-32602 "transaction version mismatch"`.
- [ ] **Stake program decoder.** Decode `Initialize`, `Authorize`, `DelegateStake`, `Split`, `Withdraw`, `Deactivate`, `Merge`, `AuthorizeWithSeed` in `programDecoder.ts`. Sheet renders "Delegate 10 SOL to validator {voteAccount}" instead of "Stake program invoked". Covers Marinade / Jito-staking / native-stake dApp flows.
- [ ] **ATA program decoder.** Decode `Create`, `CreateIdempotent`, `RecoverNested`. Annotate `danger` on `RecoverNested` when nested owner ≠ active wallet (close-authority hijack vector — complements invariant 7).
- [ ] **Address Lookup Table program decoder.** Decode `CreateLookupTable`, `ExtendLookupTable`, `FreezeLookupTable`, `DeactivateLookupTable`, `CloseLookupTable` for the rare dApp flow where the user signs ALT lifecycle instructions (Jupiter Limit Orders builder, some MEV tools). Today they'd render as unknown-program calls.
- [ ] **Metaplex Token Metadata / Core / Bubblegum instruction decoders.** Decode the common user-facing instructions (Create, Update, Transfer, Burn, Delegate, Revoke, Lock, Unlock for Token Metadata; equivalents for Core and Bubblegum). Balance *display* for cNFTs remains gated on the indexer Solana provider (separate spec); instruction decoding itself is code-only and lands here.
- [ ] **SNS (`.sol`) resolution for dApp-supplied destinations.** When a decoded instruction names a destination that's a `.sol` domain (dApps occasionally inline these into memo fields or custom-program args), resolve via `services/chains/solana/sns.ts` and render `takumi.sol → 9xyz…base58…` in the sheet. Resolution is trust-but-verify per invariant 22.

**1c exit criteria:** matrix §10.1 P1c rows green. Smoke tested on Jito-Flow swap, a Drift vault deposit, one offline-signed tx with durable nonce, one Token-2022 transfer-fee mint, one native-stake delegate + deactivate flow, one `.sol`-destination transfer.

### Phase 2+ — post-GA follow-ups

Not shipped with adapter GA. Tracked so the adapter's seams don't foreclose them. **Explicitly split by what blocks each one** — the "platform integration" group is deliberately pending until a separate spec owns the OS-level plumbing; the "library/product" group is gated on external readiness.

**Pending — requires platform integration (deferred by product decision):**

These all introduce **new transports or protocol surfaces that live outside the WebView** and therefore need iOS/Android work the bridge doesn't touch. Attempting any of them inside this adapter spec would leak platform concerns into `services/chains/solana/` and bloat the surface area. Each gets its own follow-up spec when product schedules the integration.

- **Mobile Wallet Adapter (MWA) v2.0 transport.** External mobile dApps connect over Android Intent / iOS universal-link. Requires: a claimed URI scheme (`solana-wallet://`), `AndroidManifest.xml` intent-filter entries, iOS `LSApplicationQueriesSchemes` + `CFBundleURLTypes`, a background session handler, reflector/relay keypair management. Approval spine reuses unchanged; transport is new.
- **WalletConnect v2 `solana:*` namespace.** External desktop/mobile dApps connect via WalletConnect relay. Requires: a WalletConnect Cloud project ID (platform signup), `@walletconnect/*` SDK integration (~400 KB), deep-link scheme for session proposals while app is backgrounded, push notifications for idle-app approval delivery, session-state storage outside `PermissionStore`. `services/walletconnect/caipMapping.ts` already knows the `solana:*` namespace string — the session builder and the signing route are the missing pieces.
- **Solana Pay URI handling.** `solana:<address>?amount=…&spl-token=…` links opened from outside the app (QR scan, system share-sheet, clicked in another app). Requires: OS-level scheme registration (collides / coordinates with MWA's scheme choice), a parser + first-party send-confirmation sheet, signed-request verification for the reference/memo fields. Overlaps with MWA on the claimed-scheme decision; should land together.

**Pending — library / product blocked (not platform work):**

- **SPL Token-2022 confidential-transfer full UX.** We already annotate `warn` on encounter (§10.4 inv 8). Full balance-shielded rendering is blocked on a Hermes-compatible JS ZK-proof library; Solana Labs shipped the server-side pieces in 2025, mobile-ready JS bindings ETA unknown.
- **Metaplex Core NFT / cNFT watch.** `takumi:watchToken` extension to cNFTs waits on the indexer's Solana provider from the chain-support spec follow-up (already flagged in `solana-chain-support-spec.md` N5).
- **Jito bundle submission from first-party features.** Display-only in P1c is enough for dApp UX. Originating bundles requires a first-party swap / MEV-protection feature that wants it — no product ask yet.

## 7. Test plan

| Layer | Test |
|---|---|
| `SolanaAdapter.handleRequest` | Unit — every method branch returns the expected `ChainResult` shape, including error codes 4100/4200/-32602 |
| `SolanaAdapter.executeApproval` | Unit — `sign-only` returns base64, `sign-and-send` returns base58 signature, `reject` throws code 4001 |
| `siws.ts` | Unit — message builder matches `phantom/sign-in-with-solana` reference vectors; domain validator catches homographs |
| `programDecoder.ts` | Unit — decodes System transfer, SPL transfer, ComputeBudget set-unit-price, Token-2022 transfer-checked, memo |
| `altResolver.ts` | Unit — resolves a known Jupiter ALT (fixture) into full account list; falls back on missing table |
| `simulate.ts` | Unit — post/pre balance diffing, token-balance diffing including token-2022, warning emission |
| `SolanaSimulationInspector` | Unit via `inspector.test.ts` harness — emits correct patch, never modifies `transaction` field |
| Wallet Standard announce | Manual — load Phantom's `wallet-standard-dapp` demo in the in-app browser, verify "TakumiPay" appears in the picker without manual adapter |
| SIWS round-trip | Manual — Phantom demo SIWS page; Magic Eden app-login |
| Versioned tx | Manual — Jupiter mainnet swap (v0 w/ ALT); Raydium concentrated-LP add (legacy) |
| Sign-all | Manual — pump.fun token launch (sign-all with N=3-5) |
| Token-2022 | Manual — send a `PYUSD` transfer (transfer-fee mint); verify warning |
| Durable nonce | Manual — Backpack's nonce-signer test page, offline-sign scenario |
| Cluster switching | Manual — MagicEden (mainnet) → Solana Faucet (devnet) in the same session |
| Partial signing | Manual — Drift Vaults deposit (fee payer: vault, signer: user) |
| Reject paths | Manual — reject each sheet; dApp observes `4001` |
| Origin pinning | Manual — open site-A, trigger a pending intent, navigate to site-B before approving; existing auto-reject path should fire (`DappBridge.onNavigate`) |
| Third-party smoke | §10.5 list below |

## 8. Open questions

1. **`PermissionGrant.chainId` typing.** Today `services/permissions/store.ts:7-17` types `chainId: number` — EVM-only. Widen to `string | number` and use `"solana:mainnet-beta"` as the string form? Or reserve a sentinel negative number? Recommendation: widen to `string | number`, keep EVM numeric for backward-compat, Solana uses CAIP-2 cluster strings. Low risk; one migration on boot.
2. **Cluster default for zero-wallet users.** If a dApp calls `standard:connect` and the user has no Solana wallet, do we (a) show an in-sheet "Create Solana wallet" CTA, (b) reject `4100`, (c) auto-create a Solana wallet from the user's existing mnemonic? `(c)` is enabled by Option C in `solana-chain-support-spec.md` §14. Recommendation: **(c)** when a mnemonic-backed EVM wallet exists; **(a)** otherwise.
3. **Jito tip account allowlist source.** Hard-code the 8 published mainnet tip accounts, or fetch on boot? Fetch is wasteful (they haven't changed); hard-code and bump on spec revision. Recommendation: hard-code, document under `services/chains/solana/jitoTipAccounts.ts`.
4. **Wallet Standard account `chains` field.** The WS `WalletAccount` has a `chains: IdentifierString[]` field per-account. One account with all clusters, or N accounts? The Anza reference publishes one account with all. Recommendation: one account, full chain list; dApps filter.
5. **How much legacy `window.solana` to keep.** Long-tail Anchor-app demos still poke `window.solana.connect()` directly, but major dApps moved to Wallet Standard. Keep the full shim for P1a? Remove `signAllTransactions` from the shim if it never gets exercised? Recommendation: keep the full shim through P1b, revisit via telemetry (`bridgeEventBus` shim-vs-standard counters) before cutting anything.
6. **Blockhash-expired resubmit budget for durable-nonce txs.** §4.10 caps recent-blockhash retries at 3 and durable-nonce retries at "per-intent timeout (90s)". Is 90s right, or should durable-nonce txs poll until the user actively dismisses? Recommendation: 90s for P1b with a "keep waiting" button on the success screen that extends to 10 minutes for offline-signing flows (Backpack's pattern).

## 9. Non-goals

- Wallet creation / import flows (owned by `solana-chain-support-spec.md`).
- SPL-token transfers from the first-party send screen (owned by the chain-support spec's follow-up).
- Solana transaction history / activities screen (indexer work, separate spec).
- **Platform-integration transports — explicitly out of scope, pending their own specs:**
  - Mobile Wallet Adapter (MWA) v2.0
  - WalletConnect v2 Solana sessions
  - Solana Pay URI handling

  These require OS-level URI scheme registration, iOS/Android manifest changes, backgrounded-app signing, and (for WalletConnect) external platform signup — none of which this adapter spec addresses. Product has decided to hold these until a dedicated transport-integration spec schedules the work. The bridge's `DappBridge`/`ApprovalIntent`/`ApprovalHost` spine already supports alternative transports, so picking these up later requires zero changes to `services/chains/solana/`.
- Jito bundle **submission** from first-party features — display-only in P1c.
- Confidential-transfer full balance-shielded UX — blocked on mobile-ready ZK libs.
- Any EVM-spec parity rewrite — the EVM adapter does not change.

## 10. Solana compliance matrix

**Legend:** **P1a** = Wallet Standard + routing surface • **P1b** = full signing + simulation + SIWS • **P1c** = advanced flows required for GA • **P2+** = post-GA. Error codes follow EIP-1193 + EIP-1474 where applicable; Solana extensions use the same space.

### 10.1 Wallet Standard features + legacy `window.solana` shim

| Feature / method | Phase | Approval? | Renderer | Notes |
|---|---|---|---|---|
| `standard:connect` | P1a | Yes | `SolanaConnectSheet` | `{ onlyIfTrusted }` respected — if grant exists, silent-connect without sheet |
| `standard:disconnect` | P1a | No | — | Clears cluster-scoped `PermissionGrant`; emits `standard:events change` |
| `standard:events` (on/off) | P1a | No | — | Fires `change` with updated `accounts` on wallet / cluster switch |
| `solana:signMessage` | P1a | Yes | `SolanaSignMessageSheet` | Auto-detect utf-8 vs base64; SIWS-shaped messages routed via SIWS inspector |
| `solana:signIn` (SIWS) | P1b | Yes | `SolanaSignInSheet` | Domain + address invariants; structured render |
| `solana:signTransaction` (N=1) | P1a → P1b | Yes | `SolanaTransactionSheet` | P1a: raw base64 preview. P1b: decoded + simulated. Feature is variadic — this row covers single-tx calls |
| `solana:signTransaction` (N>1) | P1b | Yes | `SolanaSignAllTransactionsSheet` | Same feature, N>1 inputs. Cap N≤20; each tx rendered as a step. Maps to `signAllTransactions` ApprovalKind |
| `solana:signAndSendTransaction` | P1a → P1b | Yes | `SolanaTransactionSheet` | `options: { commitment, skipPreflight, maxRetries, preflightCommitment, minContextSlot }` all pass-through. Output is `{ signature: Uint8Array }`, NOT base58 string |
| `takumi:switchCluster` (custom) | P1b | Yes | `SolanaSwitchClusterSheet` | Adapter-private; dApps may call, app UI calls the same feature |
| `takumi:watchToken` (custom) | P1b | Yes | `SolanaWatchTokenSheet` | SPL + token-2022; verifies mint on-chain |
| `supportedTransactionVersions` declaration | P1a | N/A | — | `["legacy", 0]` on both tx features |
| **Legacy shim — `window.solana`** | | | | |
| `window.solana.connect({onlyIfTrusted})` | P1a | via `standard:connect` | `SolanaConnectSheet` | Same path; shim only rewrites the method name |
| `window.solana.disconnect()` | P1a | No | — | Same |
| `window.solana.signMessage(bytes)` | P1a | via `solana:signMessage` | `SolanaSignMessageSheet` | `Uint8Array | string` accepted |
| `window.solana.signTransaction(tx)` | P1a | via `solana:signTransaction` | `SolanaTransactionSheet` | Legacy + v0 accepted |
| `window.solana.signAllTransactions(txs)` | P1b | via `solana:signTransaction` variadic | `SolanaSignAllTransactionsSheet` | Maps to variadic `signTransaction(...txs)` on the standard path; same cap |
| `window.solana.signAndSendTransaction(tx, opts)` | P1a | via `solana:signAndSendTransaction` | `SolanaTransactionSheet` | Same |
| `window.solana.request({method, params})` | P1a | method-dependent | per method | Routes through same switch |
| `window.solana.on/off(event, cb)` | P1a | No | — | `connect`, `disconnect`, `accountChanged` supported |
| `window.solana.isPhantom` | P1a | No | — | `false` — do not impersonate Phantom; some dApps sniff and we keep them honest |
| `window.solana.isTakumi` | P1a | No | — | `true` |
| `window.phantom.solana` alias | P1a | No | — | Points to the same shim object — required for dApps that explicitly feature-detect `window.phantom` |
| **Explicitly rejected methods** | | | | |
| `window.solana.request({method:"signAllTransactions"})` pre-P1b | P1a | error | — | Rejects `4200 "method not supported"`; shim calls fall through cleanly once 1b lands |
| Legacy `window.solana.signIn(opts)` (pre-WS variant) | P1a | error | — | Rejects `4200`; dApps must use the WS `solana:signIn` feature — no silent fallback that skips domain pinning |

### 10.2 Standards / specs enforced in code

| Spec / SIP / SMP | Area | Phase | Implementation location |
|---|---|---|---|
| **Solana Wallet Standard** (Anza, `anza-xyz/wallet-standard` master) | Core interface | P1a | `services/chains/solana/injectedScript.ts`, adapter routing |
| **`@wallet-standard/base`** — `Wallet`, `WalletAccount`, `WalletIcon`, `IdentifierArray`, `IdentifierRecord`, `WalletVersion` (literal `"1.0.0"`) | Type contracts | P1a | `injectedScript.ts` |
| **`@wallet-standard/features`** — `StandardConnectFeature`, `StandardDisconnectFeature`, `StandardEventsFeature` + `StandardEventsChangeProperties` | Core features | P1a | `injectedScript.ts` |
| **`@solana/wallet-standard-features`** — `SolanaSignTransaction`, `SolanaSignAndSendTransaction`, `SolanaSignMessage`, `SolanaSignIn` | Feature types | P1a / P1b | `injectedScript.ts`, adapter |
| **`@solana/wallet-standard-chains`** — `SOLANA_MAINNET_CHAIN`, `SOLANA_DEVNET_CHAIN`, `SOLANA_TESTNET_CHAIN` (short form `"solana:mainnet"` etc.) | Chain identifiers | P1a | `payloads.ts::SolanaChain`, `injectedScript.ts` |
| **CAIP-2 genesis-hash form** — `solana:5eykt…` (mainnet), `solana:EtWTR…` (devnet), `solana:4uhcV…` (testnet) | Legacy chain IDs, accepted on input | P1a | `canonicalizeChain()` helper |
| **Wallet Standard registration handshake** — `wallet-standard:register-wallet` + `wallet-standard:app-ready` events, both halves | Discovery protocol | P1a | `injectedScript.ts` (§4.2a) |
| **SIWS (Sign In With Solana)** — EIP-4361-derived, Phantom ref | User auth | P1b | `services/chains/solana/siws.ts`, `SolanaSiwsInspector` |
| **BIP-39 + SLIP-0010 ed25519** (coin type 501) | Key derivation | already shipped | `services/chains/solana/derivation.ts` (chain-support spec) |
| **RFC-8032 ed25519** — deterministic nonce | Signing safety | already shipped (TWV-2026-070) | `@solana/kit` `createKeyPairFromPrivateKeyBytes({ extractable: false })` |
| **Versioned transactions** — legacy + v0 | Tx format | P1a (advertise) / P1b (decode) | `@solana/kit` `getTransactionDecoder` |
| **Address Lookup Tables** (v0) | Tx compression | P1b | `services/chains/solana/altResolver.ts` |
| **Durable nonces** — `AdvanceNonceAccount` first-instr convention | Offline signing | P1c | `programDecoder.ts` + sheet |
| **Compute Budget Program** (`setComputeUnitLimit`, `setComputeUnitPrice`) | Priority fees | P1b | `programDecoder.ts`, sheet |
| **SPL Token** (program `Tokenkeg…`) | Token UX | P1b | `@solana-program/token` decoder |
| **SPL Token-2022** (program `TokenzQ…`) + extensions: `TransferFee`, `PermanentDelegate`, `NonTransferable`, `InterestBearing`, `DefaultAccountState`, `ConfidentialTransfer`, `TransferHook`, `MetadataPointer`, `MemoTransfer`, `CpiGuard`, `MintCloseAuthority`, `ScaledUiAmount`, `PausableConfig`, `GroupPointer`, `GroupMemberPointer`, inline `TokenMetadata` | Next-gen tokens | P1b | `services/chains/solana/token2022.ts` |
| **Associated Token Account program** (`ATokenGPv…`) — `Create`, `CreateIdempotent`, `RecoverNested` | ATA lifecycle | P1c | `programDecoder.ts` ATA branch |
| **Stake program** (`Stake11111…`) — `Initialize`, `Authorize`, `DelegateStake`, `Split`, `Withdraw`, `Deactivate`, `Merge`, `AuthorizeWithSeed` | Native staking | P1c | `programDecoder.ts` stake branch |
| **Address Lookup Table program** (`AddressLookupTab1e…`) — `CreateLookupTable`, `ExtendLookupTable`, `FreezeLookupTable`, `DeactivateLookupTable`, `CloseLookupTable` | User-signed ALT instructions (rare but real) | P1c | `programDecoder.ts` ALT branch |
| **Metaplex Token Metadata** (program `metaqbxx…`) — instruction decode (Create, Update, Transfer, Burn, Delegate, Revoke, Lock, Unlock) | NFT names/images + action preview | P1b (read), P1c (decode) | `programDecoder.ts` enrichment |
| **Metaplex Bubblegum** (cNFT program `BGUMAp9…`) — `Transfer`, `Delegate`, `Burn`, `Redeem`, `MintV1` instruction decode | Compressed NFT actions; balance display gated on indexer (separate spec) | P1c (instruction decode only) | `programDecoder.ts` bubblegum branch |
| **Metaplex Core** (program `CoREzp9…`) — `Create`, `Transfer`, `Update`, `Burn` instruction decode | Next-gen NFT standard | P1c | `programDecoder.ts` core branch |
| **Memo program** (`MemoSq4…`) | Visible memo | P1b | `programDecoder.ts` |
| **System program** (`11111111…`) — `Transfer`, `CreateAccount`, `CreateAccountWithSeed`, `Assign`, `Allocate`, `AdvanceNonceAccount`, `WithdrawNonceAccount`, `AuthorizeNonceAccount`, `InitializeNonceAccount` | Core account ops | P1b | `programDecoder.ts` system branch |
| **SNS / Bonfida Name Service** (`.sol` domain resolution) — resolve dApp-supplied destination domains before display | User address validation | P1c | `services/chains/solana/sns.ts` resolver |
| **Mobile Wallet Adapter (MWA)** v2.0 | Alt transport | P2+ | out of scope |
| **WalletConnect v2** `solana:*` namespace | Alt transport | P2+ | out of scope |

### 10.3 Error code contract

Every `SolanaAdapter` error path must return one of these. Zod schema at the adapter boundary validates params; unknown method branches return `4200`.

| Code | Meaning | Solana trigger |
|---|---|---|
| `4001` | User rejected | User tapped reject in any sheet |
| `4100` | Unauthorized | Origin has no `PermissionGrant` for the requested account/cluster; SIWS address mismatch |
| `4200` | Unsupported method | Adapter has no branch (unknown WS feature, unknown `window.solana.request` method); legacy `window.solana.signIn` |
| `4900` | Disconnected | No active Solana wallet |
| `4901` | Cluster not connected | Request targets a cluster the active wallet is not on AND method is a signing call (user must switch first) |
| `-32002` | Resource unavailable | Another approval from this origin is pending (`DappBridge.enqueue` enforces) |
| `-32602` | Invalid params | Base64 decode failed, tx version mismatch, CAIP-2 malformed, SIWS missing domain, signAllTransactions N>20 |
| `-32603` | Internal error | RPC failure, signer reconstruction failure, ALT resolve failure — never bubble raw exception text |

No Solana-specific codes are invented. The `chain not added` concept (`4902` on EVM) does not apply: every Solana cluster we support is known at compile time.

### 10.4 Security invariants (audited before GA)

1. **Origin + SIWS domain binding.** Every `solana:signMessage` / `solana:signIn` / `solana:signTransaction` / `solana:signAndSendTransaction` must carry an `origin.url`. `DappBridge` already refuses intents without one; Solana inherits. SIWS: `input.domain` must equal `originHost(origin.url)` — mismatch → `danger` annotation. Enforced in `SolanaSiwsInspector`.
2. **Address-swap protection.** If `intent.wallet.address !== payload.address`, reject `4100` before rendering. Holds for `signMessage`, `signIn`, `signTransaction`, `signAndSendTransaction`, `signAllTransactions`. Prevents a dApp from asking the user to sign "as" a different account.
3. **Fee payer trust.** When fee payer is **not** the active wallet, sheet shows a "Fees paid by {fp}" row AND adapter verifies the fee-payer signature is already attached (partial-sign scenario) OR returns a partially-signed tx (co-signer scenario). Adapter never signs as a non-active-wallet fee payer.
4. **Durable-nonce authority check.** When the first instruction is `AdvanceNonceAccount`, `SolanaSimulationInspector` decodes the nonce authority. If authority ≠ signing wallet, annotate `danger: "nonce authority not signer"`. User must confirm hold-to-approve.
5. **Lookup-table expansion.** `altResolver.ts` fetches every ALT referenced by a v0 message and resolves writable / read-only accounts **before** the sheet renders. Unresolved ALT → `warn: "lookup table unreadable"`. Never silently sign a tx with opaque account lists.
6. **Writable-account drain detection.** `SolanaSimulationInspector` computes post-sim balance deltas. Any writable account belonging to the active wallet with a negative delta > user-configurable threshold (default 0.1 SOL or any SPL balance going to zero) raises `warn: "Large balance outflow"`. Unknown-program writable account on the signer's pubkey → `danger: "Unknown program can modify your account"`.
7. **`setAuthority` / ATA close-authority hijack.** Decoder flags any `spl-token:setAuthority`, `spl-token:closeAccount`, `token-2022:setAuthority`, `associated-token-account:createIdempotent`-with-non-owner as `danger`. Known draining pattern.
8. **Token-2022 extension awareness.** Every SPL transfer / delegate / approve / freeze / mint / burn touching a token-2022 mint triggers a mint-account read. Every known extension emits a distinct annotation when present and material — severity tagged per footgun class:
   - `TransferFee` (non-zero basis points) → `warn: "Transfer fee {n}% ({lamports} → {feeAccount})"`
   - `PermanentDelegate` → `danger: "Mint has a permanent delegate — {delegate} can move your tokens without consent"`
   - `NonTransferable` → `warn: "Token cannot be transferred by owner"` (surfacing when the action is an owner-transfer that will fail)
   - `TransferHook` → `warn: "Transfer hook program {hookProgram} runs on every transfer"`
   - `ConfidentialTransfer` pending balance non-zero → `info: "Hidden balance in ZK-pending bucket"`
   - `MintCloseAuthority` → `danger: "Mint can be closed by {closeAuthority} — tokens may become worthless"` (rug-able mint class)
   - `PausableConfig` (paused=true) → `danger: "All transfers for this mint are currently paused"`
   - `CpiGuard` (enabled) → `info: "CPI guard active — some program interactions blocked"` (protective; informational only)
   - `DefaultAccountState = Frozen` → `warn: "New token accounts start frozen; issuer must thaw before transfer"`
   - `InterestBearing` → `info: "Interest-bearing mint — displayed balance grows over time"`
   - `MetadataPointer` → reads pointed-to metadata account; surfaces mint name / symbol in the sheet (if mismatches on-chain metadata: `warn`)
   - `MemoTransfer` (required) → `info: "Recipient requires a memo on every transfer"` (heuristic fails annotation when memo is absent)
   - `ScaledUiAmount` → silently adjusts displayed balance to the UI-scaled form; raw lamports and scaled amount both shown in the sheet
   - `GroupPointer` / `GroupMemberPointer` → `info: "Token is part of group {groupAddress}"` (usually NFT-collection context)
   - Inline `TokenMetadata` → authoritative name / symbol / URI; overrides any dApp-supplied hint
   - Unknown extension discriminant → `warn: "Mint uses an unrecognized Token-2022 extension ({discriminant}) — wallet may not display accurately"`
9. **SIWS expiry sanity.** `expirationTime` ≤ `issuedAt` → `-32602`. `notBefore` > `now` → `info: "Sign-in scheduled for future"`. `expirationTime` > 90 days → `warn: "Long-lived sign-in"`.
10. **No signer reconstruction in adapter.** `SolanaAdapter.executeApproval` and `installSolanaSigner` both resolve the signer via `walletKitRegistry.get("solana").getSignerForWallet(wallet)` — the only dwell site (TWV-2026-070). Any PR touching adapter code that calls `createKeyPairFromPrivateKeyBytes` fails review.
11. **Redaction on `BridgeEventBus`.** `services/bridge/redact.ts` gets a Solana branch: `solana:signMessage` payloads replaced with `{ length, preview: first16Chars, cluster }` before emission; `solana:signTransaction` payloads replaced with `{ version, feePayer, writableAccountCount, cluster }`. Signatures never emitted. Enforced via existing redact pipeline.
12. **Session-nonce gate.** Already enforced by `DappBridge.dispatch` (TWV-2026-015) — Solana inherits. Sub-frame injection that forges a `solana:signAndSendTransaction` request is dropped at the bridge.
13. **Wallet Standard wire types.** Inputs and outputs across the WebView boundary carry the exact shapes dApps expect: `publicKey` is `Uint8Array(32)` (not base58), `signedMessage` / `signedTransaction` / `signature` are `Uint8Array` (not base64 strings). The injected shim encodes our base64/base58 internal wire to the typed-array the Wallet Standard contract requires before resolving the dApp promise. One-way mistake: returning a base64 string where `Uint8Array` is expected fails silently in `@solana/wallet-adapter-wallet-standard`'s validator and makes the wallet appear broken on its second connect.
14. **`supportedTransactionVersions` is a literal.** `features["solana:signTransaction"].supportedTransactionVersions` must be the literal array `["legacy", 0]` attached at object creation — not a getter, not a function, not conditionally `["legacy"]`. dApps snapshot it once at connect time; any dynamic form is either ignored or trips Jupiter's route solver into legacy-only mode.
15. **`silent: true` error discipline.** `standard:connect({ silent: true })` (a.k.a. `onlyIfTrusted`) returns `{ accounts: [...] }` if a `PermissionGrant` for `(origin, activeWallet, cluster)` exists, and rejects `4100` otherwise. **Never** open a sheet on the silent path — dApps that call silent-connect in a `useEffect` (Jupiter, Drift on page-load restore) depend on the error being immediate to fall back to an explicit connect button. Opening a sheet on a `silent: true` call is a P0 bug.
16. **No `Wallet.chains` narrowing on cluster switch.** `takumi:switchCluster` does not emit a `standard:events` `change` event with a smaller `chains` array. `Wallet.chains` is the full supported-cluster set; runtime narrowing is per-request via the `chain:` input. Firing `{ chains: [...narrowed] }` makes dApps believe the wallet *lost support* for clusters and permanently hides them from multi-cluster pickers.
17. **`accounts` reflects authorization, not inventory.** Pre-connect, `Wallet.accounts` is `[]`. Post-connect, it contains exactly the accounts the dApp is authorized to use — typically one. The app's full wallet list is **never** exposed. Widening `accounts` to "all Solana wallets" leaks the user's inventory to every origin that connects.
18. **Re-injection races.** Because the injected script is re-evaluated on `onLoadEnd` (intentional; fixes SPA route transitions — see `app/dapps-browser.tsx:312-323`), the re-eval must be idempotent: `window.__takumi_solana_installed` short-circuits, `window.solana` reference stays stable, feature-function identity stays stable for the lifetime of the page. dApps cache `wallet.features["solana:signTransaction"].signTransaction` references; rebinding breaks in-flight promises.
19. **No silent re-sign on blockhash expiration.** §4.10's broadcast retry loop re-broadcasts the **same signed bytes** — never re-signs with a newer blockhash. A dApp that got back `signature: Uint8Array` must be able to look up exactly that signature on-chain; re-signing produces a different signature and breaks audit trails / receipt pages. On expiry without landing, we reject `-32603 "blockhash expired"` and let the dApp decide whether to request a fresh signature.
20. **Never leak provider API keys.** §4.12 routes all RPC through the first-party proxy. Any PR that adds a direct `https://mainnet.helius-rpc.com/?api-key=…` URL to the client bundle fails review. The env-var override (`EXPO_PUBLIC_SOLANA_*_RPC`) exists for dev and `solana-test-validator` only; a production build with a custom mainnet URL set warns on boot.
21. **No re-use of simulation across tx signatures.** Simulation result cache (§4.10 step 1) is keyed by `sha256(signedTxBase64)`, so any signature change invalidates it. Preflight never answers "yes, simulated OK" for a tx we didn't actually simulate.
22. **SNS resolution is advisory, not authoritative.** When a `.sol` domain appears in decoded instruction data or dApp-supplied destination hints, the sheet renders it as `takumi.sol → {resolvedBase58}` with the base58 address displayed in full and the domain as a label beside it. The on-chain signature is produced against the resolved base58 only — we never sign against a domain string. If resolution fails, we surface the raw base58 with no label; never invent a domain. SNS is a UI hint, not a signing input.
23. **Unknown program fall-through must be visible.** Any instruction touching a program we don't decode renders as `"Unknown program {programId} — {instructionData.length} bytes of data"` with a "Show raw" expander. Never silently render "Transaction" with zero instruction detail; a blank preview is indistinguishable from a drain payload.

### 10.5 Go/no-go GA checklist

- [ ] Every §10.1 row tagged P1a/P1b/P1c implemented; unit test per adapter branch.
- [ ] Every §10.2 standard enforced in code; fixture-driven tests where reference vectors exist (SIWS, SLIP-0010).
- [ ] Every §10.3 error code returned by the matching path; table-driven test.
- [ ] Every §10.4 invariant covered by an integration test firing the exact malicious shape.
- [ ] **Third-party smoke tests** — all must connect, sign, and complete a round-trip:
  - [ ] **Phantom's Wallet Standard demo** (`phantom/sign-in-with-solana` test pages) — connect, SIWS, signMessage, signTransaction (legacy + v0), signAndSendTransaction.
  - [ ] **Jupiter** (mainnet) — route + swap with ALTs; route + swap with priority fee; route cancelation.
  - [ ] **Magic Eden** — connect, sign a listing (SIWS + signAllTransactions), buy NFT (signAndSendTransaction).
  - [ ] **Tensor** — connect, signMessage login, place bid (signAllTransactions).
  - [ ] **Drift** — SIWS login, deposit, open position (partial-signer + priority fee).
  - [ ] **Marinade** — stake SOL (legacy tx), unstake (v0 tx).
  - [ ] **pump.fun** — buy + sell loop on a live token (sign-and-send w/ compute budget); verify Token-2022 mints surface extensions.
  - [ ] **Solana Faucet** (devnet) — airdrop flow tests cluster-switch UX.
  - [ ] **A Token-2022 transfer-fee mint** (PYUSD or an equivalent) — extension warning visible.
  - [ ] **Backpack durable-nonce demo** — offline-signing round-trip.
  - [ ] **An Anchor-app demo using `window.solana` directly** (pump-based launch page; most contemporary ones have migrated, but the shim is for exactly these) — no regressions.
- [ ] Security review sign-off on §10.4 invariants and on the `window.solana` shim surface (legacy methods are a permanent attack surface until removed).
- [ ] `bridgeEventBus` Solana event shape reviewed by the agent team — redaction proven on inspection.
- [ ] No TODO comment in `services/chains/solana/` referencing a §10 row.

### 10.6 Wallet Standard production contract (reviewer checklist)

A reviewer runs this list against the injected `TakumiSolanaWallet` object and the handshake. Every item is a specific thing that makes the wallet invisible, broken, or unsafe on real dApps. No item is optional for GA.

**Object shape**

- [ ] `wallet.version === "1.0.0"` literal string, not `process.env.npm_package_version`.
- [ ] `wallet.name` is stable across sessions; dApps store it in recent-wallets lists.
- [ ] `wallet.icon` is a `data:image/…;base64,…` URL, ≤ 100 KB, one of `svg+xml | webp | png | gif`.
- [ ] `wallet.chains` is an `IdentifierArray` containing all three short-form chains + all three CAIP-2 genesis-hash forms.
- [ ] `wallet.accounts` is `[]` before `standard:connect` resolves; populated only on approve.
- [ ] Feature-function identity is stable across `onLoadEnd` re-injections (invariant 18).

**Account shape**

- [ ] `account.address` is a base58 pubkey string.
- [ ] `account.publicKey` is a `Uint8Array(32)` — not a base58 string, not a `Buffer`, not a `number[]`.
- [ ] `account.chains` matches `wallet.chains` for software accounts.
- [ ] `account.features` lists at least `solana:signMessage`, `solana:signTransaction`, `solana:signAndSendTransaction`, `solana:signIn`.
- [ ] `account.label` set to the wallet's friendly name.

**Feature surface**

- [ ] `features["standard:connect"].version === "1.0.0"` and `connect()` honors `{ silent: true }` (invariant 15).
- [ ] `features["standard:disconnect"].version === "1.0.0"` and `disconnect()` clears the `PermissionGrant` server-side before resolving.
- [ ] `features["standard:events"].on("change", …)` returns an off-function; listener receives `StandardEventsChangeProperties` with only changed fields (§4.2e).
- [ ] `features["solana:signIn"].signIn(...inputs)` is variadic, returns `readonly SolanaSignInOutput[]` with `signature: Uint8Array` and `signedMessage: Uint8Array`.
- [ ] `features["solana:signMessage"].signMessage(...inputs)` is variadic, returns `readonly SolanaSignMessageOutput[]`.
- [ ] `features["solana:signTransaction"]`:
  - `version === "1.0.0"`
  - `supportedTransactionVersions` is a **literal** `["legacy", 0] as const` — not a getter (invariant 14)
  - `signTransaction(...inputs)` is variadic (N=1 → single sheet, N>1 → batch sheet)
  - Returns `readonly { signedTransaction: Uint8Array }[]`
- [ ] `features["solana:signAndSendTransaction"]`:
  - Same `version` + `supportedTransactionVersions` rules
  - `options.commitment / skipPreflight / maxRetries / preflightCommitment / minContextSlot` honored
  - Returns `readonly { signature: Uint8Array }[]` (raw bytes, never base58)

**Handshake**

- [ ] `window.dispatchEvent` fires `wallet-standard:register-wallet` on every injection (pre-content-load + onLoadEnd).
- [ ] `window.addEventListener('wallet-standard:app-ready', …)` handles the late-wallet race.
- [ ] Idempotent install: `window.__takumi_solana_installed` short-circuits.
- [ ] `window.solana` and `window.phantom.solana` point to the same shim object; `window.phantom = { solana: shim }` does not clobber a pre-existing `window.phantom`.
- [ ] `window.solana.isPhantom === false`; `window.solana.isTakumi === true`.

**Behavior**

- [ ] Every signing method calls into `DappBridge` via the `bridge_request` transport — no direct RPC calls from the injected script.
- [ ] Session nonce stamped on every outbound message (TWV-2026-015 — already inherited).
- [ ] No Solana secret, private key, seed, or signature ever logged — even in `__DEV__` breadcrumbs (TWV-2026-070 already enforced in `walletService.ts` / `signer.ts`).

**Verification tool**

Ship `services/chains/solana/__wallet-standard-lint.ts` — a dev-only helper that loads `@wallet-standard/app` + `@solana/wallet-adapter-wallet-standard` in a jsdom sandbox, runs every predicate the adapters apply, and fails CI if any row above regresses. Prevents a stray refactor from breaking `publicKey: Uint8Array` → `string` with no test catching it.
