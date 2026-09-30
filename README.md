# TakumiPay — Metropolis Monad Hackathon 2026

> **Consumer Cross-Border Remittance & Merchant Settlement on Monad**  
> *Seedless onboarding with Mera passkeys, sub-second settlement in Agora AUSD, and AI-driven remittance via Takumi Agent.*

- **Team:** Planckify Labs
- **Track Entered:** Track 02 — Consumer Products & Payments
- **Targeted Sponsor Bounties:**
  - **Mera Bounty:** Passkey account layer as the entire onboarding experience (zero seed phrase)
  - **Agora Bounty:** End-to-end AUSD stablecoin integration on Monad
  - **Kimi Bounty:** Takumi Agent powered by Kimi K2.6 for conversational remittance
- **License:** [GNU General Public License v3.0 (GPLv3)](./LICENSE)

---

## Overview

Cross-border remittance is the quintessential consumer application where on-chain rails offer an undeniable real-world advantage. Migrant workers sending money home to Southeast Asia face multi-day delays, 5–10% hidden FX fees, and the friction of physical cash pickup.

TakumiPay redefines this experience by removing every point of crypto friction:
1. **Passkey-First Onboarding (Mera):** Users sign up in seconds using Face ID or Touch ID. No seed phrase, no private keys to copy, and no "Connect Wallet" modal.
2. **Sub-Second Finality (Monad):** Payments settle in ~600ms on Monad with sub-cent gas fees.
3. **Purchasing Power Preservation (Agora AUSD):** Funds move in Agora AUSD (`0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`), backed 1:1 by high-quality US liquid reserves.
4. **Spendable Anywhere:** The recipient doesn't just receive tokens; they can immediately spend them at over 44M+ QRIS/UMKM merchants across Indonesia without manually off-ramping.
5. **Conversational Remittance (Takumi Agent):** Powered by Kimi K2.6, users can send funds by simply typing or speaking: *"Send $50 to my mom in Jakarta"*.

---

## Monad Blockchain & Contract Deployments

The application integrates Monad Mainnet and Testnet natively:

| Network | Chain ID | Contract / Asset | Address | Explorer |
|---|---|---|---|---|
| **Monad Mainnet** | `143` | Native Currency | `MON` (18 decimals) | [MonadVision](https://monadvision.com) |
| **Monad Mainnet** | `143` | Agora AUSD (ERC-20) | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` (6 decimals) | [MonadVision Contract](https://monadvision.com/address/0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a) |
| **Monad Testnet** | `10143` | Native Currency | `MON` (18 decimals) | [Monad Testnet Explorer](https://testnet.monadvision.com) |
| **Monad Testnet** | `10143` | Agora AUSD (ERC-20) | `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` (6 decimals) | [Monad Testnet Contract](https://testnet.monadvision.com/address/0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC) |

---

## Metropolis Hackathon Build & Originality Disclosure

*(Mandatory disclosure under Section 4.1 Clause 4 of Metropolis Hackathon Rules)*

### 1. Pre-Existing Foundation (Prior to September 1, 2026)
TakumiPay's foundational multi-chain wallet architecture (React Native, Expo 54, viem, and base UI components) existed prior to the hackathon.

### 2. Substantial New Work Built During Hackathon Window (September 18 – September 26, 2026)
All Monad-specific functionality was conceptualized, implemented, and refined during the official hackathon build window:
- **Mera Passkey Account Layer (`services/walletKit/evm/mera/`, `hooks/usePasskeyOnboarding.ts`, `app/login.tsx`):**
  Engineered PRF-derived secp256k1 EOA authentication using WebAuthn. Replaced all legacy seed-phrase onboarding with a single biometric "Continue with Face ID / Fingerprint" tap.
- **Monad & AUSD Integration (`services/chains/evm/monad.ts`):**
  Added Monad Mainnet (`143`) and Testnet (`10143`) support, Agora AUSD token integration, deterministic gas cap rules for Monad execution, and balance feeds.
- **Non-Blocking Settlement UI (`components/pay-merchant/PaymentProgressHero.tsx`, `services/nanopay/pathOnchainSettlement.ts`):**
  Built an optimistic settlement timeline (`Preparing` → `Confirming` → `Paid`) that displays immediate visual receipt upon transaction broadcast while asynchronously confirming on Monad.
- **Consumer Error Sanitization (`services/errors/sendErrors.ts`, `services/nanopay/preflight.ts`):**
  Replaced raw RPC/EVM revert messages with friendly, actionable copy tailored for non-crypto consumers.
- **App-Side Hackathon Chain Lockdown (`services/walletKit/chainSupport.ts`):**
  Implemented lockdown switches that focus the judge build exclusively on Monad Mainnet and Testnet.
- **Takumi Agent Voice & Remittance Extensions (`components/home/TakumiAgent/`):**
  Integrated Kimi K2.6 natural-language intent parsing to resolve recipients, chains, and AUSD transfers with visual voice waveforms.

### 3. AI Coding Tools Disclosure
As permitted by Hackathon Rule 4.1, generative AI coding assistants (Claude Sonnet/Opus and Google Gemini) were utilized for drafting, refactoring, and test generation.

---

## Architecture Overview

```
mobile-app/
├── app/
│   ├── login.tsx                   # Biometric passkey-only onboarding
│   ├── pay-merchant.tsx            # Merchant payment flow
│   └── send.tsx                    # Consumer AUSD transfer screen
├── components/
│   ├── home/TakumiAgent/           # Kimi-powered AI assistant & voice waves
│   └── pay-merchant/
│       └── PaymentProgressHero.tsx # Optimistic settlement timeline
├── hooks/
│   └── usePasskeyOnboarding.ts     # Mera WebAuthn/PRF ceremony orchestrator
└── services/
    ├── chains/evm/monad.ts         # Monad chain & Agora AUSD constants
    ├── errors/sendErrors.ts        # User-friendly error sanitization
    └── walletKit/
        ├── chainSupport.ts         # Hackathon-specific Monad lockdown filter
        └── evm/mera/               # Passkey EOA derivation & credential storage
```

---

## Quick Start & Verification

### Prerequisites
- Node.js 20+
- `pnpm` (v10 or v11)
- Expo CLI

### Setup
```bash
# Clone the repository
git clone https://github.com/Planckify-Labs/monad-submission-mobile-app.git
cd monad-submission-mobile-app

# Install dependencies
pnpm install

# Run TypeScript and architecture conformance checks
pnpm check:syntax
pnpm check:chains

# Run unit and integration tests
pnpm test
```

### Running Locally
```bash
# Start Expo development server (Monad lockdown active by default)
pnpm start

# Run on Android emulator or connected device
pnpm android

# Run on iOS simulator or device
pnpm ios
```

---

## Open Source License

This project is licensed under the **GNU General Public License v3.0 (GPLv3)**. See the [LICENSE](./LICENSE) file for the full license text.
