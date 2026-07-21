/**
 * Tests the enterprise governance gate inside runBeforeToolCallHook: mediated
 * runs get per-tool ontology/policy enforcement before any plugin machinery,
 * including require_approval routing through the plugin approval RPC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEnterpriseActiveRunsForTest,
  registerEnterpriseActiveRun,
  type EnterpriseActiveRun,
} from "../enterprise/runtime.js";
import type { EnterpriseRunPlan, GovernancePolicy } from "../enterprise/types.js";
import { getGlobalHookRunner, resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { HookRunner } from "../plugins/hooks.js";
import {
  requestDeferredPluginToolApproval,
  runBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));
vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return { ...actual, getGlobalHookRunner: vi.fn() };
});

const mockCallGatewayTool = vi.mocked(callGatewayTool);
const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

function registerRun(params: {
  runId: string;
  mode?: "enforce" | "observe";
  allowedTools?: string[];
  policies?: GovernancePolicy[];
  sink?: EnterpriseActiveRun["sink"];
}): void {
  const plan: EnterpriseRunPlan = {
    runId: params.runId,
    treeId: "acme.support",
    treeVersion: "1.0.0",
    treeName: "Support",
    matchedBy: "planner",
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
  const run: EnterpriseActiveRun = {
    plan,
    policies: params.policies ?? [],
    ...(params.sink ? { sink: params.sink } : {}),
  };
  registerEnterpriseActiveRun(run);
}

describe("runBeforeToolCallHook — enterprise governance gate", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    clearEnterpriseActiveRunsForTest();
    mockCallGatewayTool.mockReset();
    // Default: no plugin hooks, so the chain allows and enterprise runs.
    mockGetGlobalHookRunner.mockReturnValue(undefined as unknown as HookRunner);
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

  it("routes require_approval through the plugin approval RPC and records the resolution", async () => {
    const events: Array<Record<string, unknown>> = [];
    registerRun({
      runId: "ent-run-5",
      policies: [
        {
          id: "approve.exec",
          effect: "require_approval",
          tools: ["exec"],
          approval: { severity: "critical", timeoutBehavior: "deny" },
        },
      ],
      sink: (event) => {
        events.push(event.payload);
      },
    });
    mockCallGatewayTool.mockResolvedValueOnce({ id: "appr-1", decision: "allow-once" });

    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      toolCallId: "call-appr-1",
      ctx: { runId: "ent-run-5" },
    });
    expect(outcome.blocked).toBe(false);
    // The resolution rides the outcome so downstream approval bridges do not
    // prompt again, and Allow Always is hidden (no durable enterprise trust).
    if (!outcome.blocked) {
      expect(outcome.approvalResolution).toBe("allow-once");
    }
    expect(mockCallGatewayTool).toHaveBeenCalledTimes(1);
    const [method, , request] = mockCallGatewayTool.mock.calls[0];
    expect(method).toBe("plugin.approval.request");
    expect(request).toMatchObject({
      pluginId: "enterprise-governance",
      toolName: "exec",
      severity: "critical",
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      effect: "require_approval",
      approved: true,
      resolution: "allow-once",
    });
  });

  it("blocks when the enterprise approval is denied", async () => {
    const events: Array<Record<string, unknown>> = [];
    registerRun({
      runId: "ent-run-6",
      policies: [{ id: "approve.exec", effect: "require_approval", tools: ["exec"] }],
      sink: (event) => {
        events.push(event.payload);
      },
    });
    mockCallGatewayTool.mockResolvedValueOnce({ id: "appr-2", decision: "deny" });

    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      toolCallId: "call-appr-2",
      ctx: { runId: "ent-run-6" },
    });
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.deniedReason).toBe("enterprise-governance");
      // A denied approval is a governance veto, not a tool failure, so the
      // wrapper emits a structured block instead of throwing.
      expect(outcome.kind).toBe("veto");
    }
    expect(events[0]).toMatchObject({
      effect: "require_approval",
      approved: false,
      enforced: true,
      resolution: "deny",
    });
  });

  it("defers the enterprise approval to the caller in defer mode (records on resolution)", async () => {
    const events: Array<Record<string, unknown>> = [];
    registerRun({
      runId: "ent-run-defer",
      policies: [{ id: "approve.exec", effect: "require_approval", tools: ["exec"] }],
      sink: (event) => {
        events.push(event.payload);
      },
    });

    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      toolCallId: "call-defer",
      ctx: { runId: "ent-run-defer" },
      approvalMode: "defer",
    });
    // Deferred: not blocked, carries a deferred approval, no synchronous RPC,
    // and the rest of the chain already ran (nothing after it is skipped).
    expect(outcome.blocked).toBe(false);
    if (!outcome.blocked) {
      expect(outcome.deferredApproval).toBeDefined();
    }
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);

    // The caller resolves the deferred approval later; onResolution records it.
    mockCallGatewayTool.mockResolvedValueOnce({ id: "appr-d", decision: "deny" });
    if (!outcome.blocked && outcome.deferredApproval) {
      const resolved = await requestDeferredPluginToolApproval({
        deferredApproval: outcome.deferredApproval,
      });
      expect(resolved.blocked).toBe(true);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      effect: "require_approval",
      approved: false,
      enforced: true,
      resolution: "deny",
    });
  });

  it("fails closed when another gate defers and the enterprise gate also needs approval", async () => {
    const events: Array<Record<string, unknown>> = [];
    registerRun({
      runId: "ent-run-conflict",
      policies: [{ id: "approve.exec", effect: "require_approval", tools: ["exec"] }],
      sink: (event) => {
        events.push(event.payload);
      },
    });
    // A plugin before_tool_call hook that also requires approval; in defer mode
    // the chain returns its own deferred approval.
    const runBeforeToolCall = vi.fn<HookRunner["runBeforeToolCall"]>().mockResolvedValue({
      requireApproval: { title: "Plugin approval", description: "plugin gate" },
    });
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolCall,
    } as unknown as HookRunner);

    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      toolCallId: "call-conflict",
      ctx: { runId: "ent-run-conflict" },
      approvalMode: "defer",
    });
    // Two deferred approvals cannot compose, so governance fails closed rather
    // than letting the plugin approval resolve and run the tool ungoverned.
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.deniedReason).toBe("enterprise-governance");
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      effect: "require_approval",
      enforced: true,
      resolution: "blocked-conflicting-approval",
    });
  });

  it("preserves plugin-approval signaling in report mode (client retry with confirm)", async () => {
    registerRun({
      runId: "ent-run-report",
      policies: [{ id: "approve.exec", effect: "require_approval", tools: ["exec"] }],
    });
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      toolCallId: "call-report",
      ctx: { runId: "ent-run-report" },
      approvalMode: "report",
    });
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      // invokeGatewayTool reads plugin-approval to signal requires_approval;
      // the enterprise gate must not reclassify it as a plain denial.
      expect(outcome.deniedReason).toBe("plugin-approval");
    }
    // Report mode never prompts synchronously.
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("clamps approval title and description to the gateway protocol caps", async () => {
    const longTool = "x".repeat(200);
    registerRun({
      runId: "ent-run-9",
      policies: [
        {
          id: "approve.long",
          effect: "require_approval",
          tools: [longTool],
          description: "y".repeat(500),
        },
      ],
    });
    mockCallGatewayTool.mockResolvedValueOnce({ id: "appr-4", decision: "allow-once" });
    await runBeforeToolCallHook({
      toolName: longTool,
      params: {},
      toolCallId: "call-appr-long",
      ctx: { runId: "ent-run-9" },
    });
    const [, , request] = mockCallGatewayTool.mock.calls[0];
    const approvalRequest = request as { title: string; description: string };
    expect(approvalRequest.title.length).toBeLessThanOrEqual(80);
    expect(approvalRequest.description.length).toBeLessThanOrEqual(256);
  });

  it("normalizes an unreachable approval gateway to a governance veto", async () => {
    registerRun({
      runId: "ent-run-8",
      policies: [{ id: "approve.exec", effect: "require_approval", tools: ["exec"] }],
    });
    // No id in the response models an approval route that could not be reached.
    mockCallGatewayTool.mockResolvedValueOnce({});
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      toolCallId: "call-appr-3",
      ctx: { runId: "ent-run-8" },
    });
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.kind).toBe("veto");
      expect(outcome.deniedReason).toBe("enterprise-governance");
    }
  });

  it("does not gate approvals in observe mode", async () => {
    registerRun({
      runId: "ent-run-7",
      mode: "observe",
      policies: [{ id: "approve.exec", effect: "require_approval", tools: ["exec"] }],
    });
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      ctx: { runId: "ent-run-7" },
    });
    expect(outcome.blocked).toBe(false);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });
});
