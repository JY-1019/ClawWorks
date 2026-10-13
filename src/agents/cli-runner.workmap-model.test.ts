import { afterEach, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "./cli-backends.js";
import { runCliAgent } from "./cli-runner.js";
import type { RunCliAgentParams } from "./cli-runner/types.js";

const prepare = vi.hoisted(() => vi.fn());
vi.mock("./cli-runner/prepare.runtime.js", () => ({ prepareCliRunContext: prepare }));
vi.mock("./enterprise-mediation.js", () => ({
  applyEnterpriseMediation: async (params: RunCliAgentParams) => ({
    mediated: true,
    params: { ...params, provider: "anthropic", model: "claude-opus-4-7" },
  }),
  finishEnterpriseMediation: () => {},
}));
afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  prepare.mockReset();
});
it("keeps the chosen CLI account and transport for a canonical provider pin", async () => {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude", modelArg: "--model" },
      },
    ],
  });
  const stop = new Error("reached CLI preparation");
  prepare.mockRejectedValue(stop);
  await expect(
    runCliAgent({
      sessionId: "pin",
      sessionKey: "agent:main:pin",
      sessionFile: "/tmp/pin.jsonl",
      workspaceDir: "/tmp",
      prompt: "hello",
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      authProfileId: "anthropic:private",
      timeoutMs: 1000,
      runId: "pin-cli",
      config: {},
    }),
  ).rejects.toBe(stop);
  expect(prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "claude-cli",
      model: "claude-opus-4-7",
      authProfileId: "anthropic:private",
    }),
  );
});
