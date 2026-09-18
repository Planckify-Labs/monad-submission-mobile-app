# One sentence, one block: how Takumi Agent turns "send $50 to my mom" into a settled AUSD payment on Monad with Kimi K2.6

*Draft for the Metropolis Monad Hackathon 2026 "Best Builds Powered by KIMI" bounty
(docs/monad-metropolis-2026-spec.md §7). Publish wherever TakumiPay already publishes
technical content and link it from the submission. Code references are to the public
submission repo.*

---

Most "AI + crypto" demos put a chatbot next to a form. The chatbot explains the form.
The user still fills in the form.

Takumi Agent is not that. When a TakumiPay user types

> send $50 to my mom in Jakarta

the agent, running on **Kimi K2.6** through Moonshot's OpenAI-compatible endpoint,
resolves who "my mom" is, which token "$50" means on the wallet the user is holding,
builds the exact transfer, and hands the user a single approval sheet whose facts come
from the tool arguments, not from the model's prose. One tap later the transfer is in a
Monad block, and Monad's ~600 ms finality means the recipient sees it before the sender's
screen dims.

This post walks through what the model actually does in that loop, because the
interesting part is how little of it is special-cased.

## The setup: a wallet with no seed phrase, a stablecoin, a fast chain

Three ingredients, none of them invented for the hackathon:

- **The account.** The user onboards with a passkey via
  [Mera](https://mera.category.xyz). Face ID or Android biometric creates a platform
  passkey, the WebAuthn PRF extension gives us 32 deterministic bytes, and we derive a
  standard secp256k1 key from them. No seed phrase is ever shown; the same passkey on a
  new phone reproduces the same address. From the rest of the app's point of view the
  result is an ordinary EVM signer.
- **The money.** [AUSD](https://docs.agora.finance) on Monad mainnet, a plain ERC-20 with
  6 decimals. We integrate exactly one thing from Agora: the token contract. No API key,
  no org account, nothing KYC-gated on the send path.
- **The rail.** Monad, chain id 143, which TakumiPay had already been serving from its
  backend chain feed before the hackathon. Gas is paid in MON.

## What Kimi sees

Takumi Agent's brain lives in a small orchestrator service. Each agent owns a prompt and
a tool list; the wallet agent's tools are deliberately **chain-agnostic**:

```jsonc
// The two tools that matter for this story. Note what is NOT here:
// no chain id, no contract address, no decimals. The model never sees them.
{ "name": "get_wallet_assets", "description": "List the tokens and balances the user holds on their active wallet." }
{ "name": "send_token", "parameters": { "to": "string", "symbol": "string", "amount": "string" } }
```

The model is told, in the system prompt, that it may only move funds through
`send_token`/`send_native`, that it must resolve recipients through the user's address
book, and that it must never re-tabulate data a tool card already rendered. Those are
product rules, not Monad rules. Nothing in the prompt mentions AUSD or Monad at all.

## The loop, turn by turn

Here is the real shape of the exchange for the sentence above, with Kimi's tool calls
shown as the OpenAI-style JSON the endpoint returns.

**Turn 1. The model reads the intent and looks up the recipient.**

```json
{ "tool_calls": [{ "function": { "name": "search_address_book", "arguments": "{\"query\":\"mom\"}" } }] }
```

The address book comes back with one match, saved by the user weeks ago: `Ibu` on
Monad, `0x…f4615b`. If there had been no match the model asks for an address; it does not
guess.

**Turn 2. "$50" needs a token.** The model calls `get_wallet_assets` and gets a list that
includes

```json
{ "symbol": "AUSD", "balance": "212.40", "chain": "Monad", "isStablecoin": true }
```

Kimi picks AUSD because it is the dollar-pegged asset on the wallet the user is holding.
This is the step that would have been a hand-written `if (chain === "monad")` in a
bolted-on widget. Here it is a reasoning step over data the tool returned.

**Turn 3. The send.**

```json
{ "tool_calls": [{ "function": { "name": "send_token",
    "arguments": "{\"to\":\"0x…f4615b\",\"symbol\":\"AUSD\",\"amount\":\"50\"}" } }] }
```

That call does not execute on the server. It is shipped to the phone, where the mobile
executor:

1. re-checks that `send_token` is a write tool and that the user's agent permission
   layer allows it (fail-closed; a mislabeled tool is refused),
2. resolves `AUSD` to its contract address and decimals from the same token registry the
   wallet UI uses, so the model never handled a raw address,
3. renders the approval sheet **from the tool arguments** (recipient, token, amount,
   chain). The model's own summary text is a fallback, never the source of truth,
4. on approval, signs with the passkey-derived key and submits a plain ERC-20 `transfer`
   with a pinned gas limit. Monad bills `gas_limit × gas_price`, not `gas_used`, so we
   do not let an estimate-then-pad fallback overcharge the user for a call shape we
   measured at ~73k gas.

**Turn 4. Confirmation.** The executor returns `{ status: "success", hash }`, the chat
shows a transaction card with the Monad explorer link, and the model writes one line. It
is not allowed to repeat the amounts the card already shows.

## Why this counts as "meaningfully driving a core feature"

The send screen still exists. A user can tap through it by hand. But the agent path is
not a wrapper around that screen: it calls the same `send_token` capability the screen
does, goes through the same approval gate, the same gas policy, and the same signer. The
model is doing the work a human does on the form, which is exactly the part that makes a
non-crypto user bounce: picking the token, finding the address, getting the decimals
right.

Two design choices make Kimi K2.6 a good fit for that job:

- **Reliable tool calling over a loose vocabulary.** "$50", "fifty dollars", "50 AUSD",
  "half of what I sent last time" all have to land on the same `send_token` call with a
  correctly normalized `amount`. K2.6 is consistent about emitting the structured call
  rather than narrating it.
- **Honest abstention.** When the address book has no "mom", the right move is a
  question, not an invented address. In our evaluations the model asks.

## What we did not do

We did not give the model a private key, a chain id, or a contract address. We did not
let the model's prose drive the approval sheet. We did not build a Monad-specific agent;
Monad and AUSD became one more row in a chain feed and a token table, and the agent
learned about them the same way it learns about everything else: by calling
`get_wallet_assets`.

That is the whole point. An agent that can move money should know as little as possible
about how the money moves.

---

*TakumiPay is a multi-chain wallet with QRIS merchant payments in Indonesia. The
cross-border AUSD flow described here was built for the Metropolis Monad Hackathon
2026; the passkey onboarding ships in the preview build linked from the submission.*
