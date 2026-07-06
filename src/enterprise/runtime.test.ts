import { afterEach, describe, expect, it } from "vitest";
import {
  clearEnterpriseActiveRunsForTest,
  evaluateEnterpriseToolCall,
  getEnterpriseActiveRun,
  registerEnterpriseActiveRun,
  resolveEnterpriseMode,
  unregisterEnterpriseActiveRun,
  type EnterpriseActiveRun,
} from "./runtime.js";
import type { EnterpriseRunPlan } from "./types.js";

function makeRun(overrides: {
  runId?: string;
  mode?: "enforce" | "observe";
  allowedTools?: string[];
  audit?: boolean;
  sink?: EnterpriseActiveRun["sink"];
}): EnterpriseActiveRun {
  const plan: EnterpriseRunPlan = {
    runId: overrides.runId ?? "run-1",
    treeId: "acme.support",
    treeVersion: "1.0.0",
    treeName: "Support",
    matchedBy: "trigger",
    requestSummary: "help",
    nodes: [
      {
        nodeId: "support",
        parentId: null,
        seq: 0,
        title: "Support",
        ontology: {
          ...(overrides.allowedTools ? { allowedTools: overrides.allowedTools } : {}),
          ...(overrides.audit !== undefined ? { audit: overrides.audit } : {}),
        },
      },
    ],
    activeNodeId: "support",
    mode: overrides.mode ?? "enforce",
    createdAt: 0,
  };
  return {
    plan,
    policies: [],
    ...(overrides.sink ? { sink: overrides.sink } : {}),
  };
}

afterEach(() => {
  clearEnterpriseActiveRunsForTest();
});

describe("resolveEnterpriseMode", () => {
  it("defaults to enforce, including with no config at all", () => {
    expect(resolveEnterpriseMode(undefined)).toBe("enforce");
    expect(resolveEnterpriseMode({})).toBe("enforce");
  });

  it("honors explicit config modes", () => {
    expect(resolveEnterpriseMode({ enterprise: { mode: "observe" } })).toBe("observe");
    expect(resolveEnterpriseMode({ enterprise: { mode: "off" } })).toBe("off");
  });
});

describe("evaluateEnterpriseToolCall", () => {
  it("returns undefined for unmediated runs", () => {
    expect(evaluateEnterpriseToolCall({ runId: "unknown", toolName: "exec" })).toBeUndefined();
    expect(evaluateEnterpriseToolCall({ toolName: "exec" })).toBeUndefined();
  });

  it("blocks denied tools in enforce mode and records the decision", () => {
    const events: Array<Record<string, unknown>> = [];
    registerEnterpriseActiveRun(
      makeRun({
        allowedTools: ["memory_search"],
        sink: (event) => {
          events.push(event.payload);
        },
      }),
    );
    const verdict = evaluateEnterpriseToolCall({
      runId: "run-1",
      toolName: "exec",
      toolCallId: "call-1",
    });
    expect(verdict?.blocked).toBe(true);
    expect(verdict?.decision.effect).toBe("deny");
    expect(verdict?.nodeId).toBe("support");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      subject: "tool_call",
      toolName: "exec",
      toolCallId: "call-1",
      effect: "deny",
      enforced: true,
    });
  });

  it("records but does not block denials in observe mode", () => {
    const events: Array<Record<string, unknown>> = [];
    registerEnterpriseActiveRun(
      makeRun({
        mode: "observe",
        allowedTools: ["memory_search"],
        sink: (event) => {
          events.push(event.payload);
        },
      }),
    );
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.blocked).toBe(false);
    expect(verdict?.decision.effect).toBe("deny");
    expect(events[0]).toMatchObject({ effect: "deny", enforced: false });
  });

  it("allows in-scope tools without tracing default allows", () => {
    const events: Array<Record<string, unknown>> = [];
    registerEnterpriseActiveRun(
      makeRun({
        allowedTools: ["exec", "memory_search"],
        sink: (event) => {
          events.push(event.payload);
        },
      }),
    );
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.blocked).toBe(false);
    expect(verdict?.decision.effect).toBe("allow");
    // Stock path: no per-tool-call trace writes for default allows.
    expect(events).toHaveLength(0);
  });

  it("traces default allows when the node opts into ontology.audit", () => {
    const events: Array<Record<string, unknown>> = [];
    registerEnterpriseActiveRun(
      makeRun({
        audit: true,
        sink: (event) => {
          events.push(event.payload);
        },
      }),
    );
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.decision.effect).toBe("allow");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ effect: "allow", enforced: false });
  });

  it("fails closed in enforce mode when the plan is corrupt", () => {
    const run = makeRun({});
    run.plan.activeNodeId = "missing.node";
    registerEnterpriseActiveRun(run);
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.blocked).toBe(true);
    expect(verdict?.decision.reason).toContain("enterprise governance evaluation failed");
  });

  it("fails open in observe mode when the plan is corrupt", () => {
    const run = makeRun({ mode: "observe" });
    run.plan.activeNodeId = "missing.node";
    registerEnterpriseActiveRun(run);
    const verdict = evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" });
    expect(verdict?.blocked).toBe(false);
  });

  it("never throws when the sink throws", () => {
    registerEnterpriseActiveRun(
      makeRun({
        allowedTools: ["memory_search"],
        sink: () => {
          throw new Error("sink boom");
        },
      }),
    );
    expect(() => evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" })).not.toThrow();
  });

  it("stops gating after unregistering", () => {
    registerEnterpriseActiveRun(makeRun({ allowedTools: ["memory_search"] }));
    expect(getEnterpriseActiveRun("run-1")).toBeDefined();
    unregisterEnterpriseActiveRun("run-1");
    expect(evaluateEnterpriseToolCall({ runId: "run-1", toolName: "exec" })).toBeUndefined();
  });
});
