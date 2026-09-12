# Per-origin wallet switching (connect / switch / revoke from the wallet)

**Status:** to do. **Owner:** unassigned. **Written:** 2026-09-13.

## Goal

A user can change which of their wallets a connected app sees **from inside
TakumiPay**, for every namespace the app supports (EVM, Solana, Sui,
Stellar) and every transport (in-app browser, WalletConnect, MWA, encrypted
links), without touching the dApp's own UI. The dApp updates live wherever
its protocol allows it.

Today the only wallet-side action is Disconnect. To use a different wallet
the user must disconnect, tap the dApp's Connect again, and pick the wallet
in our ConnectSheet. MetaMask, Rabby, Coinbase Wallet and Phantom all let
the user switch in the wallet and the dApp follows; the standards make the
wallet the authority over which accounts a dApp sees (sources at the end).

## Hard constraints (do not relax)

1. **Per-origin, never global.** The wallet a dApp sees is that origin's
   own state. The home-screen `activeWallet` / `activeChain` must never be
   pushed into a connected page or session. This is the isolation rule
   from commit `4828e91` and `feedback_dapp_bridge_isolation`;
   `EvmAdapter.onStateChange` and `SuiAdapter.onStateChange` are
   deliberate no-ops for exactly this reason. Every push in this feature
   is keyed off an explicit per-origin action.
2. **Every change is user-initiated in our UI.** Switching between two
   wallets the origin already holds grants for needs no new consent.
   Connecting a wallet the origin has never been granted goes through the
   existing ConnectSheet consent (same intent, same audit trail, same
   biometric / Verify gates). No silent grants.
3. **Chain-agnostic shared code.** No `namespace === "…"` in
   `components/`, `hooks/`, `app/` (`pnpm check:chains`). Per-namespace
   behaviour docks on `WalletKitAdapter` / the chain adapters as optional
   capabilities with presence checks (`feedback_space_docking`).
4. **Address case per encoding.** Compare and key through
   `canonicalizeAddress` / `addressesEqual`: EVM is EIP-55 checksummed,
   Sui folds, Solana base58 and Stellar base32 are verbatim
   (`feedback_address_case_per_encoding`). `SuiAdapter.pickSuiWalletForOrigin`
   still uses `toLowerCase()`; fix it on the way.
5. **Signing follows the selection.** After a switch, the wallet that
   signs for that origin is the newly selected one, and only it. Test this
   hardest, per namespace.

## Coverage matrix

Every cell must be either implemented or explicitly "not possible, here is
the fallback". Nothing may be left implicit.

| Namespace × transport | Live push to dApp | How | Notes |
| --- | --- | --- | --- |
| **EVM** in-app browser | Yes | `_updateEthereumProvider({ selectedAddress })` → `accountsChanged([addr])` (`services/chains/evm/injectedScript.ts:188`) | EIP-1193: provider **MUST** emit `accountsChanged` when `eth_accounts` changes |
| **EVM** WalletConnect | Yes | `updateSession` with the new `eip155:<id>:<addr>` accounts on every chain in the session, then `emitSessionEvent("accountsChanged")` per `eip155:<id>` | `EVM_WC_EVENTS` already advertises `accountsChanged` |
| **Solana** in-app browser | Yes | `_updateSolanaWallet({ accounts })` → Wallet Standard `change({ accounts })` **and** the legacy `window.solana` shim (`publicKey`, `isConnected`, `accountChanged` hooks) (`services/chains/solana/injectedScript.ts:86,129,142`) | Both surfaces, or wallet-adapter dApps and legacy-Phantom-API dApps disagree |
| **Solana** WalletConnect | Yes | `updateSession` with `solana:<genesis>:<pubkey>` accounts, `emitSessionEvent("accountsChanged")` per chain | `SOLANA_WC_EVENTS` advertises it; chains are genesis-hash CAIP-2 with `solana:mainnet\|devnet\|testnet` aliases (`services/walletKit/solana/walletConnect.ts`) |
| **Solana** MWA (Android) | No push | Rewrite the scope's `walletAddress` (`services/transports/mwa/scopeStore.ts`); the dApp gets the new account from its next `authorize(auth_token)` | MWA is dApp → wallet JSON-RPC only |
| **Solana** encrypted links | No switch | Disconnect only; the dApp reconnects | Session is bound to `public_key` the dApp encrypts to (`services/transports/encryptedLink/session.ts`); Solana-only in our implementation |
| **Sui** in-app browser | Yes | `_updateSuiWallet({ accounts, chain })` → `change({ accounts, chains })` (`services/chains/sui/injectedScript.ts:152,236`); alias wallets share state through getters so they follow automatically | Verify the aliases really do re-emit, they register separate `standard:events` listeners |
| **Sui** WalletConnect | Partial | `updateSession` + `emitSessionEvent("accountsChanged")` work, but `sessionProperties.sui_getAccounts` (pubkey list set at `approveSession`, `services/transports/walletconnect/index.ts:508-520`) **cannot be updated**: `UpdateParams` is `{ topic, namespaces }` only (`@walletconnect/types` engine.d.ts:105). Serve fresh `sui_getAccounts` as an RPC method; a dApp that only reads the session property keeps a stale pubkey | Decide: offer the switch with this caveat, or force disconnect + reconnect for Sui sessions. Recommendation: switch, and answer `sui_getAccounts` from the selection |
| **Stellar** in-app browser | No event exists | Update the selection; the dApp sees it on its next `getAddress()` (`REQUEST_PUBLIC_KEY`) or sign | SEP-43 defines no listener API: `getAddress` "will provide the public key (G...) the wallet is signing for" |
| **Stellar** WalletConnect | Yes | `updateSession` with `stellar:pubnet\|testnet:<G…>` accounts, `emitSessionEvent("accountsChanged")` | `STELLAR_WC_EVENTS` advertises it (`services/walletKit/stellar/walletConnect.ts:33`) |

