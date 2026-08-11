import { describe, expect, it } from "vitest";
// @ts-expect-error relative import outside project root
import { TOOL_REGISTRY } from "../../../agent-api/src/tools/registry";
// Import the PURE list module (no RN executor graph) so this test can run
// under vitest — see `expectedMobileTools.ts` header.
import {
  EXPECTED_MOBILE_TOOLS,
  MOBILE_WRITE_TOOLS,
} from "./expectedMobileTools";
import { TOOL_NAMESPACE_ROLES } from "./toolNamespaceRoles";

describe("Registry Parity", () => {
  it("should match EXPECTED_MOBILE_TOOLS with server registry mobile executors", () => {
    const serverMobileTools = Object.values(TOOL_REGISTRY)
      .filter((t: any) => t.executor === "mobile")
      .map((t: any) => t.name)
      .sort();

    const expectedTools = [...EXPECTED_MOBILE_TOOLS].sort();

    expect(serverMobileTools).toEqual(expectedTools);
  });

  // Fund-safety: `MOBILE_WRITE_TOOLS` is the mobile's OWN, wire-independent
  // notion of which tools are writes (used by `authorizeToolCall` to refuse to
  // run a mislabeled write silently). It MUST equal exactly the set of mobile
  // tools the server registry declares `capability: "write"`. If a new write
  // tool is added server-side but not mirrored here, it would ship WITHOUT the
  // cross-check — so fail CI here instead of silently losing the protection.
  it("MOBILE_WRITE_TOOLS matches server mobile tools with capability=write", () => {
    const serverWriteTools = Object.values(TOOL_REGISTRY)
      .filter((t: any) => t.executor === "mobile" && t.capability === "write")
      .map((t: any) => t.name)
      .sort();

    const mobileWriteTools = [...MOBILE_WRITE_TOOLS].sort();

    expect(mobileWriteTools).toEqual(serverWriteTools);
  });

  // The app supports four namespaces but a private-key import covers only
  // ONE, so every tool has to answer "what if the user holds no key on the
  // chain this touches?". Leaving that to each tool produced 85 independent
  // answers and a family of failures that blamed the network for a missing
  // wallet. Requiring a declaration makes the question unskippable: a new
  // tool without one fails here rather than shipping with whatever its
  // author happened to assume.
  it("every mobile tool declares a namespace role", () => {
    const declared = Object.keys(TOOL_NAMESPACE_ROLES).sort();
    const expected = [...EXPECTED_MOBILE_TOOLS].sort();

    expect(declared).toEqual(expected);
  });

  // A `counterparty` tool is one that can name a chain other than the
  // active wallet's, so it must say WHERE that chain comes from — either
  // an input key or a namespace fixed by the tool. A spec carrying
  // neither would silently resolve to "no chain" and skip the check it
  // was declared to get.
  it("counterparty roles resolve a chain", () => {
    for (const [name, spec] of Object.entries(TOOL_NAMESPACE_ROLES)) {
      if (spec.role !== "counterparty") continue;
      const resolvable =
        ("chainArg" in spec && spec.chainArg.length > 0) ||
        ("namespace" in spec && !!spec.namespace);
      expect(resolvable, `${name} declares no chain source`).toBe(true);
    }
  });
});
