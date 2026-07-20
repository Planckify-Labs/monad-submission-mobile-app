# Wallet Security — Task Backlog

This folder contains engineering tasks derived from
`../wallet-security-vulnerabilities-spec.md`. Each file represents one
discrete unit of work — typically one `TWV-2026-NNN` mitigation from the
spec's §6 catalogue, scheduled into the phased rollout defined in §8
(Prioritised Remediation Roadmap).

## Filename convention

```
{NN}_{task_name}_istaken_{true|false}[_isfinish_true].md
```

- `NN` — two-digit sequential task number (phase-ordered)
- `task_name` — short snake_case label, usually ends with the `twv_NNN` id
- `istaken_true` / `istaken_false` — whether an engineer is actively working on it
- `_isfinish_true` — appended as a **postfix** once the task is complete.
  A file without this postfix is not yet finished.

Three possible states:

| State | Filename pattern |
|---|---|
| Not started | `01_block_eth_sign_twv007_istaken_false.md` |
| In progress | `01_block_eth_sign_twv007_istaken_true.md` |
| Finished    | `01_block_eth_sign_twv007_istaken_true_isfinish_true.md` |

## Workflow

1. Browse the tasks, pick one that ends with `istaken_false.md`.
2. Claim it by renaming `istaken_false` → `istaken_true`:
   ```
   git mv 01_block_eth_sign_twv007_istaken_false.md 01_block_eth_sign_twv007_istaken_true.md
   ```
3. Work on the task. Read the referenced `TWV-2026-NNN` entry and the
   cross-referenced §7 / §9 sections of
   `../wallet-security-vulnerabilities-spec.md` — each task file
   excerpts only the minimum context needed.
4. When the task is complete and merged, append the `_isfinish_true`
   postfix — do NOT flip `istaken` back to `false`:
   ```
   git mv 01_block_eth_sign_twv007_istaken_true.md 01_block_eth_sign_twv007_istaken_true_isfinish_true.md
   ```
   Finished files stay in the folder as a durable record of what shipped.
5. If you abandon a task mid-flight, rename it back to `istaken_false.md`
   (without the `isfinish_true` postfix) so someone else can pick it up.

## Phase ordering

Tasks are numbered by the phase they belong to in the roadmap (§8 of the
spec). **Do not start a later phase before the previous phase's exit
criteria are green.**

- **Phase 1** (tasks 01–14) — **Fix-first**, block next release.
  Severity × applicability is highest; mostly XS–M effort.
- **Phase 2** (tasks 15–34) — **Next quarter**. Higher-effort mitigations
  that require design review or new subsystems (simulation, pinning,
  signed push, Key Attestation).
- **Phase 3** (tasks 35–64) — **Track / policy**. Informational,
  operational, or future-feature-gated. Many are design properties for
  features not yet built (multisig, HW pairing, smart accounts, social
  recovery).

## Non-regression contract

Every task here MUST satisfy §7 of the spec: **no feature removal
without replacement**, public APIs preserved, forward migration (never
reset), signable-tx parity, dApp-compatibility parity, agent-behaviour
parity, chain-list parity, performance budget, offline-degradation
parity.

Acceptance sign-off (§7.4) requires:

- [ ] Existing test suite green (`pnpm run test`).
- [ ] `pnpm check:syntax` and `pnpm biome:check` pass.
- [ ] Manual regression list (§7.2) attached to the PR.
- [ ] Feature-flag default and rollback plan documented.
- [ ] Change Log (§10) updated with the TWV ID(s) closed.

## Task map

### Phase 1 — Fix-first (block next release)

| # | TWV | File | Title |
|---|---|---|---|
| 01 | TWV-2026-007 | `01_block_eth_sign_twv007_istaken_false.md` | Hard-reject `eth_sign` at the bridge |
| 02 | TWV-2026-002 | `02_cpsprng_wallet_gen_twv002_istaken_false.md` | Verify OS CSPRNG for wallet generation |
| 03 | TWV-2026-004 | `03_secure_store_device_only_twv004_istaken_false.md` | `WHEN_UNLOCKED_THIS_DEVICE_ONLY` for seed/key items |
| 04 | TWV-2026-023 | `04_flag_secure_sensitive_screens_twv023_istaken_false.md` | `FLAG_SECURE` / `expo-screen-capture` on sensitive screens |
| 05 | TWV-2026-005 | `05_secure_text_input_props_twv005_istaken_false.md` | Secure `TextInput` props on seed screens |
| 06 | TWV-2026-003 | `06_logger_scrubbers_twv003_istaken_false.md` | Logger/Sentry scrubbers for seed-like strings |
| 07 | TWV-2026-016 | `07_registry_chain_id_not_rpc_twv016_istaken_false.md` | Use registry chainId (not RPC `eth_chainId`) for signing |
| 08 | TWV-2026-008 | `08_permit_permit2_decoding_twv008_istaken_false.md` | Full Permit/Permit2 decoding in signer UI |
| 09 | TWV-2026-055 | `09_eas_update_code_signing_twv055_istaken_false.md` | EAS Update code signing (KMS-backed key) |
| 10 | TWV-2026-059 | `10_android_disallow_backup_twv059_istaken_false.md` | `android:allowBackup=false` + `dataExtractionRules` |
| 11 | TWV-2026-060 | `11_secure_store_require_auth_twv060_istaken_false.md` | `requireAuthentication: true` on every signing SecureStore call |
| 12 | TWV-2026-061 | `12_biometric_current_set_twv061_istaken_false.md` | Current-biometric-set binding + app password recovery |
| 13 | TWV-2026-049 | `13_explorer_url_allowlist_twv049_istaken_false.md` | Explorer-URL allowlist; reject dApp-supplied `blockExplorerUrls` |
| 14 | TWV-2026-064 | `14_native_signer_modals_twv064_istaken_false.md` | Native RN modals for signer UI; disable WebView fullscreen |

