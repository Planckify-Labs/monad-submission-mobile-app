import type { ComponentType } from "react";
import type { TWallet } from "@/constants/types/walletTypes";
import type { Namespace, Origin } from "@/services/chains/types";
import type { IntentAnnotation } from "./inspector";

export type ApprovalKind =
  | "connect"
  | "signIn"
  | "signMessage"
  | "signTypedData"
  | "signTransaction"
  | "sendTransaction"
  | "signAllTransactions"
  | "switchChain"
  | "switchCluster"
  | "switchNetwork"
  | "addChain"
  | "watchAsset"
  | "sendCalls"
  | "signAuthorization"
  /**
   * SEP-43 Soroban authorization entry (spec phase I). Distinct from
   * `signAuthorization`, which is EVM EIP-7702 delegation — unrelated
   * protocols that happen to share a word.
   */
  | "signAuthEntry";

export interface ApprovalIntent<P = unknown> {
  id: string;
  namespace: Namespace;
  kind: ApprovalKind;
  origin: Origin;
  wallet: TWallet | null;
  payload: P;
  annotations: IntentAnnotation[];
  createdAt: number;
}

export interface ApprovalDecision {
  id: string;
  outcome: "approve" | "reject";
  data?: unknown;
}

export interface ApprovalRenderer {
  canHandle(intent: ApprovalIntent): boolean;
  Component: ComponentType<{
    intent: ApprovalIntent;
    onDecision: (d: ApprovalDecision) => void;
  }>;
}
