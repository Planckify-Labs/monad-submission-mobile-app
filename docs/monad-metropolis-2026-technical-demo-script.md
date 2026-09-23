# Metropolis Monad Hackathon 2026 — Technical Demo Script

**Target runtime:** 3:00 (hard cap per deliverable requirements)
**Deliverable purpose (verbatim from the Consumer Products & Payments track page):** *"Technical
Demo Video: maximum 3 minutes, via YouTube, Loom, or Vimeo — must show the live working product,
not slides or a code walkthrough."* This is a different job from the pitch video: no founder
story, no "why we're building this" — the only thing this video has to do is **prove the build is
real**, on camera, live.
**Source of truth for every claim below:** `monad-metropolis-2026-spec.md`,
`monad-metropolis-2026-strategy.md`, plus the claims ledger at the end of this file. Persona names
(Sari, female / her husband Dimas, male) are reused lightly from the pitch video for continuity across the two
deliverables — judges may watch both back to back — but this script leads with technical nouns the
pitch video deliberately banned (Monad, AUSD, Mera, EIP-7702, block explorer, contract address).
That's the correct split: pitch video hides the machinery, this one shows it.
**Revision:** 2026-09-21 (v4). Persona updated to match the pitch script's v4 change (a live-in
caregiver in Taiwan sending home to her husband in Jakarta, not a seafarer or a Hong Kong
domestic worker) — see that file's revision note for why.

