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

  it("accepts a knowledge-scoped policy but rejects require_approval on knowledge", () => {
    expect(
      EnterpriseConfigSchema.safeParse({
        governance: {
          policies: [
            { id: "kb.deny", effect: "deny", knowledge: ["acme.secret-*"] },
            { id: "kb.audit", effect: "audit", knowledge: ["acme.*"] },
          ],
        },
      }).success,
    ).toBe(true);
    // Knowledge retrieval has no interactive approval channel, so a knowledge-
    // only require_approval policy is rejected like a run-level one.
    expect(
      EnterpriseConfigSchema.safeParse({
        governance: {
          policies: [{ id: "kb.approve", effect: "require_approval", knowledge: ["acme.kb"] }],
        },
      }).success,
    ).toBe(false);
    // A policy targets tool calls OR knowledge, not both.
    expect(
      EnterpriseConfigSchema.safeParse({
        governance: {
          policies: [{ id: "kb.mixed", effect: "deny", tools: ["exec"], knowledge: ["acme.kb"] }],
        },
      }).success,
    ).toBe(false);
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
    for (const selector of ["tools", "trees", "nodes", "knowledge"] as const) {
      const result = EnterpriseConfigSchema.safeParse({
        governance: { policies: [{ id: "ok.id", effect: "deny", [selector]: [] }] },
      });
      expect(result.success, `${selector}: [] must be rejected`).toBe(false);
    }
  });

  it("accepts require_approval policies with approval settings", () => {
    const result = EnterpriseConfigSchema.safeParse({
      governance: {
        policies: [
          {
            id: "approve.exec",
            effect: "require_approval",
            tools: ["exec"],
            approval: { timeoutMs: 60000, timeoutBehavior: "deny", severity: "critical" },
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects run-level require_approval and stray approval settings", () => {
    expect(
      EnterpriseConfigSchema.safeParse({
        governance: {
          policies: [{ id: "approve.runs", effect: "require_approval", trees: ["acme.*"] }],
        },
      }).success,
    ).toBe(false);
    expect(
      EnterpriseConfigSchema.safeParse({
        governance: {
          policies: [
            { id: "deny.exec", effect: "deny", tools: ["exec"], approval: { severity: "info" } },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      EnterpriseConfigSchema.safeParse({
        governance: {
          policies: [
            {
              id: "approve.exec",
              effect: "require_approval",
              tools: ["exec"],
              approval: { timeoutBehavior: "escalate" },
            },
          ],
        },
      }).success,
    ).toBe(false);
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

describe("enterprise.routePlanner", () => {
  it("accepts a plain model ref", () => {
    expect(
      EnterpriseConfigSchema.parse({
        mode: "enforce",
        routePlanner: { model: "mistral/mistral-medium-3-5" },
      }),
    ).toMatchObject({ routePlanner: { model: "mistral/mistral-medium-3-5" } });
  });

  it("rejects a ref with no provider, which would resolve against the agent default", () => {
    // The override skips the hook gate that exists to keep a prompt off a provider
    // the run avoided, so an unqualified ref must not read as an operator's choice.
    for (const model of [
      "llama3",
      "mistral/",
      "/mistral-medium-3-5",
      " mistral/x",
      // The auth-profile suffix is stripped before parsing, leaving "mistral/".
      "mistral/@work",
    ]) {
      expect(() => EnterpriseConfigSchema.parse({ routePlanner: { model } })).toThrow();
    }
  });

  it("keeps @-prefixed model path segments, which are part of the model id", () => {
    // The splitter deliberately preserves these; only a suffix that leaves the model
    // half empty is a profile-only value.
    for (const model of ["openrouter/@preset/router", "openai/@cf/meta/llama"]) {
      expect(EnterpriseConfigSchema.parse({ routePlanner: { model } })).toMatchObject({
        routePlanner: { model },
      });
    }
  });

  it("accepts a gateway provider that routes slash-bearing model ids", () => {
    expect(
      EnterpriseConfigSchema.parse({
        routePlanner: { model: "openrouter/mistralai/mistral-medium-3.1" },
      }),
    ).toMatchObject({ routePlanner: { model: "openrouter/mistralai/mistral-medium-3.1" } });
  });

  it("rejects the tool-model object form, which nothing behind it implements", () => {
    expect(() =>
      EnterpriseConfigSchema.parse({
        routePlanner: { model: { primary: "mistral/mistral-small-latest" } },
      }),
    ).toThrow();
  });

  it("rejects an unknown key so a typo cannot silently disable routing", () => {
    expect(() => EnterpriseConfigSchema.parse({ routePlanner: { models: "mistral/x" } })).toThrow();
  });
});
