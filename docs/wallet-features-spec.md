# Production Wallet Features — Engineering Spec

**Status:** Draft
**Owner:** Wallet team
**Scope:** `takumiaiwallet/mobile-app` — everything outside the bridge spec (`docs/dapp-bridge-spec.md`)
**Date:** 2026-04-16
**Prerequisite:** Bridge spec (Phase 1a/1b/1c) must be implemented. This spec assumes `DappBridge`, `ChainAdapter`, `ApprovalIntent`, `IntentInspector`, `BridgeEventBus`, `PermissionStore`, and `EvmAdapter` all exist.

---

## 1. Goal

Ship every feature a user expects from a **production-grade, self-custodial EVM wallet** that the bridge spec does not cover. The bridge spec owns the dApp ↔ wallet protocol layer. This spec owns everything the user interacts with **outside** the WebView: portfolio, history, token/NFT management, address resolution, security UX, connectivity (WalletConnect, deep links), and operational infrastructure (RPC failover, push notifications, backup).

When both specs ship, TakumiAI Wallet is feature-complete for a v1.0 store release on EVM.

## 2. Guiding principles

1. **The bridge spec is settled.** Nothing here redesigns `DappBridge`, adapters, or the approval spine. We consume its ports; we don't extend them except where explicitly noted (new `ApprovalKind` variants, new inspectors).
2. **Data comes from indexers, not RPC polling.** Portfolio balances, transaction history, NFT metadata, and token lists come from indexer APIs (Alchemy, Moralis, SimpleHash, or self-hosted). Direct RPC calls are reserved for signing, estimation, and fallback.
3. **Offline-first where possible.** Token lists, address book, approval records, and NFT metadata cache locally. The app must be usable on poor connections; stale data is better than a spinner.
4. **Security UX is not optional.** Biometric lock, approval revocation, address-poisoning guards, and token-spam filtering are GA requirements, not Phase 2 polish.
5. **Chain-agnostic from the start.** Every feature in this spec operates on `Namespace`-tagged data. When Solana lands, the same portfolio screen, history view, and address book handle it with zero rewrites.

## 3. Current state audit

| Feature | Current state | Gap |
|---|---|---|
| Token balances | Basic `eth_getBalance` + manual token list | No auto-discovery, no prices, no portfolio aggregation |
| Transaction history | None in-app; user checks Etherscan | No indexer, no receipt parsing, no pending-tx tracking |
| NFT display | None | No gallery, no metadata, no collection grouping |
| ENS resolution | None | No forward/reverse, no avatar, no address bar integration |
| Address book | None | No saved contacts |
| Token approval management | None | No revoke UI, no visibility into active approvals |
| WalletConnect | Not implemented | Cannot connect to desktop dApps |
| Deep links / URI handling | None | Cannot handle `ethereum:` URIs or WC links |
| Push notifications | None | No tx confirmation alerts |
| Biometric / PIN lock | None | App is unprotected if device is unlocked |
| RPC failover | Single provider, no retry | One RPC down = wallet unusable |
| Token spam filtering | None | Spam tokens visible in portfolio |
| QR scanner | None | Cannot scan addresses or WC URIs |
| Backup UX | Seed phrase shown once at creation | No re-export, no cloud backup option |
| In-app swap | None (relies on dApp browser) | No native swap aggregation |

## 4. Architecture

### 4.1 Data layer — indexer abstraction

```ts
// services/indexer/types.ts
export interface IndexerProvider {
  readonly name: string;

  getTokenBalances(address: string, chainId: number): Promise<TokenBalance[]>;
  getTransactionHistory(address: string, chainId: number, opts: HistoryOpts): Promise<Transaction[]>;
  getNFTs(address: string, chainId: number, opts?: NFTOpts): Promise<NFTAsset[]>;
  getTokenApprovals(address: string, chainId: number): Promise<TokenApproval[]>;
  getTokenMetadata(contractAddress: string, chainId: number): Promise<TokenMetadata | null>;
  getTokenPrices(contracts: string[], chainId: number): Promise<Map<string, TokenPrice>>;
  resolveENS(nameOrAddress: string): Promise<ENSResolution | null>;
}
```

Implementations:
- `AlchemyProvider` — primary (Enhanced APIs: token balances, NFTs, transfers, prices).
- `MoralisProvider` — fallback (similar coverage, different rate limits).
- `DirectRPCProvider` — last resort (manual `balanceOf` multicall, no history/NFT).

`IndexerRegistry` tries providers in priority order; caches results in `expo-sqlite` with per-type TTLs. The rest of the app imports `useIndexer()` — never calls Alchemy directly.

### 4.2 Token management

#### 4.2a Token list + auto-discovery

