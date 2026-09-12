import type { TWallet } from "@/constants/types/walletTypes";
import type { ApprovalIntent } from "@/services/bridge/approval";

export type Namespace = "eip155" | "solana" | "sui" | "stellar";

export interface Origin {
  /**
   * The origin the permission stores key on. For the WebView this is the
   * page URL; for external transports it is the transport-prefixed key
   * from `services/deeplinks/originKey.ts` (deep-link spec §4.9), which
   * can never collide with a page origin.
   */
  url: string;
  /**
   * Human string to show instead of `url` when the two differ (peer
   * metadata URL for a WalletConnect session, `identity.uri` for MWA).
   * Display only; never used as a key.
   */
  displayUrl?: string;
  title?: string;
  icon?: string;
  via?: "webview" | "agent" | "deeplink" | "walletconnect" | "mwa";
}

export interface ChainRequest {
  namespace: Namespace;
  method: string;
  params: unknown;
  origin: Origin;
  id: string;
}

export type ChainResult =
  | { status: "resolved"; value: unknown }
  | { status: "needs-approval"; intent: ApprovalIntent }
  | { status: "error"; code: number; message: string; data?: unknown };

export interface AdapterContext {
  activeWallet: TWallet | null;
  wallets: TWallet[];
  getAccount: (wallet: TWallet) => unknown;
  /**
   * TWV-2026-015 — current per-session nonce. Threaded through to the
   * injected provider's closure scope so every outbound bridge message
   * carries it. Rotated on every top-frame navigation.
   */
  sessionNonce?: string;
  /**
   * Per-origin resolved chain for a dApp-bridge request, stamped by the
   * adapter before dispatch so read/exec paths serve the origin's SELECTED
   * chain (registered → project RPC, custom → dApp RPC) instead of the
   * home-screen active chain. This is what keeps dApp chain state isolated
   * from the system chain (Phase 2). Opaque here; each adapter casts to its
   * own chain-config shape. Absent for non-bridge callers.
   */
  chainOverride?: unknown;
  // Intentionally NO `setActiveWallet`. The global active-wallet slot is
  // a UI concern (home screen, portfolio). When an adapter's approval
  // flow wrote to it, one chain's approval would poison another chain's
  // next request (e.g. a Solana connect flipped the global, and the next
  // EVM `eth_requestAccounts` saw a non-EVM active chain and returned
  // 4901). dApp-scoped state now lives in `PermissionStore` grants,
  // per-origin; the UI can observe grants if it wants to track dApp
  // sessions. Keeping this field off the context by contract makes that
  // class of bug unrepresentable.
}

export interface ChainAdapter {
  readonly namespace: Namespace;

  getInjectedScript(ctx: AdapterContext): string;

  handleRequest(req: ChainRequest, ctx: AdapterContext): Promise<ChainResult>;

  executeApproval(
    intent: ApprovalIntent,
    decision: { id: string; outcome: "approve" | "reject"; data?: unknown },
    ctx: AdapterContext,
  ): Promise<unknown>;

  onStateChange?(ctx: AdapterContext): { injectedJs: string } | null;
}
