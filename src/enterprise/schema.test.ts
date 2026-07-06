import { describe, expect, it } from "vitest";
import { BUILTIN_WORKFLOW_TREES } from "./builtin-trees.js";
import { validateWorkflowTreeDefinition } from "./schema.js";

function validTree(): Record<string, unknown> {
  return {
    schema: "clawworks.workflow-tree",
    schemaVersion: 1,
    id: "acme.support",
    version: "2.1.0",
    name: "Customer support",
    match: { keywords: ["refund"], triggers: ["user"], priority: 10 },
    root: {
      id: "support",
      title: "Handle a support request",
      ontology: {
        entities: [{ id: "customer" }],
        actions: [{ id: "lookup", tools: ["memory_search"] }],
        constraints: [{ id: "no-pii", description: "Never echo full account numbers." }],
        allowedTools: ["memory_search", "message"],
        contextHints: ["Support tone: concise and empathetic."],
        expectedOutput: "A resolution or escalation summary.",
      },
      children: [
        { id: "support.triage", title: "Triage" },
        { id: "support.resolve", title: "Resolve" },
      ],
    },
  };
}

describe("validateWorkflowTreeDefinition", () => {
  it("accepts a valid tree", () => {
    const result = validateWorkflowTreeDefinition(validTree());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tree.id).toBe("acme.support");
      expect(result.tree.root.children).toHaveLength(2);
    }
  });

  it("rejects a wrong schema tag with a path-scoped issue", () => {
    const tree = { ...validTree(), schema: "clawworks.other" };
    const result = validateWorkflowTreeDefinition(tree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === "schema")).toBe(true);
    }
  });

  it("rejects duplicate node ids", () => {
    const tree = validTree();
    (tree.root as { children: Array<{ id: string }> }).children[1].id = "support.triage";
    const result = validateWorkflowTreeDefinition(tree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].message).toContain('duplicate workflow node id "support.triage"');
    }
  });

  it("rejects malformed dotted ids", () => {
    const tree = { ...validTree(), id: "Acme Support!" };
    const result = validateWorkflowTreeDefinition(tree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toBe("id");
      expect(result.issues[0].message).toContain("dotted lowercase id");
    }
  });

  it("rejects unknown keys (strict envelope)", () => {
    const tree = { ...validTree(), extra: true };
    expect(validateWorkflowTreeDefinition(tree).ok).toBe(false);
  });

  it("rejects empty trigger lists (omit means user-triggered)", () => {
    const tree = { ...validTree(), match: { triggers: [] } };
    expect(validateWorkflowTreeDefinition(tree).ok).toBe(false);
  });

  it("accepts empty no-op ontology arrays for load compatibility", () => {
    // Empty arrays are no-ops the runtime treats as omitted (an empty action
    // tool list covers no tool in the matcher), so rejecting them would break
    // already-imported trees. Rejecting them would need a doctor migration.
    const tree = validTree();
    (tree.root as { ontology: Record<string, unknown> }).ontology = {
      actions: [{ id: "act.one", tools: [] }],
      allowedTools: [],
      deniedTools: [],
      knowledgeFoundations: [],
      contextHints: [],
    };
    expect(validateWorkflowTreeDefinition(tree).ok).toBe(true);
  });

  it("rejects blank tool globs and keywords (matcher/selection hazards)", () => {
    const blankTool = validTree();
    (blankTool.root as { ontology: { allowedTools: string[] } }).ontology.allowedTools = [" "];
    expect(validateWorkflowTreeDefinition(blankTool).ok).toBe(false);

    const blankKeyword = { ...validTree(), match: { keywords: ["  "] } };
    expect(validateWorkflowTreeDefinition(blankKeyword).ok).toBe(false);
  });
});

describe("built-in workflow trees", () => {
  it("all validate against the tree schema", () => {
    for (const tree of BUILTIN_WORKFLOW_TREES) {
      const result = validateWorkflowTreeDefinition(tree);
      expect(result.ok, `built-in tree ${tree.id} must validate`).toBe(true);
    }
  });
});
