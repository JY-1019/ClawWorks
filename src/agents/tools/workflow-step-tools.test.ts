import { afterEach, describe, expect, it } from "vitest";
import {
  clearEnterpriseActiveRunsForTest,
  registerEnterpriseActiveRun,
  type EnterpriseActiveRun,
} from "../../enterprise/runtime.js";
import type { EnterprisePlanNode, EnterpriseRunPlan } from "../../enterprise/types.js";
import { createCompleteStepTool } from "./workflow-step-tools.js";

const RUN_ID = "run-steps";

function leaf(nodeId: string, seq: number, title: string): EnterprisePlanNode {
  return {
    nodeId,
    parentId: "desk",
    seq,
    title,
    ontology: { allowedTools: ["message"] },
  };
}

function makeRun(opts: { activeNodeId?: string; nodes?: EnterprisePlanNode[] } = {}) {
  const plan: EnterpriseRunPlan = {
    runId: RUN_ID,
    treeId: "acme.support-desk",
    treeVersion: "1.0.0",
    treeName: "Support desk",
    matchedBy: "planner",
    requestSummary: "refund please",
    nodes: opts.nodes ?? [
      { nodeId: "desk", parentId: null, seq: 0, title: "Desk", ontology: {} },
      leaf("desk.triage", 1, "Triage"),
      leaf("desk.answer", 2, "Answer"),
    ],
    activeNodeId: opts.activeNodeId ?? "desk.triage",
    mode: "enforce",
    createdAt: 0,
  };
  const run: EnterpriseActiveRun = { plan, policies: [] };
  registerEnterpriseActiveRun(run);
  return run;
}

async function callCompleteStep(
  runId: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const tool = createCompleteStepTool({ runId });
  const result = await tool.execute("call-1", params);
  const text = (result as { content?: { type: string; text?: string }[] }).content?.[0]?.text ?? "";
  return JSON.parse(text) as Record<string, unknown>;
}

afterEach(() => {
  clearEnterpriseActiveRunsForTest();
});

describe("complete_step", () => {
  it("runs sequentially so a sibling call cannot straddle the transition", () => {
    // The batch was authorized against the node the run was standing on, and this
    // tool moves that node synchronously — so a parallel sibling could execute
    // under a node governance never approved it for.
    expect(createCompleteStepTool({ runId: RUN_ID }).executionMode).toBe("sequential");
  });

  it("advances to the next step and names it for the model", async () => {
    makeRun();
    const payload = await callCompleteStep(RUN_ID, { summary: "classified as a refund" });
    expect(payload).toMatchObject({
      routeComplete: false,
      completed: { nodeId: "desk.triage" },
      step: { nodeId: "desk.answer", ordinal: 2, total: 2 },
    });
    // The message has to carry the step id: it is the name the model uses to
    // address the step, and the one every denial and trace event uses.
    expect(String(payload.message)).toContain("desk.answer");
  });

  it("reports the route finished on the last step", async () => {
    makeRun({ activeNodeId: "desk.answer" });
    const payload = await callCompleteStep(RUN_ID);
    expect(payload).toMatchObject({ routeComplete: true, completed: { nodeId: "desk.answer" } });
  });

  it("corrects a model that names the wrong step instead of advancing", async () => {
    makeRun();
    const payload = await callCompleteStep(RUN_ID, { step: "desk.answer" });
    // Refusing is not enough — the result has to say where the run actually is,
    // or the model has no way to recover.
    expect(String(payload.error)).toContain("desk.triage");
    expect(payload.step).toMatchObject({ nodeId: "desk.triage", ordinal: 1 });
  });

  it("refuses an unmediated run as a result, not a throw", async () => {
    const payload = await callCompleteStep("no-such-run");
    expect(String(payload.error)).toContain("not governed by a workflow tree");
  });

  it("refuses a single-scope run that has no steps to walk", async () => {
    makeRun({
      activeNodeId: "desk",
      nodes: [{ nodeId: "desk", parentId: null, seq: 0, title: "Desk", ontology: {} }],
    });
    const payload = await callCompleteStep(RUN_ID);
    expect(String(payload.error)).toContain("no steps");
  });

  it("hands the summary to the runtime, which owns redaction and bounding", async () => {
    const run = makeRun();
    const recorded: string[] = [];
    run.sink = (event) => {
      if (event.kind === "node.completed" && typeof event.payload.summary === "string") {
        recorded.push(event.payload.summary);
      }
    };
    await callCompleteStep(RUN_ID, { summary: "x".repeat(5000) });
    // Bounded once, at the persistence boundary — a second trim here would be a
    // weaker duplicate of the same rule.
    expect(recorded[0]?.length).toBeLessThanOrEqual(300);
  });
});