```ts
// services/tokens/types.ts
export interface TokenBalance {
  contractAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: bigint;
  price?: TokenPrice;
  logoURI?: string;
  chainId: number;
  namespace: Namespace;
  isSpam: boolean;
  source: "default-list" | "user-added" | "auto-discovered" | "dapp-watch-asset";
}

export interface TokenPrice {
  usd: number;
  change24h: number;
  updatedAt: number;
}
```

**Default token list**: bundled JSON derived from Uniswap / CoinGecko token lists — top ~500 tokens per supported chain. Updated on each app release.

**Auto-discovery**: indexer returns all non-zero token balances. Tokens not in the default list appear in a "Discovered" section with an `info` badge. User can hide (spam) or pin (promote to main list).

**Spam filtering**: indexer-side spam scoring (Alchemy provides `isSpam`). Additionally, local heuristics:
- No verified logo + zero-value airdrop + contract < 7 days old → auto-hide.
- Token name mimics a known token (Levenshtein distance < 3 from top-100 names) → warn badge.
- User can report spam → persisted locally, eventually fed to agent for learning.

**Price feeds**: batched `getTokenPrices` call, cached 60s. Portfolio total computed client-side. Price display in native currency (user-configurable: USD, EUR, IDR, etc.).

#### 4.2b Token approval management (revoke UI)

```ts
// services/tokens/approvals.ts
export interface TokenApproval {
  contractAddress: string;
  spender: string;
  spenderLabel?: string;     // ENS or known-protocol label
  allowance: bigint | "unlimited";
  tokenType: "ERC-20" | "ERC-721" | "ERC-1155";
  isApprovalForAll: boolean; // ERC-721/1155 operator approval
  chainId: number;
  lastUpdatedBlock: number;
}
```

**UI: `app/settings/approvals.tsx`** — lists all active token approvals per chain, grouped by spender. Each row shows: token, spender (with ENS if available), allowance amount, "Revoke" button.

**Revoke flow**: tapping "Revoke" builds an `ApprovalIntent<EvmSendTxPayload>` for `approve(spender, 0)` (ERC-20) or `setApprovalForAll(operator, false)` (721/1155), routed through `DappBridge` with `origin: "internal://settings"`. Same approval sheet, same inspector pipeline, same event bus.

**Batch revoke**: select multiple approvals → single `wallet_sendCalls` intent (EIP-5792). Smart accounts execute atomically; EOAs execute sequentially.

**Stale detection**: on each portfolio refresh, compare current approvals against last known state. New unlimited approvals not initiated by the user (i.e., no matching `BridgeEvent`) get a push notification: "New unlimited approval detected for [token] by [spender]".

### 4.3 NFT gallery

```ts
// services/nfts/types.ts
export interface NFTAsset {
  contractAddress: string;
  tokenId: string;
  standard: "ERC-721" | "ERC-1155";
  collection: {
    name: string;
    slug?: string;
    imageUrl?: string;
    isVerified: boolean;
    floorPrice?: TokenPrice;
  };
  metadata: {
    name: string;
    description?: string;
    imageUrl: string;         // resolved gateway URL
    animationUrl?: string;    // video/3D
    attributes: NFTAttribute[];
  };
  balance: number;            // 1 for 721, N for 1155
  chainId: number;
  isSpam: boolean;
}

export interface NFTAttribute {
  traitType: string;
  value: string | number;
  displayType?: "number" | "date" | "boost_percentage" | "boost_number";
}
```

**UI: `app/(tabs)/nfts.tsx`** — grid view grouped by collection. Tap → detail screen with full-res image/video, traits, floor price, transfer button, list-on-marketplace deep link.

**Metadata resolution**: indexer returns metadata with gateway-resolved URLs. Fallback chain: indexer → `tokenURI` on-chain → IPFS gateway (pinata, cloudflare-ipfs, w3s.link) → Arweave gateway. Cache in `expo-sqlite` + file system for images.

**Spam filtering**: same heuristics as tokens. Additionally, known airdrop-scam collections (curated list, updated weekly via remote config). Hidden NFTs go to a "Hidden" tab, not deleted — user can restore.

**Send NFT flow**: builds `ApprovalIntent<EvmSendTxPayload>` for `safeTransferFrom` (721) or `safeTransferFrom` (1155 with amount). Routed through `DappBridge` with `origin: "internal://nft-gallery"`.

**ERC-6551 token-bound account display**: if an NFT owns assets (detected via 6551 registry), show a "This NFT owns assets" badge. Tap to view the TBA's portfolio inline.

### 4.4 Transaction history