Cross-cutting: a session or origin can hold **several namespaces at once**
(a WalletConnect session with EVM + Solana; a site granted both an EVM and
a Sui wallet). Switching one namespace never touches the others.

## Work items

### Epic 1. Per-origin selected account (source of truth, all namespaces)

- [ ] Add `OriginAccountStore` next to `OriginChainStore`
      (`services/permissions/`): `origin → { namespace → selected wallet
      address }`. MMKV-backed, canonical addresses, subscribable, one
      entry per namespace so EVM / Solana / Sui / Stellar selections for
      the same origin are independent.
- [ ] Invariant: for an origin and namespace, the exposed account
      (`eth_accounts[0]`, Wallet Standard `accounts[0]`, SEP-43
      `getAddress`) **and the signer** are read from this store. A grant
      with no selection falls back to the most recent grant, and the
      fallback is written into the store on first read so it stops being
      implicit.
- [ ] Replace the four per-adapter pickers with one store read:
  - `EvmAdapter` (`eth_accounts`, `eth_requestAccounts`, all sign paths,
    `OriginChainStore` interplay: selection is per namespace, chain stays
    per origin as today).
  - `SolanaAdapter.pickSolanaWalletForOrigin` (`services/chains/solana/SolanaAdapter.ts:133`):
    today returns the **first** matching grant in list order and, with no
    grant, silently `solanaWallets[0]`. Both go away.
  - `SuiAdapter.pickSuiWalletForOrigin` (`:170`): today sorts by
    `grantedAt` desc (the pivy.me fix) and compares with `toLowerCase()`.
  - `StellarAdapter.pickStellarWalletForOrigin` (`:147`): same shape as
    Sui; also `resolveGrantedNetwork` must stay network-of-selected-wallet.
- [ ] Revoke path: `PermissionStore.revoke` for a wallet clears its
      selection in that namespace; revoking the selected wallet promotes
      another granted wallet of the same namespace (if any) and pushes the
      change like a switch.
- [ ] Unit tests (`node:test`, resolver harness): round-trip; fallback
      promotion; revoke of selected; namespace isolation (an EVM
      selection never affects the Solana selection for the same origin);
      case rules per namespace (a checksummed vs lowercased EVM address is
      one selection; two Solana addresses differing by case are two).

### Epic 2. In-app browser push, per namespace

- [ ] `DappBridge.switchAccount({ origin, namespace, address })`: writes
      the store, then pushes provider state built from the **selection**,
      never from `ctx.activeWallet`. Dock as an optional adapter
      capability `accountSwitchScript?(selection) → injectedJs`,
      presence-checked; the bridge never branches on namespace.
- [ ] **EVM**: `_updateEthereumProvider({ selectedAddress })`. Keep the
      one-exposed-account model (`selectedAddress` is scalar; EIP-1193
      recommends "not exposing any accounts by default"). Multi-account
      `eth_accounts` is out of scope.
- [ ] **Solana**: `_updateSolanaWallet({ accounts })`. Confirm
      `setAccounts` fires `lsn.change` **and** updates the legacy shim
      (`sh.publicKey`, `sh.isConnected`, `hk.accountChanged`) on a switch,
      not only on connect. Account objects must carry the right `chains`
      for the session's cluster (`MA(address)` builder).
