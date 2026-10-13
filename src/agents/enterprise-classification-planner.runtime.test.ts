import type { WorkflowPlanner } from "@openclaw/enterprise-planner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  planWithClassifier,
  tryClassificationWorkflowPlan,
} from "./enterprise-classification-planner.runtime.js";

const deps = vi.hoisted(() => ({ selection: vi.fn(), plugin: vi.fn(), auth: vi.fn() }));
vi.mock("./simple-completion-runtime.js", () => ({
  resolveSimpleCompletionSelectionForAgent: deps.selection,
}));
vi.mock("../plugins/provider-runtime.js", () => ({ resolveProviderRuntimePlugin: deps.plugin }));
vi.mock("./model-auth.js", () => ({ resolveApiKeyForProvider: deps.auth }));

const input: Parameters<WorkflowPlanner>[0] = {
  trees: [
    {
      id: "ops",
      name: "Operations",
      root: {
        id: "root",
        title: "Operations",
        children: [
          {
            id: "returns",
            title: "Returns",
            children: [
              { id: "assess", title: "Assess return eligibility" },
              { id: "submit", title: "Submit refund" },
            ],
          },
          { id: "shipping", title: "Delivery lookup" },
        ],
      },
    },
  ],
  requestText: "Assess a return and look up delivery; do not submit a refund.",
  candidates: "Ops → Returns → Assess / Submit; Shipping",
};
function run(answers: Record<string, { type: "binary"; probability: number }>) {
  const classify = vi
    .fn()
    .mockResolvedValueOnce({ tree: { type: "choice", choice: "ops" } })
    .mockResolvedValueOnce(answers);
  const result = planWithClassifier({
    classify,
    modelId: "classifier",
    input,
    signal: new AbortController().signal,
  });
  return { result, classify };
}
describe("structured workflow routing", () => {
  it("selects several deep leaves without including the excluded sibling", async () => {
    const { result, classify } = run({
      $clarify: { type: "binary", probability: 0 },
      assess: { type: "binary", probability: 0.99 },
      submit: { type: "binary", probability: 0.01 },
      shipping: { type: "binary", probability: 0.9 },
    });
    expect(await result).toMatchObject({
      kind: "decided",
      treeId: "ops",
      routes: ["assess", "shipping"],
    });
    expect(classify.mock.calls[1][0].questions.assess.instructions).toContain(
      "Operations / Operations / Returns / Assess return eligibility",
    );
    expect(classify.mock.calls[1][0].questions).not.toHaveProperty("returns");
  });
  it("asks instead of executing an ambiguous operation", async () => {
    const { result } = run({
      $clarify: { type: "binary", probability: 0.9 },
      assess: { type: "binary", probability: 0.5 },
      submit: { type: "binary", probability: 0.5 },
      shipping: { type: "binary", probability: 0 },
    });
    expect(await result).toMatchObject({ kind: "clarification", treeId: "ops" });
  });
  it("rejects missing classification answers", async () => {
    expect(await run({ $clarify: { type: "binary", probability: 0 } }).result).toEqual({
      kind: "failed",
    });
  });
  it("does not call the route phase when no work-map applies", async () => {
    const classify = vi.fn().mockResolvedValue({ tree: { type: "choice", choice: "$none" } });
    expect(
      await planWithClassifier({
        classify,
        modelId: "classifier",
        input,
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "decided", treeId: null, routes: [] });
    expect(classify).toHaveBeenCalledOnce();
  });
});

describe("classification provider dispatch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    deps.selection.mockReturnValue({
      provider: "classifier",
      modelId: "current",
      agentDir: "/agent",
      profileId: "classifier:work",
    });
    deps.auth.mockResolvedValue({ apiKey: "test-key" });
  });
  const params = () => ({
    cfg: {},
    agentId: "main",
    literalModelRef: true,
    modelRef: "classifier/current@classifier:work",
    completionTimeoutMs: 1000,
    input,
    signal: new AbortController().signal,
  });
  it("honors provider activation and leaves ordinary providers on text completion", async () => {
    deps.plugin.mockReturnValue(undefined);
    expect(await tryClassificationWorkflowPlan(params())).toBeUndefined();
    expect(deps.auth).not.toHaveBeenCalled();
    expect(deps.plugin).toHaveBeenCalledWith({
      provider: "classifier",
      modelId: "current",
      config: {},
    });
  });
  it("uses the explicit credential and does not bind a work-map when auth is unavailable", async () => {
    const classify = vi.fn().mockResolvedValue({ tree: { type: "choice", choice: "$none" } });
    deps.plugin.mockReturnValue({ classify });
    expect(await tryClassificationWorkflowPlan(params())).toEqual({
      kind: "decided",
      treeId: null,
      routes: [],
    });
    expect(deps.auth).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "classifier",
        profileId: "classifier:work",
        lockedProfile: true,
      }),
    );
    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "test-key", modelId: "current" }),
    );
    deps.auth.mockRejectedValue(new Error("missing credential"));
    expect(await tryClassificationWorkflowPlan(params())).toEqual({ kind: "unavailable" });
    expect(classify).toHaveBeenCalledOnce();
  });
  it("treats a rejected credential as unavailable but not transient or malformed answers", async () => {
    const classify = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("invalid key"), { status: 401 }));
    deps.plugin.mockReturnValue({ classify });
    expect(await tryClassificationWorkflowPlan(params())).toEqual({ kind: "unavailable" });
    for (const status of [429, 500]) {
      classify.mockRejectedValue(Object.assign(new Error("transient"), { status }));
      await expect(tryClassificationWorkflowPlan(params())).rejects.toThrow("transient");
    }
  });
  it("propagates cancellation before sending classification input", async () => {
    const classify = vi.fn();
    deps.plugin.mockReturnValue({ classify });
    await expect(
      tryClassificationWorkflowPlan({ ...params(), signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(classify).not.toHaveBeenCalled();
  });
});
