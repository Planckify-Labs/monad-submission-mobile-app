/**
 * Sui package publish / upgrade semantic pass — spec §2.4 (phase B).
 *
 * The structural decoder already reports that a PTB publishes or
 * upgrades, but only as module and dependency *counts*. For an upgrade
 * that is the wrong summary: replacing the code behind a live package
 * is one of the highest-consequence actions a wallet can authorise, and
 * "2 modules, 5 dependencies" conveys none of it.
 *
 * The two facts that matter are which package is being replaced and
 * which `UpgradeCap` is being spent to do it. The cap does not appear on
 * the `Upgrade` command itself — it is consumed by a
 * `0x2::package::authorize_upgrade` call earlier in the same PTB, which
 * mints the `UpgradeTicket` the upgrade then redeems. This pass follows
 * that link.
 */

import type { SuiDecodedCommand, SuiPtbSemantic } from "../payloads";
import type { PtbSemanticContext, PtbSemanticPass } from "../ptbSemantics";

const FRAMEWORK = "0x2";

function normalizePackage(pkg: string): string {
  const hex = pkg.startsWith("0x") ? pkg.slice(2) : pkg;
  const trimmed = hex.replace(/^0+/, "");
  return `0x${trimmed === "" ? "0" : trimmed}`;
}

type MoveCall = Extract<SuiDecodedCommand, { kind: "MoveCall" }>;

function isFrameworkCall(
  c: SuiDecodedCommand,
  module: string,
  fn: string,
): c is MoveCall {
  return (
    c.kind === "MoveCall" &&
    normalizePackage(c.package) === FRAMEWORK &&
    c.module === module &&
    c.function === fn
  );
}

/** Resolve an argument that should be an object input to its object id. */
function objectIdOfArg(
  call: MoveCall,
  argIndex: number,
  ctx: PtbSemanticContext,
): string | null {
  const arg = call.arguments?.[argIndex];
  if (!arg || arg.kind !== "input") return null;
  const input = ctx.inputs[arg.index];
  if (!input || input.kind !== "object") return null;
  return input.objectId ?? null;
}

function moduleSummary(
  names: string[] | undefined,
  count: number,
): { label: string; value: string } {
  if (names && names.length > 0) {
    return { label: "Modules", value: names.join(", ") };
  }
  // Names are omitted rather than partially reported when the bytecode
  // parse did not fully succeed; fall back to the honest count.
  return { label: "Modules", value: String(count) };
}

export const PackageSemanticPass: PtbSemanticPass = {
  name: "sui-package",
  run(ctx): SuiPtbSemantic[] | null {
    const out: SuiPtbSemantic[] = [];

    for (const c of ctx.commands) {
      if (c.kind === "Publish") {
        const fields = [moduleSummary(c.moduleNames, c.modules)];
        if (c.moduleBytes !== undefined) {
          fields.push({
            label: "Code size",
            value: `${c.moduleBytes.toLocaleString()} bytes`,
          });
        }
        if (c.dependencyIds?.length) {
          fields.push({
            label: "Depends on",
            value: c.dependencyIds.join(", "),
          });
        } else {
          fields.push({ label: "Dependencies", value: String(c.dependencies) });
        }
        out.push({
          code: "package.publish",
          title: "Publish a new package",
          fields,
        });
      }

      if (c.kind === "Upgrade") {
        const fields: Array<{ label: string; value: string }> = [];
        if (c.packageId) {
          fields.push({ label: "Replaces package", value: c.packageId });
        }
        fields.push(moduleSummary(c.moduleNames, c.modules));
        if (c.moduleBytes !== undefined) {
          fields.push({
            label: "Code size",
            value: `${c.moduleBytes.toLocaleString()} bytes`,
          });
        }

        // The cap is spent by the authorize_upgrade call that minted the
        // ticket this command redeems.
        const authorize = ctx.commands.find((x) =>
          isFrameworkCall(x, "package", "authorize_upgrade"),
        ) as MoveCall | undefined;
        const capId = authorize ? objectIdOfArg(authorize, 0, ctx) : null;
        fields.push({
          label: "Upgrade authority",
          value: capId ?? "Could not be read",
        });
        fields.push({
          label: "What this means",
          value:
            "This replaces the code of a package that is already live. Anyone using it will run the new code from now on.",
        });

        out.push({
          code: "package.upgrade",
          title: "Upgrade an existing package",
          fields,
          severity: "warn",
        });
      }
    }

    return out.length > 0 ? out : null;
  },
};