```ts
// services/history/types.ts
export type TransactionStatus = "confirmed" | "pending" | "failed" | "dropped" | "replaced";

export interface WalletTransaction {
  hash: string;
  chainId: number;
  namespace: Namespace;
  status: TransactionStatus;
  from: string;
  to: string;
  value: bigint;
  // Decoded info
  type: "native-transfer" | "token-transfer" | "token-approve" | "nft-transfer"
      | "swap" | "contract-interaction" | "contract-deploy" | "bridge" | "unknown";
  decoded?: {
    functionName: string;
    args: Record<string, unknown>;
    tokenTransfers: TokenTransferEvent[];
    nftTransfers: NFTTransferEvent[];
  };
  // Fee info
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  feeUsd?: number;
  // Timing
  timestamp: number;
  blockNumber?: number;
  // Nonce
  nonce: number;
  // Replacement tracking
  replacedBy?: string;        // hash of speed-up/cancel tx
  replacementFor?: string;    // hash of original tx
}
```

**UI: `app/(tabs)/history.tsx`** — chronological list grouped by day. Each row: icon (type-based), counterparty (ENS or truncated), amount, status badge, timestamp. Tap → detail screen with decoded calldata, token transfers, gas breakdown, block explorer link.

**Pending tx tracking**: when `EvmAdapter.executeApproval` returns a hash, `PendingTxTracker` starts polling `eth_getTransactionReceipt` (exponential backoff: 2s → 4s → 8s → 15s → 30s, cap at 30s). On confirmation: update status, emit `BridgeEvent`, fire push notification. On drop (not mined after 30 min): mark as "dropped", notify user.

**Speed-up / cancel**: from the pending-tx detail screen:
- **Speed up**: same tx, same nonce, +20% `maxPriorityFeePerGas`. Routed as `ApprovalIntent<EvmSendTxPayload>` through `DappBridge`.
- **Cancel**: zero-value self-send, same nonce, +20% fee. Same route.
- Both show the original tx context: "Speeding up: Swap 1 ETH → 2500 USDC on Uniswap".

**Cross-chain aggregation**: history from all chains merged into one timeline, chain badge on each row. Filter by chain, by type, by token.

### 4.5 ENS + domain resolution

```ts
// services/ens/types.ts
export interface ENSResolution {
  name: string | null;         // forward: address → name
  address: string | null;      // reverse: name → address
  avatar?: string;             // avatar record URL
  textRecords?: Record<string, string>;  // description, url, twitter, github, etc.
  contenthash?: string;
  chainId: number;
}
```

**Integration points**:
- **Address bar** (dApp browser): type `vitalik.eth` → resolves → navigates to contenthash if it's an IPFS/ENS site.
- **Send flows**: recipient field accepts ENS names. Resolved address shown below with avatar. Confirm screen shows both name and address.
- **History + portfolio**: reverse-resolve known addresses. Cache aggressively (ENS names rarely change — TTL 24h).
- **Approval sheets**: spender addresses show ENS names when available. "Approving Uniswap V3 Router (uniswap.eth)" is vastly more trustworthy than a raw address.
- **Address bar suggestions**: recently resolved ENS names appear in autocomplete.

**L2 ENS (CCIP-read / EIP-3668)**: viem handles this natively. Ensure the indexer respects off-chain resolution for L2-hosted names (Coinbase name service, Linea ENS, etc.).

**Other domain systems**: Unstoppable Domains (`.crypto`, `.wallet`, `.nft`) — single resolver adapter, same `ENSResolution` shape. Not GA-critical but flag for fast-follow.

### 4.6 Address book / contacts

```ts
// services/contacts/types.ts
export interface Contact {
  id: string;
  label: string;
  addresses: {
    namespace: Namespace;
    address: string;
    chainIds?: number[];       // optional per-chain restriction
    ensName?: string;
  }[];
  notes?: string;
  createdAt: number;
  lastUsedAt: number;
}
```

**UI: `app/settings/contacts.tsx`** — list + search + add/edit/delete. Contacts appear in send-flow recipient autocomplete, sorted by `lastUsedAt`.

**Auto-suggest**: after sending to an address 3+ times, prompt "Save as contact?". Never auto-save without user action.

**Namespace-aware**: a contact can have both an EVM and a Solana address. The send flow shows the right one based on active chain.

### 4.7 WalletConnect v2

WalletConnect is the **second transport** for `DappBridge`. Desktop dApps (Uniswap on Chrome, Aave on Firefox) connect to the mobile wallet via QR scan or deep link.

```ts
// services/walletconnect/WalletConnectTransport.ts
export interface WCTransport {
  /** Start pairing from a WC URI (scanned or deep-linked). */
  pair(uri: string): Promise<void>;

  /** Active sessions, persisted across app restarts. */
  getSessions(): WCSession[];

  /** Disconnect a session. */
  disconnect(topic: string): Promise<void>;
}
```

**Architecture**: WC v2 sessions produce JSON-RPC requests. The transport converts them to `ChainRequest` and feeds them into `DappBridge.handleRequest()` — same gate, same inspectors, same approval sheets, same event bus. The only difference from WebView requests: `origin.transport === "walletconnect"` instead of `"webview"`.