### Phase 2 — Next quarter

| # | TWV | File | Title |
|---|---|---|---|
| 15 | TWV-2026-009 | `15_set_approval_for_all_warn_twv009_istaken_false.md` | `setApprovalForAll` red-flag UI + revoke screen |
| 16 | TWV-2026-010 | `16_eip7702_auth_ui_twv010_istaken_false.md` | EIP-7702 authorization UI + delegator allowlist enforcement |
| 17 | TWV-2026-011 | `17_tx_simulation_preview_twv011_istaken_false.md` | Pre-sign transaction simulation + asset-delta display |
| 18 | TWV-2026-013 | `18_webview_hardening_twv013_istaken_false.md` | WebView hardening: min system version, origin pin |
| 19 | TWV-2026-015 | `19_injected_nonce_and_origin_twv015_istaken_false.md` | Per-session nonce + origin check on injected provider |
| 20 | TWV-2026-022 | `20_clipboard_swap_detection_twv022_istaken_false.md` | Clipboard-swap detection + middle-char address display |
| 21 | TWV-2026-024 | `21_universal_app_links_twv024_istaken_false.md` | Universal/App Links for sensitive deeplinks |
| 22 | TWV-2026-018 | `22_ci_lockfile_supply_chain_twv018_istaken_false.md` | Lockfile-enforced CI + Socket/Snyk gate |
| 23 | TWV-2026-026 | `23_ssl_spki_pinning_twv026_istaken_false.md` | SSL/SPKI pinning on all backend + RPC hosts |
| 24 | TWV-2026-032 | `24_agent_url_sanitisation_twv032_istaken_false.md` | Agent output URL sanitisation + external-link dialog |
| 25 | TWV-2026-033 | `25_safe_tx_hash_reverify_twv033_istaken_false.md` | Independent Safe tx-hash re-derivation + `delegatecall` warn |
| 26 | TWV-2026-035 | `26_signing_mode_profile_twv035_istaken_false.md` | "Signing mode" profile (dApp browser/deeplinks/push disabled) |
| 27 | TWV-2026-038 | `27_claim_label_delta_mismatch_twv038_istaken_false.md` | Claim-label vs simulated-delta mismatch warning |
| 28 | TWV-2026-050 | `28_flashbots_protect_default_twv050_istaken_false.md` | Flashbots Protect / MEV Blocker default for swap txs |
| 29 | TWV-2026-051 | `29_scam_domain_feed_twv051_istaken_false.md` | Live scam-domain feed + pending-permits screen |
| 30 | TWV-2026-052 | `30_punycode_idn_warning_twv052_istaken_false.md` | Punycode rendering + IDN-homograph warning in URL bar |
| 31 | TWV-2026-054 | `31_signed_push_notifications_twv054_istaken_false.md` | Signed push notifications; no signature deeplinks from push |
| 32 | TWV-2026-056 | `32_bundle_integrity_runtime_twv056_istaken_false.md` | Launch-time bundle SHA-256 vs signed manifest check |
| 33 | TWV-2026-058 | `33_play_integrity_app_attest_twv058_istaken_false.md` | Play Integrity / App Attest on sign-above-threshold |
| 34 | TWV-2026-062 | `34_android_key_attestation_twv062_istaken_false.md` | Android Key Attestation chain validation at launch |

### Phase 3 — Track / policy

