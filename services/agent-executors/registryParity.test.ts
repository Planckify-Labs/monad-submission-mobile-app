import { describe, expect, it } from "vitest";
// @ts-expect-error relative import outside project root
import { TOOL_REGISTRY } from "../../../agent-api/src/tools/registry";
// Import the PURE list module (no RN executor graph) so this test can run
// under vitest — see `expectedMobileTools.ts` header.
import {
  EXPECTED_MOBILE_TOOLS,
  MOBILE_WRITE_TOOLS,
} from "./expectedMobileTools";

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
});
