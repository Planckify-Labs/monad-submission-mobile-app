# Metropolis Monad Hackathon 2026 — Pitch Video Script

**Target runtime:** 2:00 (hard cap per deliverable requirements)
**Deliverable purpose:** introduce the team, the problem, and why we're building this — narrative,
not a technical walkthrough (that's the separate 3-min technical demo video).
**Source of truth for every claim below:** `monad-metropolis-2026-strategy.md`,
`monad-metropolis-2026-spec.md`.

---

## Script

**[0:00–0:15] — Open on the problem**

*Visual: a phone screen, a Western Union / bank transfer app, a spinner, "1-3 business days."
Cut to a hand counting cash at a remittance counter — a fee being deducted.*

> **VO:** "Every month, millions of Indonesians working abroad send money home. It takes days. It
> costs a cut off the top. And even after it arrives, someone still has to go cash it out before
> they can actually use it."

**[0:15–0:30] — The onboarding moment**

*Visual: TakumiPay app, a clean "Sign up" screen. Face ID prompt. Done — no forms, no 12-word
phrase, no seed vault warning screen.*

> **VO:** "We built a better way. No seed phrase. No crypto jargon to learn. Just Face ID."

*On-screen text (bottom third, 2 sec hold):* **"Sign up with a passkey. That's it."**

**[0:30–0:50] — The send, via the agent**

*Visual: Takumi Agent chat interface. User types: "send $50 to my mom in Jakarta." Agent responds,
resolves the recipient from the address book, shows a confirmation card (amount, recipient,
asset), user taps confirm.*

> **VO:** "Our AI agent — powered by Kimi — understands what you mean, and handles it. Resolve the
> recipient, pick the asset, execute the send. You just talk to it."

**[0:50–1:10] — The settlement moment**

*Visual: a fast, clean transition — sender's phone shows "Sent," cut immediately to recipient's
phone lighting up with a notification. No loading spinner lingering.*

> **VO:** "It settles on Monad in under a second. Not one to three days. Instant."

**[1:10–1:40] — The differentiator: spend, not just receive**

*Visual: the recipient, now in a shop or at a mall counter, pulls out their phone, scans a QRIS
code, taps to pay. Transaction confirms instantly. They walk out with their bags — no detour to a
cash-out counter anywhere in the sequence.*

> **VO:** "And here's the part most remittance apps miss: the money doesn't just arrive as a
> balance you have to figure out how to use. It's spendable immediately — at any of Indonesia's
> 44 million QRIS merchants. From street vendors to shopping malls."

**[1:40–1:55] — Why us, specifically**

*Visual: quick montage — existing TakumiPay users paying at real merchants (b-roll of the app
already in use), then a simple map/graphic of Indonesia with QRIS coverage.*

> **VO:** "This isn't a concept. TakumiPay already powers QRIS payments for real users in Indonesia
> today. We're extending the same rails across borders."

**[1:55–2:00] — Close**

*Visual: TakumiPay logo on a clean background.*

*On-screen text:* **"No seed phrase. No waiting. No cash-out. Just send — and spend."**

> **VO:** "TakumiPay. Send from anywhere. Spend everywhere."

---

## Production notes

- **Runtime discipline:** the VO above is ~290 words, which at a natural, slightly brisk pace
  (~150 wpm) lands right around 1:55–2:00 with the visual holds noted — leaves no slack, so time
  an actual read-through before locking picture.
- **Don't let this video become the technical demo.** No contract addresses, no "EIP-7702," no
  architecture diagrams — that's the separate 3-minute technical demo video. This one sells the
  problem and the outcome.
- **The mall/street-vendor shot in 1:10–1:40 is the single most important visual in the video** —
  it's the one beat competitors pitching "crypto remittance" almost never show, because most of
  them can't actually do it. Don't rush it.
- **Recipient location:** using Jakarta consistently (not Manila/Philippines, which contradicts
  the Indonesia-specific QRIS/UMKM thesis this whole pitch rests on) — keep every on-screen or
  spoken example Indonesia-specific throughout, including in the technical demo video and any
  screenshots used in the written submission.

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
5. **Close on the concrete demo:** "send $50 to my mom in Jakarta" → real signed transaction on
   Monad mainnet. One sentence, one settled payment.

Not drafting the full article text yet — flag when you want that written; it's a separate pass
from this script.
