// Codex tests cover approval bridge plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reviewExecRequestWithConfiguredModel } from "openclaw/plugin-sdk/agent-harness-exec-review-runtime";
import {
  callGatewayTool,
  cancelPluginApprovalForRunAbort,
  finalizeNativeHookRelayToolRelease,
  getNativeHookRelayDeferredToolApproval,
  hasNativeHookRelayInvocation,
  invokeNativeHookRelay,
  runBeforeToolCallHook,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApprovalResponse, handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
import type { JsonObject, JsonValue } from "./protocol.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  callGatewayTool: vi.fn(),
  cancelPluginApprovalForRunAbort: vi.fn(),
  finalizeNativeHookRelayToolRelease: vi.fn(),
  getNativeHookRelayDeferredToolApproval: vi.fn(),
  hasNativeHookRelayInvocation: vi.fn(() => false),
  invokeNativeHookRelay: vi.fn(),
  runBeforeToolCallHook: vi.fn(async ({ params }: { params: unknown }) => ({
    blocked: false,
    params,
  })),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-exec-review-runtime", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("openclaw/plugin-sdk/agent-harness-exec-review-runtime")
  >()),
  reviewExecRequestWithConfiguredModel: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);
const mockCancelPluginApprovalForRunAbort = vi.mocked(cancelPluginApprovalForRunAbort);
const mockFinalizeNativeHookRelayToolRelease = vi.mocked(finalizeNativeHookRelayToolRelease);
const mockGetNativeHookRelayDeferredToolApproval = vi.mocked(
  getNativeHookRelayDeferredToolApproval,
);
const mockHasNativeHookRelayInvocation = vi.mocked(hasNativeHookRelayInvocation);
const mockInvokeNativeHookRelay = vi.mocked(invokeNativeHookRelay);
const mockReviewExecRequestWithConfiguredModel = vi.mocked(reviewExecRequestWithConfiguredModel);
const mockRunBeforeToolCallHook = vi.mocked(runBeforeToolCallHook);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function jsonObject(value: JsonObject): JsonObject {
  return value;
}

