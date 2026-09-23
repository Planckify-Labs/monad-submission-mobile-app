# Metropolis Monad Hackathon 2026 — Pitch Video Script

**Target runtime:** 2:00 (hard cap per deliverable requirements)
**Deliverable purpose:** introduce the team, the problem, and why we're building this — narrative,
not a technical walkthrough (that's the separate 3-min technical demo video).
**Source of truth for every claim below:** `monad-metropolis-2026-strategy.md`,
`monad-metropolis-2026-spec.md`, plus the claims ledger at the end of this file.
**Revision:** 2026-09-20 (v4). Supersedes the v3 seafarer draft: persona is now a live-in
caregiver in Taiwan sending home to her husband in Jakarta. Reasoning, in order: (1) global
hackathon, no Indonesian judging panel, so the choice is about a specific, credible named segment
and a sharp version of the "instant settlement" claim, not cultural resonance to any one
audience; (2) Taiwan–Jakarta is verified as a real, large corridor — Taiwan is becoming
Indonesia's top migrant-worker destination, and caregiving/domestic work is historically one of
the largest categories within it (BP2MI/IOM data, cited in the claims ledger); (3) husband-wife,
not mother-child, deliberately avoids an "elderly woman who struggles with a phone" stereotype —
that framing would undercut the passkey story (implying the recipient needs help, not that the
product removed the friction) and reads as a cliché rather than a specific, credible person. The
urgency mechanic is scarce *privacy and personal time*, not scarce signal — a live-in caregiver's
one stolen hour has to be enough. The Kimi-article angle note at the bottom is unchanged.

---

## Story spine (decided 2026-09-18, revisit only if the demo can't deliver a beat)

**One transfer, followed all the way to the shop counter, with a clock on screen.**

- The old world is measured in **days**; ours in **seconds**. A stopwatch is the recurring visual.
- The video does **not** end at "received". That is where every other remittance pitch stops. Ours
  keeps rolling until the recipient has paid for something with the QR code that was already on
  the counter. That last-mile beat is the one thing no other team in this hackathon can show, so
  the whole first minute exists to set it up.
- Passkey and "no seed phrase" are shown as an **absence** (one button, one fingerprint, nothing
  else on screen), not explained.
- The agent (Kimi) is one sentence spoken and one card confirmed. Never a chatbot demo.
- Named people, not statistics: **Sari** (sender, live-in caregiver in Taiwan) and her husband
  **Dimas** (Jakarta). Privacy and personal time are scarce for her, not just distance — the one
  hour she gets to herself is what makes "settles in under a second" the actual point, not a
  nice-to-have. Every example stays Indonesia-specific, in this video and in the technical demo.

How the criteria map onto the beats:

| Criterion (weight) | Beat that carries it |
|---|---|
| Founder & Market Readiness (25%) | 1:32 founder on camera (solo) + Play Store + real-merchant b-roll + "Indonesia first, Southeast Asia next" |
| Technical Execution (20%) | 0:52 two phones, sub-second settlement on Monad, timer visible |
| Design & Craft (20%) | 0:22 one-button sign-up, no seed phrase, no "connect wallet" |
| Traction & Path Forward (20%) | 1:05 the QR code already on the counter = distribution we inherit, not recruit; 1:44 "Southeast Asia next" names the path forward beyond this submission |
| Originality & Track Insight (15%) | the video continues past "received" |

---

## Audio sourcing — two different tracks, don't mix them up

This video has **two different audio sources**, and only one of them goes through ElevenLabs.
Get this wrong and half the video gets processed the wrong way.

| Beat | Audio source |
|---|---|
| 0:00–0:16 The old world | **ElevenLabs narrator VO** |
| 0:16–0:22 The turn | **ElevenLabs narrator VO** |
| 0:22–0:35 Sign-up | **ElevenLabs narrator VO** |
| 0:35–0:52 The send | **ElevenLabs narrator VO** |
| 0:52–1:05 Settlement | **ElevenLabs narrator VO** |
| 1:05–1:32 The spend | **ElevenLabs narrator VO** |
| **1:32–1:50 Why me** | **Real, live audio — you, on camera. Not ElevenLabs.** |
| 1:50–2:00 Close | **ElevenLabs narrator VO** |

### Narrator VO — ElevenLabs Eleven v3

Every beat above except the founder beat. Per ElevenLabs' own v3 prompting docs: no SSML, no
break tags. Control delivery with four things instead, applied below:

- **A `*Tone:*` line before each beat's VO** — this is the actual emotional direction: what the
  delivery should feel like and why, not just where to drop a tag. This is the primary lever;
  the video is built as a deliberate arc (weary → resolve → relief → warmth → triumph → quiet
  pride → warm close), and the tags/pacing below exist to serve that arc, not the other way
  around. Read the Tone line before generating or performing each beat.
- **Bracketed audio tags** — `[sighs]`, `[excited]`, etc. — placed immediately before or after
  the phrase they modify. Used only where the beat's Tone genuinely calls for it, since a voice
  mismatched to a tag (e.g. asking a flat, neutral voice to `[cry]`) produces artifacts rather
  than emotion.
- **Ellipses (…)** for pauses and weight — used instead of a comma or period where the pacing
  matters to the line landing right. Used more freely now than tags, since pacing is what
  actually carries most of the emotional arc beat to beat.
- **CAPS** for word-level emphasis, used once or twice per beat at most — overuse flattens it
  back out.

**Settings:** use **Creative** or **Natural** stability, not **Robust** — Robust is stable but
largely ignores tags. Pick a voice with some emotional range in its training data; the voice
choice matters more than the tags do, per ElevenLabs' own guidance.

### Founder beat (1:32–1:50) — real audio, not TTS

This is you, on camera, speaking live — captured with the video, not generated. None of the
ElevenLabs tag/pacing syntax above applies to this line; it's an acting/delivery note for
yourself, not a TTS prompt. The ellipsis in that line ("Indonesia first... Southeast Asia's
next.") is just a natural breath pause, same as you'd use in any script — deliver it however
feels right, don't try to "perform" a bracket tag that isn't there. See the script section below
for the line itself; it's marked `(founder, male, to camera)` to keep this distinction visible
inline too.

---

## Script

**[0:00–0:16] — The old world** *(AI-generated, see Veo 3 prompts A/B/C below; nothing in this
segment shows our app)*

*Visual: Prompt A. Late afternoon in a quiet residential Taiwanese neighborhood. Sari slips out
of the apartment where she works and hurries to a roadside money-changer kiosk half a block
away, glancing back toward the building; the agent peels several notes off the top as the fee
and hands back a receipt. Cut to Prompt B: a phone lying dark on a table in a Jakarta home while
window light cycles day → night → day, three times. Cut to Prompt C: Dimas on a plastic chair in
a crowded cash-out queue, paper ticket in hand.*

*On-screen (added in the edit, never generated): a small stopwatch, top-right, ticking through
**DAY 1 · DAY 2 · DAY 3**. On the fee shot, a plain callout: **"the cut"**.*

*Tone: tired, resigned — a monthly routine that's worn her down. Not dramatic grief, just
weariness. Slow the pace here; this is the heaviest beat in the video.*

> **VO:** "Sari looks after someone else's family, day and night... in Taiwan. The one hour she
> gets to herself barely covers sending money home — fast costs a cut, cheap costs three days
> she doesn't have. [sighs] Either way... Dimas ends up standing in line, waiting to cash it out."

**[0:16–0:22] — The turn**

*Visual: hard cut to black, then you on camera for one line (or the TakumiPay mark if you'd
rather save your face for the 1:32 beat). The stopwatch resets to 0:00.0.*

*Tone: quiet resolve, almost protective — a promise, not a pitch. The weariness from the last
beat is still present, but there's conviction underneath it now.*

> **VO:** "I built TakumiPay so the money lands... BEFORE Sari even has to hurry back inside.
> And so it's spendable the second it lands."

**[0:22–0:35] — Sign-up** *(real screen recording, Android)*

*Visual: Sari's phone, fresh install. Login screen shows exactly one button: "Continue with
fingerprint". Fingerprint prompt. Home screen. Nothing else appears: no seed phrase, no import,
no "connect wallet". The stopwatch runs and freezes on the home screen (expect ~0:15–0:20).*

*On-screen text (bottom third, 2 sec hold):* **"No seed phrase. Ever."**

*Tone: relief, lightness — the weight from the last two beats visibly lifts here. Faster,
brighter pace; this is the first beat that gets to feel easy.*

> **VO:** "It starts with sign-up — one button, one fingerprint. No seed phrase, no twelve words
> to hide in a drawer, nothing on the screen that even says 'crypto.' When every minute's
> stolen... that matters."

**[0:35–0:52] — The send** *(real screen recording)*

*Visual: Takumi Agent. Sari taps the mic and says "send 100 dollars to Dimas" — real voice
input, not typed. The agent answers with one card: recipient (from her contacts), 100 AUSD,
Monad. She taps confirm, enters her PIN, done. No scrolling, no second message from the
agent.*

*Tone: warm, easy, a little charmed by how simple it is — this should feel almost effortless to
say, matching how effortless the action is.*

> **VO:** "She just says what she wants. Takumi Agent, running on Kimi, finds Dimas in her
> contacts, fills everything in, shows her exactly what's about to happen. One touch, and she's
> done."

**[0:52–1:05] — Settlement** *(real, two phones side by side, single continuous shot)*

*Visual: split screen. Left: Sari's phone shows "Sent". Right: Dimas's phone, lock screen,
lights up with the "Transfer received" notification. The stopwatch starts on the confirm tap and
freezes on the notification. Overlay under the frozen number: **"3 days → under a second"**.*

*Tone: quiet triumph — a held breath released. The biggest beat so far, but it lands quick;
don't oversell it, let the speed of the moment do the work.*

> **VO:** "It settles on Monad in under a second — [excited] Dimas's phone lights up before
> Sari's screen even locks... before she's even back inside. Real dollars, AUSD, on Monad."

**[1:05–1:32] — The spend** *(real footage at a real place; the most important 27 seconds in the
video, do not rush it)*

*Visual: Dimas at a warung, mini-mart or mall counter. The QRIS sticker is already on the
counter; we did not put it there. He opens TakumiPay, scans, enters his PIN. The status hero runs
Preparing → Confirming → Paid to {merchant}. The merchant's phone or terminal chimes. He picks up
the bag and walks out. No detour to a counter anywhere in the sequence. Stopwatch runs from scan
to Paid (expect single-digit seconds).*

*On-screen text over the QRIS sticker (2 sec hold):* **"QRIS: one QR standard, 40M+ merchants
across Indonesia"** *(exact figure per the claims ledger, verify before lock)*

*Tone: the emotional peak of the video — building satisfaction that lands on quiet pride by the
last line. Start confident, almost defiant on "TakumiPay DOESN'T," then ease into warmth for the
close; this is the payoff for everything the old-world beat set up.*

> **VO:** "And here's where every other remittance app stops. TakumiPay DOESN'T. There's no
> cash-out — Dimas just walks to the shop, scans the same QRIS code sitting on that counter, the
> same one over forty million shops across Indonesia use... and pays. The merchant gets rupiah.
> Sari's hundred dollars is groceries by that afternoon... while she's still at work."

**[1:32–1:50] — Why me** *(founder on camera, solo, then b-roll)*

*Visual: you on camera, one shot, natural light, no slides. Cut to b-roll: the Play Store
listing, existing users paying at real merchants, a map graphic of Indonesia that pulses to
show merchant coverage, then pulls back to frame the wider Southeast Asia region (map graphic
only, not a promise of live coverage — see claims ledger). Back to you for the last sentence.*

*Tone (real delivery, not TTS): sincere and grounded, not a pitch-deck voice. You've earned this
line — the whole video built to it. Let "Indonesia first" land with quiet confidence, not a
sales push; the pause before "Southeast Asia's next" is a real breath, not a performed beat.*

> **VO (founder, male, to camera):** "I'm Satria Ali, and I build TakumiPay out of Lombok. This isn't a
> prototype — it's live on the Play Store, real people paying real merchants. This month I added
> passkeys and AUSD, and pointed those same rails across the border. Indonesia first... Southeast
> Asia's next."

**[1:50–2:00] — Close**

*Visual: the three frozen stopwatch numbers from the video stack up on a clean background
(sign-up · send · spend), then the TakumiPay mark.*

*On-screen text:* **"No seed phrase. No waiting. No cash-out."**

*Tone: warm, confident, simple — a smile, not a shout. This is the whole thesis in six words; let
it sit, don't rush the landing.*

> **VO:** "TakumiPay. Send it from anywhere... spend it everywhere."

---

## Veo 3 prompts for the "old world" segment (0:00–0:16)

Generate these with **Veo 3.1** (Google Flow at `labs.google/flow`, or the Gemini API model
`veo-3.1-generate-preview`). Each prompt is one **8-second, 16:9, 1080p** clip with native
audio; the edit trims A/B/C to roughly 7 s / 5 s (speed-ramped) / 4 s.

**Rules for this segment**

- **These are the only AI-generated shots in the video.** Never generate anything that shows
  the TakumiPay app, a phone UI, or a "receipt". Judges are grading a live product; every
  product frame must be a real screen recording or real footage.
- **No text inside Veo.** Veo garbles and hallucinates lettering. Every prompt ends with the
  no-text clause, and the DAY 1/2/3 stopwatch and "the cut" callout are added in the edit.
- **No real brands.** No Western Union / bank logos, generic counters only. Saves a trademark
  headache and keeps the "fast costs a cut, cheap takes days" claim about the category, not one
  company.
- **Character consistency.** Paste the character sheet verbatim into every prompt. Better: first
  generate one still of each character (Nano Banana or Imagen), then feed those stills as
  reference images ("Ingredients") in Flow so A, B and C share the same faces and clothes.
- **Takes.** Generate 3–4 takes per prompt and pick. Hands counting money and queues are the two
  things Veo most often gets wrong; check fingers and face continuity before you commit.
- **Audio.** Keep Veo's native ambience and SFX, mute any accidental dialogue, and lay the music
  bed over the top in the edit. If a take produces captions on its own, discard it.
- **API negative prompt** (Vertex/Gemini API `negativePrompt`, or just append to the prompt in
  Flow): `text, subtitles, captions, watermark, logo, brand name, phone screen UI, extra fingers,
  distorted hands, duplicate people`.

**Character sheet (paste into every prompt, edit the details once and keep them fixed)**

> SARI (female): Indonesian woman, late 20s to mid-30s, hair tied back in a practical low bun,
> simple caregiver's uniform or plain modest blouse, small cross-body bag, composed but visibly
> tired expression.
>
> DIMAS (male): Indonesian man, early-to-mid 30s, short black hair, plain everyday t-shirt,
> casual clothing suited to waiting at home and running errands in the city.

**Prompt A — the stolen hour (target: 0:00–0:07)**

> Cinematic documentary style, 35 mm lens, shallow depth of field, handheld with subtle
> movement. Late afternoon in a quiet residential neighborhood, generic Taiwanese suburban
> street: narrow lanes, scooters parked along the curb, laundry hanging from apartment balconies
> above. SARI [character sheet] steps out of a modest apartment building's side door, glancing
> back at it, and walks briskly to a small roadside money-changer kiosk half a block away. She
> slides a stack of banknotes across the counter; the clerk peels several bills off the top as a
> fee and hands back a thin receipt. Sari checks her watch, glances back toward the apartment
> building, and hurries the receipt into her bag. Camera: slow push-in from over her shoulder
> ending on a close-up of the receipt in her hand. Audio: distant scooters, an air-conditioning
> unit humming, the crisp riffle of counted banknotes, generic street ambience. No music. No
> dialogue. No on-screen text, no subtitles, no readable logos or brand names, all signage
> generic or out of focus.

**Prompt B — three days (target: 0:07–0:12, speed-ramped in the edit)**

> Cinematic, warm natural light, locked-off tripod shot, time-lapse. Interior of a modest home in
> Jakarta: patterned tile floor, a wooden side table beside a window with thin light curtains, a
> framed family photo, a glass of sweet tea. A phone lies face-up on the table, screen dark.
> Sunlight through the window sweeps from soft morning to harsh noon to amber dusk to blue night
> and back again, three full cycles, shadows racing across the floor, while the phone never
> lights up. DIMAS [character sheet] enters the frame twice to glance at the dark phone and
> leaves. On the final cycle he sits down, picks the phone up, and its glow finally lights his
> face. Camera: static, medium-wide. Audio: time-lapse layered ambience, a rooster at dawn,
> passing scooters, a brief rain shower fading in and out, a distant street vendor's call, a wall
> clock ticking. No music. No dialogue. No on-screen text, no subtitles, no readable phone screen
> content.

**Prompt C — the cash-out line (target: 0:12–0:16)**

> Cinematic documentary style, handheld, 35 mm lens, midday, harsh tropical sunlight. A small
> bank branch or remittance agent on a busy Jakarta street: motorbikes parked outside, a security
> guard at the glass door, a paper number-ticket dispenser inside. DIMAS [character sheet] waits
> on a plastic chair in a crowded waiting area, holding his paper ticket while the counter
> display ticks up slowly. Cut to the counter: a teller counts out rupiah banknotes, Dimas folds
> the cash carefully into his pocket and steps back out into the sun and noise. Camera: opens
> tight on the ticket number in his hand, rack focus to the queue display, follows him to the
> counter, then out through the door. Audio: ceiling fans, a ticket-counter chime, murmured
> Indonesian conversation, motorbikes and street traffic swelling as the door opens, banknotes
> being counted. No music. No dialogue. No on-screen text, no subtitles, generic unbranded
> signage.

**Fallback if Veo output isn't usable:** stock footage of the same three beats (counter, waiting,
queue) cut to the same timings. The script does not depend on the generated footage; it depends
on the three beats being legible in 16 seconds.

---

## Production notes

- **Format: landscape, 16:9, 1080p, for the whole video** — matches the Veo clips (already
  specified 16:9 below), the standard for judged submissions viewed on desktop via YouTube/Loom/
  Vimeo, and the founder-on-camera talking-head beat. Phone-screen recordings get composited into
  this frame (bezel/mockup or a clean padded crop), not the other way around. A vertical cut for
  the optional, non-judged 30-second social ad is a separate re-edit from this landscape master
  afterward, never the reverse.
- **Runtime discipline.** The VO is now ~270 words after the humanized rewrite — at ~150 wpm
  that's ~1:48, leaving a tighter ~12 s for the visual holds marked above (down from the earlier
  draft's ~20 s). Time an actual read-through before locking picture; if it runs long, cut from
  0:35–0:52 (the agent beat) first, never from 1:05–1:32.
- **The stopwatch is the spine, and it is per leg on purpose.** Three separate timers: sign-up
  (install → home screen), send (confirm tap → recipient notification), spend (scan → Paid).
  **Do not stitch them into one "sign-up to groceries in one take" number.** Even though both
  legs now run on the same network (see below), keep them as three honest, separate numbers —
  three real timings, not one inflated composite.
- **Full demo runs on Monad testnet — decided 2026-09-21, a funding-practicality call, not a
  technical downgrade.** Real mainnet AUSD would need moving scarce funds into a freshly-created
  passkey wallet for every take, with no room for a botched retake. Testnet AUSD (the project's
  own open-mint stand-in, spec §6.6) removes that risk entirely and satisfies every judged
  criterion that actually matters here — Technical Execution asks whether mechanics "actually
  execute onchain... not simulated," which testnet does exactly as well as mainnet. This video
  deliberately never says "mainnet" or "testnet" at all — no crypto-speak, per the existing
  rule — it just says "Monad." Where the network specifics get spelled out explicitly is the
  3-minute technical demo and the written submission, same as before.
- **The 1:05–1:32 shop shot is the single most important visual in the video.** It's the beat
  competitors pitching "crypto remittance" almost never show, because most of them can't. Shoot
  it at a real place with a QRIS sticker that was already there. Get the merchant's terminal
  chime on audio if at all possible; that sound is the proof.
- **Android and "fingerprint" — sign-up beat only.** iOS passkeys can't work until the AASA
  `TEAM_ID` placeholder is replaced, so record on Android and say "fingerprint", not "Face ID",
  for the 0:22–0:35 sign-up beat specifically — that's the real WebAuthn biometric step. If you
  do end up on an iPhone, swap that one instance for "Face ID"; the app already labels the button
  per device (`hooks/useBiometricLabel.ts`).
- **PIN, not biometric, confirms every transaction after sign-up.** `app/send.tsx`'s
  `handleSend` opens a PIN modal (`setIsPinModalVisible`), not a biometric prompt —
  `handlePinConfirm(pin)` is what actually finalizes a send. The send beat (0:35–0:52) and the
  spend beat (1:05–1:32) both confirm with a PIN, not a fingerprint — don't say "fingerprint"
  for either of those, on Android or iPhone.
- **The Mera bounty is won or lost in 0:22–0:35.** The login screen must show one passkey
  button and nothing else. No "import wallet", no seed phrase, no Google sign-in, at any point
  in this video (`FEATURE_PASSKEY_ONLY_ONBOARDING` is true on this branch's dev/preview
  builds). Also never show the Wallet Details screen's Passkey block long enough to read.
- **Don't let this become the technical demo.** No contract addresses, no "EIP-7702", no gas
  settings screen, no architecture. "Gasless" is not mentioned at all (settings toggle, decided
  2026-09-16). The only technical nouns allowed in the VO are Monad, AUSD, Kimi, QRIS.
- **No crypto-speak in the VO.** Banned words: wallet, token, on-chain, transaction, address,
  asset, network, gas. "Real dollars, AUSD" is the one place the asset is named, for Agora.
- **Dimas's home is Jakarta; Sari's workplace is Taiwan** — neither matches the founder's real
  location (Lombok), and that's fine: this is the **persona's** setting, kept deliberately
  separate from where the founder actually lives and where real footage actually gets shot. The
  0:22–0:35 sign-up recording and the 1:05–1:32 shop scene are shot wherever real footage is
  actually available, which will likely be Lombok. Keep those shots **generic**: a warung/
  mini-mart/mall counter interior with a QRIS sticker, no skyline, landmark, or signage that
  visibly ties the shot to one city or the other. QRIS merchants look the same nationwide, so
  this isn't a stretch, and it means the "Dimas in Jakarta" VO line is never visually
  contradicted by the b-roll. Don't shoot anything distinctly Lombok (Rinjani backdrop, beach,
  obviously rural/coastal scenery) for the parts of the video the persona VO claims are Jakarta.
  Don't drift either side of the corridor to Manila or a generic "abroad" either; the thesis is
  Indonesia-specific and Taiwan is the verified real corridor (claims ledger).
