import type { ApprovalRenderer } from "@/services/bridge/approval";
import { AddChainSheet } from "./AddChainSheet";
import { AgentCardRenderer } from "./AgentCardRenderer";
import { AuthorizationSheet } from "./AuthorizationSheet";
import { ConnectSheet } from "./ConnectSheet";
import { EvmBatchCallsSheet } from "./EvmBatchCallsSheet";
import { EvmSignMessageSheet } from "./EvmSignMessageSheet";
import { EvmTransactionSheet } from "./EvmTransactionSheet";
import { SolanaSignAllTransactionsSheet } from "./SolanaSignAllTransactionsSheet";
import { SolanaSignInSheet } from "./SolanaSignInSheet";
import { SolanaSignMessageSheet } from "./SolanaSignMessageSheet";
import { SolanaSwitchClusterSheet } from "./SolanaSwitchClusterSheet";
import { SolanaTransactionSheet } from "./SolanaTransactionSheet";
import { SolanaWatchTokenSheet } from "./SolanaWatchTokenSheet";
import { StellarAuthEntrySheet } from "./StellarAuthEntrySheet";
import { StellarSignMessageSheet } from "./StellarSignMessageSheet";
import { StellarTransactionSheet } from "./StellarTransactionSheet";
import { SuiSignInSheet } from "./SuiSignInSheet";
import { SuiSignPersonalMessageSheet } from "./SuiSignPersonalMessageSheet";
import { SuiSwitchNetworkSheet } from "./SuiSwitchNetworkSheet";
import { SuiTransactionSheet } from "./SuiTransactionSheet";
import { SwitchChainSheet } from "./SwitchChainSheet";
import { WatchAssetSheet } from "./WatchAssetSheet";

export const evmRenderers: ApprovalRenderer[] = [
  // Agent-origin takes precedence so intents tagged `origin.via === "agent"`
  // render via the agent renderer instead of the default chain sheets.
  {
    canHandle: (i) => i.origin?.via === "agent",
    Component: AgentCardRenderer as ApprovalRenderer["Component"],
  },
  // `connect` intents route through the unified `ConnectSheet` regardless of
  // namespace — per-chain presentation (chip colour, biometric gate, chip
  // sub-label) is owned by the namespace's `WalletKitAdapter`. Adding a new
  // chain (e.g. Sui) requires zero edits here; it just needs to register
  // its kit with the relevant optional hooks.
  {
    canHandle: (i) => i.kind === "connect",
    Component: ConnectSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) =>
      i.namespace === "eip155" &&
      (i.kind === "signMessage" || i.kind === "signTypedData"),
    Component: EvmSignMessageSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "eip155" && i.kind === "sendTransaction",
    Component: EvmTransactionSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "eip155" && i.kind === "addChain",
    Component: AddChainSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "eip155" && i.kind === "switchChain",
    Component: SwitchChainSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "eip155" && i.kind === "watchAsset",
    Component: WatchAssetSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "eip155" && i.kind === "sendCalls",
    Component: EvmBatchCallsSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) =>
      i.namespace === "eip155" && i.kind === "signAuthorization",
    Component: AuthorizationSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "solana" && i.kind === "signIn",
    Component: SolanaSignInSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "solana" && i.kind === "signMessage",
    Component: SolanaSignMessageSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "solana" && i.kind === "signTransaction",
    Component: SolanaTransactionSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) =>
      i.namespace === "solana" && i.kind === "signAllTransactions",
    Component: SolanaSignAllTransactionsSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "solana" && i.kind === "switchCluster",
    Component: SolanaSwitchClusterSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "solana" && i.kind === "watchAsset",
    Component: SolanaWatchTokenSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "sui" && i.kind === "signIn",
    Component: SuiSignInSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "sui" && i.kind === "signMessage",
    Component: SuiSignPersonalMessageSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "sui" && i.kind === "signTransaction",
    Component: SuiTransactionSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "sui" && i.kind === "switchNetwork",
    Component: SuiSwitchNetworkSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "stellar" && i.kind === "signTransaction",
    Component: StellarTransactionSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "stellar" && i.kind === "signMessage",
    Component: StellarSignMessageSheet as ApprovalRenderer["Component"],
  },
  {
    canHandle: (i) => i.namespace === "stellar" && i.kind === "signAuthEntry",
    Component: StellarAuthEntrySheet as ApprovalRenderer["Component"],
  },
];
