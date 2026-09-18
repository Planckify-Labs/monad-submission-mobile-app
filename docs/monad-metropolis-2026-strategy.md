# Metropolis Monad Hackathon 2026 — TakumiPay Strategy

> Working doc. Source of truth for what we submit and why. Hackathon facts pulled from the
> Metropolis platform screens (track + bounty pages) supplied 2026-09-14. External facts cited
> inline; full source list in the companion [engineering spec](./monad-metropolis-2026-spec.md).

## TL;DR — DECIDED

- **Primary track:** **Consumer Products & Payments** ($30k, split evenly 3 ways — $10k each).
- **Sponsor bounty #1:** **Best Cross-Border Payments App on Monad (Agora)** — $10,000.
- **Sponsor bounty #2:** **Best Builds Powered by KIMI** — $3,000 in credits (10 teams).
- **Sponsor bounty #3 (added 2026-09-14):** **Best Mera-Powered UX on Monad** (Monad Foundation) —
  $2,500. All-tracks bounty; asks for exactly what we're already building — *"an app on Monad
  where Mera is the entire account layer — no seed phrase, no extension."* Zero incremental
  engineering cost, contingent on one framing discipline: Mera must actually be **the** account
  layer for this flow, not an optional alternative sitting next to the seed-phrase wallet (see
  §"What NOT to do" and spec §3.5 — this was already the plan, just needs to stay true in the demo).
- **One build, four judged surfaces.** We ship **one feature** — a passkey-onboarded cross-border
  AUSD remittance flow inside the existing TakumiPay wallet, operable either by hand or by asking
  the (Kimi-powered) Takumi Agent in plain language — and it satisfies all four. Send path
  (decided 2026-09-16): a plain on-chain send with **gas paid in MON, the default**, demo
  wallet(s) manually pre-funded with a little MON (no automated top-up feature needed — see "MON
  top-up" decision below). Gasless send via MetaMask's EIP-7702 smart account + the 1Shot
  relayer is a **nice-to-have that's already wired app-wide** (`resolveGasPayment` +
  `oneShotRelayerProvider`, opt-in on the Gas Settings screen) and confirmed live on Monad
  mainnet (spec §4.2). Zero new code for it; it's a settings toggle, not a headline.
  This mirrors how we scoped Sui Overflow 2026 (`docs/sui-overflow-2026-strategy.md`): one hard
  problem solved once, reused across every judged surface, rather than separate builds per bounty.
- **Also worth a free eligibility check (parked until submission time):** **"Best Community
  Team Project"** (Monad Foundation, $5,000, all-tracks) — pure eligibility, no engineering, if
  the team qualifies as a Metropolis community supporter. Not counted as a "judged surface" above
  since it rewards team status, not the build.
- **Monad itself is not new work.** Chain 143 has been a live, backend-seeded EVM chain in this
  app for a while already — it's in `api/src/scripts/prisma/seed.ts` (`isActive: true`,
  `isTestnet: false`, native `MON` token row) and already in the 1Shot gas-abstraction default
  allowlist (`services/gasAbstraction/supportedChains.ts`). The net-new surface is **AUSD + Mera
  passkey onboarding + the demo flow that glues them together.**

---

## Hard constraints

1. **Timeline.** Submissions open **2026-09-22**; deadline **2026-10-14, 11:59 GMT+8**. Today is
   2026-09-14 — 8 days until the window opens, ~22 days of actual submission window, ~30 days
   total runway from today.
2. **Repo access.** Public GitHub repo must be reachable by `metropolis@hackathon.monad.xyz`.
   **Action item:** grant access before submission (this repo, or a scrubbed mirror — see
   `docs/arc-hackathon-submission` precedent in memory for the "public mirror of a private repo"
   pattern if a full mirror is preferred over granting direct access).
3. **Deployment.** Live product link on **Monad Mainnet or Testnet**. We're targeting **mainnet**
   (143) since it's already the seeded chain and AUSD's mainnet contract address is published —
   no reason to demo on testnet unless AUSD testnet liquidity/faucet access turns out easier
   during development.