| # | TWV | File | Title |
|---|---|---|---|
| 35 | TWV-2026-006 | `35_release_integrity_sbom_twv006_istaken_false.md` | Release integrity, SBOM, reproducible builds |
| 36 | TWV-2026-017 | `36_no_silent_chain_switch_twv017_istaken_false.md` | No silent chain switches |
| 37 | TWV-2026-020 | `37_app_store_impersonation_watch_twv020_istaken_false.md` | App-store impersonation monitoring |
| 38 | TWV-2026-021 | `38_freeze_prototype_zod_twv021_istaken_false.md` | `Object.freeze(Object.prototype)` + Zod at bridge boundary |
| 39 | TWV-2026-025 | `39_tee_biometric_gate_twv025_istaken_false.md` | TEE-enforced biometric gate on SecureStore reads |
| 40 | TWV-2026-027 | `40_dnssec_rpki_infra_twv027_istaken_false.md` | DNSSEC / RPKI on owned infra |
| 41 | TWV-2026-028 | `41_multi_rpc_consensus_twv028_istaken_false.md` | Multi-RPC consensus for critical reads |
| 42 | TWV-2026-029 | `42_eip1559_and_chainid_only_twv029_istaken_false.md` | EIP-1559-only + chainId on every signed payload |
| 43 | TWV-2026-030 | `43_walletconnect_v2_securestore_twv030_istaken_false.md` | WalletConnect v2 via SecureStore (when integrated) |
| 44 | TWV-2026-031 | `44_eip6963_uuid_rdns_twv031_istaken_false.md` | Stable `uuid` + `rdns` for EIP-6963 announcement |
| 45 | TWV-2026-012 | `45_eip712_domain_display_twv012_istaken_false.md` | Always display EIP-712 `domain` fields |
| 46 | TWV-2026-014 | `46_redpill_resistant_sim_twv014_istaken_false.md` | Red-pill-resistant simulator review |
| 47 | TWV-2026-019 | `47_no_runtime_remote_js_twv019_istaken_false.md` | No runtime remote JS loading in app process |
| 48 | TWV-2026-034 | `48_reproducible_signer_ui_twv034_istaken_false.md` | Reproducible signer UI for any future multisig |
| 49 | TWV-2026-036 | `49_dev_machine_posture_twv036_istaken_false.md` | Dev-machine posture + OOB tx attestation |
| 50 | TWV-2026-037 | `50_hot_wallet_key_partition_twv037_istaken_false.md` | Partition hot-wallet keys per chain |
| 51 | TWV-2026-039 | `51_multisig_independence_twv039_istaken_false.md` | Independence property for multisig/guardian sets |
| 52 | TWV-2026-040 | `52_profanity_vanity_flag_twv040_istaken_false.md` | Flag known Profanity-class vanity-prefix patterns on import |
| 53 | TWV-2026-041 | `53_paymaster_allowlist_caps_twv041_istaken_false.md` | Paymaster allowlist + per-sender caps |
| 54 | TWV-2026-042 | `54_multi_bundler_fallback_twv042_istaken_false.md` | Multi-bundler fallback for UserOp submission |
| 55 | TWV-2026-043 | `55_social_recovery_safeguards_twv043_istaken_false.md` | Social-recovery time-lock + pinned guardians |
| 56 | TWV-2026-044 | `56_userop_hash_bind_entrypoint_twv044_istaken_false.md` | UserOp hash binds EntryPoint + chainId; ECDSA `s` normalised |
| 57 | TWV-2026-045 | `57_erc7562_validation_rules_twv045_istaken_false.md` | Enforce ERC-7562 validation rules on paymaster / bundler |
| 58 | TWV-2026-046 | `58_hw_pairing_attestation_twv046_istaken_false.md` | HW pairing: attestation + anti-klepto auxiliary entropy |
| 59 | TWV-2026-047 | `59_hw_pairing_ble_numeric_twv047_istaken_false.md` | HW pairing: numeric-comparison BLE; warn on multi-pair |
| 60 | TWV-2026-048 | `60_hw_firmware_disclosure_twv048_istaken_false.md` | HW pairing: show firmware version + release-notes link |
| 61 | TWV-2026-053 | `61_uniswap_v4_hook_allowlist_twv053_istaken_false.md` | Uniswap v4 hook address + allowlist display |
| 62 | TWV-2026-057 | `62_hermes_only_native_signing_twv057_istaken_false.md` | Hermes-only RN engine; native-layer signing |
| 63 | TWV-2026-063 | `63_no_clipboard_auto_read_twv063_istaken_false.md` | No clipboard auto-read; explicit "Paste" with BIP-39 warn |
| 64 | TWV-2026-065 | `64_distribution_discipline_twv065_istaken_false.md` | Official distribution discipline; SHA-256 in About screen |

### Phase 4 — Clear-signing adoption (build on shipped Phase 1/2 decoders)

| # | TWV | File | Title |
|---|---|---|---|
| 65 | TWV-2026-066 | `65_clear_signing_ai_translation_twv066_istaken_true_isfinish_true.md` | ERC-7730/8213 clear-signing decode + AI plain-English summary |

Task 65 is numbered after the Phase 3 block but isn't policy/future-gated
like most of Phase 3 — it directly upgrades already-shipped decoders
(`TWV-2026-008`, `TWV-2026-011`, `TWV-2026-012`). Treat it as
Phase-2-priority when scheduling, despite the number.

## Source of truth

`../wallet-security-vulnerabilities-spec.md` is the canonical spec.
These task files are a projection of it — if anything here disagrees
with the spec, **the spec wins**. Update the spec first, then update
the task.

`TWV-2026-001` is browser-extension-specific (Demonic / `<input>`
restore-session leak) and has no mobile code-path today; it is tracked
in the spec but not scheduled as a task here. Re-open a task if a
WebView ever hosts seed-entry UI.