**Session management UI: `app/settings/walletconnect.tsx`**:
- Active sessions list: dApp name, icon, connected chains, connected accounts, "Disconnect" button.
- Session approval sheet: when a new pairing arrives, show `ConnectSheet` with the dApp's metadata, requested chains, requested methods. User approves/rejects per the existing `ApprovalIntent<connect>` flow.

**CAIP-2 namespace mapping**: WC v2 uses CAIP-2 natively (`eip155:1`, `solana:mainnet`). Map directly to our `Namespace` + `chainId`. When Solana adapter lands, WC sessions requesting `solana:*` methods route to `SolanaAdapter` with zero changes.

**Push notifications for WC requests**: when the app is backgrounded and a WC session sends a request, fire a local notification: "Uniswap wants to send a transaction". Tapping opens the approval sheet directly.

**Relay**: use WalletConnect's public relay (`relay.walletconnect.com`) for v1. Self-hosted relay is a follow-up for enterprise deployments.

### 4.8 Deep links + URI handling

| URI scheme | Standard | Action |
|---|---|---|
| `ethereum:<address>[@chainId][/function?params]` | EIP-681 | Open send flow pre-filled with recipient, amount, calldata |
| `wc:<topic>@2?relay-protocol=irn&symKey=<key>` | WalletConnect v2 | Initiate WC pairing |
| `takumiwallet://send?to=<address>&amount=<value>&chain=<chainId>` | Custom | Internal deep link for send flow |
| `takumiwallet://dapp?url=<encoded-url>` | Custom | Open dApp browser to URL |
| `takumiwallet://connect?uri=<wc-uri>` | Custom | WC pairing via deep link |

**Implementation**: Expo Router's `app.config.ts` registers URL schemes. `app/_layout.tsx` handles incoming links via `expo-linking`. Each URI type maps to a screen + pre-filled params.

**EIP-681 parsing**: dedicated parser (`services/deeplinks/eip681.ts`) handles the full spec: `ethereum:0x1234@137/transfer?address=0x5678&uint256=1e18`. Builds a pre-filled send sheet. Chain mismatch prompts `wallet_switchEthereumChain`.

**Security**: deep links that trigger signing or transactions always show the approval sheet. Never auto-approve from a deep link. Origin is `"deeplink://<scheme>"` so inspectors can reason about it.

### 4.9 QR code scanner

**UI: floating action button on portfolio / send screens** → opens camera with `expo-camera`. Decodes:
- Ethereum addresses (raw hex) → open send flow.
- ENS names → resolve, then open send flow.
- EIP-681 URIs → parse and pre-fill.
- WalletConnect URIs → initiate pairing.
- Unknown → show "Unrecognized QR code" toast.

Also used by `wallet_scanQRCode` (§10.1 of bridge spec, P2 method) — dApps can invoke the scanner.

### 4.10 Push notifications

**Provider**: `expo-notifications` for local; Firebase Cloud Messaging (FCM) / APNs for remote (backend-triggered).

| Event | Source | Channel |
|---|---|---|
| Transaction confirmed | `PendingTxTracker` | Local |
| Transaction failed / dropped | `PendingTxTracker` | Local |
| Token received (incoming transfer) | Indexer webhook / polling | Remote |
| NFT received | Indexer webhook / polling | Remote |
| New unlimited approval detected | Approval watcher | Local |
| WC session request (app backgrounded) | WC relay push | Remote |
| Price alert (token moved > ±10%) | Price monitor | Remote |
| Security alert (connected dApp flagged) | PhishingListInspector feed update | Remote |

**User controls**: per-channel toggle in `app/settings/notifications.tsx`. All channels default ON except price alerts (default OFF).

**Backend requirement**: `takumipay-api` needs a new `notifications` module that accepts FCM tokens, stores per-user preferences, and fires remote pushes when indexer webhooks trigger. Minimal scope — a thin gateway, not a full notification service.

### 4.11 Security UX

#### 4.11a App lock (biometric / PIN)

- On first launch after wallet creation: prompt to enable biometric (Face ID / fingerprint) or 6-digit PIN. Strongly recommended, not forced.
- **Lock triggers**: app foreground after >30s background, or on-demand via lock button.
- **Per-action authentication**: signing, sending, exporting keys, revoking approvals — always re-prompt biometric/PIN regardless of lock state. Configurable: user can disable per-action auth for small amounts (threshold they set).
- **Implementation**: `expo-local-authentication` for biometrics. PIN stored as argon2 hash in `expo-secure-store`.
- **Device with no screen lock** (no biometric, no PIN / pattern / passcode): the OS cannot authenticate anyone, so there is no cold-start lock screen on such a device. The app opens as usual and every per-action gate (send, sign, dApp approve, seed view / export, backup, sign-in) falls back to the in-app PIN, walking the user through PIN setup on first use with the same sheet the send / redeem flows already use. Posture is read via `getEnrolledLevelAsync()` at boot and before every gate (`services/security/deviceSecurityLevel.ts`); OS auth resumes automatically once the user adds a screen lock.