4. **Deliverables common to all four surfaces:** public repo, 3-min technical demo video (must
   show the *live working product*, not slides/code walkthrough), 2-min pitch video, live product
   link with test credentials for judges, project logo/graphic.
5. **Agora bounty says "staging environment" — it doesn't exist.** The bounty description reads:
   *"Teams should build against Agora's public API documentation and staging environment (internal
   codebase access is not provided)."* Research against `docs.agora.finance` found **no staging or
   sandbox base URL anywhere in the docs** — only `https://api.agora.finance` (production). This
   turns out not to block us (§ below — we don't need Agora's API at all for the P2P send), but
   it's worth flagging to organizers if we want written confirmation, and it means **don't burn
   time hunting for a staging URL that isn't published.**
6. **Kimi bounty needs a published article, separate from code.** Not a demo requirement — a
   written deliverable. Plan time for it explicitly (§ below).
7. **Kimi hackathon credit redemption is unconfirmed.** No signup link, promo code, or redemption
   flow was found on `platform.kimi.ai`/`platform.kimi.com` or via search. **Action item:** ask in
   the Monad/Metropolis hackathon Discord how the "$3,000 in credits / 10 teams" is actually
   claimed — don't assume self-serve.

---

## Judging criteria → what we're building toward

| Track / bounty | Criterion | Weight | How our build answers it |
|---|---|---|---|
| Consumer Products & Payments | Founder & Market Readiness | 25% | **Named segment, not "everyone needs payments":** Indonesian overseas workers sending money home. TakumiPay already has Indonesian QRIS/UMKM distribution and users — a from-scratch hackathon team can't match that market-readiness story. |
| | Technical Execution | 20% | Real on-chain AUSD settlement on Monad mainnet, not simulated — reuses the existing chain-agnostic send pipeline, address-book, and agent tool-calling infra. The already-wired USDC-gas option (EIP-7702 delegation via 1Shot, verified live on Monad) is a footnote in the technical story, not the centrepiece. |
| | Design & Craft | 20% | Passkey onboarding = **zero seed phrase, zero "connect wallet" moment** — the bar this track explicitly sets ("judge harshly on any point of friction that reveals 'this is crypto'"). |
| | Traction & Path Forward | 20% | We're not starting from zero users — frame the pitch around rolling this out to an existing user base. Concrete distribution answer to "how do the next 100 users find this": the same 44M+ QRIS-merchant network TakumiPay's existing users already transact through — proven live on testnet (spec §6.6), not hypothetical. |
| | Originality & Track Insight | 15% | The insight: remittance is the one consumer case where "onchain rails as design advantage" isn't abstract — settlement time and fees are the entire pain point Western Union/bank wires have, and Monad's ~600ms finality and sub-cent MON gas directly attack both (spec §4). The "send → spend anywhere" completion (spec §6.6) is the differentiator most remittance pitches don't have: money that's usable same-day, not a balance the recipient has to cash out. |
| Agora bounty | Implementation quality / Real-world usability / Business viability | — | Passkey onboarding (Mera) → AUSD balance → send/receive settled in ~1 block. All three bounty deliverable bullets satisfied by the same flow. |
| KIMI bounty | "Meaningfully driving a core feature, not a bolted-on widget" | — | The **natural-language send path** ("send $50 to my mom in Jakarta") is a core feature, not a chatbot bolted onto a form — the agent resolves recipient + token + chain and calls the existing `send_token` capability tool. Already how Takumi Agent works for every other chain; Monad/AUSD just becomes one more thing it can do. |
| Mera bounty | "Mera is the entire account layer — no seed phrase, no extension" | — | The flow's onboarding IS Mera, full stop — no fallback to the seed-phrase wallet inside this flow, no "connect a different wallet" escape hatch. The demo should never show a seed phrase or an existing-wallet-import option at any point in this specific journey. |

---

## The thesis (why this wins Consumer Products & Payments)

**Cross-border remittance is the case where "onchain rails as a design advantage" stops being a
slogan.** A migrant worker sending money home today deals with multi-day settlement, opaque fees,
and a recipient who has to visit a physical location. None of that is a crypto-UX problem — it's a
rails problem. Monad's sub-second finality and AUSD's dollar-stability solve the rails; **the
UX problem is the seed phrase and the seed phrase is what Mera removes.** Put together: a user signs
up with Face ID, sends money with a sentence or a tap, and the recipient has it before the sender's
phone screen locks.

