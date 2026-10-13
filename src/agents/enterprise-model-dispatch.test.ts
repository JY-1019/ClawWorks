import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueCommandInLane, getCommandLaneActiveTaskIds } from "../process/command-queue.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { getEnterpriseDispatchContext } from "./enterprise-dispatch-context.js";
import {
  EnterpriseModelExecutionError,
  runWithEnterpriseModelFallback,
} from "./enterprise-model-dispatch.js";
import { FailoverError } from "./failover-error.js";

const mocks = vi.hoisted(() => ({
  pin: "ollama/qwen3:8b" as string | undefined,
  registered: true,
  mediate: vi.fn(),
  finish: vi.fn(),
  fallback: vi.fn(),
}));
vi.mock("../enterprise/runtime.js", () => ({
  resolveEnterpriseMode: () => "enforce",
  getEnterpriseActiveRun: () => ({ plan: { executionModel: mocks.pin } }),
}));
vi.mock("../enterprise/tree-registry.js", () => ({
  getWorkflowTreeRegistrySnapshot: () => ({
    entries: mocks.registered ? [{ tree: { executionModel: "ollama/qwen3:8b" } }] : [],
  }),
}));
vi.mock("./enterprise-mediation.js", () => ({
  applyEnterpriseMediation: mocks.mediate,
  finishEnterpriseMediation: mocks.finish,
}));
vi.mock("./model-fallback.js", () => ({ runWithModelFallback: mocks.fallback }));
vi.mock("./embedded-agent-runner/context-engine-maintenance.js", () => ({
  waitForDeferredTurnMaintenanceForSession: async () => {},
}));
const answer: EmbeddedAgentRunResult = { payloads: [{ text: "Done" }], meta: { durationMs: 1 } };
const params = () => ({
  cfg: {},
  provider: "openai",
  model: "gpt-5.5",
  fallbacksOverride: ["mistral/mistral-small-latest"],
  enterpriseRun: {
    runId: "bound-run",
    sessionId: "bound-session",
    sessionKey: "agent:main:bound",
    prompt: "handle return",
    timeoutMs: 1000,
  },
  run: vi.fn(async () => answer),
});
beforeEach(() => {
  mocks.pin = "ollama/qwen3:8b";
  mocks.registered = true;
  mocks.mediate.mockReset().mockResolvedValue({ mediated: true });
  mocks.finish.mockReset();
  mocks.fallback.mockReset().mockImplementation(async (input) => ({
    outcome: "completed",
    result: await input.run(input.provider, input.model),
    provider: input.provider,
    model: input.model,
    attempts: [],
  }));
});
describe("work-map model dispatch", () => {
  it("plans before model/auth selection, disables alternate models and owns trace completion", async () => {
    const input = params();
    input.run.mockImplementation(async () => {
      expect(getEnterpriseDispatchContext("bound-run")).toBeDefined();
      expect(getEnterpriseDispatchContext("child-run")).toBeUndefined();
      expect(mocks.finish).not.toHaveBeenCalled();
      return answer;
    });
    const result = await runWithEnterpriseModelFallback(input);
    expect(mocks.mediate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.fallback.mock.invocationCallOrder[0],
    );
    expect(mocks.mediate).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", model: "gpt-5.5" }),
    );
    expect(mocks.fallback).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ollama", model: "qwen3:8b", fallbacksOverride: [] }),
    );
    expect(result.executionModel).toBe("ollama/qwen3:8b");
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith("bound-run", { result: answer });
    expect(getEnterpriseDispatchContext("bound-run")).toBeUndefined();
  });
  it("keeps the normal model and fallback list when the selected map has no binding", async () => {
    mocks.pin = undefined;
    const input = params();
    const result = await runWithEnterpriseModelFallback(input);
    expect(result.executionModel).toBeUndefined();
    expect(mocks.fallback).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.5",
        fallbacksOverride: input.fallbacksOverride,
      }),
    );
  });
  it.each([{ modelRun: true }, { promptMode: "none" }])(
    "does not mediate raw calls: %j",
    async (raw) => {
      const input = params();
      await runWithEnterpriseModelFallback({
        ...input,
        enterpriseRun: { ...input.enterpriseRun, ...raw },
      });
      expect(mocks.mediate).not.toHaveBeenCalled();
    },
  );
  it("never starts execution after governance blocks or asks for clarification", async () => {
    mocks.mediate.mockResolvedValue({ blockedResult: answer });
    expect((await runWithEnterpriseModelFallback(params())).result).toBe(answer);
    expect(mocks.fallback).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledTimes(1);
  });
  it("marks pinned failures terminal and still releases the lanes and trace", async () => {
    const failure = new Error("503 unavailable");
    mocks.fallback.mockRejectedValueOnce(failure);
    await expect(runWithEnterpriseModelFallback(params())).rejects.toBeInstanceOf(
      EnterpriseModelExecutionError,
    );
    expect(mocks.finish).toHaveBeenCalledWith("bound-run", {
      error: expect.objectContaining({ cause: failure }),
    });
    await expect(runWithEnterpriseModelFallback(params())).resolves.toHaveProperty(
      "result",
      answer,
    );
  });
  it("does not plan or dispatch a cancelled queued turn", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runWithEnterpriseModelFallback({ ...params(), abortSignal: controller.signal }),
    ).rejects.toThrow();
    expect(mocks.mediate).not.toHaveBeenCalled();
    expect(mocks.fallback).not.toHaveBeenCalled();
  });
  it("the real fallback engine never tries configured alternatives after a pinned failure", async () => {
    const actual =
      await vi.importActual<typeof import("./model-fallback.js")>("./model-fallback.js");
    mocks.fallback.mockImplementationOnce(actual.runWithModelFallback);
    const input = params();
    input.run.mockRejectedValue(
      new FailoverError("pinned model unavailable", {
        reason: "rate_limit",
        provider: "ollama",
        model: "qwen3:8b",
      }),
    );
    await expect(
      runWithEnterpriseModelFallback({ ...input, skipAuthProfileRuntime: true }),
    ).rejects.toBeInstanceOf(EnterpriseModelExecutionError);
    expect(input.run).toHaveBeenCalledExactlyOnceWith(
      "ollama",
      "qwen3:8b",
      expect.objectContaining({ isFinalFallbackAttempt: true }),
    );
  });
  it("retains an explicit nested lane and pinned routing credentials", async () => {
    const input = params();
    mocks.mediate.mockImplementationOnce(async () => {
      expect(getCommandLaneActiveTaskIds("nested-work-map")).toHaveLength(1);
      return { mediated: true };
    });
    await runWithEnterpriseModelFallback({
      ...input,
      lane: "nested-work-map",
      enterpriseRun: {
        ...input.enterpriseRun,
        authProfileId: "openai:tenant",
        authProfileIdSource: "user",
      },
    });
    expect(mocks.mediate).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "openai:tenant", authProfileIdSource: "user" }),
    );
  });
  it("finalizes a planning timeout and prevents a late planner from starting execution", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let oldSignal: AbortSignal | undefined;
    mocks.mediate.mockImplementationOnce(async () => {
      oldSignal = getEnterpriseDispatchContext("bound-run")!.abortSignal;
      await gate;
      return { mediated: true };
    });
    try {
      const promise = runWithEnterpriseModelFallback(params());
      const rejection = expect(promise).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(31_001);
      await rejection;
      expect(oldSignal?.aborted).toBe(true);
      expect(mocks.finish).toHaveBeenCalledTimes(1);
      expect(mocks.fallback).not.toHaveBeenCalled();
      await runWithEnterpriseModelFallback(params());
      expect(mocks.finish).toHaveBeenCalledTimes(2);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.finish).toHaveBeenCalledTimes(2);
      expect(mocks.fallback).toHaveBeenCalledTimes(1);
    } finally {
      release();
      vi.useRealTimers();
    }
  });
  it("notifies cron execution before a slow routing call", async () => {
    const started = vi.fn();
    mocks.mediate.mockImplementationOnce(async () => {
      expect(started).toHaveBeenCalledTimes(1);
      return { mediated: true };
    });
    const input = params();
    await runWithEnterpriseModelFallback({
      ...input,
      enterpriseRun: { ...input.enterpriseRun, trigger: "cron", onExecutionStarted: started },
    });
  });
  it.each(["session:agent:main:bound", "waiting-global"])(
    "reports a blocked %s lane before admission",
    async (blockedLane) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = enqueueCommandInLane(blockedLane, () => gate);
      const input = params();
      const waiting = vi.fn();
      const started = vi.fn();
      const run = runWithEnterpriseModelFallback({
        ...input,
        lane: "waiting-global",
        enterpriseRun: {
          ...input.enterpriseRun,
          trigger: "cron",
          onLaneWait: waiting,
          onExecutionStarted: started,
        },
      });
      try {
        await vi.waitFor(() => expect(waiting).toHaveBeenLastCalledWith({ waiting: true }));
        expect(started).not.toHaveBeenCalled();
        expect(mocks.mediate).not.toHaveBeenCalled();
      } finally {
        release();
      }
      await Promise.all([blocker, run]);
      expect(waiting).toHaveBeenLastCalledWith({ waiting: false });
      expect(started).toHaveBeenCalledTimes(1);
    },
  );
  it("holds same-session order across asynchronous planning and dispatch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.mediate.mockImplementationOnce(async () => {
      await gate;
      return { mediated: true };
    });
    const first = runWithEnterpriseModelFallback(params());
    const secondInput = params();
    secondInput.enterpriseRun.runId = "second-run";
    const second = runWithEnterpriseModelFallback(secondInput);
    await vi.waitFor(() => expect(mocks.mediate).toHaveBeenCalledTimes(1));
    expect(secondInput.run).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(mocks.mediate).toHaveBeenCalledTimes(2);
    expect(secondInput.run).toHaveBeenCalledTimes(1);
  });
});