- [ ] **Sui**: `_updateSuiWallet({ accounts, chain })` with the origin's
      granted network as `chain` so `W.chains` ordering stays correct.
      Verify every alias wallet (`ALIAS_DEFS`) re-emits `change`; if an
      alias keeps its own listener set, fan out.
- [ ] **Stellar**: no injected event (SEP-43). Nothing to push; the next
      `REQUEST_PUBLIC_KEY` / `SUBMIT_*` reads the selection. Document
      this in the row hint ("applies on the app's next request").
- [ ] Only push into the WebView when the origin is the page currently
      loaded; a switch made from Settings for a site that is not open
      updates the store only.

### Epic 3. WalletConnect sessions, per namespace

- [ ] `walletConnectTransport.switchAccount(topic, namespace, address)`:
      rebuild that namespace's accounts for every chain the session holds
      via the kit's `walletConnectNamespace` builder (all four kits have
      one), `updateSession({ topic, namespaces })`, then
      `emitSessionEvent({ topic, event: { name: "accountsChanged", data },
      chainId })` **once per chain** of that namespace (the event is
      chain-scoped).
- [ ] **EVM**: `data: [address]`, chains `eip155:<id>` for every chain row
      in the session.
- [ ] **Solana**: `data: [pubkey]`, chains are the genesis-hash CAIP-2 ids
      the session was approved with (keep the `solana:mainnet` alias
      mapping consistent with `solanaWalletConnectNamespace`).
- [ ] **Sui**: `data: [address]` per `sui:<network>`; answer the
      `sui_getAccounts` RPC from the selection (`suiAccountsForSession`);
      record in the row that `sessionProperties` is frozen by the SDK and
      a dApp reading only that may need a reconnect. Product decision
      logged above.
- [ ] **Stellar**: `data: [G-address]` per `stellar:pubnet|testnet`.
- [ ] Persist: grant rows for the new wallet under the session's
      `originKey`, old wallet's rows for that session revoked;
      `sessions()` reflects the new `accounts` so the Connected apps card
      updates.
- [ ] Signing: `session_request` resolves the signer from the session's
      current accounts (`services/transports/walletconnect/index.ts`
      ~825/850). Test per namespace that a request after the switch is
      signed by the new wallet and a request naming the old account is
      refused.
- [ ] Multi-namespace sessions: switching `solana` leaves `eip155`
      untouched, and vice versa. Test it.
- [ ] Failure: if `updateSession` throws (peer offline), roll the store
      back and show fixed friendly copy; never surface SDK text
      (`feedback_user_facing_errors`).

### Epic 4. MWA and encrypted links (Solana)

- [ ] MWA: switching rewrites the scope's `walletAddress`; the next
      `authorize` with the existing `auth_token` returns the new account
      (`services/transports/mwa/index.ts` authorize / reauthorize paths).
      Row hint: "applies on the app's next request".
- [ ] Encrypted links: no switch. Row offers Disconnect only with a hint
      that the app must reconnect. Never rewrite `public_key`.

### Epic 5. UI (`ConnectedAppsList`, sheet Wallets tab, Settings)

- [ ] `ConnectedWalletRow` gains a `connect` action alongside
      `disconnect` / `status` / `none`; "Other wallets" rows in the
      sheet's Wallets tab become actionable, grouped as today by account
      (`WalletAccountGroupHeader`) so the EVM / SOL / SUI / XLM rows of one
      seed phrase stay together.
  - Wallet of a namespace the origin already holds a grant for →
    **Switch** (no consent; Epic 2 / 3 / 4).
  - Wallet of a namespace the origin has no grant for → **Connect**:
    dispatch a synthetic connect intent for that origin with
    `walletIndex` preselected so the existing ConnectSheet opens
    (`components/dapps-browser/approvals/ConnectSheet.tsx:199`;
    `EvmAdapter` `:1224`, `SolanaAdapter` `:607`, `SuiAdapter` `:576`
    already read it) and the grant + push happen through the existing
    `pushPostDecisionUpdate` fast path.
- [ ] Connected rows: **Use this wallet** on non-selected granted wallets
      of the same namespace; the selected one shows a check. Same in the
      Connected apps cards (sheet tab and Settings).
- [ ] Session rows: **Switch wallet** opens a wallet picker filtered to
      the session's namespace(s); MWA and Stellar-in-browser rows say
      "applies on the app's next request"; encrypted-link rows have no
      switch; Sui WalletConnect rows carry the `sui_getAccounts` caveat if
      the decision is "switch".
- [ ] Pending / error states: spinner on the row during the push; fixed
      friendly copy on failure. No em-dashes (`feedback_no_emdash_in_ui_copy`).