#### 4.11b Address-poisoning detection

Address poisoning: attacker sends 0-value transfers from addresses that share the first/last 4 characters of addresses the user frequently interacts with.

**Detection**:
- On incoming transfer: compare `from` against user's contact book + recent counterparties. If first/last 4 chars match but full address differs → flag as potential poisoning.
- In send flow: if user pastes an address that matches a poisoning pattern, show `danger` annotation: "This address looks similar to [contact name] but is different. Verify carefully."
- In history: poisoning-flagged transfers get a `⚠️ Possible address poisoning` badge. Tapping explains the attack.

#### 4.11c Token spam filtering (expanded)

Beyond §4.2a heuristics:
- **Phishing token names**: tokens whose name contains "Claim at <url>" or "Visit <url>" — auto-hide + `danger` badge if shown.
- **Honeypot detection**: if a token cannot be sold (simulated `approve` + `transferFrom` fails), badge it as "Cannot be transferred — possible honeypot".
- **Airdrop quarantine**: tokens received via airdrop (no user-initiated interaction) go to a "Received" quarantine tab. User explicitly moves them to portfolio. Interacting with quarantined tokens shows a warning.

#### 4.11d Seed phrase / key management

- **Re-export seed phrase**: `app/settings/security/export-seed.tsx`. Requires biometric + PIN (both). Shows seed words one screen at a time, never all at once in a screenshot-able grid. Prevents screenshots via `FLAG_SECURE` (Android) / screenshot notification (iOS).
- **Export private key**: same flow, single key for the selected wallet.
- **Cloud backup (optional)**: encrypted seed backup to iCloud Keychain (iOS) / Google Cloud Key Vault (Android). Encrypted client-side with a user-chosen backup password (not the PIN). Backup password is NOT stored — user must remember it. Recovery: re-enter backup password → decrypt → restore wallets. Enabled opt-in from settings.
- **Wipe wallet**: `app/settings/security/wipe.tsx`. Requires full auth. Deletes all keys from `SecureStore`, clears `expo-sqlite`, resets app to onboarding. Shows 10s countdown before executing. Destructive — no undo.

### 4.12 RPC infrastructure

#### 4.12a Multi-provider with failover

```ts
// services/rpc/types.ts
export interface RPCProvider {
  name: string;
  url: string;
  chainId: number;
  priority: number;        // lower = preferred
  rateLimitRpm: number;
  healthStatus: "healthy" | "degraded" | "down";
  lastLatencyMs: number;
}
```

**Per-chain provider list**: each chain has 2-3 providers (e.g., Alchemy primary, Infura secondary, public fallback). Stored in remote config, updatable without app release.

**Health monitoring**: every 60s, each active chain's primary provider gets a lightweight `eth_blockNumber` ping. If latency > 5s or error → mark degraded → automatic failover to next priority. Restore when healthy for 3 consecutive pings.

**User-facing**: `app/settings/networks.tsx` shows per-chain health status. User can add custom RPC endpoints (used as highest priority for that chain).

#### 4.12b Rate limiting + request dedup

- Client-side rate limiter per provider (token bucket, configured from `rateLimitRpm`).
- Request dedup: identical `eth_call` / `eth_getBalance` calls within 2s window → return cached result, don't hit RPC.
- Multicall batching: aggregate multiple `balanceOf` / `allowance` calls into a single Multicall3 `aggregate3` call. Reduces RPC calls from O(tokens) to O(1) per chain.

### 4.13 In-app swap (native)

A lightweight swap interface that doesn't require opening the dApp browser.

**UI: `app/swap.tsx`** — token selector (from/to), amount input, slippage setting, route preview, "Swap" button.

**Aggregator backend**: route through `takumipay-api` which queries aggregators (0x, 1inch, Paraswap, or LI.FI for cross-chain). Returns: route, calldata, estimated output, gas estimate, price impact.

**Execution**: the "Swap" button builds an `ApprovalIntent<EvmSendTxPayload>` (or `EvmBatchCallsPayload` if approve+swap is needed) and routes through `DappBridge` with `origin: "internal://swap"`. Same approval sheet, same inspectors, same event bus.

**Cross-chain swap**: LI.FI or Socket aggregation for bridging + swap in one flow. Shows multi-step route: "Swap ETH → USDC on Ethereum → Bridge to Base → Swap USDC → ETH on Base". Each step is a separate `ApprovalIntent`, shown sequentially.

**MEV protection**: for Ethereum mainnet swaps, submit via Flashbots Protect RPC (or similar private mempool) by default. Toggle in swap settings. On L2s: not applicable (sequencer ordering).

### 4.14 Staking + yield display

