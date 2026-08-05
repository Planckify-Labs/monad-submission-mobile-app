/**
 * Stellar bridge capability — CAIP ids, execution, destination readiness.
 *
 * Spec: docs/bridge-capability-spec.md §5.1, §5.2, §5.4, §7.5.
 *
 * Docked onto `StellarWalletKit` as optional, presence-checked methods
 * (`feedback_space_docking`).
 *
 * ## Why Stellar is the reason §7.5 exists
 *
 * Every other namespace's destination precondition is "have some gas".
 * Stellar's is a TRUSTLINE plus the XLM base reserve, and a trustline is
 * a hard precondition the recipient must have opted into. Our own code
 * says it best (`services/chains/stellar/trustlineService.ts`):
 *
 *   "no amount of sender-side signing can complete a transfer to an
 *    account that hasn't opted in."
 *
 * That is a different CLASS of problem from missing gas, which is why
 * §10.4 reframed the question from "does the destination need an
 * approve?" to per-namespace readiness. Every primitive we need already
 * exists — `hasTrustline`, `ensureTrustline`, `detectAccountFunded`,
 * `computeMinBalanceStroops`, `BASE_RESERVE_STROOPS` — and
 * `ensureTrustline` works on the caller's OWN wallet, which is exactly
 * our case: one mnemonic, so the Stellar wallet is the user's.
 *
 * Note also that Stellar has NO Fast Transfer and NO Forwarding Service
 * (§2.3, §7.5.1), so the warning path here is mandatory rather than an
 * optimisation.
 */

import type { ChainConfig } from "@/constants/configs/chainConfig";
import {
  BASE_RESERVE_STROOPS,
  computeMinBalanceStroops,
  detectAccountFunded,
} from "@/services/chains/stellar/accountState";
import { getHorizonClient } from "@/services/chains/stellar/horizonClient";
import { hasTrustline } from "@/services/chains/stellar/trustlineService";
import {
  type BridgeDestinationReadinessArgs,
  BridgePayloadUnsupportedError,
  type BridgeReadinessBlocker,
  type SubmitBridgeExecutionArgs,
} from "../types";

const STELLAR_NAMESPACE = "stellar" as const;

/**
 * Internal `ChainConfig.network` → CAIP-2 reference.
 *
 * This is the one namespace where the CAIP-2 wire reference diverges from
 * the app's internal value: CAIP-28 says `pubnet`, NOT `mainnet`. Getting
 * this wrong routes to a chain id nothing recognises.
 */
function caipReference(network: "mainnet" | "testnet"): "pubnet" | "testnet" {
  return network === "mainnet" ? "pubnet" : "testnet";
}

export function stellarCaip2For(chain: ChainConfig): string | null {
  return chain.namespace === STELLAR_NAMESPACE
    ? `${STELLAR_NAMESPACE}:${caipReference(chain.network)}`
    : null;
}

/**
 * CAIP-19 asset namespace for a Stellar classic asset.
 *
 * CAIP-19 constrains `asset_namespace` to `[-a-z0-9]{3,8}` (verified
 * against the CAIP-19 spec), so the descriptive `credit_alphanum4` /
 * `credit_alphanum12` names are NOT legal: they carry an underscore and
 * exceed 8 characters. There is no registered Stellar CAIP-19 profile at
 * time of writing, so we use the grammar-valid `asset` and document it
 * here rather than emit an id that fails its own spec.
 */
const STELLAR_ASSET_NAMESPACE = "asset";

/**
 * Internal `CODE:ISSUER` ⇄ CAIP-19 `CODE-ISSUER`.
 *
 * The app's `contractAddress` column carries Stellar assets as
 * `CODE:ISSUER`, but CAIP-19's `asset_reference` grammar is
 * `[-.%a-zA-Z0-9]{1,128}` and excludes the colon. `CODE-ISSUER` is both
 * grammar-valid AND Stellar's own canonical display form (the one
 * stellar.expert uses), so the round trip is lossless: asset codes are
 * alphanumeric only, so the FIRST hyphen is always the separator.
 *
 * Keeping this translation inside the Stellar kit is the point: no shared
 * code has to know that Stellar encodes assets differently from everyone
 * else.
 */
export function stellarToAssetCaip19(
  chain: ChainConfig,
  contractAddress?: string | null,
): string | null {
  const caip2 = stellarCaip2For(chain);
  if (!caip2) return null;
  if (!contractAddress) return `${caip2}/native`;

  // The issuer strkey is CASE-SENSITIVE, so it passes through verbatim
  // (`feedback_address_case_per_encoding`).
  const idx = contractAddress.indexOf(":");
  const reference =
    idx > 0
      ? `${contractAddress.slice(0, idx)}-${contractAddress.slice(idx + 1)}`
      : contractAddress;
  return `${caip2}/${STELLAR_ASSET_NAMESPACE}:${reference}`;
}

