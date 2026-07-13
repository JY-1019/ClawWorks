import { describe, expect, it, vi } from "vitest";
import type { WorkflowTreeDefinition } from "../enterprise/types.js";
import {
  createModelRoutePlanner,
  parseRoutePlannerResponse,
} from "./enterprise-route-planner.runtime.js";

const TREE: WorkflowTreeDefinition = {
  schema: "clawworks.workflow-tree",
  schemaVersion: 1,
  id: "acme.ops",
  version: "1.0.0",
  name: "Ops",
  root: { id: "ops", title: "Operations", children: [{ id: "ops.pay", title: "Pay" }] },
};

function planner(deps: {
  prepare?: ReturnType<typeof vi.fn>;
  complete?: ReturnType<typeof vi.fn>;
}) {
  const prepare =
    deps.prepare ?? vi.fn(async () => ({ model: { id: "m" }, auth: { apiKey: "k" } }));
  const complete =
    deps.complete ??
    vi.fn(async () => ({ content: [{ type: "text", text: '{"routes":["ops.pay"]}' }] }));
  const build = createModelRoutePlanner({
    cfg: {} as Parameters<typeof createModelRoutePlanner>[0]["cfg"],
    agentId: "main",
    deps: {
      prepareSimpleCompletionModelForAgent: prepare as never,
      completeWithPreparedSimpleCompletionModel: complete as never,
    },
  });
  return { run: build, prepare, complete };
}

describe("parseRoutePlannerResponse", () => {
  it("parses a bare object", () => {
    expect(parseRoutePlannerResponse('{"routes":["a.b"],"rationale":"why"}')).toEqual({
      routes: ["a.b"],
      rationale: "why",
    });
  });

  it("parses a fenced object and one wrapped in prose", () => {
    expect(parseRoutePlannerResponse('```json\n{"routes":["a"]}\n```')).toEqual({ routes: ["a"] });
    expect(parseRoutePlannerResponse('Sure! {"routes":["a"]} hope that helps')).toEqual({
      routes: ["a"],
    });
  });

  it("returns null for unparseable or wrong-shaped replies (caller plans the whole tree)", () => {
    expect(parseRoutePlannerResponse("no json here")).toBeNull();
    expect(parseRoutePlannerResponse("{not json}")).toBeNull();
    expect(parseRoutePlannerResponse('{"routes":"not-an-array"}')).toBeNull();
  });
});

describe("createModelRoutePlanner cancellation", () => {
  it("never contacts the model when the run is already aborted", async () => {
    const { run, prepare, complete } = planner({});
    const controller = new AbortController();
    controller.abort();
    const decision = await run?.({
      tree: TREE,
      requestText: "pay it",
      candidates: "ops",
      signal: controller.signal,
    });
    expect(decision).toBeNull();
    // Not even model PREPARATION should happen for a cancelled run.
    expect(prepare).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not send the request text when the run aborts during model preparation", async () => {
    const controller = new AbortController();
    const prepare = vi.fn(async () => {
      // The user cancels while the model is being prepared.
      controller.abort();
      return { model: { id: "m" }, auth: { apiKey: "k" } };
    });
    const { run, complete } = planner({ prepare });
    const decision = await run?.({
      tree: TREE,
      requestText: "pay it",
      candidates: "ops",
      signal: controller.signal,
    });
    expect(decision).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns the parsed decision on the happy path", async () => {
    const { run, complete } = planner({});
    const decision = await run?.({ tree: TREE, requestText: "pay it", candidates: "ops" });
    expect(decision).toEqual({ routes: ["ops.pay"] });
    expect(complete).toHaveBeenCalled();
  });

  it("plans the whole tree (null) when the model is unavailable", async () => {
    const prepare = vi.fn(async () => ({ error: "no api key" }));
    const { run, complete } = planner({ prepare });
    const decision = await run?.({ tree: TREE, requestText: "pay it", candidates: "ops" });
    expect(decision).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });
});