Not a staking service — surface positions the user already has.

**Native ETH staking**: detect beacon chain deposits, display staking status (active/pending/exiting), rewards accrued. Uses beacon chain API.

**Liquid staking tokens (LSTs)**: recognize stETH, rETH, cbETH, etc. Show underlying ETH value + APY in portfolio. Treat as regular tokens for transfer/approval but badge them as "Staking position".

**ERC-4626 vaults**: detect vault positions (Yearn, Aave aTokens, Compound cTokens). Show underlying value + yield rate. "Withdraw" button → builds appropriate calldata → routes through `DappBridge`.

**DeFi positions aggregator**: future — integrate Zapper/DeBank API to show all DeFi positions in one view. Flag for fast-follow, not GA.

### 4.15 L2-specific handling

| Concern | L2 behavior | Implementation |
|---|---|---|
| **Withdrawal delays** | Optimistic rollups (OP, Arb) have 7-day withdrawal challenge periods | Detect `L2ToL1MessagePasser` calls; show countdown timer in history; push notification when ready to finalize |
| **L1 data fee** | OP Stack chains charge L1 data fee on top of L2 execution fee | Gas estimation includes `l1Fee` from `GasPriceOracle` precompile; shown separately in tx sheet: "L2 fee: X ETH + L1 data fee: Y ETH" |
| **Deposit tracking** | L1→L2 deposits take ~minutes (OP) to ~10min (Arb) | Track deposit hash on L1; poll L2 for relay; show "Bridging…" in history with progress |
| **Sequencer health** | If sequencer is down, L2 is write-unavailable | Health check includes sequencer status endpoint; show banner: "Base sequencer is experiencing delays" |
| **Native bridging** | Each L2 has a canonical bridge contract | Recognized in calldata decoder; shown as "Bridge" tx type in history with source/destination chain |

## 5. File layout (additions to bridge spec's layout)

```
services/
  indexer/
    types.ts                  ← IndexerProvider, TokenBalance, Transaction, NFTAsset
    AlchemyProvider.ts
    MoralisProvider.ts
    DirectRPCProvider.ts
    registry.ts               ← provider priority + failover
    cache.ts                  ← expo-sqlite cache with per-type TTLs
  tokens/
    types.ts
    approvals.ts              ← TokenApproval, revoke helpers
    spamFilter.ts             ← heuristic spam detection
    tokenList.ts              ← bundled default list + user additions
    prices.ts                 ← price feed aggregation
  nfts/
    types.ts
    metadataResolver.ts       ← tokenURI → gateway → cache
    spamFilter.ts
  history/
    types.ts
    PendingTxTracker.ts       ← poll + speed-up/cancel
    decoder.ts                ← receipt → WalletTransaction.decoded
  ens/
    types.ts
    resolver.ts               ← forward + reverse + avatar + CCIP-read
    unstoppable.ts            ← .crypto/.wallet/.nft domains
  contacts/
    types.ts
    store.ts                  ← expo-sqlite CRUD
  walletconnect/
    WalletConnectTransport.ts ← WC v2 → DappBridge adapter
    sessionStore.ts           ← persist sessions across restarts
    pushRelay.ts              ← FCM relay for background requests
  deeplinks/
    eip681.ts                 ← URI parser
    router.ts                 ← scheme → screen mapping
  rpc/
    types.ts
    MultiProvider.ts          ← failover + health monitoring
    rateLimiter.ts
    multicall.ts              ← Multicall3 batching
  notifications/
    channels.ts               ← channel definitions + defaults
    handlers.ts               ← event → notification mapping
  security/
    appLock.ts                ← biometric + PIN state machine
    addressPoisoning.ts       ← detection heuristics
    screenshotGuard.ts        ← FLAG_SECURE / notification
  swap/
    aggregator.ts             ← route via takumipay-api
    mevProtection.ts          ← Flashbots Protect toggle
  staking/
    ethStaking.ts             ← beacon chain positions
    lstDetector.ts            ← liquid staking token recognition
    vaultDetector.ts          ← ERC-4626 position display
  l2/
    withdrawalTracker.ts      ← OP/Arb withdrawal countdown
    gasPriceOracle.ts         ← L1 data fee estimation
    sequencerHealth.ts
hooks/
  queries/
    useTokenBalances.ts
    useTransactionHistory.ts
    useNFTs.ts
    useTokenApprovals.ts
    useENS.ts
    useTokenPrices.ts
    useStakingPositions.ts
components/
  portfolio/
    TokenRow.tsx
    PortfolioChart.tsx
    SpamBadge.tsx
  nft/
    NFTGrid.tsx
    NFTDetail.tsx
    CollectionHeader.tsx
    TBABadge.tsx
  history/
    TransactionRow.tsx
    TransactionDetail.tsx
    PendingTxBanner.tsx
    SpeedUpSheet.tsx
  send/
    RecipientInput.tsx        ← ENS autocomplete + contact suggest + QR scan
    AmountInput.tsx
    SendReviewSheet.tsx
  swap/
    SwapInterface.tsx
    RoutePreview.tsx
    SlippageSettings.tsx
  walletconnect/
    SessionList.tsx
    PairingSheet.tsx
  security/
    BiometricPrompt.tsx
    PinPad.tsx
    SeedExportScreen.tsx
app/
  (tabs)/
    nfts.tsx
    history.tsx
  swap.tsx
  settings/
    approvals.tsx             ← token approval revoke UI
    contacts.tsx
    walletconnect.tsx
    networks.tsx              ← RPC health + custom endpoints
    notifications.tsx
    security/
      index.tsx               ← biometric/PIN toggle
      export-seed.tsx
      export-key.tsx
      cloud-backup.tsx
      wipe.tsx
    dapp-permissions.tsx      ← (from bridge spec, EIP-2255)
```