/**
 * The reverse of {@link stellarToAssetCaip19}: CAIP-19 back to the
 * `CODE:ISSUER` shape `sendTokenTransfer` / `hasTrustline` expect.
 * Returns `null` for the native asset, matching the "no contract" signal
 * those APIs already use.
 */
export function stellarFromAssetCaip19(asset: string): string | null {
  const slash = asset.indexOf("/");
  if (slash < 0) return null;
  const tail = asset.slice(slash + 1);
  if (tail === "native" || tail.startsWith("slip44:")) return null;

  const colon = tail.indexOf(":");
  if (colon < 0) return null;
  const reference = tail.slice(colon + 1);
  const hyphen = reference.indexOf("-");
  return hyphen > 0
    ? `${reference.slice(0, hyphen)}:${reference.slice(hyphen + 1)}`
    : reference;
}

/**
 * Stellar has no LI.FI route (§3.2), so no provider hands us a
 * serialised Stellar transaction to sign today. The CCTP path burns on an
 * EVM source and the destination mint is atomic and non-custodial inside
 * `CctpForwarder` — nothing for this wallet to sign at all.
 *
 * The method is still implemented so a future Stellar-source bridge docks
 * by extending it rather than by editing shared code, and so an
 * unexpected payload fails loudly with a typed error instead of silently
 * doing nothing.
 */
export async function stellarSubmitBridgeExecution({
  payload,
}: SubmitBridgeExecutionArgs): Promise<string> {
  throw new BridgePayloadUnsupportedError(payload.kind);
}

/**
 * Headroom above the account's computed minimum balance. Adding a
 * trustline consumes one more base reserve (0.5 XLM), so an account
 * sitting exactly at its floor cannot opt in even though it "has" XLM.
 */
const TRUSTLINE_HEADROOM_STROOPS = BASE_RESERVE_STROOPS + 1_000_000n;

const SUGGESTED_TOP_UP_USD = 2;

/**
 * Stellar destination readiness.
 *
 * Three distinct blockers, in dependency order:
 *   1. The account does not exist on the ledger at all.
 *   2. It exists but has no trustline to the incoming asset. Without one
 *      the transfer CANNOT complete — this is `blocking`, not a warning.
 *   3. It has a trustline but is at its reserve floor, so it cannot
 *      afford another subentry or a fee.
 *
 * Copy is hand-written and carries no em-dashes (`feedback_no_emdash_in_ui_copy`).
 */
export async function stellarCheckBridgeDestinationReadiness({
  chain,
  address,
  contractAddress,
  assetCaip19,
}: BridgeDestinationReadinessArgs): Promise<BridgeReadinessBlocker[]> {
  if (chain.namespace !== STELLAR_NAMESPACE) return [];

  const horizon = getHorizonClient(chain);

  let funded: boolean;
  try {
    funded = await detectAccountFunded(horizon, address);
  } catch {
    // A check that cannot run must not invent a blocker: warning on
    // incomplete information trains users to dismiss the real warning.
    return [];
  }

  if (!funded) {
    return [
      {
        code: "account_not_funded",
        message:
          "This Stellar account has not been created yet. It needs a small amount of XLM before it can hold any asset.",
        severity: "blocking",
        remedy: {
          kind: "fund_account",
          minimumRaw: (BASE_RESERVE_STROOPS * 2n).toString(),
          symbol: "XLM",
        },
      },
    ];
  }

  if (contractAddress) {
    const idx = contractAddress.indexOf(":");
    if (idx > 0 && idx < contractAddress.length - 1) {
      const code = contractAddress.slice(0, idx);
      const issuer = contractAddress.slice(idx + 1);

      let trusts: boolean;
      try {
        trusts = await hasTrustline(horizon, address, code, issuer);
      } catch {
        return [];
      }

      if (!trusts) {
        return [
          {
            code: "missing_trustline",
            message: `This account has not set up ${code} yet. Funds cannot arrive until a trustline is added, which locks 0.5 XLM as a reserve.`,
            severity: "blocking",
            remedy: {
              kind: "establish_trustline",
              asset:
                assetCaip19 ??
                stellarToAssetCaip19(chain, contractAddress) ??
                contractAddress,
            },
          },
        ];
      }
    }
  }

  // Trustline present. Check there is room above the reserve floor to
  // actually move the funds afterwards.
  try {
    const account = await horizon.loadAccount(address);
    const native = account.balances.find((b) => b.asset_type === "native");
    const balanceStroops = native
      ? BigInt(Math.round(Number.parseFloat(native.balance) * 10_000_000))
      : 0n;
    const minBalance = computeMinBalanceStroops(account);
    if (balanceStroops < minBalance + TRUSTLINE_HEADROOM_STROOPS) {
      return [
        {
          code: "no_destination_gas",
          message:
            "This Stellar account is at its minimum XLM reserve. You will not be able to move these funds after they arrive.",
          severity: "warning",
          remedy: { kind: "gas_top_up", suggestedUsd: SUGGESTED_TOP_UP_USD },
        },
      ];
    }
  } catch {
    return [];
  }

  return [];
}
