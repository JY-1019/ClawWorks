import { describe, expect, it } from "vitest";
import { BUILTIN_ASSIST_TREE, BUILTIN_SYSTEM_TREE } from "./builtin-trees.js";
import {
  buildEnterprisePromptSection,
  buildEnterpriseRunPlan,
  classifyWorkflowTrigger,
  selectWorkflowTree,
} from "./plan.js";
import type { WorkflowTreeDefinition } from "./types.js";

const REFUND_TREE: WorkflowTreeDefinition = {
  schema: "clawworks.workflow-tree",
  schemaVersion: 1,
  id: "acme.refunds",
  version: "1.0.0",
  name: "Refund handling",
  match: { keywords: ["refund", "chargeback"], triggers: ["user"] },
  root: {
    id: "refunds",
    title: "Handle a refund request",
    ontology: {
      allowedTools: ["memory_search", "message"],
      constraints: [{ id: "policy", description: "Only refund within 30 days." }],
      contextHints: ["Refund window: 30 days."],
      expectedOutput: "Refund decision with rationale.",
    },
    children: [
      { id: "refunds.verify", title: "Verify the purchase" },
      { id: "refunds.decide", title: "Decide the refund" },
    ],
  },
};

describe("classifyWorkflowTrigger", () => {
  it("maps triggers onto tree trigger classes", () => {
    expect(classifyWorkflowTrigger({ trigger: "user" })).toBe("user");
    expect(classifyWorkflowTrigger({ trigger: "manual" })).toBe("user");
    expect(classifyWorkflowTrigger({})).toBe("user");
    expect(classifyWorkflowTrigger({ trigger: "cron" })).toBe("system");
    expect(classifyWorkflowTrigger({ trigger: "heartbeat" })).toBe("system");
    expect(classifyWorkflowTrigger({ trigger: "user", spawnedBy: "agent:main:x" })).toBe(
      "subagent",
    );
  });
});

describe("selectWorkflowTree", () => {
  const trees = [BUILTIN_ASSIST_TREE, BUILTIN_SYSTEM_TREE, REFUND_TREE];

  it("prefers keyword matches over trigger-only trees", () => {
    const selection = selectWorkflowTree({
      requestText: "I want a refund for my order",
      trigger: "user",
      trees,
    });
    expect(selection.tree.id).toBe("acme.refunds");
    expect(selection.matchedBy).toBe("keywords");
  });

  it("skips keyword-scoped trees when nothing matches", () => {
    const selection = selectWorkflowTree({
      requestText: "what is the weather like",
      trigger: "user",
      trees,
    });
    expect(selection.tree.id).toBe("clawworks.assist");
    expect(selection.matchedBy).toBe("trigger");
  });

  it("routes system triggers to the system tree", () => {
    const selection = selectWorkflowTree({ requestText: "tick", trigger: "system", trees });
    expect(selection.tree.id).toBe("clawworks.system");
  });

  it("falls back to the built-in default when no tree matches the trigger", () => {
    const selection = selectWorkflowTree({
      requestText: "hello",
      trigger: "system",
      trees: [REFUND_TREE],
    });
    expect(selection.tree.id).toBe("clawworks.assist");
    expect(selection.matchedBy).toBe("default");
  });

  it("falls back to an imported override of the default tree, not the static built-in", () => {
    const assistOverride: WorkflowTreeDefinition = {
      ...BUILTIN_ASSIST_TREE,
      version: "9.9.9",
      match: { keywords: ["special"], triggers: ["user"] },
    };
    const selection = selectWorkflowTree({
      requestText: "hello",
      trigger: "user",
      trees: [assistOverride, BUILTIN_SYSTEM_TREE],
    });
    expect(selection.matchedBy).toBe("default");
    expect(selection.tree.version).toBe("9.9.9");
  });

  it("treats an empty trigger list like user-triggered (programmatic trees)", () => {
    const tree: WorkflowTreeDefinition = {
      ...REFUND_TREE,
      id: "acme.empty-triggers",
      match: { keywords: ["refund"], triggers: [] },
    };
    const selection = selectWorkflowTree({
      requestText: "refund please",
      trigger: "user",
      trees: [tree],
    });
    expect(selection.tree.id).toBe("acme.empty-triggers");
  });
});

