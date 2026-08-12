/**
 * Sui Kiosk / TransferPolicy semantic pass — spec §4 (phase C).
 *
 * Why this decodes without simulation: `0x2::kiosk::purchase` returns a
 * `TransferRequest`, a struct with neither `drop` nor `store`. The only
 * way to consume it is `transfer_policy::confirm_request`, and if the
 * PTB ends without doing so the whole block aborts. That "hot potato"
 * rule means the full economic picture of a purchase — item, price and
 * every rule payment — is statically present in the command list,
 * because the protocol will not let it be anywhere else.
 *
 * Price attribution follows PTB data flow rather than guessing: the
 * `payment` argument is a `Result` reference back to a `SplitCoins`
 * whose amount is a `pure` u64, so it resolves offline. When the coin
 * is forwarded from somewhere we cannot follow, the pass reports the
 * item and the rules and marks the price unresolved.
 */

import type { SuiArgRef, SuiDecodedCommand, SuiPtbSemantic } from "../payloads";
import {
  formatMist,
  type PtbSemanticContext,
  type PtbSemanticPass,
  pureAsU64,
} from "../ptbSemantics";

const FRAMEWORK = "0x2";

/** `0x0000…0002` and `0x2` are the same package; compare canonically. */
function normalizePackage(pkg: string): string {
  const hex = pkg.startsWith("0x") ? pkg.slice(2) : pkg;
  const trimmed = hex.replace(/^0+/, "");
  return `0x${trimmed === "" ? "0" : trimmed}`;
}

type MoveCall = Extract<SuiDecodedCommand, { kind: "MoveCall" }>;

function isCall(
  c: SuiDecodedCommand,
  module: string,
  fn: string | string[],
): c is MoveCall {
  if (c.kind !== "MoveCall") return false;
  if (normalizePackage(c.package) !== FRAMEWORK) return false;
  if (c.module !== module) return false;
  return Array.isArray(fn) ? fn.includes(c.function) : c.function === fn;
}

/**
 * Resolve how much SUI a coin argument carries, by walking back to the
 * `SplitCoins` that produced it. Returns `null` when the trail leaves
 * the PTB (a coin passed in as an input, or forwarded from a command we
 * do not model) — the caller renders "unresolved" rather than a guess.
 */
function resolveCoinAmount(
  arg: SuiArgRef | undefined,
  ctx: PtbSemanticContext,
): bigint | null {
  if (!arg || arg.kind !== "result") return null;
  const producer = ctx.commands[arg.command];
  if (!producer || producer.kind !== "SplitCoins") return null;
  // A `SplitCoins` can mint several coins; `nested` picks which one.
  const which = arg.nested ?? 0;
  const amountArg = producer.amountArgs?.[which];
  if (!amountArg || amountArg.kind !== "input") return null;
  return pureAsU64(ctx.inputs[amountArg.index]);
}

/** Item type is the first type argument on the kiosk call. */
function itemType(call: MoveCall): string | null {
  return call.typeArguments?.[0] ?? null;
}

/**
 * Rule payments are `<pkg>::<something>_rule::pay` calls sitting between
 * the purchase and its `confirm_request`. Matching on the module suffix
 * rather than an address list is deliberate: royalty and fee rules are
 * deployed per-collection, so an allowlist would silently miss most of
 * them and under-report the true cost.
 */
function isRulePayment(c: SuiDecodedCommand): c is MoveCall {
  return (
    c.kind === "MoveCall" && c.module.endsWith("_rule") && c.function === "pay"
  );
}

export const KioskSemanticPass: PtbSemanticPass = {
  name: "sui-kiosk",
  run(ctx): SuiPtbSemantic[] | null {
    const out: SuiPtbSemantic[] = [];

    const purchases = ctx.commands.filter((c) =>
      isCall(c, "kiosk", "purchase"),
    );
    const listings = ctx.commands.filter((c) =>
      isCall(c, "kiosk", ["list", "place_and_list"]),
    );
    const takes = ctx.commands.filter((c) =>
      isCall(c, "kiosk", ["take", "delist"]),
    );
    const confirms = ctx.commands.filter((c) =>
      isCall(c, "transfer_policy", "confirm_request"),
    );

    if (purchases.length === 0 && listings.length === 0 && takes.length === 0) {
      return null;
    }

    for (const p of purchases) {
      const fields: Array<{ label: string; value: string }> = [];
      const type = itemType(p);
      if (type) fields.push({ label: "Item", value: type });

      // `purchase(self, id, payment)` — the coin is the third argument.
      const price = resolveCoinAmount(p.arguments?.[2], ctx);
      fields.push({
        label: "Price",
        value: price === null ? "Could not be read" : formatMist(price),
      });

      const rulePayments = ctx.commands.filter(isRulePayment);
      let ruleTotal = 0n;
      let ruleUnresolved = false;
      for (const r of rulePayments) {
        // `pay(policy, request, payment, ...)` — coin is argument 2.
        const amount = resolveCoinAmount(r.arguments?.[2], ctx);
        if (amount === null) ruleUnresolved = true;
        else ruleTotal += amount;
      }
      if (rulePayments.length > 0) {
        fields.push({
          label: "Creator fees",
          value: ruleUnresolved ? "Could not be read" : formatMist(ruleTotal),
        });
        if (price !== null && !ruleUnresolved) {
          fields.push({
            label: "Total cost",
            value: formatMist(price + ruleTotal),
          });
        }
      }

      out.push({
        code: "kiosk.purchase",
        title: "Buy an item from a kiosk",
        fields,
      });
    }

    // A purchase whose TransferRequest is never confirmed cannot succeed
    // on-chain. Surfacing it is worthwhile even though the network would
    // reject it: a PTB shaped this way is either broken or probing.
    if (purchases.length > confirms.length) {
      out.push({
        code: "kiosk.unconfirmed-request",
        title: "Purchase is missing its policy confirmation",
        fields: [
          {
            label: "What this means",
            value:
              "This purchase does not complete the transfer policy step, so the network will reject it. Only continue if you expected that.",
          },
        ],
        severity: "warn",
      });
    }

    for (const l of listings) {
      const fields: Array<{ label: string; value: string }> = [];
      const type = itemType(l);
      if (type) fields.push({ label: "Item", value: type });
      // `list(self, cap, id, price)` / `place_and_list(self, cap, item, price)`
      const priceArg = l.arguments?.[3];
      const price =
        priceArg?.kind === "input"
          ? pureAsU64(ctx.inputs[priceArg.index])
          : null;
      fields.push({
        label: "Asking price",
        value: price === null ? "Could not be read" : formatMist(price),
      });
      out.push({
        code: "kiosk.list",
        title: "List an item for sale",
        fields,
      });
    }

    for (const t of takes) {
      const type = itemType(t);
      out.push({
        code: "kiosk.take",
        title:
          t.function === "delist"
            ? "Remove an item from sale"
            : "Withdraw an item from a kiosk",
        fields: type ? [{ label: "Item", value: type }] : [],
      });
    }

    return out;
  },
};
