/**
 * MWA origin attestation — app wiring for `attestationCore.ts`: encrypted
 * MMKV `mwa.v1`, the deep-link notice host, and the MWA activity's
 * private return scheme (`<app scheme>-mwa://attest/return`, declared by
 * `plugins/withSolanaMobileWalletAdapter.js`).
 */

import { APP_SCHEME } from "@/constants/appVariant";
import { deepLinkNotices } from "@/services/deeplinks/notices";
import { openEncryptedMmkv } from "@/services/security/encryptedMmkv";
import { MwaAttestation } from "./attestationCore";
import { parseProvisionReturn } from "./attestationToken";
import { MWA_MMKV_ID, MWA_MMKV_SECURE_KEY } from "./scopeStore";

export {
  type AttestationBrowser,
  CHALLENGE_TTL_MS,
  MWA_ATTEST_ORIGIN_URI,
  MwaAttestation,
  type PendingChallenge,
  type ProvisionedKey,
} from "./attestationCore";
export { parseProvisionReturn };

/**
 * Private scheme of the MWA host activity (declared by the config plugin
 * as `<app scheme>-mwa`), so the provisioning return lands in the MWA
 * task rather than `MainActivity`.
 */
export const MWA_ACTIVITY_SCHEME = `${APP_SCHEME}-mwa`;
export const MWA_ATTEST_RETURN_URL = `${MWA_ACTIVITY_SCHEME}://attest/return`;

export const mwaAttestation = new MwaAttestation({
  store: () => openEncryptedMmkv(MWA_MMKV_ID, MWA_MMKV_SECURE_KEY),
  returnUrl: MWA_ATTEST_RETURN_URL,
  notify: (n) => deepLinkNotices.push(n),
});