describe("buildEnterpriseRunPlan", () => {
  it("flattens the subtree depth-first with deterministic seq and activates the root", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-1",
      requestText: "please process my refund",
      trigger: "user",
      mode: "enforce",
      trees: [BUILTIN_ASSIST_TREE, REFUND_TREE],
      now: 1000,
    });
    expect(plan.treeId).toBe("acme.refunds");
    expect(plan.nodes.map((node) => node.nodeId)).toEqual([
      "refunds",
      "refunds.verify",
      "refunds.decide",
    ]);
    expect(plan.nodes.map((node) => node.seq)).toEqual([0, 1, 2]);
    expect(plan.nodes[1].parentId).toBe("refunds");
    expect(plan.activeNodeId).toBe("refunds");
    expect(plan.createdAt).toBe(1000);
  });

  it("truncates and collapses whitespace in the request summary", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-2",
      requestText: `a  b\n\nc ${"x".repeat(600)}`,
      trigger: "user",
      mode: "enforce",
      trees: [BUILTIN_ASSIST_TREE],
    });
    expect(plan.requestSummary.startsWith("a b c ")).toBe(true);
    expect(plan.requestSummary.length).toBeLessThanOrEqual(300);
    expect(plan.requestSummary.endsWith("…")).toBe(true);
  });
});

describe("buildEnterprisePromptSection", () => {
  it("returns an empty string for guidance-free built-in trees (prompt-neutral default)", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-3",
      requestText: "hello",
      trigger: "user",
      mode: "enforce",
      trees: [BUILTIN_ASSIST_TREE],
    });
    expect(buildEnterprisePromptSection(plan)).toBe("");
  });

  it("renders a compact digest for guidance-bearing ontologies", () => {
    const plan = buildEnterpriseRunPlan({
      runId: "run-4",
      requestText: "refund please",
      trigger: "user",
      mode: "enforce",
      trees: [REFUND_TREE],
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("## Enterprise workflow");
    expect(section).toContain('workflow "Refund handling" (acme.refunds@1.0.0)');
    expect(section).toContain("Current step: Handle a refund request");
    expect(section).toContain("1. Verify the purchase");
    expect(section).toContain("- Only refund within 30 days.");
    expect(section).toContain("- Refund window: 30 days.");
    expect(section).toContain("Allowed tools: memory_search, message");
    expect(section).toContain("Expected output: Refund decision with rationale.");
  });

  it("renders knowledge sources when the ontology declares them", () => {
    const tree: WorkflowTreeDefinition = {
      ...REFUND_TREE,
      root: {
        id: "refunds",
        title: "Handle a refund request",
        ontology: { knowledgeFoundations: ["acme.support-kb", "acme.policy-kb"] },
      },
    };
    const plan = buildEnterpriseRunPlan({
      runId: "run-6",
      requestText: "refund",
      trigger: "user",
      mode: "enforce",
      trees: [tree],
    });
    expect(buildEnterprisePromptSection(plan)).toContain(
      "Knowledge sources: acme.policy-kb, acme.support-kb",
    );
  });

  it("renders action guidance when actions are the only ontology content", () => {
    const tree: WorkflowTreeDefinition = {
      ...REFUND_TREE,
      root: {
        id: "refunds",
        title: "Handle a refund request",
        ontology: {
          actions: [
            { id: "lookup-order", description: "Find the purchase", tools: ["memory_search"] },
            { id: "notify" },
          ],
        },
      },
    };
    const plan = buildEnterpriseRunPlan({
      runId: "run-5",
      requestText: "refund",
      trigger: "user",
      mode: "enforce",
      trees: [tree],
    });
    const section = buildEnterprisePromptSection(plan);
    expect(section).toContain("Actions:");
    expect(section).toContain("- lookup-order: Find the purchase — tools: memory_search");
    expect(section).toContain("- notify");
  });
});
