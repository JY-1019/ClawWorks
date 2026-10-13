// Codex tests cover native hook relay plugin behavior.
import type { NativeHookRelayRegistrationHandle } from "openclaw/plugin-sdk/agent-harness-runtime";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import {
  buildCodexNativeHookRelayConfig,
  buildCodexNativeHookRelayDisabledConfig,
  CodexNativeToolResultTracker,
  findCodexNativePreToolUseHookConflicts,
  resolveCodexNativeHookRelayCommandTimeoutMs,
  resolveCodexNativeHookRelayUnregisterGraceMs,
} from "./native-hook-relay.js";

describe("Codex native hook relay config", () => {
  it("builds deterministic Codex config overrides with command hooks", () => {
    const config = buildCodexNativeHookRelayConfig({
      relay: createRelay(),
      hookTimeoutSec: 7,
    });

    expect(config).toEqual({
      bypass_hook_trust: false,
      "features.hooks": true,
      "hooks.PreToolUse": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event pre_tool_use --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "ClawWorks native hook relay",
            },
          ],
        },
      ],
      "hooks.PostToolUse": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event post_tool_use --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "ClawWorks native hook relay",
            },
          ],
        },
      ],
      "hooks.PermissionRequest": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event permission_request --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "ClawWorks native hook relay",
            },
          ],
        },
      ],
      "hooks.Stop": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event before_agent_finalize --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "ClawWorks native hook relay",
            },
          ],
        },
      ],
      "hooks.state": {
        "/<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:post_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:post_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:stop:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:stop:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain("timeoutSec");
    expect(JSON.stringify(config)).not.toContain('"matcher":null');
    expect(config).not.toHaveProperty("hooks.SessionStart");
    expect(config).not.toHaveProperty("hooks.UserPromptSubmit");
  });

  it("includes only requested hook events", () => {
    expect(
      buildCodexNativeHookRelayConfig({
        relay: createRelay(),
        events: ["permission_request"],
      }),
    ).toEqual({
      bypass_hook_trust: false,
      "features.hooks": true,
      "hooks.PermissionRequest": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event permission_request --timeout 624000",
              timeout: 625,
              async: false,
              statusMessage: "ClawWorks native hook relay",
            },
          ],
        },
      ],
      "hooks.state": {
        "/<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("clears requested hook events when the relay reports no local work", () => {
    expect(
      buildCodexNativeHookRelayConfig({
        relay: createRelay({ inactiveEvents: ["post_tool_use", "before_agent_finalize"] }),
        events: ["pre_tool_use", "post_tool_use", "before_agent_finalize"],
      }),
    ).toEqual({
      bypass_hook_trust: false,
      "features.hooks": true,
      "hooks.PreToolUse": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event pre_tool_use --timeout 2454000",
              timeout: 2455,
              async: false,
              statusMessage: "ClawWorks native hook relay",
            },
          ],
        },
      ],
      "hooks.PostToolUse": [],
      "hooks.Stop": [],
      "hooks.state": {
        "/<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("keeps selected no-policy PreToolUse installed with an unavailable no-op marker", () => {
    expect(
      buildCodexNativeHookRelayConfig({
        relay: createRelay({ inactiveEvents: ["pre_tool_use"] }),
        events: ["pre_tool_use"],
      }),
    ).toEqual({
      bypass_hook_trust: false,
      "features.hooks": true,
      "hooks.PreToolUse": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event pre_tool_use --pre-tool-use-unavailable noop --timeout 2454000",
              timeout: 2455,
              async: false,
              statusMessage: "ClawWorks native hook relay",
            },
          ],
        },
      ],
      "hooks.state": {
        "/<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("clears omitted hook events when requested", () => {
    expect(
      buildCodexNativeHookRelayConfig({
        relay: createRelay(),
        events: ["permission_request"],
        clearOmittedEvents: true,
      }),
    ).toEqual({
      bypass_hook_trust: false,
      "features.hooks": true,
      "hooks.PreToolUse": [],
      "hooks.PostToolUse": [],
      "hooks.PermissionRequest": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event permission_request --timeout 624000",
              timeout: 625,
              async: false,
              statusMessage: "ClawWorks native hook relay",
            },
          ],
        },
      ],
      "hooks.Stop": [],
      "hooks.state": {
        "/<session-flags>/config.toml:pre_tool_use:0:0": { enabled: false },
        "<session-flags>/config.toml:pre_tool_use:0:0": { enabled: false },
        "/<session-flags>/config.toml:post_tool_use:0:0": { enabled: false },
        "<session-flags>/config.toml:post_tool_use:0:0": { enabled: false },
        "/<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:stop:0:0": { enabled: false },
        "<session-flags>/config.toml:stop:0:0": { enabled: false },
      },
    });
  });

  it("reserves relay timeout margin before Codex can kill the hook subprocess", () => {
    expect(resolveCodexNativeHookRelayCommandTimeoutMs(undefined)).toBe(4000);
    expect(resolveCodexNativeHookRelayCommandTimeoutMs(1)).toBe(750);
    expect(resolveCodexNativeHookRelayCommandTimeoutMs(7)).toBe(6000);
  });

  it("keeps default approval-chain deadlines inside their parent hooks", () => {
    const config = buildCodexNativeHookRelayConfig({ relay: createRelay() });
    const pre = (
      config["hooks.PreToolUse"] as Array<{
        hooks: Array<{ command: string; timeout: number }>;
      }>
    )[0]?.hooks[0];
    const permission = (
      config["hooks.PermissionRequest"] as Array<{
        hooks: Array<{ command: string; timeout: number }>;
      }>
    )[0]?.hooks[0];

    expect(pre).toMatchObject({ timeout: 2455 });
    expect(pre?.command).toContain("--timeout 2454000");
    expect(permission).toMatchObject({ timeout: 625 });
    expect(permission?.command).toContain("--timeout 624000");
  });

  it("finds every enabled sibling PreToolUse hook regardless of current trust", () => {
    expect(
      findCodexNativePreToolUseHookConflicts({
        cwd: "/workspace",
        response: {
          data: [
            {
              cwd: "/workspace",
              hooks: [
                {
                  key: "trusted",
                  eventName: "preToolUse",
                  handlerType: "command",
                  enabled: true,
                  isManaged: false,
                  trustStatus: "trusted",
                },
                {
                  key: "managed",
                  eventName: "preToolUse",
                  handlerType: "command",
                  enabled: true,
                  isManaged: false,
                  trustStatus: "managed",
                },
                {
                  key: "untrusted",
                  eventName: "preToolUse",
                  handlerType: "command",
                  enabled: true,
                  isManaged: false,
                  trustStatus: "untrusted",
                },
                {
                  key: "disabled",
                  eventName: "preToolUse",
                  handlerType: "command",
                  enabled: false,
                  isManaged: true,
                  trustStatus: "managed",
                },
              ],
              warnings: [],
              errors: [],
            },
          ],
        },
      }),
    ).toEqual(["managed", "trusted", "untrusted"]);
  });

  it("omits matchers so Codex MCP tool names reach the relay with a stable trust hash", () => {
    const config = buildCodexNativeHookRelayConfig({
      relay: createRelay(),
      events: ["pre_tool_use", "post_tool_use"],
    });

    expect((config["hooks.PreToolUse"] as Array<{ matcher?: unknown }>)[0]).not.toHaveProperty(
      "matcher",
    );
    expect((config["hooks.PostToolUse"] as Array<{ matcher?: unknown }>)[0]).not.toHaveProperty(
      "matcher",
    );
  });

  it("builds deterministic clearing config when the relay is disabled", () => {
    expect(buildCodexNativeHookRelayDisabledConfig()).toEqual({
      "features.hooks": false,
      "hooks.PreToolUse": [],
      "hooks.PostToolUse": [],
      "hooks.PermissionRequest": [],
      "hooks.Stop": [],
    });
  });

  it("caps oversized native hook cleanup grace before scheduling", () => {
    expect(resolveCodexNativeHookRelayUnregisterGraceMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });
});

