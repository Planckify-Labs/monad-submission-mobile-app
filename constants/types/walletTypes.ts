import type { Namespace } from "@/services/chains/types";

export type WalletSource = "Created" | "Imported" | "Social";
export type WalletType =
  | "PrivateKey"
  | "SeedPhrase"
  | "Social"
  | "Smart4337"
  | "Smart7702"
  /**
   * Mera passkey wallet (docs/monad-metropolis-2026-spec.md §3). An
   * EVM-only EOA whose key is a deterministic function of a platform
   * passkey's WebAuthn PRF output. The user never sees a seed phrase;
   * the passkey itself is the recovery mechanism (same passkey on a new
   * device reproduces the same key). Signs exactly like `PrivateKey`.
   */
  | "Passkey";

export interface TPasskeyFields {
  /** WebAuthn credential id, canonical unpadded base64url. */
  credentialId: string;
  /** Relying-party id the passkey is scoped to (`takumipay.xyz`). */
  rpId: string;
  /** Authenticator transports reported at creation, when available. */
  transports?: string[];
}

export interface TSmart4337Fields {
  signerWalletId: string;
  factory?: string;
  bundlerUrl: string;
  entryPoint: string;
}

export interface TSmart7702Fields {
  signerWalletId: string;
  delegator: `0x${string}`;
  authorizationByChain?: Record<
    number,
    { expiresAt: number; signature?: `0x${string}`; nonce: number }
  >;
}

export interface TSolanaFields {
  pubkeyBase58: string;
  derivationPath?: string;
}

export interface TSuiFields {
  /** 0x-prefixed 32-byte hex (canonical Sui address). */
  suiAddress: string;
  /** Raw 32-byte ed25519 public key, hex. */
  pubkeyHex: string;
  /** SLIP-0010 ed25519 path. Absent ⇒ default `m/44'/784'/0'/0'/0'`. */
  derivationPath?: string;
  /** Signing scheme; only `ed25519` in v1. Future Secp variants need a new gate. */
  scheme: "ed25519";
}

export interface TStellarFields {
  /** StrKey `G…` — the account's public key AND its ledger address (no separate hashing step). */
  stellarAddress: string;
  /** SEP-0005 derivation path. Absent ⇒ default `m/44'/148'/0'`. */
  derivationPath?: string;
  /** Signing scheme; only `ed25519` — Stellar has no other account-signer scheme in v1. */
  scheme: "ed25519";
}

export interface TWallet {
  name: string;
  address: string;
  balance: string;
  source: WalletSource;
  type: WalletType;
  namespace: Namespace;
  chainId?: string | number;
  account: any;
  /**
   * For EVM rows: 0x-prefixed 32-byte hex.
   * For Solana rows: base58-encoded 32-byte seed.
   * For Sui rows: bech32 `suiprivkey1…` form so the dwell site re-decodes
   *   without re-running BIP-39. `address` mirrors `sui.suiAddress`.
   * For Stellar rows: StrKey `S…` secret-seed form so the dwell site
   *   re-decodes without re-running BIP-39. `address` mirrors
   *   `stellar.stellarAddress`.
   */
  privateKey?: string;
  seedPhrase?: string;
  /**
   * TWV-2026-057 Tier 1 — non-secret discriminator shared by every row
   * derived from the same BIP-39 mnemonic (one EVM + one Solana + one
   * Sui + one Stellar row). A salted keyed hash of the mnemonic,
   * assigned by `services/walletService.ts`. Group rows into accounts
   * with this; never compare `seedPhrase`.
   *
   * Absent on private-key imports and social wallets, which each form a
   * single-row account keyed by address.
   *
   * NOTE: `privateKey` / `seedPhrase` above are NOT present on wallets
   * that come from app state. The wallet service strips both on the way
   * out of storage and keeps them in a module-private vault; signer
   * dwell sites resolve them by address. They stay declared because
   * fresh imports and freshly derived rows carry them until first
   * persisted, and the reveal/backup screens read them back through
   * `revealWalletSecret`. Do not read either field off a wallet from
   * `useWallet()`, a React Query entry, or a dApp `ApprovalIntent`.
   */
  seedGroupId?: string;
  socialAccount?: {
    provider: string;
    email: string;
    name: string;
  };
  smart4337?: TSmart4337Fields;
  smart7702?: TSmart7702Fields;
  /** Present iff `type === "Passkey"`. Non-secret credential metadata. */
  passkey?: TPasskeyFields;
  solana?: TSolanaFields;
  sui?: TSuiFields;
  stellar?: TStellarFields;
}

export interface TWalletCreationParams {
  source:
    | "social"
    | "SeedPhrase"
    | "PrivateKey"
    | "SolanaSeedPhrase"
    | "SolanaPrivateKey"
    | "SuiSeedPhrase"
    | "SuiPrivateKey"
    | "StellarSeedPhrase"
    | "StellarPrivateKey";
  privateKey?: string;
  seedPhrase?: string;
  name?: string;
  provider?: string;
  socialAccount?: { email: string; name: string };
  account?: any;
}

export const WALLET_SETUP_PROGRESS_KEY = "walletSetupProgress";

export type TSelectedWords = { [key: number]: string };
export type TWordOptions = { [key: number]: string[] };
export type TSetupProgress = {
  step: number;
  mnemonic: string[];
  selectedWords: TSelectedWords;
};

export type TWalletSetupStep = {
  title: string;
  content: React.ReactNode;
  buttonText: string;
  onButtonPress: () => void;
};

export type TWalletSetupStepsProps = {
  currentStep: number;
  steps: TWalletSetupStep[];
  onBackPress: () => void;
  disableBackButton?: boolean;
};