**Network: the entire demo runs on Monad testnet, decided 2026-09-21.** Not a downgrade — a
funding-practicality call. Real mainnet AUSD would mean moving scarce funds into a
freshly-created passkey wallet for every take, with zero room for a botched retake. Testnet
AUSD (the project's own open-mint stand-in, spec §6.6) removes that risk entirely, and satisfies
Technical Execution exactly as well: the criterion asks whether mechanics "actually execute
onchain... not simulated," which is equally true on testnet. One exception — the gas-option beat
(1:33–1:48) is shown from a mainnet-context wallet screen, no funds needed, because that specific
capability (1Shot/MetaMask smart accounts) is only live on mainnet, not testnet. Everything else
below says "Monad," not "mainnet" or "testnet," per beat — this note is the one place the network
is spelled out in full.

---

## What this video has to prove, and why each beat exists

Four judged surfaces, one build. Every beat below maps to a specific bounty/criterion so nothing
is screen time without a reason:

| Beat | Proves | Judged surface |
|---|---|---|
| 0:08–0:30 Passkey onboarding | Mera is the entire account layer, no seed phrase, no fallback | Mera bounty |
| 0:30–0:55 Manual send + on-chain proof | Real signed transaction on Monad, through the everyday UI (not staged) | Agora bounty, Technical Execution |
| 0:55–1:05 Received-transfer notification | Settlement is real and near-instant on the receiving end too, not just the sender's screen | Technical Execution |
| 1:05–1:33 Agent send (side feature) + write-approval prompt | Agent tool-calling is real and generic, not bolted-on, and every write asks first | KIMI bounty |
| 1:33–1:48 Gas option | MetaMask EIP-7702 smart account + 1Shot relayer genuinely live on Monad | Technical Execution (footnote, not centerpiece) |
| 1:48–2:13 QRIS direct merchant pay | AUSD settles directly at a real QRIS merchant, token-agnostic rail | Agora bounty, Traction & Path Forward |
| 2:13–2:43 Balance top-up → PPOB redemption | Same rail covers daily-life utility (electricity), not just one merchant type | Design & Craft, Traction & Path Forward |
| 2:43–2:52 Coverage recap | All four surfaces are one flow, not four separate builds | Founder & Market Readiness |
| 2:52–3:00 Close | Live product link, chain, contract | Deliverable requirement (live link + credentials) |

---

## Voiceover generation (ElevenLabs Eleven v3)

**Unlike the pitch script, every beat here is ElevenLabs narrator VO — there's no on-camera
segment in this video at all.** No founder-speaking-live beat to carve out; the whole track goes
through TTS, generated and treated the same way start to finish.

Same tag/pacing system as the pitch script — see that file for the full rules. Short version:
bracketed tags (`[excited]`, etc.) placed sparingly, ellipses (…) for pacing, CAPS for occasional
emphasis, no SSML. This video's register is confident and matter-of-fact throughout, not
emotional, so most beats below carry no tag at all — only the two moments where something
genuinely lands (the explorer proof, the closing PPOB line) get one. Use **Creative** or
**Natural** stability, not **Robust**.

---

## Script

**[0:00–0:08] — Cold open**

*Visual: hard cut straight into the app, already recording — no title card, no slide. Home
screen, real balance visible.*

> **VO:** "This is TakumiPay... live on Monad. Passkey wallet, real AUSD, real settlement."

**[0:08–0:30] — Passkey onboarding (Mera)** *(real screen recording, Android, fresh install)*

*Visual: fresh install, login screen shows exactly one button: "Continue with fingerprint."
Fingerprint prompt. Home screen. Cut briefly to Wallet Details → the Passkey badge, held long
enough to actually read this time (unlike the pitch video).*

> **VO:** "Sign-up is one button, one fingerprint... that's it. Mera, from Category Labs, builds
> this wallet straight from the passkey's WebAuthn PRF extension — no mnemonic, ever. No seed
> phrase, no wallet import, nothing else on this screen. Mera really is the account layer here,
> not an option sitting next to one."

**[0:30–0:55] — Manual send, then on-chain proof** *(real screen recording + real block
explorer)* — the primary send proof; ordinary UI, not the agent

*Visual: home screen → tap Send → pick Dimas from the address book → enter 100 AUSD → confirm →
PIN → sent. The send-success screen has a real "View on Explorer" link — tap it, stay on
the same phone, same continuous recording. No cross-device cut, no copy-pasting a hash onto a
desktop tab: the explorer opens directly in the phone's browser, showing the confirmed AUSD
transfer on Monad testnet — block number, gas used, token contract address, all visible on
screen.*

> **VO:** "Sending a hundred AUSD to Dimas — pick him from contacts, enter the amount, confirm
> with a PIN. That's it. Tap into the explorer... [excited] already confirmed on Monad. Block
> time's under a second, so by the time that page loads, it's done."

**[0:55–1:05] — Received-transfer notification** *(real, single continuous phone recording)*

*Visual: home screen. A real push notification banner slides down — "Transfer received" — from
a real transfer sent by a second wallet off-camera during the take. No second phone on screen,
no cutaway; it just arrives while the camera keeps rolling.*

> **VO:** "And on the other end... it just shows up. No refresh, no waiting around."

**[1:05–1:33] — Agent send (side feature), then write-approval prompt** *(real screen
recording)* — the agent is one more way to do this, not the headline

*Visual: Takumi Agent. Tap the mic and say "send 10 dollars to Dimas" — real voice input, not
typed. Confirmation card appears — recipient, 10 AUSD, Monad. Before the confirm tap, the
write-approval prompt itself, held long enough to read: real options (once / this session / a
few hours / until revoked). Confirm, PIN, done. Then, quick and silent, no new
narration: a second voice send, different amount ("send 5 dollars to Dimas") — no approval
prompt this time, because "until revoked" was already granted. On-screen text flash: **"Granted
once. No popup after that."***

> **VO:** "Or, just say it. Kimi figures out the recipient, the amount, the asset, through
> `send_token` — the same tool it always uses. Before it signs, it ASKS FIRST: once, this
> session, a few hours, or until revoked. Grant it once, and the next one just goes through — no
> popup."

**[1:33–1:48] — Gas option** *(real screen recording, quick)*

*Visual: Gas Settings screen. Toggle from native MON gas to the stablecoin-gas option.*

> **VO:** "Gas defaults to native MON. It can also route through a MetaMask EIP-7702 smart
> account and 1Shot, paying in a stablecoin instead — already live on Monad mainnet."

**[1:48–2:13] — QRIS direct merchant pay** *(real footage, real merchant)*

*Visual: a real QRIS-accepting counter. Open TakumiPay, scan the merchant's QRIS code, confirm
with a PIN. Status hero runs Preparing → Confirming → Paid, hold on the "Paid" state long
enough to read the merchant name and amount.*

> **VO:** "Same AUSD, settling straight into a real QRIS merchant — no cash-out, same contract
> as the send shown earlier. Getting this onto mainnet needs one scoped step, rotating a backend
> signer key... NOT rushed for a demo. Everything shown today is proven end to end on testnet —
> same contract, same code, mainnet is the deliberate next step."

**[2:13–2:43] — Balance top-up → PPOB redemption (electricity)** *(real footage/screen
recording)*

*Visual: no meter shot — open straight on real app footage. A brief on-screen text card over the
home screen sets context ("electricity token running low"), then open TakumiPay, deposit a small
amount of AUSD — one PIN confirm, one on-chain transaction. Balance updates. Cut to the
PPOB catalog grid for **under one second** — just long enough to register it's a real catalog, not
a browse — then straight into "Token PLN," enter the meter number, confirm — no second wallet
prompt. Token code appears. Don't linger on the catalog: the breadth claim is carried by the VO
("mobile data, credit, whatever's next"), not by a scroll. This beat has one job — prove one
complete transaction, start to finish, uninterrupted.*

> **VO:** "One more everyday thing, same rail. Depositing AUSD turns it into a balance — one
> signature. After that: electricity, data, credit, instant, no wallet popup per purchase. Same
> trick GoPay, OVO, and DANA already taught this market — nothing new invented, just the crypto
> disappearing inside the one people already trust. To him, it's not a token... it's just his
> balance."

**[2:43–2:52] — Coverage recap**

*Visual: quick, real cuts — not a slide — back through the last two minutes: passkey login,
manual send, the notification landing, the agent's voice send, QRIS scan, PPOB redemption. Fast,
no new narration content, just a visual reminder these were all one continuous flow.*

> **VO:** "So that's the flow: sign up, send it, spend it two ways — a QRIS merchant, a utility
> bill. Works EVERYWHERE this rail reaches."

**[2:52–3:00] — Close**

*Visual: the live product link and a QR code to it, on screen, held for the full duration.*

> **VO:** "That's TakumiPay — LIVE on Monad. Link and test credentials are in the submission."

---

## Production notes

- **Music/atmosphere.** Keep it minimal and steady, not an arc — this video's job is proving
  claims, and almost every second has narration carrying information judges actually need to
  hear, unlike the pitch video's silent visual stretches. One quiet, low bed under the whole
  thing, roughly flat start to finish rather than rising and falling. Two exceptions: drop it
  further, close to silent, under the write-approval prompt read (1:05–1:33) and the testnet
  disclosure (1:48–2:13) — those are the two places the actual words are doing the most work and
  shouldn't compete with a swell. A small, tasteful lift is fine right at the two payoff beats
  already called out below (the explorer confirmation, the QRIS "Paid" state) to underline them —
  nothing dramatic, this isn't the pitch video's music cue.
- **Format: portrait, 9:16, native phone resolution.** Unlike the pitch video, this one is a
  single continuous phone-screen recording start to finish — Mera onboarding, the manual send,
  the explorer tap-through, the notification, the agent send, gas settings, QRIS scan, PPOB
  redemption. Portrait fills that native format edge-to-edge with no bezel mockup or cropping
  needed. This is a deliberate difference from the pitch video's landscape format, not an
  inconsistency — the two videos have genuinely different content shapes (one continuous phone
  recording vs. cinematic b-roll + talking head).
- **Manual send carries the primary Technical Execution proof now; the agent is a side feature,
  not the headline.** Earlier drafts led with the agent-driven send as the main proof of "real
  send." That overstated the agent's role — most real usage goes through the ordinary UI, and the
  agent is one more way to do it, not the only way. The restructure: ordinary send (0:30–0:55)
  carries the block-explorer proof; the agent (1:05–1:33) is shorter, later, and exists
  specifically to carry what's genuinely agent-only — the write-approval prompt and the
  once-granted convenience proof. Removing the agent entirely was considered and rejected: the
  KIMI bounty requires showing the agent live, on camera, not just described in the written
  article.
- **This video is allowed to say what the pitch video can't.** Contract addresses, "EIP-7702,"
  "gas," "on-chain," block explorers — all fair game here. The pitch video's crypto-speak ban
  doesn't apply; this deliverable's entire job is proving the technical claims, which requires
  naming them.
- **The path to mainnet gets disclosed here, explicitly, out loud** — this is the venue the
  pitch script's own production notes designated for network specifics. Say it plainly in the
  QRIS beat (1:48–2:13): everything shown today is proven end to end on testnet, mainnet
  activation is a known, scoped, deliberately unrushed next step (one signer-key rotation). See
  the header note at the top of this file for the full reasoning on why the whole demo is
  testnet, and why that's a funding-practicality call, not a technical shortfall. Confidence, not
  apology — see the wording already drafted above.
- **"Must show the live working product, not slides or a code walkthrough."** Every beat above is
  either a real screen recording or real footage. No architecture diagrams, no IDE, no terminal.
  The electricity beat (2:13–2:43) uses an on-screen text card instead of a meter shot — no
  physical prop needed. The app interaction itself (deposit → balance → redeem) is still a real
  screen recording throughout. The notification beat (0:55–1:05) needs a real second wallet
  sending a real transfer off-camera during the take — don't fake the banner.
- **Runtime discipline.** VO is roughly similar in total length to the previous draft, redistributed
  across more, shorter beats. At a deliberately slow, unhurried pace this is tight against 3:00 —
  do an actual read-through with the edit assembled, not just a script read, before locking
  picture. If it runs long: **first**, tighten the agent beat's second-send insert (2–3 s is
  enough — confirmation card, PIN, done, no need to linger); **second**, cut the coverage
  recap (2:43–2:52) entirely, it's the one beat with no new information; **never** the QRIS or
  PPOB beats, which are the two live-product proofs no other team can show. [1:33–1:48] (gas
  option) is the last resort cut: a footnote per the strategy doc's own framing ("gasless isn't
  the story"), not a required beat.
