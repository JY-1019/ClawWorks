/**
 * Tests the enterprise governance gate inside runBeforeToolCallHook: mediated
 * runs get per-tool ontology/policy enforcement before any plugin machinery.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearEnterpriseActiveRunsForTest,
  registerEnterpriseActiveRun,
  type EnterpriseActiveRun,
} from "../enterprise/runtime.js";
import type { EnterpriseRunPlan, GovernancePolicy } from "../enterprise/types.js";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runBeforeToolCallHook } from "./agent-tools.before-tool-call.js";

function registerRun(params: {
  runId: string;
  mode?: "enforce" | "observe";
  allowedTools?: string[];
  policies?: GovernancePolicy[];
}): void {
  const plan: EnterpriseRunPlan = {
    runId: params.runId,
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
        ontology: params.allowedTools ? { allowedTools: params.allowedTools } : {},
      },
    ],
    activeNodeId: "support",
    mode: params.mode ?? "enforce",
    createdAt: 0,
  };
  const run: EnterpriseActiveRun = { plan, policies: params.policies ?? [] };
  registerEnterpriseActiveRun(run);
}

describe("runBeforeToolCallHook — enterprise governance gate", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    clearEnterpriseActiveRunsForTest();
  });

  afterEach(() => {
    clearEnterpriseActiveRunsForTest();
  });

  it("blocks out-of-scope tools for mediated runs in enforce mode", async () => {
    registerRun({ runId: "ent-run-1", allowedTools: ["memory_search"] });
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      toolCallId: "call-1",
      ctx: { runId: "ent-run-1" },
    });
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.kind).toBe("veto");
      expect(outcome.deniedReason).toBe("enterprise-governance");
      expect(outcome.reason).toContain("ontology tool scope");
    }
  });

  it("blocks tools denied by governance policy", async () => {
    registerRun({
      runId: "ent-run-2",
      policies: [{ id: "deny.exec", effect: "deny", tools: ["exec"] }],
    });
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      ctx: { runId: "ent-run-2" },
    });
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.reason).toContain('governance policy "deny.exec"');
    }
  });

  it("does not block denials in observe mode", async () => {
    registerRun({ runId: "ent-run-3", mode: "observe", allowedTools: ["memory_search"] });
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      ctx: { runId: "ent-run-3" },
    });
    expect(outcome.blocked).toBe(false);
  });

  it("allows in-scope tools for mediated runs", async () => {
    registerRun({ runId: "ent-run-4", allowedTools: ["exec"] });
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      ctx: { runId: "ent-run-4" },
    });
    expect(outcome.blocked).toBe(false);
  });

  it("leaves unmediated runs untouched (enterprise off / unknown runId)", async () => {
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      ctx: { runId: "not-mediated" },
    });
    expect(outcome.blocked).toBe(false);
  });
});