## 6. Phased rollout

### Phase A — Portfolio + history foundation (2 PRs)

- [ ] Indexer abstraction (`AlchemyProvider` primary, `DirectRPCProvider` fallback) + `expo-sqlite` cache.
- [ ] Token balances with auto-discovery + spam filtering + price feeds.
- [ ] Portfolio screen: token list, total value, 24h change.
- [ ] Transaction history: indexed from Alchemy, decoded types, pending tx tracking.
- [ ] Speed-up / cancel for pending txs (routed through `DappBridge`).
- [ ] RPC multi-provider with failover + health monitoring.
- [ ] Multicall batching for `balanceOf` aggregation.

**Exit criteria:** portfolio shows all token balances with prices; history shows decoded transactions; stuck tx can be sped up.

### Phase B — NFT + ENS + contacts (1 PR)

- [ ] NFT gallery: grid view, collection grouping, metadata resolution, spam filtering.
- [ ] NFT detail: full metadata, traits, floor price, transfer flow.
- [ ] ERC-6551 TBA detection + badge.
- [ ] ENS forward + reverse resolution, avatar, address bar integration.
- [ ] ENS in send flow (recipient field resolves names).
- [ ] ENS in approval sheets (spender label).
- [ ] Address book CRUD + send-flow autocomplete + auto-suggest after 3 sends.
- [ ] Unstoppable Domains resolver (fast-follow, not blocking).

**Exit criteria:** NFTs visible and transferable; ENS resolves everywhere; contacts work in send flow.

### Phase C — Security + app lock (1 PR)

- [ ] Biometric / PIN lock: setup flow, lock triggers, per-action re-auth.
- [ ] Address-poisoning detection in history + send flow.
- [ ] Token spam filtering (expanded: phishing names, honeypot simulation, airdrop quarantine).
- [ ] Seed phrase re-export (screenshot-guarded).
- [ ] Private key export.
- [ ] Cloud backup (encrypted, opt-in).
- [ ] Wipe wallet.
- [ ] Token approval management: list, revoke, batch revoke.
- [ ] Stale approval detection + push notification.

**Exit criteria:** app is locked by default; poisoning detected in test; seed exportable; approvals revocable.

### Phase D — WalletConnect + deep links + QR (1 PR)

- [ ] WalletConnect v2: pair, approve session, route requests through `DappBridge`, session management UI.
- [ ] WC push notifications (background session requests).
- [ ] Deep link handling: `ethereum:` (EIP-681), `wc:`, custom `takumiwallet://` schemes.
- [ ] QR scanner: addresses, ENS, EIP-681, WC URIs.
- [ ] `wallet_scanQRCode` method support (bridge spec P2 row).

**Exit criteria:** desktop Uniswap connects via QR scan; EIP-681 link opens pre-filled send; backgrounded WC request triggers notification.

### Phase E — Swap + L2 + staking display (1 PR)

- [ ] In-app swap: aggregator routing via `takumipay-api`, approval sheet flow.
- [ ] Cross-chain swap (LI.FI/Socket).
- [ ] MEV protection (Flashbots Protect) for mainnet.
- [ ] L2 withdrawal tracking (OP, Arb): countdown timer, finalize notification.
- [ ] L1 data fee display in tx sheet.
- [ ] Sequencer health banner.
- [ ] Staking positions: native ETH, LSTs, ERC-4626 vaults.

**Exit criteria:** swap executes end-to-end; L2 withdrawal shows countdown; staking balance visible.

### Phase F — Push notifications + polish (1 PR)

- [ ] Local notifications: tx confirmed/failed, new approval detected.
- [ ] Remote notifications: token received, NFT received, WC request, security alerts.
- [ ] Notification settings screen with per-channel toggles.
- [ ] Backend: `takumipay-api` notifications module (FCM/APNs gateway).
- [ ] Price alerts (opt-in).