**And the money doesn't just arrive — it's immediately spendable.** This is the part most crypto
remittance pitches skip: the recipient is left holding a token they still have to figure out how to
cash out. TakumiPay already has a live, token-agnostic, chain-agnostic merchant-settlement rail
(`services/nanopay/pathOnchainSettlement.ts` + the backend's `takumipay` settlement provider) that
lets **any** registered ERC-20 pay at **any** QRIS-accepting merchant in Indonesia — 44M+ of them,
from street vendors to shopping malls — with the backend converting to IDR at settlement. It's
already proven end-to-end on testnet across multiple chains. AUSD plugging in is just a token
registration, not new settlement logic. **This isn't limited to remittance recipients either** —
any AUSD holder on Monad can use TakumiPay as a spending rail in Indonesia, remittance is just the
on-ramp story for this specific submission. So the full pitch: **send from abroad with a passkey
and a sentence, and the recipient can spend it at the mall the same day** — not just receive a
balance they have to work out how to use.

> **One-liner:** *"No seed phrase, no gas, no waiting, no cash-out — just send, and spend."*

### The persona

> *"I work abroad and send money home every month. Western Union takes a cut and 1–3 days, and even
> after it arrives my family has to go cash it out somewhere. I don't want to learn what a seed
> phrase is — I just want to send the money and have it usable the same day, whether that's paying
> a street vendor or shopping at the mall."*

This is not a hypothetical for TakumiPay — it's adjacent to the Indonesian QRIS/UMKM user base the
product already serves (see `project_qris_any_pan_target_model` in memory). We are not inventing a
new market; we're extending an existing one into cross-border.

---

## What NOT to do

- **Don't integrate Agora's institutional API for the P2P send.** Research confirms
  `api.agora.finance` is an org-level treasury API (register your bank accounts + wallets, mint/
  redeem fiat↔AUSD, read settled history) — **there is no "send AUSD to person X" endpoint.**
  Trying to force our P2P flow through it would be building against a product that doesn't exist.
  What we actually need from Agora is just **the AUSD token itself** (a standard ERC-20, verified
  on-chain: 6 decimals, symbol/name `"AUSD"` — spec §2) plus their published contract addresses —
  both public, on-chain, and require zero API access or credentials. This *reduces* our integration
  risk relative to what the bounty copy implies. (AUSD does document ERC-3009 support, but that
  turned out not to matter for our plan — see the next bullet.)
- **Don't replace the existing seed-phrase wallet with Mera app-wide — but don't show a
  seed-phrase fallback *inside this specific flow* either.** Two different levels: at the
  **codebase level**, Mera is additive — it derives a standalone, EVM-only EOA from a passkey, has
  no relationship to the existing mnemonic-based derivation in `hooks/useWallet.helpers.ts`, and
  docks in the same "space docking" pattern as every other optional capability, without touching
  the primary wallet. At the **UX level, within this cross-border journey specifically**, Mera has
  to be the *only* onboarding path shown — no "import an existing wallet" or "use your seed
  phrase" escape hatch visible in that flow — or the Mera bounty's "entire account layer, no seed
  phrase" bar isn't genuinely met, it's just decoration next to the real wallet.
- **Don't make gasless the story.** Paying gas in MON is fine for this hackathon; ~600ms
  finality is already "instant" for the demo. The gasless path is real and verified live on
  Monad mainnet (spec §4.2) and, as of 2026-09-16, confirmed to be **already wired end to end**
  in the app (`resolveGasPayment` → `oneShotRelayerProvider`, called from both the send screen
  and the agent executor, default native, opt-in USDC on the Gas Settings screen). So there is
  nothing to build for it and nothing to timebox; mention it as a settings option if it fits the
  narration, don't spend demo minutes on it. Mainnet-only (1Shot doesn't serve Monad testnet).
- **Don't spread across multiple "suggested starting point" ideas.** The track explicitly rewards
  a *specific* segment and a *concrete* distribution story over breadth. One flow, done well, with
  a real answer to "how would the next 100 users find this," beats three shallow demos.