- **Traction b-roll must be real and current.** Check the Play Store listing version on the day
  you record it. The store build predates most of this year's work (memory:
  `project_playstore_build_predates_stellar`); the distribution and user base are real, but
  don't show or imply that passkeys/AUSD are in the store build. "Live on the Play Store, with
  real people paying real merchants" is the true sentence. "Passkeys are in the store" is not.
- **Solo submission, and the founder beat should own it, not hide it.** Founder name is Satria
  Ali (applying solo). "I build TakumiPay" says solo without making it the headline; the
  credibility comes from the Play Store listing behind you, not from a bio. Never say "we"
  anywhere in the VO or written submission: a judge who notices one "we" on a solo entry stops
  trusting the rest. Keep it to three sentences on camera.
- **Music.** One bed, starts under the turn at 0:16 (silence or ambience only over the old-world
  segment), lifts at 0:52 (settlement), holds through the shop, drops out for the founder,
  returns under the close.

---

## Claims ledger (every number or factual claim in the VO and on-screen text)

| Claim | Where | Status | Source / what to verify |
|---|---|---|---|
| "Fast costs a cut. Cheap takes three days." | 0:00 VO | OK as phrased | Category-level trade-off (cash pickup is fast but priced accordingly; bank-deposit remittance commonly quotes 1–3 business days). Deliberately not "remittance takes three days", which a judge could counter with a same-day cash-pickup quote. |
| Corridor: caregiver in Taiwan → Jakarta, Indonesia | 0:00 VO + Veo A | Verified, real corridor | Per BP2MI (Indonesia's official migrant-worker placement agency), Taiwan is becoming Indonesia's top migrant-worker destination, and caregiving/domestic work is historically one of the largest categories within it. Not chosen for cultural recognition to any one judging panel — chosen because it's the real, largest, best-documented version of this corridor, which is what Founder & Market Readiness actually rewards (a specific, credible segment). |
| "under a second" settlement | 0:52 VO + overlay | OK, must be **shown** | Monad finality ~600 ms (spec §4.1). The two-phone shot has to make it visible; if the recipient push takes longer than the on-chain finality (it's a server-side push, commit `f679729`), freeze the timer on the sender's "Sent" and let the notification land in the next second rather than fudging the number. |
| "Real dollars, AUSD, on Monad" | 0:52 VO | OK, network deliberately unspecified | Testnet AUSD stand-in (spec §6.6) — the video never says "mainnet" or "testnet" for either leg, consistent with the no-crypto-speak rule. Network specifics live in the technical demo + written submission instead. |
| "over forty million shops" / "40M+ merchants" | 1:05 VO + on-screen | **Verify before lock** | Older docs in this repo say 44M. Pull the latest Bank Indonesia QRIS merchant count and use that exact figure on screen; keep "over forty million" in the VO so a small revision doesn't force a re-record. |
| "scans the same QRIS code that sits on the counter" | 1:05 VO | OK as phrased, **do not upgrade to "any merchant"** | Today's rail resolves registered pilot merchants; any-PAN payout is the target model, not the shipped one (memory `project_qris_any_pan_target_model`). The wording sells the network without claiming universal acceptance. Upgrade only if any-PAN is live by recording day. |
| "The merchant gets rupiah" | 1:05 VO | OK | Backend converts at settlement (`takumipay` settlement provider, spec §6.6). |
| "live on the Play Store, with real people paying real merchants" | 1:32 VO | OK, **re-check store version on record day** | `com.planckify.takumiwallet` listing. See production note on traction b-roll. |
| "This month I added passkeys and AUSD" | 1:32 VO | OK | Commits `3bfb340`, `9dbaaee`, `f679729` on `monad-hackathon`. Not device-verified as of 2026-09-18; the recording itself is the verification. |
| "powered by Kimi" | 0:35 VO | OK | `kimi-k2.6` via `agent-api/src/agents/models.ts`. |
| Voice input to the agent ("she just says what she wants") | 0:35 visual | OK, real feature | `hooks/useVoiceTranscription.ts` + `services/transcribeAudio.ts`, already-live transcription path. Real voice, not a typed message read aloud after the fact — record it live, don't fake it with a voiceover dub. |
| "No seed phrase. Ever." | 0:22 on-screen | OK for this flow | Passkey wallet row stores a derived private key, never a mnemonic; user never sees one (spec §3.5). Do not extend this to "lose your phone, keep your money": cross-device passkey restore is not device-verified (memory `reference_mera_prf_is_per_credential`). |
| "Indonesia first. Southeast Asia next." | 1:44 VO + map graphic | **Roadmap/vision statement, not a built-feature claim** | Nothing shipped outside Indonesia; do not let this be read as "already expanding." Grounded, not generic hand-waving: several ASEAN countries run their own domestic QR-merchant-payment standards structurally identical to QRIS (Thailand PromptPay, Malaysia DuitNow QR, Singapore SGQR, Philippines QR Ph, Vietnam VietQR), and central banks in the region (Bank Indonesia included) have already stood up cross-border QR payment linkages between several of these — so "the same rail, another QR standard" is a real technical path, not just ambition talk. Keep the VO to the one line; don't turn this into a roadmap slide or name specific countries/timelines the build doesn't back yet. |

---

## Kimi bounty article — angle reminder (per user instruction 2026-09-15)

**Keep this article scoped to TakumiAgent specifically — not the QRIS-spend story, not the Mera
passkey story.** Those belong to the pitch video and the main written submission. The article's
job (per spec §7) is narrower and technical: how Kimi K2.6's tool-calling turns a plain-language
instruction into a real, signed on-chain transaction. Suggested outline:

1. **The problem the agent solves:** payments UX today is a form — recipient field, amount field,
   asset dropdown, confirm. TakumiAgent replaces that with a sentence.
2. **How it actually works, concretely:** the `send_native`/`send_token` capability-tool shape,
   how the agent resolves a token by symbol without ever handling a raw contract address, the
   write-approval gate that renders the actual parsed transaction facts before execution (not a
   model-generated summary — ties to `approvalSummary.ts`, per memory
   `project_facts_first_approval_summary`).
3. **What changed for Monad/AUSD specifically:** nothing in the agent code — the same tool that
   already sends USDC on Base or SOL on Solana now sends AUSD on Monad, because the tool resolves
   assets generically. That *is* the "not bolted on" story the bounty asks for.
4. **The Kimi-specific detail worth naming:** `kimi-k2.6` via the OpenAI-compatible
   `api.moonshot.ai/v1` endpoint, real production tool-calling (not a demo integration) —
   `agent-api/src/agents/models.ts`.
5. **Close on the concrete demo:** "send $100 to Dimas" → real signed transaction on Monad. One
   sentence, one settled payment.

Not drafting the full article text yet — flag when you want that written; it's a separate pass
from this script.