- **The block explorer shot (0:30–0:55) is the single highest-leverage 15 seconds in this video.**
  It's the difference between "trust me, it settled" and an independently-checkable transaction
  hash on a public explorer. Don't rush the cut to it, and don't cover the contract address with
  a finger or a notification banner.
- **The write-approval prompt (inside 1:05–1:33) is its own proof point — don't rush past it
  either.** It's live evidence the agent can't move funds without asking, and that "asking" has
  real, user-controlled granularity (once / session / timed / until revoked) rather than a single
  blanket yes/no. Hold on the real options long enough for a judge to read them.
- **Recording device stays Android**, same reasoning as the pitch script (iOS AASA gap for
  passkeys is unresolved) — say "fingerprint," not "Face ID," for the sign-up beat specifically
  (that's the real WebAuthn biometric step), unless you end up recording on iPhone, in which case
  swap that one instance. Every other confirmation in this script is PIN, not biometric — see the
  note below.
- **PIN, not biometric, confirms every transaction after sign-up.** `app/send.tsx`'s
  `handleSend` opens a PIN modal (`setIsPinModalVisible`), not a biometric prompt —
  `handlePinConfirm(pin)` is what actually finalizes a send. Only the passkey sign-up step
  (0:08–0:30) is genuinely biometric; every confirm tap after that — the manual send, the agent
  send, QRIS, the PPOB deposit — is a PIN entry. Don't say "fingerprint" for any of those.
- **Dimas's location stays Jakarta; Sari's workplace stays Taiwan** — same persona continuity
  rule as the pitch script. Don't introduce a new corridor here.
- **No new claims beyond what's in the spec.** Every number or technical assertion in this script
  should trace to the claims ledger below or to `monad-metropolis-2026-spec.md`. If something
  needs saying that isn't sourced yet, flag it before recording rather than ad-libbing a number
  on camera.

---

## Claims ledger

| Claim | Where | Status | Source / what to verify |
|---|---|---|---|
| "derives this wallet directly from the device passkey... WebAuthn PRF extension" | 0:08 VO | OK | `@category-labs/mera` architecture, spec §3.1 |
| "no mnemonic generated anywhere, ever" | 0:08 VO | OK for this flow | Passkey wallet row stores a derived private key, never a mnemonic (spec §3.5) |
| Transaction hash shown on block explorer, Monad testnet | 0:30 visual | **Must be captured live on record day** | Real send at record time; don't reuse a screenshot from an earlier test |
| "View on explorer" link on the send-success screen | 0:30 visual | OK, real feature | `app/send-success.tsx` — real `explorerUrl` param, opened via `Linking.openURL`, not staged for this video; opens in the phone's own browser, no desktop cutaway needed |
| AUSD contract shown on the explorer page | 0:30 visual (on the explorer page, not spoken — reading a hex address aloud is meaningless) | Testnet stand-in, verified on-chain | MockAUSD at `0x1aC593085Fa34c651E805085da4b2cabAC676F99` on Monad testnet (10143) — `decimals()`/`symbol()`/`name()` read back as 6 / AUSD / AUSD (spec §6.6 step 2), so the UI shows "AUSD" consistently even though it's a different contract address than the real mainnet-issued token. Real mainnet AUSD is `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` (spec §2.1) — not used in this recording, funding-practicality call (see header note). |
| "under a second" block time | 0:30 VO | OK | Monad finality ~600ms, `docs.monad.xyz/developer-essentials/summary`, spec §4.1 |
| "it just shows up, no refresh" — real push notification on receipt | 0:55 visual | OK, real feature | `services/transferOutbox` / push registration path, commits `f679729`, `7a8cd22`, `58f27ae` (persistent transfer-record outbox, retry-safe push registration). Needs a real second wallet sending a real transfer off-camera during the take — don't fake the banner with a mocked notification. |
| "`send_token`, a real capability tool, not a one-off script" | 1:05 VO | OK | `agent-api/src/agents/wallet/tools/capabilities.ts`; a real, pre-existing agent tool, not something stood up for this submission |
| Voice input to the agent ("just say it") | 1:05 visual | OK, real feature | `hooks/useVoiceTranscription.ts` + `services/transcribeAudio.ts`, already-live transcription path. Real voice, recorded live — don't dub a typed message after the fact. |
| "once, this session, a few hours, or until revoked" | 1:05 VO (approval prompt insert) | OK, exact option labels | `components/agent/approvalSheetLogic.ts` `buildGrantOptions`: "Just this once" (once), "For this session" (session), "For the next [duration]" (15m/1h/4h/24h presets), "Until [date]", "Always (manage in Settings)" — VO simplifies to the four most legible spoken; the on-screen prompt itself shows the real full set, which is what actually needs to read correctly on camera |
| "Granted once. No popup after that." (second-send insert, no prompt) | ~1:25 visual, on-screen text only | OK, real behavior | The "Always" grant is a real permanent override in `PermissionStore`; once set, the dispatcher's authorization check resolves `authorized` and the write executes without re-prompting (spec: `services/agent-permission*`, `WriteApprovalGate.tsx`'s `authorized` branch). Must be recorded as a genuinely separate second take with the grant already set from the first take — not simulated by cutting the prompt out of the same take. |
| "MetaMask EIP-7702 smart account and a public relayer, 1Shot... verified live against Monad mainnet" | 1:33 VO | Verified live 2026-09-14 | `@metamask/smart-accounts-kit`, `services/walletKit/evm/EvmWalletKit.ts` (`upgradeToSmartAccount`, `signEip7702Authorization`); `relayer_getCapabilities` for chain `"143"` returned a real fee-collector and target address, with two accepted fee tokens (spec §4.2). Not AUSD-denominated gas — the fee leg is in one of those accepted tokens, not AUSD. |
| "everything shown today is proven end to end on testnet" | 1:48 VO | OK, must stay accurate on record day | `takumi_pay` 2.1.0 proxy on Monad testnet (10143) at `0x9EEC5aD4FC092fD468A8114007e541238F4Ba5ee`, MockAUSD at `0x1aC593085Fa34c651E805085da4b2cabAC676F99`, deployed + verified on-chain 2026-09-16 (spec §8) — same contract and token now cover the manual send, agent send, and PPOB deposit beats too, not just QRIS |
| "mainnet activation is gated behind... rotating a backend signer key" | 1:48 VO | OK, do not soften | `FEATURE_EVM_ONCHAIN_SETTLEMENT_MAINNET` default OFF; `backendSigner` derives from a key committed in `.env.example`, contract ownership not yet transferred (`constants/configs/featureFlags.ts`). This is a real, currently-true constraint, not a hedge for the pitch — never say or imply it's been fixed. |
| "depositing AUSD converts it into a spendable balance — one signature" | 2:13 VO | OK, uses existing infra | `useDepositState` → `depositPoints()` on the `takumi_pay` "payment"-type contract, same contract as the QRIS leg |
| "everything after that... is instant, no wallet prompt per purchase" | 2:13 VO | OK | `PointRedemption` purchase path (`ItemVariantWithoutInput.tsx`) is off-chain against the credited balance, no further on-chain signature |
| "same top-up-once pattern GoPay, OVO, and DANA already taught this market" | 2:13 VO | Framing/analogy, not a sourced statistic | Don't cite a specific user-count figure for GoPay/OVO/DANA on camera unless independently verified; keep it as a named-pattern comparison, not a stat |
| PLN token purchase via vcGamer | 2:13 visual | OK, real partner integration | `services/ppob/partners/vcgamer.ts`, `PLNCard.tsx`, real voucher parsing |