---

## Existing plumbing we reuse

| Need | Existing asset | Notes |
|---|---|---|
| Monad as a supported EVM chain | `api/src/scripts/prisma/seed.ts` blockchain row (chainId 143), consumed via the `/blockchains` feed | Already done — confirmed live, not hackathon work |
| Chain-agnostic send UI | `app/send.tsx` — address-book recipient picker, `kit.validateAddress`, existing send pipeline | Monad + AUSD is "just another token on an EVM chain" to this screen once seeded |
| Optional USDC-gas (gasless) send, end to end | `services/gasAbstraction/resolveGasPayment.ts` → `oneShot/oneShotRelayerProvider.ts` (on top of `walletKit/evm/{delegations,relayer}.ts`), toggled in `app/gas-settings.tsx` | Already wired into `app/send.tsx` and the agent executor; default native. Monad 143 in the allowlist, USDC accepted by 1Shot on Monad, MetaMask 7702 contracts confirmed deployed (spec §4.2). Nothing to build. |
| Recipient resolution | `services/agent-executors/wallet/addressBook.ts`, `hooks/useAddressBook` | Reuse as-is; no phone/email resolution needed for the hackathon scope |
| Agent-driven send, chain-agnostic | `send_native` / `send_token` capability tools (`agent-api/src/agents/wallet/tools/capabilities.ts`) | Once AUSD is a DB token row, "send AUSD" works through the agent with **zero new agent-api code** |
| The AI brain itself | Kimi K2.6 via `agent-api/src/agents/models.ts` (`moonshotProvider`, `api.moonshot.ai/v1`) | Already live — the Kimi bounty is mostly a documentation/demo-framing exercise, not new integration work |

---

## Net-new work

1. Register AUSD as a Monad token row (backend seed) — contract addresses from Agora docs,
   **decimals must be verified on-chain before seeding** (not published in the docs we found).
2. Mera passkey onboarding module — new, additive, EVM-only key-derivation path. The
   `.well-known` domain-association files already exist and are deployed
   (`landing-page/public/.well-known/`) — Android's `assetlinks.json` already has the passkey
   relation; iOS's `apple-app-site-association` needs one small `webcredentials` block added.
3. Wire the plain on-chain AUSD send end to end (Tier 1, guaranteed baseline). For the demo
   itself, fund the demo wallet(s) with a small amount of MON **manually**, same one-time ops step
   as acquiring AUSD (§6.5) — no automated top-up feature needed for the submission. **Automated
   MON top-up for newly-onboarded wallets is demoted to nice-to-have (decided 2026-09-14)** —
   the existing USDC-gas toggle already covers "user would rather not hold MON" for anyone who
   wants it. Build it only after everything else is clear, if time remains.
3b. ~~Tier 2 gasless send~~ — **no work item (decided 2026-09-16).** Already wired app-wide via
    `resolveGasPayment` + `oneShotRelayerProvider` + the Gas Settings screen; default is native
    MON gas, USDC-gas is opt-in. The only touchpoint is that the Mera-derived signer must plug
    into `EvmWalletKit` normally (item 2), which it has to anyway. If the recording shows the
    toggle, fund the demo wallet with a few dollars of USDC on Monad (ops, one-time).
4. **QRIS-spend completion (decided 2026-09-14, Monad TESTNET):** seed Monad testnet (10143) as a
   `Blockchain` row + MON testnet token, **deploy and seed our own open-mint 6-decimal AUSD
   stand-in** (Agora's testnet AUSD has a permissioned mint and no faucet — verified on-chain
   2026-09-16, spec §6.6 step 2), redeploy the existing
   `takumi_pay` contract to Monad testnet (reuse the `contract/evm` deploy scripts already used for
   Base/Arbitrum/Ethereum Sepolia), register the new `SmartContract` row. **Zero app-code
   changes** — `pathSelector.ts`/`pathOnchainSettlement.ts` already dispatch generically and the
   mainnet security gate (`FEATURE_EVM_ONCHAIN_SETTLEMENT_MAINNET`) only blocks non-testnet chains,
   so this clears it naturally (spec §6.6). Deliberately **not** pursuing mainnet activation for
   this piece — the backend quote-signer key is a known-public key committed in `.env.example`,
   flipping the (global, all-EVM-mainnet) flag without rotating it first is a real production
   security risk, not a demo toggle.
