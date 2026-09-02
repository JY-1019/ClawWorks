/**
 * Gateway startup orchestration tests.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const ensureOpenClawModelsJsonMock = vi.fn<
  (
    config: unknown,
    agentDir: unknown,
    options?: unknown,
  ) => Promise<{ agentDir: string; wrote: boolean }>
>(async () => ({ agentDir: "/tmp/agent", wrote: false }));
const resolveModelMock = vi.fn<(...args: unknown[]) => Record<string, never>>(() => ({}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentDir: () => "/tmp/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
  resolveDefaultAgentId: () => "default",
}));

vi.mock("../agents/models-config.js", () => ({
  ensureOpenClawModelsJson: (config: unknown, agentDir: unknown, options?: unknown) =>
    ensureOpenClawModelsJsonMock(config, agentDir, options),
}));

vi.mock("../agents/embedded-agent-runner/model.js", () => ({
  resolveModel: (...args: unknown[]) => resolveModelMock(...args),
}));

let prewarmConfiguredPrimaryModel: typeof import("./server-startup-post-attach.js").testing.prewarmConfiguredPrimaryModel;
let shouldSkipStartupModelPrewarm: typeof import("./server-startup-post-attach.js").testing.shouldSkipStartupModelPrewarm;

function expectModelsJsonPrewarmCall(cfg: OpenClawConfig) {
  expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledTimes(1);
  const [calledConfig, agentDir, options] = ensureOpenClawModelsJsonMock.mock.calls.at(0) ?? [];
  expect(calledConfig).toBe(cfg);
  expect(agentDir).toBe("/tmp/agent");
  expect(options).toEqual({
    workspaceDir: "/tmp/workspace",
    providerDiscoveryProviderIds: ["openai"],
    providerDiscoveryTimeoutMs: 5000,
    providerDiscoveryEntriesOnly: true,
  });
}

describe("gateway startup primary model warmup", () => {
  beforeAll(async () => {
    ({
      testing: { prewarmConfiguredPrimaryModel, shouldSkipStartupModelPrewarm },
    } = await import("./server-startup-post-attach.js"));
  });

  beforeEach(() => {
    ensureOpenClawModelsJsonMock.mockClear();
    resolveModelMock.mockClear();
  });

  it("prewarms an explicit configured primary model", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;

    await prewarmConfiguredPrimaryModel({
      cfg,
      log: { warn: vi.fn() },
    });

    expectModelsJsonPrewarmCall(cfg);
    expect(resolveModelMock).not.toHaveBeenCalled();
  });

  it("skips warmup when no explicit primary model is configured", async () => {
    await prewarmConfiguredPrimaryModel({
      cfg: {} as OpenClawConfig,
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(resolveModelMock).not.toHaveBeenCalled();
  });

  it("honors the startup model prewarm skip env", () => {
    expect(shouldSkipStartupModelPrewarm({})).toBe(false);
    expect(
      shouldSkipStartupModelPrewarm({
        OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
      }),
    ).toBe(true);
    expect(
      shouldSkipStartupModelPrewarm({
        OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "true",
      }),
    ).toBe(true);
  });

  it("skips static warmup for configured CLI backends", async () => {
    await prewarmConfiguredPrimaryModel({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "codex-cli/gpt-5.5",
            },
            cliBackends: {
              "codex-cli": {
                command: "codex",
                args: ["exec"],
              },
            },
          },
        },
      } as OpenClawConfig,
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(resolveModelMock).not.toHaveBeenCalled();
  });

  it("warns when scoped models.json preparation fails", async () => {
    ensureOpenClawModelsJsonMock.mockRejectedValueOnce(new Error("models write failed"));
    const warn = vi.fn();

    await prewarmConfiguredPrimaryModel({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "codex/gpt-5.4",
            },
          },
        },
      } as OpenClawConfig,
      log: { warn },
    });

    expect(warn).toHaveBeenCalledWith(
      "startup model warmup failed for codex: Error: models write failed",
    );
  });

  it("warms the route planner's provider even when the primary is CLI-backed", async () => {
    // The router calls a provider API directly, and on a CLI primary it is the only
    // model that needs a catalog row. Without this the first governed turn either
    // pays a cold scan or reports the router unavailable.
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "codex-cli/gpt-5.5" },
          cliBackends: { "codex-cli": { command: "codex", args: ["exec"] } },
        },
      },
      enterprise: { mode: "enforce", routePlanner: { model: "mistral/mistral-medium-3-5" } },
    } as OpenClawConfig;

    await prewarmConfiguredPrimaryModel({ cfg, log: { warn: vi.fn() } });

    const options = ensureOpenClawModelsJsonMock.mock.calls.at(0)?.[2];
    expect(options).toMatchObject({ providerDiscoveryProviderIds: ["mistral"] });
  });

  it("warms a router on the default provider when no primary is configured", async () => {
    // With no explicit primary the primary is skipped, but the router still needs its
    // catalog even when it resolves to the same provider the default would have.
    await prewarmConfiguredPrimaryModel({
      cfg: {
        enterprise: { mode: "enforce", routePlanner: { model: "openai/gpt-5.4-mini" } },
      } as OpenClawConfig,
      log: { warn: vi.fn() },
    });

    const options = ensureOpenClawModelsJsonMock.mock.calls.at(0)?.[2];
    expect(options).toMatchObject({ providerDiscoveryProviderIds: ["openai"] });
  });

  it("leaves a dormant route planner alone when enterprise mode is off", async () => {
    await prewarmConfiguredPrimaryModel({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "codex-cli/gpt-5.5" },
            cliBackends: { "codex-cli": { command: "codex", args: ["exec"] } },
          },
        },
        enterprise: { mode: "off", routePlanner: { model: "mistral/mistral-medium-3-5" } },
      } as OpenClawConfig,
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
  });
});
