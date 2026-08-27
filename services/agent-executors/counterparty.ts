/**
 * Which argument of a write tool names the COUNTERPARTY — the address
 * value ends up at, or that gains control of it.
 *
 * Deny-layer spec §4.0 extension: the "known destination" envelope. A
 * grant says the agent may act without asking; it does not say the user
 * accepts a destination they have never seen. `authorizeToolCall` uses
 * this to escalate an authorized write back to `ask` the first time funds
 * are pointed at a given address.
 *
 * ## Why a table and not a `switch`
 *
 * This is DATA about each tool's schema, resolved by lookup — adding a
 * tool is adding a row, and no shared code branches on a namespace to
 * read it. Namespaces appear here as VALUES (which chain family a
 * per-chain tool inherently targets), never as comparisons.
 *
 * ## Pure by design
 *
 * `authorizeToolCall` is a pure, synchronous gate whose whole test matrix
 * depends on staying that way, so this module imports nothing but types.
 * Address canonicalisation and the confirmed-address store are INJECTED
 * into the gate instead (same pattern as `ConnectedWallet.grantStore`),
 * because both reach the wallet-kit registry.
 */

import { bridgeDestinationChoice } from "@/services/bridgeRoutes/destinationChoice";
import type { Namespace } from "@/services/chains/types";
import type { ToolInput } from "./types.ts";

export interface ToolCounterparty {
  address: string;
  namespace: Namespace;
}

interface CounterpartyField {
  /** Input key holding the address. */
  field: string;
  /**
   * Namespace this tool inherently targets. Per-chain tools (`send_sol`,
   * `send_xlm`, …) are pinned; chain-agnostic ones resolve at call time.
   */
  namespace?: Namespace;
  /**
   * Input key holding a CAIP-2 id to take the namespace from — for tools
   * whose destination chain is an argument rather than implied
   * (`bridge_execute`'s `to_chain`).
   */
  namespaceFromCaip2Field?: string;
  /**
   * Input key naming the chain whose LIVE USER OVERRIDE outranks the
   * argument (`bridge_execute`'s `to_chain`).
   *
   * The gate must vet the address that will actually be signed, not the
   * one the model asked for. Those diverge exactly when the user has just
   * switched destination on the card: the executor resolves to their
   * pick, while the model's argument still names the previous wallet. If
   * that previous wallet happened to be an established one, checking the
   * argument would report "known" and wave through a transfer to an
   * address that is NOT established — silently skipping the very ask this
   * envelope exists to force.
   */
  overrideFromChainField?: string;
}

/**
 * Write tools that point value at a user-supplied address.
 *
 * Keep in sync with `MOBILE_WRITE_TOOLS`; `counterparty.test.ts` fails if
 * a write tool is missing from BOTH this table and the exempt set below,
 * so a new one cannot silently skip the envelope.
 */
const COUNTERPARTY_FIELDS: Record<string, CounterpartyField> = {
  // chain-agnostic capability sends — namespace follows the paying wallet
  send_native: { field: "to" },
  send_token: { field: "to" },
  // evm
  send_native_token: { field: "to", namespace: "eip155" },
  transfer_erc20: { field: "to", namespace: "eip155" },
  // An allowance hands ongoing spending authority to the spender, which is
  // a counterparty in every sense that matters here.
  approve_erc20: { field: "spender", namespace: "eip155" },
  // solana
  send_sol: { field: "to", namespace: "solana" },
  send_spl_token: { field: "to", namespace: "solana" },
  // sui
  send_sui: { field: "to", namespace: "sui" },
  send_sui_coin: { field: "to", namespace: "sui" },
  // stellar
  send_xlm: { field: "to", namespace: "stellar" },
  send_stellar_asset: { field: "to", namespace: "stellar" },
  // bridge — destination chain is an argument, so is its namespace, and
  // the card's wallet switcher can override the address outright.
  bridge_execute: {
    field: "to_address",
    namespaceFromCaip2Field: "to_chain",
    overrideFromChainField: "to_chain",
  },
};

/**
 * Write tools with NO user-supplied counterparty, and why. Listed
 * explicitly rather than defaulted so the omission is a decision on the
 * record, not an oversight.
 */
export const TOOLS_WITHOUT_COUNTERPARTY: ReadonlySet<string> = new Set([
  // Arbitrary contract call. Its risk lives in the calldata, which this
  // envelope cannot read — a confirmed contract address would imply a
  // safety guarantee we are not making. Still gets the run-down veto.
  "write_contract",
  // Destination is a protocol contract resolved server-side from the
  // opportunity registry, never a user-typed address. The opportunity
  // card is where that venue is disclosed.
  "defi_deposit",
  "defi_withdraw",
  "defi_claim",
  "defi_rebalance",
  "defi_cross_chain_deposit",
  "defi_compound",
  "defi_intent_execute",
  // Creates a reminder, not a transfer. There is no destination at setup
  // time; the venue is disclosed on the opportunity card each cycle, when
  // the user actually approves a deposit.
  "defi_set_recurring_invest",
  // Settles inside a pre-signed on-chain allowance whose caveats are the
  // hard ceiling; there is no address for the user to vet per call.
  "x402_fetch",
  // First-party rails — the counterparty is TakumiPay itself.
  "deposit_points",
  "execute_redemption",
  "execute_booking_sol",
  "deposit_points_sol",
  // Authorises an ASSET, moves no value to anyone.
  "establish_stellar_trustline",
]);

function readString(input: ToolInput, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The counterparty of this call, or `null` when the tool has none (or the
 * argument is absent — an omitted destination is resolved downstream by
 * the executor, and there is nothing to vet yet).
 *
 * `fallbackNamespace` is the paying wallet's, used by the chain-agnostic
 * send capabilities whose target chain is the wallet's own.
 */
export function extractCounterparty(
  toolName: string,
  input: ToolInput | undefined,
  fallbackNamespace: Namespace | undefined,
): ToolCounterparty | null {
  const descriptor = COUNTERPARTY_FIELDS[toolName];
  if (!descriptor || !input) return null;

  // A live user override outranks the argument — see
  // `overrideFromChainField`. Read BEFORE the argument so a switch the
  // model has not caught up with is still what gets vetted.
  const overrideChain = descriptor.overrideFromChainField
    ? readString(input, descriptor.overrideFromChainField)
    : null;
  const override = overrideChain
    ? bridgeDestinationChoice.get(overrideChain)
    : null;

  const address = override ?? readString(input, descriptor.field);
  if (!address) return null;

  let namespace = descriptor.namespace;
  if (!namespace && descriptor.namespaceFromCaip2Field) {
    // CAIP-2 is `<namespace>:<reference>`; only the head is needed and a
    // local split keeps this module dependency-free.
    const caip2 = readString(input, descriptor.namespaceFromCaip2Field);
    const head = caip2?.split(":")[0];
    if (head) namespace = head as Namespace;
  }
  namespace ??= fallbackNamespace;
  if (!namespace) return null;

  return { address, namespace };
}

/** Test-only: the tools this envelope claims to cover. */
export const COUNTERPARTY_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.keys(COUNTERPARTY_FIELDS),
);