---

## Open items before recording

- [ ] Confirm a real QRIS merchant is accessible on record day (no meter/prop needed for the
      electricity beat — it opens on an on-screen text card instead).
- [ ] Do a dry-run send + block-explorer lookup beforehand to confirm the explorer UI reads
      cleanly on a recorded phone/screen-share (font size, whether the address needs manual
      copy-paste vs. deep link).
- [ ] Have a second wallet funded and ready off-camera to send the real transfer that triggers
      the notification beat (0:55–1:05) — needs to land during the take, not be pre-sent. Testnet
      MockAUSD is free/unlimited to mint, so fund generously and don't worry about re-takes here.
- [ ] Briefly switch to a mainnet-context wallet for the gas-option beat (1:33–1:48) only — no
      funds needed, just needs to be looking at mainnet since 1Shot doesn't serve testnet. Switch
      back to the testnet wallet immediately after for the QRIS/PPOB beats.
- [ ] Reset agent permissions to defaults (Settings → Agent Permissions → Reset to defaults)
      immediately before recording the agent beat, so the write-approval prompt shows fresh; grant
      "Always" only after that shot is captured, then use it for the second-send insert and any
      re-takes.
- [ ] Time the actual VO read-through against picture before locking edit — production notes
      above already name the cut order if it runs long.
