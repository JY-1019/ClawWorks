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
import { setPluginToolMeta } from "../plugins/tools.js";
import {
  requestDeferredPluginToolApproval,
  runBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { textResult, type AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  cancelPluginApprovalForRunAbort: vi.fn(),
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
  executionId?: string;
  mode?: "enforce" | "observe";
  allowedTools?: string[];
  /** Servers the STEP attaches (ontology.mcpServers). */
  attachMcpServers?: string[];
  /** Servers an operator REGISTERED in config; only these are gated. */
  registeredMcpServers?: string[];
  audit?: boolean;
  actions?: NonNullable<EnterpriseRunPlan["nodes"][number]["ontology"]["actions"]>;
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
        ontology: {
          ...(params.allowedTools ? { allowedTools: params.allowedTools } : {}),
          ...(params.attachMcpServers ? { mcpServers: params.attachMcpServers } : {}),
          ...(params.audit !== undefined ? { audit: params.audit } : {}),
          ...(params.actions ? { actions: params.actions } : {}),
        },
      },
    ],
    activeNodeId: "support",
    // Attaching anywhere is what turns attachment governance on for a work-map.
    ...(params.attachMcpServers ? { mcpGoverned: true } : {}),
    mode: params.mode ?? "enforce",
    createdAt: 0,
  };
  const run: EnterpriseActiveRun = {
    plan,
    executionId: params.executionId ?? `execution:${params.runId}`,
    policies: params.policies ?? [],
    ...(params.registeredMcpServers ? { mcpServers: params.registeredMcpServers } : {}),
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

  it("blocks an MCP tool from a server no step attached", async () => {
    // The wrapper that every materialized MCP tool goes through supplies the
    // server; the name alone could never say which server this belongs to.
    // The work-map opts into attachment governance by attaching SOMETHING; this
    // step attaches a different server, so github is still unreachable here.
    registerRun({
      runId: "ent-run-mcp-1",
      attachMcpServers: ["atlassian"],
      registeredMcpServers: ["github", "atlassian"],
    });
    const outcome = await runBeforeToolCallHook({
      toolName: "github__create_issue",
      params: {},
      ctx: { runId: "ent-run-mcp-1" },
      mcpTool: { serverName: "github", safeServerName: "github", toolName: "create_issue" },
    });
    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.deniedReason).toBe("enterprise-governance");
      expect(outcome.reason).toContain("ontology.mcpServers");
    }
  });

  it("allows an MCP tool once the step attaches its server", async () => {
    registerRun({
      runId: "ent-run-mcp-2",
      attachMcpServers: ["github"],
      registeredMcpServers: ["github"],
    });
    const outcome = await runBeforeToolCallHook({
      toolName: "github__create_issue",
      params: {},
      ctx: { runId: "ent-run-mcp-2" },
      mcpTool: { serverName: "github", safeServerName: "github", toolName: "create_issue" },
    });
    expect(outcome.blocked).toBe(false);
  });

  it("rechecks outward MCP action arguments after plugin hooks", async () => {
    const eventKinds: string[] = [];
    registerRun({
      runId: "ent-run-mcp-rewrite",
      attachMcpServers: ["core-banking"],
      registeredMcpServers: ["core-banking"],
      actions: [
        {
          id: "freeze-account",
          parameters: [{ id: "account-id", type: "id", required: true }],
          effects: [{ kind: "call", tool: "core-banking__freeze_account" }],
        },
      ],
      sink: (event) => eventKinds.push(event.kind),
    });
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolCall: vi.fn().mockResolvedValue({ params: { delete_account: true } }),
    } as unknown as HookRunner);

    const outcome = await runBeforeToolCallHook({
      toolName: "core-banking__freeze_account",
      params: { "account-id": "AC-1" },
      ctx: { runId: "ent-run-mcp-rewrite" },
      mcpTool: {
        serverName: "core-banking",
        safeServerName: "core-banking",
        toolName: "freeze_account",
      },
    });

    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.reason).toContain('does not declare a parameter "delete_account"');
    }
    expect(eventKinds).not.toContain("action.invoked");
  });

  it("records an outward dispatch only after a deferred plugin approval releases it", async () => {
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    registerRun({
      runId: "ent-run-mcp-deferred",
      attachMcpServers: ["core-banking"],
      registeredMcpServers: ["core-banking"],
      actions: [
        {
          id: "freeze-account",
          parameters: [{ id: "account-id", type: "id", required: true }],
          effects: [{ kind: "call", tool: "core-banking__freeze_account" }],
        },
      ],
      sink: (event) => events.push({ kind: event.kind, payload: event.payload }),
    });
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolCall: vi.fn().mockResolvedValue({
        requireApproval: { title: "Approve freeze", description: "Freeze this account" },
      }),
    } as unknown as HookRunner);

    const outcome = await runBeforeToolCallHook({
      toolName: "core-banking__freeze_account",
      params: { "account-id": "AC-1" },
      ctx: { runId: "ent-run-mcp-deferred" },
      approvalMode: "defer",
      mcpTool: {
        serverName: "core-banking",
        safeServerName: "core-banking",
        toolName: "freeze_account",
      },
    });

    expect(outcome.blocked).toBe(false);
    if (outcome.blocked || !outcome.deferredApproval) {
      throw new Error("expected deferred approval");
    }
    expect(events.map((event) => event.kind)).not.toContain("action.invoked");

    mockCallGatewayTool.mockResolvedValueOnce({ id: "appr-outward", decision: "allow-once" });
    const approved = await requestDeferredPluginToolApproval({
      deferredApproval: outcome.deferredApproval,
    });
    expect(approved.blocked).toBe(false);
    if (approved.blocked) {
      return;
    }
    expect(events.filter((event) => event.kind === "action.invoked")).toHaveLength(1);
    expect(events.find((event) => event.kind === "action.invoked")?.payload).toMatchObject({
      actionId: "freeze-account",
      context: { "account-id": "AC-1" },
    });
    expect(outcome.deferredApproval.finalizeApprovedParams?.(approved.params)).toBeUndefined();
    expect(events.filter((event) => event.kind === "action.invoked")).toHaveLength(1);
  });

  it("records an outward dispatch only after the provider confirms release", async () => {
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    registerRun({
      runId: "ent-run-mcp-provider-release",
      attachMcpServers: ["core-banking"],
      registeredMcpServers: ["core-banking"],
      actions: [
        {
          id: "freeze-account",
          parameters: [{ id: "account-id", type: "id", required: true }],
          effects: [{ kind: "call", tool: "core-banking__freeze_account" }],
        },
      ],
      sink: (event) => events.push({ kind: event.kind, payload: event.payload }),
    });

    const outcome = await runBeforeToolCallHook({
      toolName: "core-banking__freeze_account",
      params: { "account-id": "AC-1" },
      ctx: { runId: "ent-run-mcp-provider-release" },
      deferRelease: true,
      mcpTool: {
        serverName: "core-banking",
        safeServerName: "core-banking",
        toolName: "freeze_account",
      },
    });

    expect(outcome.blocked).toBe(false);
    if (outcome.blocked || !outcome.finalizeRelease) {
      throw new Error("expected provider release finalizer");
    }
    expect(events.filter((event) => event.kind === "action.invoked")).toHaveLength(0);
    expect(outcome.finalizeRelease(true)).toBeUndefined();
    expect(outcome.finalizeRelease(true)).toBeUndefined();
    expect(events.filter((event) => event.kind === "action.invoked")).toHaveLength(1);
  });

  it("records an approved outward action when its provider releases it", async () => {
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    registerRun({
      runId: "ent-run-mcp-enterprise-approval",
      attachMcpServers: ["core-banking"],
      registeredMcpServers: ["core-banking"],
      actions: [
        {
          id: "freeze-account",
          parameters: [{ id: "account-id", type: "id", required: true }],
          effects: [{ kind: "call", tool: "core-banking__freeze_account" }],
        },
      ],
      policies: [
        {
          id: "approve.freeze",
          effect: "require_approval",
          tools: ["core-banking__freeze_account"],
        },
      ],
      sink: (event) => events.push({ kind: event.kind, payload: event.payload }),
    });

    const outcome = await runBeforeToolCallHook({
      toolName: "core-banking__freeze_account",
      params: { "account-id": "AC-1" },
      ctx: { runId: "ent-run-mcp-enterprise-approval" },
      approvalMode: "defer",
      deferRelease: true,
      mcpTool: {
        serverName: "core-banking",
        safeServerName: "core-banking",
        toolName: "freeze_account",
      },
    });
    if (outcome.blocked || !outcome.deferredApproval) {
      throw new Error("expected deferred enterprise approval");
    }
    expect(events.filter((event) => event.kind === "action.invoked")).toHaveLength(0);

    mockCallGatewayTool.mockResolvedValueOnce({ id: "appr-outward", decision: "allow-once" });
    const approved = await requestDeferredPluginToolApproval({
      deferredApproval: outcome.deferredApproval,
    });

    expect(approved.blocked).toBe(false);
    expect(events.filter((event) => event.kind === "action.invoked")).toHaveLength(0);
    if (!outcome.finalizeRelease) {
      throw new Error("expected provider release finalizer");
    }
    expect(outcome.finalizeRelease(true)).toBeUndefined();
    expect(events.filter((event) => event.kind === "action.invoked")).toHaveLength(1);
    expect(events.find((event) => event.kind === "action.invoked")?.payload).toMatchObject({
      actionId: "freeze-account",
      context: { "account-id": "AC-1" },
    });
  });

  it("audits an outward call blocked by a plugin without recording a dispatch", async () => {
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    registerRun({
      runId: "ent-run-mcp-plugin-block",
      attachMcpServers: ["core-banking"],
      registeredMcpServers: ["core-banking"],
      audit: true,
      actions: [
        {
          id: "freeze-account",
          parameters: [{ id: "account-id", type: "id", required: true }],
          effects: [{ kind: "call", tool: "core-banking__freeze_account" }],
        },
      ],
      sink: (event) => events.push({ kind: event.kind, payload: event.payload }),
    });
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolCall: vi.fn().mockResolvedValue({
        block: true,
        blockReason: "blocked by plugin",
      }),
    } as unknown as HookRunner);

    const outcome = await runBeforeToolCallHook({
      toolName: "core-banking__freeze_account",
      params: { "account-id": "AC-1" },
      ctx: { runId: "ent-run-mcp-plugin-block" },
      mcpTool: {
        serverName: "core-banking",
        safeServerName: "core-banking",
        toolName: "freeze_account",
      },
    });

    expect(outcome).toMatchObject({ blocked: true, reason: "blocked by plugin" });
    expect(events.filter((event) => event.kind === "governance.decision")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "action.invoked")).toHaveLength(0);
  });

  it("audits a denied deferred outward call without recording a dispatch", async () => {
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    registerRun({
      runId: "ent-run-mcp-deferred-deny",
      attachMcpServers: ["core-banking"],
      registeredMcpServers: ["core-banking"],
      actions: [
        {
          id: "freeze-account",
          parameters: [{ id: "account-id", type: "id", required: true }],
          effects: [{ kind: "call", tool: "core-banking__freeze_account" }],
        },
      ],
      policies: [
        {
          id: "audit.freeze",
          effect: "audit",
          tools: ["core-banking__freeze_account"],
        },
      ],
      sink: (event) => events.push({ kind: event.kind, payload: event.payload }),
    });
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolCall: vi.fn().mockResolvedValue({
        params: { "account-id": "AC-2" },
        requireApproval: { title: "Approve freeze", description: "Freeze this account" },
      }),
    } as unknown as HookRunner);

    const outcome = await runBeforeToolCallHook({
      toolName: "core-banking__freeze_account",
      params: { "account-id": "AC-1" },
      ctx: { runId: "ent-run-mcp-deferred-deny" },
      approvalMode: "defer",
      mcpTool: {
        serverName: "core-banking",
        safeServerName: "core-banking",
        toolName: "freeze_account",
      },
    });
    if (outcome.blocked || !outcome.deferredApproval) {
      throw new Error("expected deferred approval");
    }
    expect(events).toEqual([]);

    mockCallGatewayTool.mockResolvedValueOnce({ id: "appr-denied", decision: "deny" });
    const denied = await requestDeferredPluginToolApproval({
      deferredApproval: outcome.deferredApproval,
    });

    expect(denied.blocked).toBe(true);
    expect(events.filter((event) => event.kind === "governance.decision")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "action.invoked")).toHaveLength(0);
  });

  it("blocks hook-rewritten outward arguments after deferred approval", async () => {
    const eventKinds: string[] = [];
    registerRun({
      runId: "ent-run-mcp-deferred-rewrite",
      attachMcpServers: ["core-banking"],
      registeredMcpServers: ["core-banking"],
      actions: [
        {
          id: "freeze-account",
          parameters: [{ id: "account-id", type: "id", required: true }],
          effects: [{ kind: "call", tool: "core-banking__freeze_account" }],
        },
      ],
      sink: (event) => eventKinds.push(event.kind),
    });
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolCall: vi.fn().mockResolvedValue({
        params: { delete_account: true },
        requireApproval: { title: "Approve freeze", description: "Freeze this account" },
      }),
    } as unknown as HookRunner);

    const outcome = await runBeforeToolCallHook({
      toolName: "core-banking__freeze_account",
      params: { "account-id": "AC-1" },
      ctx: { runId: "ent-run-mcp-deferred-rewrite" },
      approvalMode: "defer",
      mcpTool: {
        serverName: "core-banking",
        safeServerName: "core-banking",
        toolName: "freeze_account",
      },
    });
    if (outcome.blocked || !outcome.deferredApproval) {
      throw new Error("expected deferred approval");
    }

    mockCallGatewayTool.mockResolvedValueOnce({ id: "appr-rewrite", decision: "allow-once" });
    const approved = await requestDeferredPluginToolApproval({
      deferredApproval: outcome.deferredApproval,
    });
    expect(approved.blocked).toBe(true);
    if (approved.blocked) {
      expect(approved.deniedReason).toBe("enterprise-governance");
      expect(approved.reason).toContain('does not declare a parameter "delete_account"');
    }
    expect(eventKinds).not.toContain("action.invoked");
  });

  it("fails closed consistently when a deferred enterprise run disappears", async () => {
    registerRun({
      runId: "ent-run-mcp-disappeared",
      attachMcpServers: ["core-banking"],
      registeredMcpServers: ["core-banking"],
      actions: [
        {
          id: "freeze-account",
          parameters: [{ id: "account-id", type: "id", required: true }],
          effects: [{ kind: "call", tool: "core-banking__freeze_account" }],
        },
      ],
    });
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolCall: vi.fn().mockResolvedValue({
        requireApproval: { title: "Approve freeze", description: "Freeze this account" },
      }),
    } as unknown as HookRunner);
    const outcome = await runBeforeToolCallHook({
      toolName: "core-banking__freeze_account",
      params: { "account-id": "AC-1" },
      ctx: { runId: "ent-run-mcp-disappeared" },
      approvalMode: "defer",
      mcpTool: {
        serverName: "core-banking",
        safeServerName: "core-banking",
        toolName: "freeze_account",
      },
    });
    if (outcome.blocked || !outcome.deferredApproval) {
      throw new Error("expected deferred approval");
    }
    clearEnterpriseActiveRunsForTest();

    mockCallGatewayTool.mockResolvedValueOnce({ id: "appr-disappeared", decision: "allow-once" });
    const approved = await requestDeferredPluginToolApproval({
      deferredApproval: outcome.deferredApproval,
    });
    expect(approved.blocked).toBe(true);
    if (approved.blocked) {
      expect(approved.deniedReason).toBe("enterprise-governance");
      expect(approved.reason).toContain("no longer available");
    }
  });

  it("does not release a deferred plugin approval into a replacement execution", async () => {
    const runId = "ent-run-mcp-replaced";
    const replacementEvents: string[] = [];
    const actions = [
      {
        id: "freeze-account",
        parameters: [{ id: "account-id", type: "id" as const, required: true }],
        effects: [{ kind: "call" as const, tool: "core-banking__freeze_account" }],
      },
    ];
    registerRun({
      runId,
      executionId: "execution-a",
      attachMcpServers: ["core-banking"],
      registeredMcpServers: ["core-banking"],
      actions,
    });
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolCall: vi.fn().mockResolvedValue({
        requireApproval: { title: "Approve freeze", description: "Freeze this account" },
      }),
    } as unknown as HookRunner);
    const outcome = await runBeforeToolCallHook({
      toolName: "core-banking__freeze_account",
      params: { "account-id": "AC-1" },
      ctx: { runId },
      approvalMode: "defer",
      mcpTool: {
        serverName: "core-banking",
        safeServerName: "core-banking",
        toolName: "freeze_account",
      },
    });
    if (outcome.blocked || !outcome.deferredApproval) {
      throw new Error("expected deferred approval");
    }
    registerRun({
      runId,
      executionId: "execution-b",
      attachMcpServers: ["core-banking"],
      registeredMcpServers: ["core-banking"],
      actions,
      sink: (event) => replacementEvents.push(event.kind),
    });

    mockCallGatewayTool.mockResolvedValueOnce({ id: "appr-replaced", decision: "allow-once" });
    const approved = await requestDeferredPluginToolApproval({
      deferredApproval: outcome.deferredApproval,
    });

    expect(approved.blocked).toBe(true);
    if (approved.blocked) {
      expect(approved.reason).toContain("no longer available");
    }
    expect(replacementEvents).toEqual([]);
  });

  it("fails closed when an enforced run disappears while plugin hooks are running", async () => {
    registerRun({
      runId: "ent-run-hook-disappeared",
      allowedTools: ["memory_search"],
    });
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolCall: vi.fn().mockImplementation(async () => {
        clearEnterpriseActiveRunsForTest();
        return {};
      }),
    } as unknown as HookRunner);

    const outcome = await runBeforeToolCallHook({
      toolName: "memory_search",
      params: { query: "safe" },
      ctx: { runId: "ent-run-hook-disappeared" },
    });

    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.deniedReason).toBe("enterprise-governance");
      expect(outcome.reason).toContain("no longer available");
    }
  });

  it("does not adopt a replacement execution after an async plugin hook", async () => {
    const runId = "ent-run-hook-replaced";
    const replacementEvents: string[] = [];
    registerRun({ runId, executionId: "execution-a", allowedTools: ["memory_search"] });
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolCall: vi.fn().mockImplementation(async () => {
        registerRun({
          runId,
          executionId: "execution-b",
          allowedTools: ["memory_search"],
          sink: (event) => replacementEvents.push(event.kind),
        });
        return {};
      }),
    } as unknown as HookRunner);

    const outcome = await runBeforeToolCallHook({
      toolName: "memory_search",
      params: { query: "safe" },
      ctx: { runId },
    });

    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.reason).toContain("no longer available");
    }
    expect(replacementEvents).toEqual([]);
  });

  it("captures the execution before lazy diagnostics load", async () => {
    const runId = "ent-run-diagnostics-replaced";
    const replacementEvents: string[] = [];
    registerRun({ runId, executionId: "execution-a", allowedTools: ["exec"] });

    const pending = runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      ctx: { runId, sessionKey: "agent:main:diagnostics-replaced" },
    });
    registerRun({
      runId,
      executionId: "execution-b",
      allowedTools: ["exec"],
      sink: (event) => replacementEvents.push(event.kind),
    });
    const outcome = await pending;

    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.reason).toContain("no longer available");
    }
    expect(replacementEvents).toEqual([]);
  });

  it("keeps observe mode fail-open when its execution is replaced", async () => {
    const runId = "ent-run-hook-replaced-observe";
    const replacementEvents: string[] = [];
    registerRun({
      runId,
      executionId: "execution-a",
      mode: "observe",
      allowedTools: ["memory_search"],
    });
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolCall: vi.fn().mockImplementation(async () => {
        registerRun({
          runId,
          executionId: "execution-b",
          allowedTools: ["memory_search"],
          sink: (event) => replacementEvents.push(event.kind),
        });
        return {};
      }),
    } as unknown as HookRunner);

    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      ctx: { runId },
    });

    expect(outcome.blocked).toBe(false);
    expect(replacementEvents).toEqual([]);
  });

  it("leaves a same-looking core tool alone when no provenance says MCP", async () => {
    // Without the server the gate must not classify by name, or a core tool
    // spelled `<something>__<something>` would be denied for being unattached.
    registerRun({ runId: "ent-run-mcp-3", registeredMcpServers: ["github"] });
    const outcome = await runBeforeToolCallHook({
      toolName: "github__create_issue",
      params: {},
      ctx: { runId: "ent-run-mcp-3" },
    });
    expect(outcome.blocked).toBe(false);
  });

  it("carries MCP provenance from the wrapper every materialized tool goes through", async () => {
    // The regression this guards: reading the metadata only in the definition
    // adapter is dead code, because embedded tools are already wrapped here and
    // the adapter skips its own hook call for them.
    registerRun({
      runId: "ent-run-mcp-wrap",
      attachMcpServers: ["atlassian"],
      registeredMcpServers: ["github", "atlassian"],
    });
    let executed = 0;
    const tool: AnyAgentTool = {
      name: "github__create_issue",
      label: "create_issue",
      description: "",
      parameters: { type: "object", properties: {} } as never,
      execute: async () => {
        executed += 1;
        return textResult("ok", { status: "ok" });
      },
    };
    setPluginToolMeta(tool, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: "github",
        safeServerName: "github",
        toolName: "create_issue",
        operation: "tool",
      },
    });

    const wrapped = wrapToolWithBeforeToolCallHook(tool, { runId: "ent-run-mcp-wrap" });
    const result = (await wrapped.execute?.("call-mcp", {}, undefined, undefined)) as {
      details?: { status?: string; deniedReason?: string };
    };

    expect(executed).toBe(0);
    expect(result.details?.status).toBe("blocked");
    expect(result.details?.deniedReason).toBe("enterprise-governance");
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

  it("does not release an inline enterprise approval into a replacement execution", async () => {
    const runId = "ent-run-approval-replaced";
    const policies: GovernancePolicy[] = [
      { id: "approve.exec", effect: "require_approval", tools: ["exec"] },
    ];
    const replacementEvents: string[] = [];
    registerRun({ runId, executionId: "execution-a", policies });
    mockCallGatewayTool.mockImplementationOnce(async () => {
      registerRun({
        runId,
        executionId: "execution-b",
        policies,
        sink: (event) => replacementEvents.push(event.kind),
      });
      return { id: "appr-replaced", decision: "allow-once" };
    });

    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      ctx: { runId },
    });

    expect(outcome.blocked).toBe(true);
    if (outcome.blocked) {
      expect(outcome.reason).toContain("no longer available");
    }
    expect(replacementEvents).toEqual([]);
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

  it("does not release a deferred enterprise approval into a replacement execution", async () => {
    const runId = "ent-run-defer-replaced";
    const policies: GovernancePolicy[] = [
      { id: "approve.exec", effect: "require_approval", tools: ["exec"] },
    ];
    const replacementEvents: string[] = [];
    registerRun({ runId, executionId: "execution-a", policies });
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      ctx: { runId },
      approvalMode: "defer",
    });
    if (outcome.blocked || !outcome.deferredApproval) {
      throw new Error("expected deferred approval");
    }
    registerRun({
      runId,
      executionId: "execution-b",
      policies,
      sink: (event) => replacementEvents.push(event.kind),
    });

    mockCallGatewayTool.mockResolvedValueOnce({ id: "appr-replaced", decision: "allow-once" });
    const approved = await requestDeferredPluginToolApproval({
      deferredApproval: outcome.deferredApproval,
    });

    expect(approved.blocked).toBe(true);
    if (approved.blocked) {
      expect(approved.reason).toContain("no longer available");
    }
    expect(replacementEvents).toEqual([]);
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
    const approvalRequest = mockCallGatewayTool.mock.calls[0]?.[2] as {
      title: string;
      description: string;
    };
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
