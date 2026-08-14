# Task 29 — Live scam-domain feed + pending-permits screen

**Status:** Partially landed (2026-08-14) — browser block + signing gate
done, live feed and pending-permits screen still open. See "Landed so far"
below.
**Owner:** Mobile (mobile-app)
**Spec reference:** wallet-security-vulnerabilities-spec.md TWV-2026-051, §7, §9

## Why this matters

Industrial-scale drainers (Inferno, Pink, Angel) harvest Permit /
Permit2 signatures via lookalike airdrop claim sites, batch-execute
later, and users have no feedback loop because off-chain signatures
have no gas cost. Two defences, together: block signatures on flagged
origins using a live scam-domain feed, and surface a pending-permits
screen so users can revoke outstanding allowances before they are
burned.

## Scope

- Integrate a scam-domain feed (ScamSniffer / Blockaid / GoPlus — pick
  one or chain; see spec §9). Cache the feed locally with a short
  TTL; update in the background.
- Extend the dApp-browser origin check and the signer-UI origin
  display: if the origin is flagged, hard-block any
  signature-producing method (Permit, Permit2, `eth_sign`-class
  requests) and show a full-screen "This site is on a scam-domain
  feed" block with a "report false positive" link.
- Build `app/settings/pending-permits.tsx` (or similar — see spec §9)
  listing all active Permit2 allowances for the active wallet with a
  one-tap revoke (`invalidateNonces`) button. Refresh on app open.
- All Permit / Permit2 prompts run through the existing decoders
  (task 08) AND display the spender + amount explicitly; add a
  3-second cool-down timer before the Sign button enables.

## Rules (non-negotiable)

- Scam-domain feed is advisory only when the app is offline / feed is
  stale — fall back to the existing origin-reputation logic, do not
  soft-fail open for known-flagged cached entries.
- Pending-permits revoke MUST go through the signer-UI flow — no
  silent revoke.
- Feed lookups must not leak the user's address to the feed
  provider (hash the domain only; do not include the wallet address
  in the request).

## Landed so far (2026-08-14)

`services/security/scamDomainFeed.ts` had shipped as a lookup gate with
**zero call sites** — the predicate and its tests existed, nothing asked
it anything, so a flagged domain loaded, connected and reached a signing
sheet exactly like any other site. It is now wired at three points:

- **Navigation.** `app/dapps-browser.tsx` checks on both entry paths:
  `navigateToUrl` (address bar, hub, suggestions, deep links) and the
  WebView's `onShouldStartLoadWithRequest` (redirects and in-page links,
  which is how drainers are actually reached). A blocked URL parks the
  WebView on `about:blank`, so the flagged page is never fetched and no
  previous dApp keeps a live provider session behind the warning.
- **Interstitial.** `components/dapps-browser/BrowserBlockedSite.tsx`,
  red, hostname spelled out, "Back to safety" filled, "Continue anyway"
  a ghost link behind a second confirmation. The bypass is a ref, scoped
  to the browser session, never persisted.
- **Signing.** `DappBridge.dispatch` blocks
  `SIGNATURE_PRODUCING_METHODS` on a flagged origin, and
  `DappBridge.enqueue` blocks *every* approval intent from one, which is
  the namespace-agnostic twin (the method list is EVM-only, so on its own
  it would leave Solana / Sui / Stellar signing open). Continuing past
  the interstitial does **not** unlock signing: browsing a drainer costs
  nothing, signing its payload costs the wallet.

Also fixed while here: `isFlaggedHost` parsed with
`try { new URL(x) } catch`, which on device is a regex shim that never
throws and yields `""` for a hostname it cannot match — the blocklist
would have quietly looked up the empty string, and the Node test suite
would have kept passing because Node has a real `URL`. It now uses the
repo's own `parseUrl`, and accepts bare hosts.

Still open: the background feed fetch (needs a vendor key), the
pending-permits screen, the 3-second cool-down, and the "report false
positive" link.

## Acceptance

- [ ] Background task updates the scam-domain feed cache on a
      configurable interval.
- [x] A flagged origin cannot initiate a Permit / Permit2 signature —
      the block screen is shown. (Blocked at navigation, and again at
      `dispatch` / `enqueue` for anything that gets past it.)
- [ ] Pending-permits screen lists active Permit2 allowances and
      revoke flows complete an on-chain `invalidateNonces`.
- [ ] 3-second cool-down is enforced on all Permit / Permit2 prompts.
- [x] No outgoing network request includes the user's wallet address
      in scam-feed lookups. (Still vacuously true: the lookup is local,
      nothing is fetched yet.)
- [ ] Regression: benign origins and flows unchanged. (Not yet verified
      on device.)
- [x] `pnpm check:syntax` passes.

## Out of scope

- ERC-20 `approve` pending-allowances screen (separate task — see
  task 15).
- Feed provider A/B selection + attribution UI.
- Paid-tier rules for Blockaid / GoPlus APIs.