4. Demo/UI glue: an entry point into Mera onboarding, and confirming the existing send screen +
   agent tool both work cleanly with AUSD/Monad selected.
5. The Kimi bounty's published article.

Full technical breakdown: [`monad-metropolis-2026-spec.md`](./monad-metropolis-2026-spec.md).

---

## Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Mera is pre-1.0 (`@category-labs/mera` v0.2.0, "preview," API can change) | Medium | Pin the exact version; treat as a demo-time dependency, not a long-term production commitment yet |
| Mera's native-PRF Android coverage is thinly documented (one unqualified sentence, no per-OEM breakdown) vs. the well-evidenced browser table | **High** | Test on real Android hardware early, not late — per this team's own standing rule to get on-device evidence before trusting a claim (`feedback_get_crash_log_before_naming_root_cause`, `feedback_rn_device_debugging_traps`) |
| New deps (`@category-labs/mera`, `react-native-passkey`, `@noble/*`/`@scure/*`) could ship a CJS export named after an `Object.prototype` member and crash under the frozen-prototype setup (`pollyfills.ts`) | Medium | Run `pnpm check:protofreeze` immediately after adding the deps; watch the `__DEV__` boot canary; this has bitten this codebase three times before (bn.js, posthog-react-native, ox) |
| Monad bills gas on `gas_limit`, not `gas_used` — an `estimateGas`-fallback path that pads the limit on revert will overcharge the user | Low–Medium | Use explicit fixed gas limits for the known-shape AUSD transfer call rather than trusting a padded simulation fallback |
| Newly-onboarded wallet has zero MON (or zero USDC if the user flipped gas to USDC) and can't pay for its first AUSD send | Low | For the demo itself: fund the demo wallet(s) manually, one-time, ops step — not a built feature. An automated top-up mechanism is nice-to-have, post-MVP (decided 2026-09-14). |
| USDC-gas option is mainnet-only — 1Shot doesn't serve Monad testnet (confirmed: `relayer_getCapabilities` for chain `"10143"` returns empty) | Low | Irrelevant to the default MON-gas path; `resolveGasPayment` falls back to native automatically when the provider declines |
| ~~Tier 2 requires a genuinely new (non-x402) bundle-assembly function~~ — withdrawn 2026-09-16: `oneShotRelayerProvider.ts` already is that function, already wired into send + agent | None | No work; gasless is an existing settings toggle, default off (native gas) |
| Agora's testnet AUSD can't be obtained (permissioned mint, no faucet — verified 2026-09-16) | Low | Own open-mint 6-decimal stand-in on Monad testnet for the QRIS leg (spec §6.6); the real AUSD contract is what the mainnet remittance leg uses. Disclose the split in the pitch. |
| QRIS-spend demo runs on testnet while remittance runs on mainnet — a judge could read the split as inconsistent if it's not explained | Low | State it plainly in the demo/pitch narration: "remittance settlement is live on mainnet; the QRIS-merchant-spend rail is proven end-to-end on testnet, with mainnet activation gated behind a known, already-scoped security step (signer-key rotation) we're deliberately not rushing for a demo." Confidence, not apology. |
| Agora's documented "staging environment" doesn't exist | Low | We don't call Agora's API for the P2P leg at all — this only matters if we later want fiat on/off-ramp, which is out of scope |
| Kimi hackathon credit redemption process unknown | Low | Ask in Discord; doesn't block building since Kimi access is already live via existing prod keys |

---

## Timeline / sequencing (target)

- **Now → Sept 22 (submissions open):** Mera integration spike (device-test passkey creation +
  PRF reproducibility on real iOS + Android hardware), AUSD contract verification, backend token
  seed, **acquire real mainnet AUSD + MON for demo/testing** (swap MON → AUSD on Kuru — spec §6.5;
  do NOT use Agora's own Instant Settlement AMM, it's KYC-gated for every swap).
