import { describe, expect, it } from "vitest";
import { applyEnterpriseDefaults } from "./defaults.js";
import { materializeRuntimeConfig } from "./materialize.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { EnterpriseConfigSchema } from "./zod-schema.enterprise.js";

describe("EnterpriseConfigSchema", () => {
  it("accepts a full enterprise section", () => {
    const result = EnterpriseConfigSchema.safeParse({
      mode: "observe",
      governance: {
        policies: [
          {
            id: "finance.deny-exec",
            description: "Finance workflows must not run shell commands.",
            effect: "deny",
            trees: ["finance.*"],
            nodes: ["finance.review"],
            tools: ["exec", "process"],
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty/omitted section", () => {
    expect(EnterpriseConfigSchema.safeParse(undefined).success).toBe(true);
    expect(EnterpriseConfigSchema.safeParse({}).success).toBe(true);
  });

  it("rejects unknown modes, unknown keys, and malformed policy ids", () => {
    expect(EnterpriseConfigSchema.safeParse({ mode: "strict" }).success).toBe(false);
    expect(EnterpriseConfigSchema.safeParse({ unknown: true }).success).toBe(false);
    expect(
      EnterpriseConfigSchema.safeParse({
        governance: { policies: [{ id: "Bad Id", effect: "deny" }] },
      }).success,
    ).toBe(false);
    expect(
      EnterpriseConfigSchema.safeParse({
        governance: { policies: [{ id: "ok.id", effect: "require_approval" }] },
      }).success,
    ).toBe(false);
  });

  it("rejects empty selector arrays (omit means run-level, not empty)", () => {
    for (const selector of ["tools", "trees", "nodes"] as const) {
      const result = EnterpriseConfigSchema.safeParse({
        governance: { policies: [{ id: "ok.id", effect: "deny", [selector]: [] }] },
      });
      expect(result.success, `${selector}: [] must be rejected`).toBe(false);
    }
  });

  it("rejects blank selector entries (matcher would widen them to match-all)", () => {
    for (const selector of ["tools", "trees", "nodes"] as const) {
      const result = EnterpriseConfigSchema.safeParse({
        governance: { policies: [{ id: "ok.id", effect: "deny", [selector]: [" "] }] },
      });
      expect(result.success, `${selector}: [" "] must be rejected`).toBe(false);
    }
  });
});

describe("applyEnterpriseDefaults", () => {
  it("defaults enterprise mode to enforce (default-on)", () => {
    const cfg: OpenClawConfig = {};
    const next = applyEnterpriseDefaults(cfg);
    expect(next.enterprise?.mode).toBe("enforce");
  });

  it("returns the same reference when a mode is already set", () => {
    const cfg: OpenClawConfig = { enterprise: { mode: "off" } };
    expect(applyEnterpriseDefaults(cfg)).toBe(cfg);
  });

  it("preserves sibling enterprise settings when defaulting the mode", () => {
    const cfg: OpenClawConfig = {
      enterprise: { governance: { policies: [{ id: "p.one", effect: "audit" }] } },
    };
    const next = applyEnterpriseDefaults(cfg);
    expect(next.enterprise?.mode).toBe("enforce");
    expect(next.enterprise?.governance?.policies).toHaveLength(1);
  });

  it("is applied by materializeRuntimeConfig", () => {
    const runtime = materializeRuntimeConfig({}, "load");
    expect(runtime.enterprise?.mode).toBe("enforce");
    const optedOut = materializeRuntimeConfig({ enterprise: { mode: "off" } }, "load");
    expect(optedOut.enterprise?.mode).toBe("off");
  });
});