describe("Codex native tool release tracking", () => {
  it("marks an exact legacy MCP approval cancellation as not released", () => {
    const tracker = new CodexNativeToolResultTracker();
    tracker.recordLegacyMcpApprovalResult(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "mcp-denied",
        questions: [
          {
            id: "mcp_tool_call_approval_mcp-denied",
            header: "Approve app tool call?",
            question: "Allow GitHub to create an issue?",
          },
        ],
      },
      { answers: {} },
    );

    expect(
      tracker.take({
        type: "mcpToolCall",
        id: "mcp-denied",
        title: null,
        name: null,
        server: "github",
        tool: "create_issue",
        command: null,
        cwd: null,
        query: null,
        status: "failed",
        arguments: { title: "denied" },
        result: null,
        error: { message: "MCP tool call cancelled by user" },
        durationMs: 0,
        aggregatedOutput: null,
        text: "",
        changes: [],
      }),
    ).toEqual({
      toolCallId: "mcp-denied",
      released: false,
      toolInput: { title: "denied" },
    });
  });

  it("does not guess which parallel identical MCP call a modern denial belongs to", () => {
    const tracker = new CodexNativeToolResultTracker();
    const modernDenial = {
      request: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "github",
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { title: "same" } },
      },
      response: { action: "decline" },
    };
    expect(modernDenial.request).not.toHaveProperty("itemId");
    expect(modernDenial.response.action).toBe("decline");

    // The modern denial cannot be recorded without an item id; both calls stay
    // conservatively released because either may have reached the server.
    const releases = ["mcp-parallel-1", "mcp-parallel-2"].map((id) =>
      tracker.take({
        type: "mcpToolCall",
        id,
        title: null,
        name: null,
        server: "github",
        tool: "create_issue",
        command: null,
        cwd: null,
        query: null,
        status: "failed",
        arguments: { title: "same" },
        result: null,
        error: { message: "MCP tool call cancelled" },
        durationMs: 0,
        aggregatedOutput: null,
        text: "",
        changes: [],
      }),
    );
    expect(releases).toEqual([
      { toolCallId: "mcp-parallel-1", released: true, toolInput: { title: "same" } },
      { toolCallId: "mcp-parallel-2", released: true, toolInput: { title: "same" } },
    ]);
  });
});

function createRelay(options?: {
  inactiveEvents?: readonly NativeHookRelayRegistrationHandle["allowedEvents"][number][];
}): NativeHookRelayRegistrationHandle {
  const inactiveEvents = new Set(options?.inactiveEvents ?? []);
  return {
    relayId: "relay-1",
    provider: "codex",
    generation: "generation-1",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    runId: "run-1",
    allowedEvents: ["pre_tool_use", "post_tool_use", "permission_request", "before_agent_finalize"],
    expiresAtMs: Date.now() + 1000,
    shouldRelayEvent: (event) => !inactiveEvents.has(event),
    commandForEvent: (event, commandOptions) =>
      `openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event ${event}${
        event === "pre_tool_use" && inactiveEvents.has(event)
          ? " --pre-tool-use-unavailable noop"
          : ""
      }${commandOptions?.timeoutMs ? ` --timeout ${commandOptions.timeoutMs}` : ""}`,
    renew: () => undefined,
    unregister: () => undefined,
  };
}
