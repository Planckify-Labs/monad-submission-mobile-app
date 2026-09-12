// Central catalog of product-analytics events. Every `track()` call site is
// type-checked against this map — add new events here, not ad-hoc strings at
// the call site (mirrors services/errors/paymentErrors.ts centralizing the
// payment-error vocabulary).
export type AnalyticsEventProps = {
  app_session_started: Record<string, never>;
  wallet_created: { chains: string[]; wallets_added: number };
  wallet_imported: { chains: string[]; wallets_added: number };
  payment_sent: { chain: string; token?: string; amount?: number };
  merchant_payment_completed: {
    chain: string;
    rail?: string;
    amount_minor?: string;
  };
  bill_payment_completed: {
    product_category?: string;
    points_spent?: number;
  };
  swap_completed: {
    chain: string;
    from_asset?: string;
    to_asset?: string;
    amount?: number;
  };
  /**
   * A safety-pipeline refusal (§11.6 #7). Failures only — passes stay in the
   * device-local ring in `services/defi/safety/opsConfig.ts`. Carries no
   * wallet address and no raw error text, only our own curated vocabulary.
   */
  defi_safety_check_failed: {
    check_id: string;
    layer: number;
    verdict: string;
    fail_code?: string;
    detail?: string;
    target_kind?: string;
    chain_id?: string | number;
    passed_before?: string;
  };
  /**
   * Quick Invest entry surface (docs/defi-quick-invest-spec.md §10). These
   * three are what actually validate the redesign: does leading with an
   * outcome shorten "card shown" → "deposit confirmed", and how often does
   * a user drop to the pool-by-pool browse list instead?
   *
   * `entry_state` is 1 (user stated an amount), 2 (goal/tier only) or 3
   * (no specifics — recommendation first). No wallet address, no balance.
   */
  defi_quick_invest_shown: { entry_state: number };
  defi_quick_invest_submitted: {
    entry_state: number;
    tier: string;
    legs: number;
    amount_usd: number;
  };
  defi_quick_invest_browse: { entry_state: number };
  defi_deposit_completed: {
    chain: string;
    protocol_slug?: string;
    chain_id?: string | number;
    asset_symbol?: string;
    amount?: number;
    amount_usd?: number;
  };
  deposit_completed: { chain: string; amount?: number };
  dapp_connected: { chain: string; dapp_host?: string; dapp_name?: string };
  dapp_transaction_approved: {
    chain: string;
    method: string;
    dapp_host?: string;
    dapp_name?: string;
  };
  agent_message_sent: Record<string, never>;
  agent_tool_completed: { tool_name: string; state: string };
  // In-screen feature engagement — taps that open a sub-feature/modal
  // without an expo-router navigation, so they're invisible to `$screen`.
  // `feature` is a short slug (e.g. "agent_mode", "receive_modal");
  // `trigger` further breaks down *which* entry point, only populated for
  // "agent_mode" (ask_bar | mic | spotlight | capability_card |
  // quick_prompt_chip | floating_button).
  feature_opened: { feature: string; trigger?: string };
  // Lifecycle of one Agent Mode "visit" — from the pager landing on the
  // chat page to leaving it (back button, swipe home, etc.), whichever
  // path gets there. Answers "how long do people spend chatting" and
  // "how many chat sessions per day/week/month", not just per-message
  // volume.
  agent_session_started: Record<string, never>;
  agent_session_ended: { duration_seconds: number };
  // Google sign-in funnel (app/login.tsx, components/auth/GoogleOtpSheet.tsx).
  // `reason` values are the curated TGoogleAuthErrorCode codes from
  // hooks/queries/useGoogleAuth.ts (e.g. "invalid_code", "rate_limited",
  // "account_conflict") — never raw error text, per the user-facing-errors
  // rule in CLAUDE.md, which applies here too.
  google_signin_started: Record<string, never>;
  // The native picker resolved and the server emailed a code — step 1 done.
  google_signin_otp_requested: Record<string, never>;
  // User dismissed the Google account picker. Tracked separately from
  // `google_signin_failed` since it's a normal drop-off, not an error.
  google_signin_cancelled: Record<string, never>;
  google_signin_failed: { reason: string };
  otp_verified: Record<string, never>;
  // Fired for both a rejected code and a failed resend — either way the OTP
  // step didn't complete; `reason` distinguishes the cause.
  otp_verify_failed: { reason: string };
  otp_resent: Record<string, never>;
  // `path` is which of the five post-OTP outcomes landed the user on a
  // wallet: existing_wallet (returning account, same device), drive_restore,
  // new_account (brand-new, no backup), account_found_new_wallet (lost
  // recovery, minted fresh), account_found_recovery_phrase (recovered via
  // seed phrase).
  google_signin_completed: { path: string };
  // Auth succeeded (OTP verified) but the post-auth wallet setup didn't
  // finish. `stage` is where it broke: post_otp | drive_restore |
  // account_found_new_wallet.
  google_signin_setup_failed: { stage: string; reason?: string };
  // Google Drive seed-backup management from the wallet screen (distinct from
  // `google_signin_completed`'s drive_restore path, which is the login-time
  // *restore*). `is_update` is true when this replaced an existing backup
  // (passphrase change) rather than creating the first one.
  wallet_backup_completed: { is_update: boolean };
  wallet_backup_removed: Record<string, never>;
  // `stage` is which action failed: create | update | remove. `reason` is a
  // curated TBackupErrorCode from services/backup/errors.ts, never raw error
  // text.
  wallet_backup_failed: { stage: string; reason?: string };
  // Deep-link kernel (docs/deeplink-wallet-interactions-spec.md §13.2).
  // Never a URL: `class` is the DeepLinkIntent kind, `transport` the
  // carrier, `verification` the Provenance verification kind.
  deeplink_received: {
    class: string;
    transport: string;
    verification: string;
    namespace?: string;
    source: string;
  };
  deeplink_rejected: { code: string };
  deeplink_approved: { class: string; transport: string };
};

export type AnalyticsEvent = keyof AnalyticsEventProps;
