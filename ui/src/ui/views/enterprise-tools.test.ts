import { describe, expect, it } from "vitest";
import { listCoreToolSections } from "../../../../src/agents/tool-catalog.js";
import { ENTERPRISE_TOOL_IDS } from "./enterprise.ts";

// The Tools sub-tab lists the enterprise tool catalog from a UI-side constant (the
// Control UI cannot import the server catalog at runtime). Pin it to the runtime
// source of truth so a new enterprise tool cannot appear in the runtime yet be
// missing from — or misgrouped in — the operator's Tools tab.
describe("enterprise Tools tab catalog", () => {
  it("stays in sync with the server tool catalog (group:enterprise / enterprise-write)", () => {
    const byId = new Map(
      listCoreToolSections().map((section) => [
        section.id,
        section.tools.map((tool) => tool.id).toSorted(),
      ]),
    );
    expect([...ENTERPRISE_TOOL_IDS.read].toSorted()).toEqual(byId.get("enterprise"));
    expect([...ENTERPRISE_TOOL_IDS.write].toSorted()).toEqual(byId.get("enterprise-write"));
  });
});