### Epic 6. Deep-link and agent surfaces

- [ ] Deep-link intents (`services/deeplinks/`) that resolve a wallet for
      an origin read `OriginAccountStore`, not `activeWallet`.
- [ ] Agent executors (`services/agent-executors/`) acting "as the wallet
      connected to X" read the same store, through the kit registry.
- [ ] Analytics: `dapp_account_switched { transport, namespace,
      dapp_host }`; no addresses.

### Epic 7. Tests and device verification

- [ ] `node:test`: store; each adapter's selection read (EVM, Solana,
      Sui, Stellar); WalletConnect `switchAccount` per namespace with a
      mocked kit (asserting one `emitSessionEvent` per chain and the
      `sui_getAccounts` answer); `useDappConnections` exposing `selected`.
- [ ] Device matrix on a preview build (`adb shell am force-stop` between
      runs, `feedback_rn_device_debugging_traps`):
  - EVM in-app (Uniswap): address changes without reload.
  - Solana in-app, wallet-adapter dApp (Jupiter): `change` picked up.
  - Solana in-app, legacy `window.solana` dApp: `accountChanged` fires.
  - Sui in-app, dapp-kit dApp: `change` picked up; test through an alias
    entry as well as the canonical TakumiPay entry.
  - Stellar in-app (Lumenswap): next sign uses the new G-address.
  - EVM WalletConnect desktop (RainbowKit/wagmi): live switch after
    `session_update` + `accountsChanged`.
  - Solana WalletConnect (AppKit dApp): live switch.
  - Sui WalletConnect: live `accountsChanged`; observe whether the dApp
    re-requests `sui_getAccounts`.
  - Stellar WalletConnect: live switch.
  - MWA native Android dApp: next transaction signed by the new wallet.
- [ ] Regression: switching the home-screen active wallet changes
      **nothing** for any connected app, in any namespace. Automate as a
      bridge test if possible; otherwise log the page's listeners on
      device.

## Acceptance criteria

1. From the sheet or Settings, a user can switch the wallet a connected
   app uses for any namespace the app was granted. EVM / Solana / Sui
   in-app pages and EVM / Solana / Sui / Stellar WalletConnect sessions
   reflect it without a reload; Stellar in-app, MWA and encrypted links
   behave exactly as the matrix says and the UI tells the user so.
2. The next signature for that origin comes from the newly selected
   wallet on every transport and namespace; the previously selected
   wallet cannot sign for that origin until reselected.
3. Connecting a not-yet-granted wallet always shows the ConnectSheet.
4. The home-screen active wallet never leaks into a connected app.
5. `pnpm check:chains`, `pnpm check:syntax`, lint and the `node:test`
   suite pass; the device matrix is green on Android and iOS.

## Out of scope

- Exposing several EVM accounts at once (`eth_accounts` with more than
  one entry).
- Per-origin **chain** switching from the wallet for non-EVM namespaces
  (EVM already has `OriginChainStore` + `wallet_switchEthereumChain`).
- WalletConnect One-Click Auth session re-issuance on switch.
- MWA on iOS (still "planned" upstream).

## References (primary sources, fetched 2026-09-12/13)

- EIP-1193, "accountsChanged":
  https://github.com/ethereum/EIPs/blob/master/EIPS/eip-1193.md
- Wallet Standard `standard:events`, `StandardEventsChangeProperties`
  (`accounts`, `chains`, `features`):
  https://github.com/wallet-standard/wallet-standard/blob/master/packages/core/features/src/events.ts
- SEP-0043, Standard Web Wallet API Interface, "getAddress":
  https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0043.md
- WalletConnect Wallet SDK (React Native) usage, "Updating a Session",
  "Emitting Session Events", "Session Disconnect":
  https://docs.walletconnect.com/wallets/react-native/usage
- `@walletconnect/types` `EngineTypes.UpdateParams = { topic, namespaces }`
  (installed copy, `dist/types/sign-client/engine.d.ts:105`).
- Solana Mobile Wallet Adapter spec, session establishment and
  `authorize`:
  https://github.com/solana-mobile/mobile-wallet-adapter/blob/main/spec/spec.md
- In-repo: `docs/deeplink-wallet-interactions-spec.md` (§7 WalletConnect,
  §8 MWA, §9 encrypted links), `services/bridge/DappBridge.ts`
  (`pushPostDecisionUpdate`), `services/permissions/store.ts`,
  `services/walletKit/{evm,solana,sui,stellar}/walletConnect.ts`,
  `components/dapps-browser/connections/ConnectedAppsList.tsx`.