function gatewayCallAt(callIndex = 0) {
  const call = mockCallGatewayTool.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected gateway call ${callIndex + 1}`);
  }
  return call;
}

function gatewayRequestPayload(callIndex = 0) {
  return requireRecord(gatewayCallAt(callIndex)[2], `gateway request payload ${callIndex + 1}`);
}

function gatewayCallOptions(callIndex = 0) {
  return gatewayCallAt(callIndex)[3];
}

function gatewayCallMethod(callIndex = 0) {
  return gatewayCallAt(callIndex)[0];
}

function findApprovalEvent(
  params: EmbeddedRunAttemptParams,
  fields: {
    status?: string;
    approvalId?: string;
    command?: string;
    reason?: string;
    message?: string;
  },
) {
  const onAgentEvent = params.onAgentEvent as unknown as { mock?: { calls?: unknown[][] } };
  const calls = onAgentEvent.mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error("Expected onAgentEvent mock calls");
  }
  for (const call of calls) {
    const event = requireRecord(call[0], "agent event");
    if (event.stream !== "approval") {
      continue;
    }
    const data = requireRecord(event.data, "approval event data");
    if (
      (!fields.status || data.status === fields.status) &&
      (!fields.approvalId || data.approvalId === fields.approvalId) &&
      (!fields.command || data.command === fields.command) &&
      (!fields.reason || data.reason === fields.reason) &&
      (!fields.message || data.message === fields.message)
    ) {
      return data;
    }
  }
  throw new Error(`Expected approval event ${JSON.stringify(fields)}`);
}

function createParams(): EmbeddedRunAttemptParams {
  return {
    sessionKey: "agent:main:session-1",
    agentId: "main",
    messageChannel: "telegram",
    currentChannelId: "chat-1",
    agentAccountId: "default",
    currentThreadTs: "thread-ts",
    onAgentEvent: vi.fn(),
  } as unknown as EmbeddedRunAttemptParams;
}

describe("Codex app-server approval bridge", () => {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
    mockCancelPluginApprovalForRunAbort.mockReset();
    mockCancelPluginApprovalForRunAbort.mockResolvedValue(undefined);
    mockFinalizeNativeHookRelayToolRelease.mockReset();
    mockFinalizeNativeHookRelayToolRelease.mockReturnValue(undefined);
    mockGetNativeHookRelayDeferredToolApproval.mockReset();
    mockHasNativeHookRelayInvocation.mockReset();
    mockHasNativeHookRelayInvocation.mockReturnValue(false);
    mockInvokeNativeHookRelay.mockReset();
    mockReviewExecRequestWithConfiguredModel.mockReset();
    mockReviewExecRequestWithConfiguredModel.mockResolvedValue({
      decision: "ask",
      rationale: "test reviewer asks for approval",
      risk: "unknown",
    });
    mockRunBeforeToolCallHook.mockReset();
    mockRunBeforeToolCallHook.mockImplementation(async ({ params }) => ({
      blocked: false,
      params,
    }));
  });

  it("auto-accepts app-server command approvals in yolo mode without opening plugin approvals", async () => {
    const params = createParams();

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-yolo",
        command: "/bin/bash -lc 'node -v'",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      autoApprove: true,
    });

    expect(result).toEqual({ decision: "acceptForSession" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(mockRunBeforeToolCallHook).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "exec",
        approvalMode: "request",
      }),
    );
    findApprovalEvent(params, {
      status: "approved",
      message: "Codex app-server approval auto-approved by runtime policy.",
    });
  });

  it("auto-accepts app-server file approvals in yolo mode without opening plugin approvals", async () => {
    const params = createParams();

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/fileChange/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch-yolo",
        reason: "needs write access",
        grantRoot: "/workspace",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      autoApprove: true,
    });

    expect(result).toEqual({ decision: "acceptForSession" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(mockRunBeforeToolCallHook).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "apply_patch",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "patch-yolo",
          reason: "needs write access",
          grantRoot: "/workspace",
        },
        approval: {
          provider: "codex",
          method: "item/fileChange/requestApproval",
          request: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "patch-yolo",
            reason: "needs write access",
            grantRoot: "/workspace",
          },
        },
      }),
    );
    findApprovalEvent(params, {
      status: "approved",
      reason: "needs write access",
      message: "Codex app-server approval auto-approved by runtime policy.",
    });
  });

  it("routes command approvals through plugin approvals and accepts allowed commands", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-1", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-1", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-1",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(gatewayCallMethod()).toBe("plugin.approval.request");
    expect(typeof gatewayCallAt(0)[1]).toBe("object");
    const requestPayload = gatewayRequestPayload();
    expect(requestPayload.pluginId).toBe("openclaw-codex-app-server");
    expect(requestPayload.title).toBe("Codex app-server command approval");
    expect(requestPayload.twoPhase).toBe(true);
    expect(requestPayload.turnSourceChannel).toBe("telegram");
    expect(requestPayload.turnSourceTo).toBe("chat-1");
    expect(gatewayCallOptions()).toEqual({ expectFinal: false });
    expect(mockRunBeforeToolCallHook).toHaveBeenCalledWith({
      toolName: "exec",
      params: {
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
        approval: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "cmd-1",
          command: "pnpm test extensions/codex/src/app-server",
          cwd: "/workspace",
        },
      },
      approval: {
        provider: "codex",
        method: "item/commandExecution/requestApproval",
        request: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "cmd-1",
          command: "pnpm test extensions/codex/src/app-server",
          cwd: "/workspace",
        },
      },
      toolCallId: "cmd-1",
      approvalMode: "request",
      deferRelease: true,
      signal: undefined,
      ctx: {
        agentId: "main",
        cwd: "/workspace",
        sessionKey: "agent:main:session-1",
        channelId: "chat-1",
      },
    });
    findApprovalEvent(params, { status: "pending", approvalId: "plugin:approval-1" });
    findApprovalEvent(params, { status: "approved", approvalId: "plugin:approval-1" });
  });

  it.each([
    { decision: "allow-once", released: true, response: { decision: "accept" } },
    { decision: "deny", released: false, response: { decision: "decline" } },
  ])("settles deferred execution after the outer UI decides $decision", async (testCase) => {
    const params = createParams();
    const finalizeRelease = vi.fn();
    mockRunBeforeToolCallHook.mockImplementationOnce(async ({ params: toolParams }) => ({
      blocked: false,
      params: toolParams,
      finalizeRelease,
    }));
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-release", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-release",
        decision: testCase.decision,
      });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-release",
        command: "node --version",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual(testCase.response);
    expect(finalizeRelease).toHaveBeenCalledOnce();
    expect(finalizeRelease).toHaveBeenCalledWith(testCase.released);
  });

  it("shows deferred policy context in the outer capability approval", async () => {
    const params = createParams();
    const onResolution = vi.fn();
    mockRunBeforeToolCallHook.mockImplementationOnce(async ({ params: toolParams }) => ({
      blocked: false,
      params: toolParams,
      deferredApproval: {
        approval: {
          title: "Review managed network",
          description: "Policy requires a one-time approval.",
          severity: "critical" as const,
          allowedDecisions: ["allow-once", "deny"] as const,
          onResolution,
        },
        toolName: "exec",
        baseParams: toolParams,
        lifecycle: { status: "pending" as const },
      },
    }));
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-policy-context", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-policy-context",
        decision: "allow-always",
      });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-policy-context",
        command: "curl https://example.test",
        availableDecisions: ["accept", "acceptForSession"],
        networkApprovalContext: { host: "example.test", protocol: "https" },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "acceptForSession" });
    expect(onResolution).toHaveBeenCalledWith("allow-once");
    expect(gatewayRequestPayload()).toMatchObject({
      title: "Review managed network: Codex app-server command approval",
      severity: "critical",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
    expect(gatewayRequestPayload().description).toContain("Command: curl https://example.test");
    expect(gatewayRequestPayload().description).toContain("Policy requires a one-time approval.");
  });

  it("does not expose or accept allow decisions for a deny-only deferred policy", async () => {
    const params = createParams();
    const onResolution = vi.fn();
    mockRunBeforeToolCallHook.mockImplementationOnce(async ({ params: toolParams }) => ({
      blocked: false,
      params: toolParams,
      deferredApproval: {
        approval: {
          title: "Blocked by policy",
          description: "This action cannot be approved.",
          allowedDecisions: ["deny"] as const,
          onResolution,
        },
        toolName: "exec",
        baseParams: toolParams,
        lifecycle: { status: "pending" as const },
      },
    }));
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-deny-only", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-deny-only", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-deny-only",
        command: "curl https://example.test",
        networkApprovalContext: { host: "example.test", protocol: "https" },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(gatewayRequestPayload().allowedDecisions).toEqual(["deny"]);
    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });

  it.each([
    {
      decision: "allow-once",
      availableDecisions: ["decline"],
    },
    {
      decision: "allow-always",
      availableDecisions: [
        {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { host: "example.test", action: "deny" },
          },
        },
      ],
    },
  ])(
    "does not release when $decision cannot produce an approving Codex decision",
    async (testCase) => {
      const params = createParams();
      const finalizeRelease = vi.fn();
      const onResolution = vi.fn();
      mockRunBeforeToolCallHook.mockImplementationOnce(async ({ params: toolParams }) => ({
        blocked: false,
        params: toolParams,
        finalizeRelease,
        deferredApproval: {
          approval: {
            title: "Review command",
            description: "Review the policy before running.",
            onResolution,
          },
          toolName: "exec",
          baseParams: toolParams,
          lifecycle: { status: "pending" },
        },
      }));
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: "plugin:approval-unencodable", status: "accepted" })
        .mockResolvedValueOnce({
          id: "plugin:approval-unencodable",
          decision: testCase.decision,
        });

      const result = await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "cmd-unencodable",
          command: "node --version",
          availableDecisions: testCase.availableDecisions,
        },
        paramsForRun: params,
        threadId: "thread-1",
        turnId: "turn-1",
      });

      expect(result).toEqual({ decision: "decline" });
      expect(finalizeRelease).toHaveBeenCalledOnce();
      expect(finalizeRelease).toHaveBeenCalledWith(false);
      expect(onResolution).toHaveBeenCalledOnce();
      expect(onResolution).toHaveBeenCalledWith("cancelled");
      expect(gatewayRequestPayload().allowedDecisions).toEqual(["deny"]);
      findApprovalEvent(params, { status: "unavailable" });
    },
  );

  it("denies an approved request when the final release gate fails", async () => {
    const params = createParams();
    const finalizeRelease = vi.fn((released: boolean) =>
      released ? "enterprise run changed before release" : undefined,
    );
    mockRunBeforeToolCallHook.mockImplementationOnce(async ({ params: toolParams }) => ({
      blocked: false,
      params: toolParams,
      finalizeRelease,
    }));
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-release-veto", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-release-veto",
        decision: "allow-once",
      });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-release-veto",
        command: "node --version",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(finalizeRelease).toHaveBeenCalledOnce();
    findApprovalEvent(params, {
      status: "denied",
      message: "enterprise run changed before release",
    });
  });

  it("cancels a deferred callback when the provider release gate vetoes", async () => {
    const params = createParams();
    const onResolution = vi.fn();
    const finalizeApprovedParams = vi.fn(() => "");
    const finalizeRelease = vi.fn((released: boolean) =>
      released ? "enterprise run changed before release" : undefined,
    );
    mockRunBeforeToolCallHook.mockImplementationOnce(async ({ params: toolParams }) => ({
      blocked: false,
      params: toolParams,
      finalizeRelease,
      deferredApproval: {
        approval: {
          title: "Review command",
          description: "Review the policy before running.",
          onResolution,
        },
        toolName: "exec",
        baseParams: toolParams,
        finalizeApprovedParams,
        lifecycle: { status: "pending" },
      },
    }));
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-deferred-veto", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-deferred-veto",
        decision: "allow-once",
      });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-deferred-veto",
        command: "node --version",
        networkApprovalContext: { host: "example.test", protocol: "https" },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(finalizeRelease).toHaveBeenCalledOnce();
    expect(finalizeRelease).toHaveBeenCalledWith(true);
    expect(finalizeApprovedParams).toHaveBeenCalledOnce();
    expect(onResolution).toHaveBeenCalledOnce();
    expect(onResolution).toHaveBeenCalledWith("cancelled");
    findApprovalEvent(params, {
      status: "denied",
      message: "enterprise run changed before release",
    });
  });

  it.each(["throws", "rejects"])(
    "keeps an approved release when the resolved event handler $s",
    async (failureMode) => {
      const params = createParams();
      const finalizeRelease = vi.fn();
      let eventCount = 0;
      params.onAgentEvent = vi.fn(() => {
        eventCount += 1;
        if (eventCount !== 2) {
          return undefined;
        }
        if (failureMode === "throws") {
          throw new Error("event failed");
        }
        return Promise.reject(new Error("event failed"));
      });
      mockRunBeforeToolCallHook.mockImplementationOnce(async ({ params: toolParams }) => ({
        blocked: false,
        params: toolParams,
        finalizeRelease,
      }));
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: "plugin:approval-event", status: "accepted" })
        .mockResolvedValueOnce({ id: "plugin:approval-event", decision: "allow-once" });

      const result = await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "cmd-event",
          command: "node --version",
        },
        paramsForRun: params,
        threadId: "thread-1",
        turnId: "turn-1",
      });

      await Promise.resolve();
      expect(result).toEqual({ decision: "accept" });
      expect(finalizeRelease).toHaveBeenCalledOnce();
      expect(finalizeRelease).toHaveBeenCalledWith(true);
    },
  );

  it("uses the configured ClawWorks exec auto-review model before plugin approvals", async () => {
    const params = createParams();
    params.workspaceDir = "/workspace";
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
            timeoutMs: 12_000,
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "read-only version check",
      risk: "low",
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-auto-review",
        command: "node --version",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      execPolicy: { mode: "auto" },
      execReviewerAgentId: "main",
      internalExecAutoReview: true,
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(mockReviewExecRequestWithConfiguredModel).toHaveBeenCalledWith({
      cfg: params.config,
      agentId: "main",
      reviewer: {
        model: "openai/gpt-5.5-mini",
        timeoutMs: 12_000,
      },
      input: {
        command: "node --version",
        argv: ["node", "--version"],
        cwd: "/workspace",
        envKeys: undefined,
        host: "codex-app-server",
        reason: "approval-required",
        analysis: {
          parsed: true,
          allowlistMatched: false,
          inlineEval: false,
        },
        agent: {
          id: "main",
          sessionKey: "agent:main:session-1",
        },
      },
    });
    findApprovalEvent(params, {
      status: "approved",
      message:
        "Codex app-server command approval granted by ClawWorks exec auto-reviewer: read-only version check",
    });
  });

  it("falls back to plugin approval when no exec auto-review model is configured", async () => {
    const params = createParams();
    params.config = {
      tools: {
        exec: {
          mode: "auto",
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-no-reviewer", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-no-reviewer", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-auto-review-missing",
        command: "node --version",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      execPolicy: { mode: "auto" },
      internalExecAutoReview: true,
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("falls back to plugin approval for managed-network command approvals", async () => {
    const params = createParams();
    mockRunBeforeToolCallHook.mockImplementationOnce(async ({ params: toolParams }) => ({
      blocked: false,
      params: toolParams,
      approvalResolution: "allow-once",
    }));
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "network request looks fine",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-network", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-network", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-auto-review-network",
        networkApprovalContext: {
          host: "example.test",
          protocol: "https",
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      execPolicy: { mode: "auto" },
      internalExecAutoReview: true,
      autoApprove: true,
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockRunBeforeToolCallHook).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "exec",
        params: {
          approval: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-auto-review-network",
            networkApprovalContext: {
              host: "example.test",
              protocol: "https",
            },
          },
        },
        approvalMode: "defer",
        deferRelease: true,
        approval: {
          provider: "codex",
          method: "item/commandExecution/requestApproval",
          request: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-auto-review-network",
            networkApprovalContext: {
              host: "example.test",
              protocol: "https",
            },
          },
        },
      }),
    );
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(gatewayRequestPayload().description).toContain("Network request: https example.test");
  });

  it.each(["lmstudio/local-model", "local-model"])(
    "falls back to plugin approval for unsafe exec auto-review model %s",
    async (model) => {
      const params = createParams();
      params.config = {
        tools: {
          exec: {
            mode: "auto",
            reviewer: {
              model,
            },
          },
        },
      } as unknown as EmbeddedRunAttemptParams["config"];
      mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
        decision: "allow-once",
        rationale: "unsafe self review",
        risk: "low",
      });
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: "plugin:approval-local-reviewer", status: "accepted" })
        .mockResolvedValueOnce({ id: "plugin:approval-local-reviewer", decision: "allow-once" });

      const result = await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "cmd-auto-review-local",
          command: "node --version",
        },
        paramsForRun: params,
        threadId: "thread-1",
        turnId: "turn-1",
        execPolicy: { mode: "auto" },
        internalExecAutoReview: true,
      });

      expect(result).toEqual({ decision: "accept" });
      expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
      expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
        "plugin.approval.request",
        "plugin.approval.waitDecision",
      ]);
    },
  );

  it.each([
    {
      name: "provider base URL",
      reviewerModel: "openai/gpt-5.5-mini",
      models: {
        providers: {
          openai: {
            baseUrl: "http://127.0.0.1:11434/v1",
            models: [],
          },
        },
      },
    },
    {
      name: "provider key casing with custom base URL",
      reviewerModel: "openai/gpt-5.5-mini",
      models: {
        providers: {
          OpenAI: {
            baseUrl: "http://localhost:8080/v1",
            models: [],
          },
        },
      },
    },
    {
      name: "provider local service",
      reviewerModel: "openai/gpt-5.5-mini",
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            localService: { command: "local-openai-compatible" },
            models: [],
          },
        },
      },
    },
    {
      name: "model base URL",
      reviewerModel: "openai/gpt-5.5-mini@work",
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-5.5-mini",
                name: "Local GPT-compatible reviewer",
                baseUrl: "http://localhost:8080/v1",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    },
  ])(
    "falls back to plugin approval for OpenAI reviewer with custom $name",
    async ({ models, reviewerModel }) => {
      const params = createParams();
      params.config = {
        tools: {
          exec: {
            mode: "auto",
            reviewer: {
              model: reviewerModel,
            },
          },
        },
        models,
      } as unknown as EmbeddedRunAttemptParams["config"];
      mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
        decision: "allow-once",
        rationale: "custom endpoint reviewer",
        risk: "low",
      });
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: "plugin:approval-custom-openai", status: "accepted" })
        .mockResolvedValueOnce({ id: "plugin:approval-custom-openai", decision: "allow-once" });

      const result = await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "cmd-auto-review-custom-openai",
          command: "node --version",
        },
        paramsForRun: params,
        threadId: "thread-1",
        turnId: "turn-1",
        execPolicy: { mode: "auto" },
        internalExecAutoReview: true,
      });

      expect(result).toEqual({ decision: "accept" });
      expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
      expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
        "plugin.approval.request",
        "plugin.approval.waitDecision",
      ]);
    },
  );

  it("falls back to plugin approval when an OpenAI-looking reviewer is a configured model alias", async () => {
    const params = createParams();
    params.config = {
      agents: {
        defaults: {
          models: {
            "lmstudio/local-reviewer": {
              alias: "OpenAI/Reviewer",
            },
          },
        },
      },
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/reviewer@work",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "aliased local reviewer",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-aliased-openai", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-aliased-openai", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-auto-review-aliased-openai",
        command: "node --version",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      execPolicy: { mode: "auto" },
      internalExecAutoReview: true,
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("keeps exec auto-review when only an agent-specific alias matches the OpenAI reviewer", async () => {
    const params = createParams();
    params.config = {
      agents: {
        list: [
          {
            id: "sidecar",
            models: {
              "lmstudio/local-reviewer": {
                alias: "openai/gpt-5.5-mini",
              },
            },
          },
        ],
      },
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini@work",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "real OpenAI reviewer",
      risk: "low",
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-auto-review-agent-alias",
        command: "node --version",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      execPolicy: { mode: "auto" },
      execReviewerAgentId: "main",
      internalExecAutoReview: true,
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: params.config,
        agentId: "main",
        reviewer: {
          model: "openai/gpt-5.5-mini@work",
        },
      }),
    );
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("falls back to plugin approval when OpenAI reviewer uses a custom environment base URL", async () => {
    const params = createParams();
    vi.stubEnv("OPENAI_BASE_URL", "http://127.0.0.1:11434/v1");
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "custom env endpoint reviewer",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-env-openai", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-env-openai", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-auto-review-env-openai",
        command: "node --version",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      execPolicy: { mode: "auto" },
      internalExecAutoReview: true,
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("falls back to plugin approval when Codex native OpenAI config uses a local base URL", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-approval-"));
    try {
      await fs.mkdir(path.join(tempDir, "codex-home"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "codex-home", "config.toml"),
        'openai_base_url = "http://127.0.0.1:11434/v1"\n',
      );
      const params = createParams();
      params.agentDir = tempDir;
      params.config = {
        tools: {
          exec: {
            mode: "auto",
            reviewer: {
              model: "openai/gpt-5.5-mini",
            },
          },
        },
      } as EmbeddedRunAttemptParams["config"];
      mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
        decision: "allow-once",
        rationale: "custom native endpoint reviewer",
        risk: "low",
      });
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: "plugin:approval-native-openai", status: "accepted" })
        .mockResolvedValueOnce({ id: "plugin:approval-native-openai", decision: "allow-once" });

      const result = await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "cmd-auto-review-native-openai",
          command: "node --version",
        },
        paramsForRun: params,
        threadId: "thread-1",
        turnId: "turn-1",
        execPolicy: { mode: "auto" },
        internalExecAutoReview: true,
      });

      expect(result).toEqual({ decision: "accept" });
      expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
      expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
        "plugin.approval.request",
        "plugin.approval.waitDecision",
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps permission amendment command approvals on the plugin approval route", async () => {
    const params = createParams();
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "safe command",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-amendment", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-amendment", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-auto-review-amendment",
        command: "node --version",
        additionalPermissions: {
          network: {
            allowHosts: ["example.com"],
          },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      execPolicy: { mode: "auto" },
      internalExecAutoReview: true,
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(gatewayRequestPayload().description).toContain("Additional permissions: network");
  });

  it("keeps object-shaped execpolicy amendment command approvals on the plugin approval route", async () => {
    const params = createParams();
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "safe command",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-execpolicy-object", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-execpolicy-object", decision: "allow-always" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-auto-review-execpolicy-object",
        command: "node --version",
        proposedExecpolicyAmendment: {
          permissions: [{ permission: "allow", command: ["node"] }],
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      execPolicy: { mode: "auto" },
      internalExecAutoReview: true,
    });

    expect(result).toEqual({ decision: "acceptForSession" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("keeps unbound shell command approvals on the plugin approval route", async () => {
    const params = createParams();
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "safe command",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-unbound", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-unbound", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-auto-review-unbound",
        command: "node --version && echo ok",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      execPolicy: { mode: "auto" },
      internalExecAutoReview: true,
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it.each([
    "/approve abc123 allow-once",
    "bash -lc '/approve abc123 allow-once'",
    "openclaw channels login --channel whatsapp",
    "sudo -EH bash -lc 'openclaw channels login --channel whatsapp'",
  ])("keeps unsafe control command approvals on the plugin approval route: %s", async (command) => {
    const params = createParams();
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "unsafe control command",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-control-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-control-command", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-auto-review-control-command",
        command,
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      execPolicy: { mode: "auto" },
      internalExecAutoReview: true,
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("keeps security audit suppression edits on the plugin approval route", async () => {
    const params = createParams();
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "safe command",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-security-suppression", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-security-suppression",
        decision: "allow-once",
      });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-auto-review-security-suppression",
        command: "openclaw config set security.audit.suppressions '[]'",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      execPolicy: { mode: "auto" },
      internalExecAutoReview: true,
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("keeps amendment-only decision command approvals on the plugin approval route", async () => {
    const params = createParams();
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "safe command",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-amendment-only", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-amendment-only", decision: "allow-always" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-auto-review-amendment-only",
        command: "node --version",
        availableDecisions: [
          {
            acceptWithExecpolicyAmendment: {
              patterns: ["node"],
            },
          },
        ],
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      execPolicy: { mode: "auto" },
      internalExecAutoReview: true,
    });

    expect(result).toEqual({
      decision: {
        acceptWithExecpolicyAmendment: {
          patterns: ["node"],
        },
      },
    });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("falls back to plugin approval when the exec auto-review model asks", async () => {
    const params = createParams();
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: { primary: "openai/gpt-5.5-mini" },
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "ask",
      rationale: "needs human review",
      risk: "medium",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-reviewer-ask", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-reviewer-ask", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-auto-review-ask",
        command: "git status",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      execPolicy: { mode: "auto" },
      internalExecAutoReview: true,
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).toHaveBeenCalledTimes(1);
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("cancels command approvals when the run aborts during exec auto-review", async () => {
    const params = createParams();
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    const abortController = new AbortController();
    mockReviewExecRequestWithConfiguredModel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                decision: "allow-once",
                rationale: "late allow",
                risk: "low",
              }),
            50,
          );
        }),
    );

    const resultPromise = handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-auto-review-abort",
        command: "node --version",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      execPolicy: { mode: "auto" },
      internalExecAutoReview: true,
      signal: abortController.signal,
    });
    abortController.abort(new Error("run stopped"));

    await expect(resultPromise).resolves.toEqual({ decision: "cancel" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "failed",
      message: "Codex app-server approval cancelled because the run stopped.",
    });
  });

  it("closes a pending command approval when the run aborts during the user wait", async () => {
    const params = createParams();
    const abortController = new AbortController();
    mockCallGatewayTool.mockResolvedValueOnce({ id: "plugin:approval-abort", status: "accepted" });
    mockCallGatewayTool.mockImplementationOnce((_method, opts) => {
      const signal = (opts as { signal?: AbortSignal }).signal;
      return new Promise((_, reject) => {
        const rejectAbort = () => {
          const error = new Error("gateway request aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted) {
          rejectAbort();
        } else {
          signal?.addEventListener("abort", rejectAbort, { once: true });
        }
      });
    });

    const resultPromise = handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-user-wait-abort",
        command: "node --version",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      signal: abortController.signal,
    });
    await vi.waitFor(() => expect(mockCallGatewayTool).toHaveBeenCalledTimes(2));
    abortController.abort(new Error("run stopped"));

    await expect(resultPromise).resolves.toEqual({ decision: "cancel" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(gatewayCallAt(0)[1]).toMatchObject({ signal: abortController.signal });
    expect(gatewayCallAt(1)[1]).toMatchObject({ signal: abortController.signal });
    expect(mockCancelPluginApprovalForRunAbort).toHaveBeenCalledWith("plugin:approval-abort");
  });

  it("closes an accepted command approval when abort wins before the wait connects", async () => {
    const params = createParams();
    const abortController = new AbortController();
    const abortReason = new Error("run stopped between approval phases");
    mockCallGatewayTool
      .mockImplementationOnce(async () => {
        abortController.abort(abortReason);
        return { id: "plugin:approval-handoff-abort", status: "accepted" };
      })
      .mockRejectedValueOnce(abortReason);

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-handoff-abort",
        command: "node --version",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      signal: abortController.signal,
    });

    expect(result).toEqual({ decision: "cancel" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(gatewayCallAt(1)[1]).toMatchObject({ signal: abortController.signal });
    expect(mockCancelPluginApprovalForRunAbort).toHaveBeenCalledWith(
      "plugin:approval-handoff-abort",
    );
  });

  it("normalizes prefixed channel targets for ClawWorks tool policy context", async () => {
    const params = createParams();
    params.messageChannel = "telegram";
    params.messageProvider = "telegram";
    params.currentChannelId = "telegram:-100123";
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-prefixed", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-prefixed", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-prefixed",
        command: "pnpm test extensions/codex/src/app-server",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(mockRunBeforeToolCallHook).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          channelId: "-100123",
        }),
      }),
    );
    expect(gatewayRequestPayload().turnSourceTo).toBe("telegram:-100123");
  });

  it("denies command approvals before prompting when ClawWorks tool policy blocks", async () => {
    const params = createParams();
    mockRunBeforeToolCallHook.mockResolvedValueOnce({
      blocked: true,
      kind: "veto",
      deniedReason: "plugin-before-tool-call",
      reason: "blocked by policy",
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-blocked",
        command: "cat /tmp/private_key",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, { status: "denied" });
  });

  it("routes command approvals through the active native hook relay before prompting", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockResolvedValueOnce({
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "blocked by native relay",
        },
      })}\n`,
      stderr: "",
      exitCode: 0,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-native-relay",
        command: "cat /tmp/private_key",
        cwd: "/workspace",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay: {
        relayId: "relay-1",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledWith({
      provider: "codex",
      relayId: "relay-1",
      generation: "generation-1",
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        openclaw_approval_mode: "report",
        openclaw_approval_context: {
          provider: "codex",
          method: "item/commandExecution/requestApproval",
          request: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-native-relay",
            command: "cat /tmp/private_key",
            cwd: "/workspace",
          },
        },
        tool_name: "exec_command",
        tool_use_id: "cmd-native-relay",
        cwd: "/workspace",
        turn_id: "turn-1",
        tool_input: {
          command: "cat /tmp/private_key",
          cwd: "/workspace",
          approval: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-native-relay",
            command: "cat /tmp/private_key",
            cwd: "/workspace",
          },
          cmd: "cat /tmp/private_key",
        },
      },
      requireGeneration: true,
      projectToolInputForRewriteCheck: expect.any(Function),
    });
    findApprovalEvent(params, {
      status: "denied",
      message: "blocked by native relay",
    });
  });

  it("uses the outer UI to settle an existing native capability approval", async () => {
    const params = createParams();
    mockHasNativeHookRelayInvocation.mockReturnValue(true);
    mockGetNativeHookRelayDeferredToolApproval.mockReturnValue({
      title: "Review native network policy",
      description: "Native policy requires a one-time approval.",
      severity: "critical",
      allowedDecisions: ["allow-once", "deny"],
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-native-network", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-native-network",
        decision: "allow-always",
      });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-native-network",
        command: "curl https://example.test",
        availableDecisions: ["accept", "acceptForSession"],
        networkApprovalContext: { host: "example.test", protocol: "https" },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay: {
        relayId: "relay-1",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
      autoApprove: true,
    });

    expect(result).toEqual({ decision: "acceptForSession" });
    expect(mockInvokeNativeHookRelay).not.toHaveBeenCalled();
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockGetNativeHookRelayDeferredToolApproval).toHaveBeenCalledWith({
      relayId: "relay-1",
      toolUseId: "cmd-native-network",
      generation: "generation-1",
    });
    expect(mockFinalizeNativeHookRelayToolRelease).toHaveBeenCalledWith({
      relayId: "relay-1",
      toolUseId: "cmd-native-network",
      generation: "generation-1",
      resolution: "allow-always",
    });
    expect(gatewayRequestPayload()).toMatchObject({
      title: "Review native network policy: Codex app-server command approval",
      severity: "critical",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
    expect(gatewayRequestPayload().description).toContain("Command: curl https://example.test");
    expect(gatewayRequestPayload().description).toContain(
      "Native policy requires a one-time approval.",
    );
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("falls through to plugin approval when the native hook relay has no decision", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-native-noop", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-native-noop", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-native-relay-noop",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay: {
        relayId: "relay-1",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
    expect(mockGetNativeHookRelayDeferredToolApproval).toHaveBeenCalledWith({
      relayId: "relay-1",
      toolUseId: "cmd-native-relay-noop",
      generation: "generation-1",
    });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    findApprovalEvent(params, {
      status: "pending",
      approvalId: "plugin:approval-native-noop",
    });
    findApprovalEvent(params, {
      status: "approved",
      approvalId: "plugin:approval-native-noop",
    });
  });

  it("does not invoke the app-server relay when native PreToolUse already ran", async () => {
    const params = createParams();
    mockHasNativeHookRelayInvocation.mockReturnValueOnce(true);
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-native-observed", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-native-observed", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-native-relay-observed",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay: {
        relayId: "relay-1",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockHasNativeHookRelayInvocation).toHaveBeenCalledWith({
      relayId: "relay-1",
      event: "pre_tool_use",
      toolUseId: "cmd-native-relay-observed",
    });
    expect(mockGetNativeHookRelayDeferredToolApproval).toHaveBeenCalledWith({
      relayId: "relay-1",
      toolUseId: "cmd-native-relay-observed",
      generation: "generation-1",
    });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("merges deferred native policy into the outer command approval", async () => {
    const params = createParams();
    mockHasNativeHookRelayInvocation.mockReturnValueOnce(true);
    mockGetNativeHookRelayDeferredToolApproval.mockReturnValueOnce({
      title: "Review managed command",
      description: `Native policy requires approval: ${"p".repeat(400)}`,
      severity: "critical",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:native-deferred", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:native-deferred", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-native-relay-deferred",
        command: `curl https://network-proof.example.test/${"x".repeat(400)}`,
        cwd: "/workspace",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay: {
        relayId: "relay-1",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).not.toHaveBeenCalled();
    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("Command: curl https://network-proof.example.test/");
    expect(description).toContain("Native policy requires approval:");
    expect(description.length).toBeLessThanOrEqual(256);
    findApprovalEvent(params, {
      status: "approved",
      approvalId: "plugin:native-deferred",
    });
  });

  it("fails closed when the native hook relay returns unreadable approval output", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockResolvedValueOnce({
      stdout: "not-json",
      stderr: "",
      exitCode: 0,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-native-relay-unreadable",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay: {
        relayId: "relay-1",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message:
        "ClawWorks native hook relay returned an unreadable Codex app-server approval result.",
    });
  });

  it("fails closed when the native hook relay returns a non-deny decision", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockResolvedValueOnce({
      stdout:
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
          },
        }) + "\n",
      stderr: "",
      exitCode: 0,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-native-relay-allow",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay: {
        relayId: "relay-1",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message:
        "ClawWorks native hook relay returned a non-deny Codex app-server approval decision.",
    });
  });

  it("fails closed when the native hook relay exits non-zero", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockResolvedValueOnce({
      stdout: "ignored stdout",
      stderr: "blocked from stderr",
      exitCode: 1,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-native-relay-exit",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay: {
        relayId: "relay-1",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message: "blocked from stderr",
    });
  });

  it("fails closed when the expected native hook relay cannot be invoked", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockRejectedValueOnce(new Error("native hook relay not found"));

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-native-relay-missing",
        command: "cat /tmp/private_key",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay: {
        relayId: "relay-missing",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message:
        "ClawWorks native hook relay unavailable for Codex app-server approval: native hook relay not found",
    });
  });

  it("keeps non-command approvals on the app-server approval route when a native relay is registered", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:file-approval", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:file-approval", decision: "allow-once" })
      .mockResolvedValueOnce({ id: "plugin:permission-approval", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:permission-approval", decision: "deny" });
    const nativeHookRelay = {
      relayId: "relay-1",
      generation: "generation-1",
      allowedEvents: ["pre_tool_use" as const],
    };

    await handleCodexAppServerApprovalRequest({
      method: "item/fileChange/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch-native-relay-registered",
        reason: "needs write access",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay,
    });
    await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "permission-native-relay-registered",
        permissions: {
          network: { allowHosts: ["example.com"] },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay,
    });

    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("denies command approvals when ClawWorks tool policy rewrites params", async () => {
    const params = createParams();
    mockRunBeforeToolCallHook.mockImplementationOnce(async ({ params: toolParams }) => {
      const rewrittenParams = requireRecord(toolParams, "tool policy params");
      rewrittenParams.command = "echo rewritten";
      return { blocked: false, params: rewrittenParams };
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-rewritten",
        command: "cat /tmp/private_key",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message:
        "ClawWorks tool policy rewrote Codex app-server approval params; refusing original request.",
    });
  });

  it.each([
    {
      authority: "command cwd",
      method: "item/commandExecution/requestApproval",
      requestParams: jsonObject({
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-cwd-rewritten",
        command: "pnpm test",
        cwd: "/workspace",
      }),
      rewrite: (toolParams: Record<string, unknown>) => {
        toolParams.cwd = "/tmp";
      },
      expected: { decision: "decline" },
    },
    {
      authority: "file grant root",
      method: "item/fileChange/requestApproval",
      requestParams: jsonObject({
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch-root-rewritten",
        grantRoot: "/workspace",
      }),
      rewrite: (toolParams: Record<string, unknown>) => {
        toolParams.grantRoot = "/";
      },
      expected: { decision: "decline" },
    },
    {
      authority: "requested permissions",
      method: "item/permissions/requestApproval",
      requestParams: jsonObject({
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "permissions-rewritten",
        environmentId: "local",
        cwd: "/workspace",
        permissions: { network: { allowHosts: ["example.com", "*.internal"] } },
      }),
      rewrite: (toolParams: Record<string, unknown>) => {
        toolParams.permissions = { network: { allowHosts: ["example.com"] } };
      },
      expected: { permissions: {}, scope: "turn" },
    },
    {
      authority: "available command decisions",
      method: "item/commandExecution/requestApproval",
      requestParams: jsonObject({
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-decisions-rewritten",
        command: "pnpm test",
        availableDecisions: ["decline"],
      }),
      rewrite: (toolParams: Record<string, unknown>) => {
        const approval = requireRecord(toolParams.approval, "approval context");
        approval.availableDecisions = ["accept"];
      },
      expected: { decision: "decline" },
    },
  ] satisfies Array<{
    authority: string;
    method: string;
    requestParams: JsonObject;
    rewrite: (toolParams: Record<string, unknown>) => void;
    expected: JsonValue;
  }>)("denies approvals when policy rewrites $authority", async (testCase) => {
    const params = createParams();
    mockRunBeforeToolCallHook.mockImplementationOnce(async ({ params: toolParams }) => {
      const rewrittenParams = requireRecord(toolParams, "tool policy params");
      testCase.rewrite(rewrittenParams);
      return { blocked: false, params: rewrittenParams };
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: testCase.method,
      requestParams: testCase.requestParams,
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual(testCase.expected);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message:
        "ClawWorks tool policy rewrote Codex app-server approval params; refusing original request.",
    });
  });

  it("allows policy to omit display-only approval context", async () => {
    const params = createParams();
    mockRunBeforeToolCallHook.mockResolvedValueOnce({
      blocked: false,
      params: { command: "pnpm test", cwd: "/workspace" },
      approvalResolution: "allow-always",
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-needs-approval",
        startedAtMs: 1_725_000_000_000,
        reason: "display-only context",
        command: "pnpm test",
        cwd: "/workspace",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "approved",
      message: "Codex app-server approval granted for this turn.",
    });
  });

  it("denies command approvals when ClawWorks tool policy requires approval", async () => {
    const params = createParams();
    mockRunBeforeToolCallHook.mockResolvedValueOnce({
      blocked: true,
      kind: "failure",
      deniedReason: "plugin-approval",
      reason: "Plugin approval required",
    });
    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-needs-approval",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message: "Plugin approval required",
    });
  });

  it("describes command approvals from parsed command actions when available", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-actions", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-actions", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-actions",
        command: "bash -lc 'pnpm test extensions/codex'",
        commandActions: [{ command: "pnpm test extensions/codex" }],
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const requestPayload = gatewayRequestPayload();
    expect(String(requestPayload.description)).toContain("Command: pnpm test extensions/codex");
    expect(String(requestPayload.description)).not.toContain("bash -lc");
    expect(mockRunBeforeToolCallHook.mock.calls.at(0)?.[0]).toMatchObject({
      toolName: "exec",
      params: {
        command: "bash -lc 'pnpm test extensions/codex'",
      },
    });
    findApprovalEvent(params, { command: "pnpm test extensions/codex" });
  });

  it("describes command approval permission and policy amendments", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-command-permissions", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-command-permissions",
        decision: "allow-always",
      });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-permissions",
        command: "npm install",
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: {
            write: ["/"],
          },
        },
        proposedExecpolicyAmendment: ["npm install"],
        proposedNetworkPolicyAmendments: [{ host: "registry.npmjs.org", action: "allow" }],
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "acceptForSession" });
    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("Command: npm install");
    expect(description).toContain("Additional permissions: network, fileSystem");
    expect(description).toContain("High-risk targets: network access, filesystem root");
    expect(description).toContain("Network enabled: true");
    expect(description).toContain("File system write: /");
    expect(description).toContain("Proposed exec policy: npm install");
    expect(description).toContain("Proposed network policy: allow registry.npmjs.org");
  });

  it("keeps command approval permission details visible after long command previews", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-long-command-permissions", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-long-command-permissions",
        decision: "allow-always",
      });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-long-permissions",
        command: `${"npm install ".repeat(500)} --unsafe-perm`,
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: {
            write: ["/"],
          },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("[preview truncated or unsafe content omitted]");
    expect(description).toContain("Additional permissions: network, fileSystem");
    expect(description).toContain("High-risk targets: network access, filesystem root");
  });

  it("sanitizes command previews before forwarding approval text and events", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-sanitized-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-sanitized-command", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-sanitized",
        command: ["pnpm", "test\n--watch", "\u001b[31mextensions/codex/src/app-server\u001b[0m"],
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(gatewayRequestPayload().description).toBe(
      "Command: pnpm test --watch extensions/codex/src/app-server\nSession: agent:main:session-1",
    );
    findApprovalEvent(params, {
      status: "pending",
      command: "pnpm test --watch extensions/codex/src/app-server",
    });
  });

  it("escapes command approval previews before forwarding approval text and events", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-escaped-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-escaped-command", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-escaped",
        command: "printf '<@U123> [trusted](https://evil) @here'",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const description = String(gatewayRequestPayload().description);
    expect(description).toContain(
      "printf '&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here'",
    );
    expect(description).not.toContain("<@U123>");
    expect(description).not.toContain("[trusted](https://evil)");
    expect(description).not.toContain("@here");
    findApprovalEvent(params, {
      command: "printf '&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here'",
    });
  });

  it("preserves visible OSC-8 link labels in command previews", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-osc", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-osc", decision: "allow-once" });
    const esc = "\u001b";

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-osc",
        command: `prefix ${esc}]8;;https://example.com${esc}\\VISIBLE${esc}]8;;${esc}\\ suffix`,
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(gatewayRequestPayload().description).toBe(
      "Command: prefix VISIBLE suffix\nSession: agent:main:session-1",
    );
    findApprovalEvent(params, { command: "prefix VISIBLE suffix" });
  });

  it("strips bidi and invisible formatting controls from command previews", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-bidi", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-bidi", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-bidi",
        command: "echo safe\u202e cod.exe\u2066 hidden\u2069 \ufeffdone\u{e0100}",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(gatewayRequestPayload().description).toBe(
      "Command: echo safe cod.exe hidden done\nSession: agent:main:session-1",
    );
    findApprovalEvent(params, { command: "echo safe cod.exe hidden done" });
  });

  it("marks oversized unsafe command previews as omitted", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-omitted-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-omitted-command", decision: "allow-once" });
    const esc = "\u001b";
    const oversizedPrefix = `${esc}]8;;https://example.com${esc}\\`.repeat(300);

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-omitted",
        command: [oversizedPrefix, "TAIL"],
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(gatewayRequestPayload().description).toBe(
      "Command: [preview truncated or unsafe content omitted]\nSession: agent:main:session-1",
    );
    const omittedEvent = findApprovalEvent(params, {});
    expect(omittedEvent.commandPreviewOmitted).toBe(true);
  });

  it("marks clipped command previews even when a safe prefix remains", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-clipped-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-clipped-command", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-clipped",
        command: `${"a".repeat(5000)} tail`,
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("[preview truncated or unsafe content omitted]");
    const omittedEvent = findApprovalEvent(params, {});
    expect(omittedEvent.commandPreviewOmitted).toBe(true);
  });

  it("does not trust request-time decisions for two-phase command approvals", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({
        id: "plugin:approval-untrusted",
        status: "accepted",
        decision: "allow-always",
      })
      .mockResolvedValueOnce({ id: "plugin:approval-untrusted", decision: "deny" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-untrusted",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    findApprovalEvent(params, {
      status: "denied",
      approvalId: "plugin:approval-untrusted",
    });
  });

  it("only treats own null data-property request decisions as no-route", async () => {
    const params = createParams();
    const inheritedDecisionResult = Object.assign(Object.create({ decision: null }), {
      id: "plugin:approval-inherited",
      status: "accepted",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce(inheritedDecisionResult)
      .mockResolvedValueOnce({ id: "plugin:approval-inherited", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-inherited",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("does not invoke request-time decision accessors", async () => {
    const params = createParams();
    const requestResult = {
      id: "plugin:approval-accessor",
      status: "accepted",
      get decision() {
        throw new Error("decision getter must not run");
      },
    };
    mockCallGatewayTool
      .mockResolvedValueOnce(requestResult)
      .mockResolvedValueOnce({ id: "plugin:approval-accessor", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-accessor",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "accept" });
  });

  it("does not fail when request-time decision descriptors throw", async () => {
    const params = createParams();
    const requestResult = new Proxy(
      { id: "plugin:approval-proxy", status: "accepted" },
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === "decision") {
            throw new Error("descriptor trap must not fail approval");
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    mockCallGatewayTool
      .mockResolvedValueOnce(requestResult)
      .mockResolvedValueOnce({ id: "plugin:approval-proxy", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-proxy",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "accept" });
  });

  it("fails closed when no approval route is available", async () => {
    const params = createParams();
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "plugin:approval-2",
      decision: null,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/fileChange/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch-1",
        reason: "needs write access",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).toHaveBeenCalledTimes(1);
    findApprovalEvent(params, { status: "unavailable", reason: "needs write access" });
  });

  it("sanitizes reason previews before forwarding approval text and events", async () => {
    const params = createParams();
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "plugin:approval-sanitized-reason",
      decision: null,
    });

    await handleCodexAppServerApprovalRequest({
      method: "item/fileChange/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch-sanitized",
        reason: "needs write access\nfor \u001b[31m/tmp\u001b[0m\tplease",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(gatewayRequestPayload().description).toBe(
      "Reason: needs write access for /tmp please\nSession: agent:main:session-1",
    );
    findApprovalEvent(params, {
      status: "unavailable",
      reason: "needs write access for /tmp please",
    });
  });

  it("fails closed for unsupported native approval methods without requesting plugin approval", async () => {
    const params = createParams();

    const result = await handleCodexAppServerApprovalRequest({
      method: "future/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "future-1",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      decision: "decline",
      reason: "ClawWorks codex app-server bridge does not grant native approvals yet.",
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(params.onAgentEvent).not.toHaveBeenCalled();
  });
  it("labels permission approvals explicitly with permission detail", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-3", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-3", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-1",
        environmentId: "local",
        cwd: "/workspace",
        reason: "needs scoped access",
        permissions: {
          network: { allowHosts: ["example.com", "*.internal"] },
          fileSystem: { roots: ["/"], writePaths: ["/home/simone"] },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      permissions: {
        network: { allowHosts: ["example.com", "*.internal"] },
        fileSystem: { roots: ["/"], writePaths: ["/home/simone"] },
      },
      scope: "turn",
    });
    expect(gatewayCallMethod()).toBe("plugin.approval.request");
    expect(typeof gatewayCallAt(0)[1]).toBe("object");
    const requestPayload = gatewayRequestPayload();
    expect(requestPayload.title).toBe("Codex app-server permission approval");
    expect(requestPayload.toolName).toBe("codex_permission_approval");
    const description = String(requestPayload.description);
    expect(description).toContain("Permissions: network, fileSystem");
    expect(gatewayCallOptions()).toEqual({ expectFinal: false });
    expect(description).toContain("Network allowHosts: example.com, *.internal");
    expect(description).toContain("File system roots: /; writePaths: ~");
    expect(description).toContain(
      "High-risk targets: wildcard hosts, private-network wildcards, filesystem root",
    );
    expect(description).not.toContain("agent:main:session-1");
    expect(mockRunBeforeToolCallHook).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "codex_permission_approval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "perm-1",
          environmentId: "local",
          cwd: "/workspace",
          reason: "needs scoped access",
          permissions: {
            network: { allowHosts: ["example.com", "*.internal"] },
            fileSystem: { roots: ["/"], writePaths: ["/home/simone"] },
          },
        },
        approval: {
          provider: "codex",
          method: "item/permissions/requestApproval",
          request: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "perm-1",
            environmentId: "local",
            cwd: "/workspace",
            reason: "needs scoped access",
            permissions: {
              network: { allowHosts: ["example.com", "*.internal"] },
              fileSystem: { roots: ["/"], writePaths: ["/home/simone"] },
            },
          },
        },
      }),
    );
  });

  it("keeps permission detail bounded with truncated and compacted target samples", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-4", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-4", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-2",
        permissions: {
          network: {
            allowHosts: [
              "https://secret-token@example.com/private",
              "*.internal",
              "very-long-service-name.example.corp",
              "third.example.com",
            ],
          },
          fileSystem: {
            roots: ["/", "/workspace/project", "/Users/simone/Documents"],
            readPaths: ["/Users/simone/.ssh/id_rsa", "/etc/hosts", "/var/log/system.log"],
            writePaths: ["/tmp/output", "/var/log/app", "/home/simone/private"],
          },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const description = String(gatewayRequestPayload().description);
    expect(description.length).toBeLessThanOrEqual(700);
    expect(description).toContain("example.com");
    expect(description).not.toContain("secret-token");
    expect(description).not.toContain("simone");
    expect(description).toContain("*.internal");
    expect(description).toContain("/workspace/project");
    expect(description).toContain("High-risk targets:");
    expect(description).toContain("readPaths: ~/.ssh/id_rsa, /etc/hosts");
  });

  it("describes current protocol network and filesystem permission grants", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-current-permissions", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-current-permissions", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-current",
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: ["/Users/simone/.ssh/id_rsa"],
            write: ["/"],
            entries: [
              { path: "/workspace/project", access: "read" },
              { path: "/tmp/output", access: "write" },
              { path: "/ignored", access: "none" },
            ],
          },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: ["/Users/simone/.ssh/id_rsa"],
          write: ["/"],
          entries: [
            { path: "/workspace/project", access: "read" },
            { path: "/tmp/output", access: "write" },
            { path: "/ignored", access: "none" },
          ],
        },
      },
      scope: "turn",
    });
    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("Network enabled: true");
    expect(description).toContain("File system read: ~/.ssh/id_rsa; write: /");
    expect(description).toContain("entries: read /workspace/project, write /tmp/output (+1 more)");
    expect(description).toContain("High-risk targets: network access, filesystem root");
  });

  it("compacts Windows home paths in permission descriptions", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-windows-home", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-windows-home", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-windows-home",
        permissions: {
          fileSystem: {
            roots: ["C:/Users/alice"],
            readPaths: ["C:\\Users\\alice\\.ssh\\id_rsa", "c:/users/bob/project"],
          },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("File system roots: ~; readPaths: ~/.ssh/id_rsa, ~/project");
    expect(description).not.toContain("High-risk targets");
  });

  it("strips terminal and invisible controls from permission descriptions", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-permission-controls", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-permission-controls", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-controls",
        permissions: {
          network: { allowHosts: ["exa\u009b31mmple.com", "safe\u202e.example.com"] },
          fileSystem: { roots: ["/tmp/\u001b[31mproject\u001b[0m"] },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("example.com");
    expect(description).toContain("safe .example.com");
    expect(description).toContain("/tmp/project");
    expect(description).not.toContain("\u009b");
    expect(description).not.toContain("\u202e");
    expect(description).not.toContain("\u001b");
  });

  it("ignores approval requests that are missing explicit thread or turn ids", async () => {
    const params = createParams();

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        itemId: "cmd-2",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toBeUndefined();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(params.onAgentEvent).not.toHaveBeenCalled();
  });

  it("maps app-server approval response families separately", () => {
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["accept"] },
        "approved-session",
      ),
    ).toEqual({
      decision: "accept",
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        {
          availableDecisions: [
            "accept",
            {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: {
                  permissions: [{ permission: "allow", command: ["pnpm", "test"] }],
                },
              },
            },
          ],
        },
        "approved-session",
      ),
    ).toEqual({
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: {
            permissions: [{ permission: "allow", command: ["pnpm", "test"] }],
          },
        },
      },
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        {
          availableDecisions: [
            {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: {
                  host: "registry.npmjs.org",
                  action: "allow",
                },
              },
            },
          ],
        },
        "approved-session",
      ),
    ).toEqual({
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: "registry.npmjs.org",
            action: "allow",
          },
        },
      },
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["decline"] },
        "approved-once",
      ),
    ).toEqual({
      decision: "decline",
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["decline"] },
        "approved-session",
      ),
    ).toEqual({
      decision: "decline",
    });
    expect(
      buildApprovalResponse("item/commandExecution/requestApproval", undefined, "approved-once"),
    ).toEqual({
      decision: "accept",
    });
    expect(
      buildApprovalResponse("item/commandExecution/requestApproval", undefined, "approved-session"),
    ).toEqual({
      decision: "acceptForSession",
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["cancel"] },
        "approved-once",
      ),
    ).toEqual({
      decision: "cancel",
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["accept", "cancel"] },
        "denied",
      ),
    ).toEqual({
      decision: "cancel",
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["decline"] },
        "cancelled",
      ),
    ).toEqual({
      decision: "decline",
    });
    expect(buildApprovalResponse("item/fileChange/requestApproval", undefined, "denied")).toEqual({
      decision: "decline",
    });
    expect(
      buildApprovalResponse(
        "item/permissions/requestApproval",
        {
          permissions: {
            network: { allowHosts: ["example.com"] },
            fileSystem: null,
          },
        },
        "approved-once",
      ),
    ).toEqual({
      permissions: { network: { allowHosts: ["example.com"] } },
      scope: "turn",
    });
    expect(buildApprovalResponse("future/requestApproval", undefined, "approved-once")).toEqual({
      decision: "decline",
      reason: "ClawWorks codex app-server bridge does not grant native approvals yet.",
    });
  });
});