- **Sept 22 → early Oct:** Wire the AUSD send end to end (MON gas, the existing pipeline),
  onboarding UI, agent demo script, live-deploy to Monad mainnet. In
  parallel, the contract-side ops for the QRIS testnet leg: `MockAUSD` + `takumi_pay` to Monad
  testnet, seed rows.
- **Early Oct → Oct 14:** Polish, record demo + pitch videos, write the Kimi article, submit.
  Leave real buffer before the Oct 14 11:59 GMT+8 deadline — don't plan to finish same-day.

---

## Decisions — all resolved as of 2026-09-16

Nothing below needs a call before building. Items 1–4 are closed; the two things deliberately
**parked until after the build** are listed at the end.

1. ~~Where does the Mera passkey flow live in the app?~~ — **resolved 2026-09-14.** Ships via the
   existing **`.preview`** build/bundle variant (`com.planckify.takumiwallet.preview`), not the
   Play Store production release — a dedicated Mera-only onboarding entry point, no seed-phrase/
   import fallback shown, judged as the "Live Product Link." Keeps pre-1.0 Mera and unverified
   Android PRF coverage out of the real production app while still genuinely satisfying the Mera
   bounty's "entire account layer" framing (spec §3.5). Makes two `.well-known` gaps load-bearing
   now, not optional: `assetlinks.json`'s `.preview` entry needs `get_login_creds` added, and the
   new iOS `webcredentials` block must list the `.preview` bundle ID too (spec §3.3, §3.5).
2. ~~Mainnet vs. testnet for the actual demo recording~~ — **resolved 2026-09-14: mainnet.**
   Reasons: AUSD's mainnet contract, decimals, and MON are all confirmed live; the real AUSD
   can't be obtained on testnet anyway (item 5); and the optional USDC-gas toggle only works on
   mainnet (1Shot doesn't serve Monad testnet, `relayer_getCapabilities("10143")` returns empty,
   live verified). No remaining reason to prefer testnet for the remittance leg.
3. ~~How deep to go on Tier 2 (gasless)~~ — **resolved 2026-09-16: nice-to-have, and it turns
   out there is no depth to go to.** Owner's call: MON-gas transactions are fine for this
   hackathon, gasless isn't what wins it. And on re-reading the code, the whole path is already
   wired app-wide (`resolveGasPayment` → `oneShotRelayerProvider`, send screen + agent executor,
   default native, opt-in USDC on the Gas Settings screen), so the earlier "new bundle-assembly
   function" work item was a mistake. Zero code. Whether the toggle is shown in the recording is
   a narration choice at recording time (spec §4.2).
4. ~~How the token top-ups work~~ — **resolved 2026-09-14: manual for the demo.** Fund demo
   wallet(s) with MON (and a few dollars of USDC only if the recording shows the USDC-gas
   toggle) by hand, one-time, same as AUSD acquisition (§6.5) — no automated top-up feature is
   part of this submission's scope. An automated mechanism (app-funded treasury or faucet-style
   endpoint) is nice-to-have, built only after Mera/AUSD/send-flow are all clear.
5. ~~Testnet AUSD for the QRIS-spend leg~~ — **resolved 2026-09-16: deploy our own stand-in.**
   Not originally listed here; surfaced while closing the list. Agora's testnet AUSD has a
   permissioned mint (verified on-chain) and no faucet, so an open-mint 6-decimal ERC-20 of our own
   is what gets seeded on Monad testnet. Rail is token-agnostic; the real AUSD is exercised on the
   mainnet leg (spec §6.6 step 2).

### Parked until after the build (decided 2026-09-16 — not open, just later)

- **Submission repo access** for `metropolis@hackathon.monad.xyz` — public mirror vs. direct
  access. Handle once the implementation is done. When it comes up, the Arc precedent applies
  (`project_arc_hackathon_submission` in memory): public `Planckify-Labs/*-submission-*` mirrors,
  and `agent-api` must be **cherry-picked onto its scrubbed public head, never force-pushed**,
  because local history still contains an old `.env.production`.
- **Best Community Team Project ($5k) eligibility** — team-status question, zero engineering.
  Check when the submission form is being filled in, alongside the Kimi credit-redemption ask.