**Exit criteria:** all notification channels fire correctly; user can toggle each independently.

## 7. Test plan

| Feature | Test type | Target |
|---|---|---|
| Token balances | Unit + integration | Alchemy mock → correct `TokenBalance[]`; multicall batching produces same result as individual calls |
| Spam filtering | Unit | Known spam patterns trigger auto-hide; legitimate tokens pass |
| Transaction history | Unit | Raw receipts decode to correct `WalletTransaction.type` |
| Pending tx tracker | Integration | Speed-up produces replacement tx with +20% fee; cancel produces self-send |
| NFT metadata | Unit | IPFS URIs resolve through gateway chain; cache hit on second request |
| ENS | Integration | Forward + reverse resolve on mainnet fork; CCIP-read resolves L2 names |
| Address poisoning | Unit | Similar-prefix addresses flagged; dissimilar addresses pass |
| App lock | Manual | Biometric prompt on foreground; PIN fallback works; per-action re-auth fires for signing |
| WalletConnect | Integration | Pair → approve → sign message → disconnect. Full cycle with WC test dApp |
| Deep links | Integration | `ethereum:` URI pre-fills send; `wc:` URI initiates pairing |
| Swap | Integration | Aggregator returns route; execution produces correct calldata; MEV protection routes through Flashbots |
| L2 withdrawal | Unit | Detect `L2ToL1MessagePasser` → create countdown; finalize notification fires at 0 |
| Approval revoke | Integration | Revoke builds correct `approve(spender, 0)` calldata; batch revoke uses `wallet_sendCalls` |

## 8. Open questions

1. **Indexer provider choice.** Alchemy vs Moralis vs self-hosted. Alchemy has the best EVM coverage + NFT + token APIs, but vendor lock-in risk. Recommend: Alchemy primary with abstraction layer that makes swapping painless.
2. **SimpleHash for NFTs.** Alchemy's NFT API is good but SimpleHash has better cross-chain + spam scoring. Worth the additional vendor dependency? Recommend: start with Alchemy, swap to SimpleHash if NFT spam rates are too high.
3. **Cloud backup encryption scheme.** AES-256-GCM with PBKDF2-derived key from user password is standard. But key stretching params (iterations, memory) affect UX on low-end devices. Need benchmarks.
4. **Swap aggregator self-hosted vs API.** 0x / 1inch APIs have rate limits and may require API keys with commercial terms. LI.FI has a more permissive model. Need cost analysis.
5. **Notification backend scope.** Minimal gateway (this spec) vs full notification service (scheduled digests, alert rules, in-app notification center). Recommend: ship gateway-only for GA; in-app center is Phase F+.
6. **DeFi position aggregation.** Zapper/DeBank APIs are paid and rate-limited. Worth integrating for v1.0 or defer? Recommend: defer. Show LSTs and ERC-4626 from indexer data; full DeFi dashboard is a v1.1 feature.

## 9. Non-goals

- Redesigning the bridge or adapter architecture (settled in bridge spec).
- Shipping Solana/Sui wallet features (separate adapter specs).
- Building a full DeFi dashboard (v1.1).
- Fiat on/off-ramp integration (separate spec, involves payment processor partnerships).
- Social features (follow addresses, shared watchlists).
- Hardware wallet support (flagged in bridge spec §8 as follow-up; requires `ApprovalRenderer` for Ledger/NFC).
- Multi-device sync (requires account server; out of scope for self-custodial v1).

## 10. Dependency on bridge spec

| This spec's feature | Bridge spec dependency | Status |
|---|---|---|
| Approval revoke | `DappBridge.enqueue()` with `origin: "internal://settings"` | Requires bridge Phase 1a |
| Send NFT | `ApprovalIntent<EvmSendTxPayload>` for `safeTransferFrom` | Requires bridge Phase 1a |
| Speed-up/cancel | `ApprovalIntent<EvmSendTxPayload>` with replacement nonce | Requires bridge Phase 1b (nonce strategy) |
| Batch revoke | `ApprovalIntent<EvmBatchCallsPayload>` via EIP-5792 | Requires bridge Phase 1b |
| In-app swap | `ApprovalIntent<EvmSendTxPayload>` with `origin: "internal://swap"` | Requires bridge Phase 1a |
| WalletConnect | `DappBridge.handleRequest()` with `origin.transport: "walletconnect"` | Requires bridge Phase 1a |
| Stale approval alert | `BridgeEventBus` to correlate approvals with user-initiated intents | Requires bridge Phase 1a |
| ENS in approval sheets | Renderer consumes `spenderLabel` from `IntentAnnotation.data` | Requires bridge Phase 1a (inspector pipeline) |

**Conclusion:** this spec's Phase A can start in parallel with bridge Phase 1b, since it only needs the `DappBridge` plumbing from Phase 1a.
