import { describe, expect, it } from "vitest";
import {
  addNodeOntologyEntry,
  collectDefinitionNodeIds,
  type EditableTreeDefinition,
  insertChildNode,
  newNodeIdIssue,
  removeNodeOntologyEntry,
  setNodeGuidance,
} from "./enterprise-tree-edit.ts";

function definition(): EditableTreeDefinition {
  return {
    schema: "clawworks.workflow-tree",
    schemaVersion: 1,
    id: "acme.support",
    version: "1.0.0",
    name: "Support",
    root: {
      id: "support",
      title: "Support",
      ontology: { entities: [{ id: "claim" }] },
      children: [{ id: "support.triage", title: "Triage" }],
    },
  };
}

describe("collectDefinitionNodeIds", () => {
  it("collects every node id in the tree", () => {
    expect([...collectDefinitionNodeIds(definition())].toSorted()).toEqual([
      "support",
      "support.triage",
    ]);
  });
});

describe("newNodeIdIssue", () => {
  const ids = new Set(["support", "support.triage"]);

  it("accepts a fresh dotted-lowercase id", () => {
    expect(newNodeIdIssue("support.resolve", ids)).toBeNull();
    expect(newNodeIdIssue("standalone", ids)).toBeNull();
  });

  it("rejects an empty id", () => {
    expect(newNodeIdIssue("   ", ids)).toBe("empty");
  });

  it("rejects a malformed id (uppercase, spaces, bad separators)", () => {
    expect(newNodeIdIssue("Support.Resolve", ids)).toBe("pattern");
    expect(newNodeIdIssue("support resolve", ids)).toBe("pattern");
    expect(newNodeIdIssue("support..resolve", ids)).toBe("pattern");
    expect(newNodeIdIssue(".support", ids)).toBe("pattern");
  });

  it("rejects an id already present in the tree", () => {
    expect(newNodeIdIssue("support.triage", ids)).toBe("duplicate");
  });
});

describe("insertChildNode", () => {
  it("appends a bare child under an existing node and preserves other fields", () => {
    const original = definition();
    const result = insertChildNode(original, "support", {
      id: "support.resolve",
      title: "Resolve",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const root = result.definition.root;
    expect(root.children?.map((child) => child.id)).toEqual(["support.triage", "support.resolve"]);
    // The added node is bare id + title; nothing else is invented.
    expect(root.children?.at(-1)).toEqual({ id: "support.resolve", title: "Resolve" });
    // Untouched fields survive verbatim.
    expect(root.ontology).toEqual({ entities: [{ id: "claim" }] });
    expect(result.definition.id).toBe("acme.support");
    expect(result.definition.schema).toBe("clawworks.workflow-tree");
  });

  it("creates the children array when the parent had none", () => {
    const original = definition();
    const result = insertChildNode(original, "support.triage", {
      id: "support.triage.review",
      title: "Review",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const triage = result.definition.root.children?.find((child) => child.id === "support.triage");
    expect(triage?.children).toEqual([{ id: "support.triage.review", title: "Review" }]);
  });

  it("does not mutate the input definition", () => {
    const original = definition();
    insertChildNode(original, "support", { id: "support.resolve", title: "Resolve" });
    expect(original.root.children?.map((child) => child.id)).toEqual(["support.triage"]);
  });

  it("fails when the parent id is not in the tree", () => {
    const result = insertChildNode(definition(), "support.ghost", { id: "support.x", title: "X" });
    expect(result).toEqual({ ok: false, reason: "parent-not-found" });
  });

  it("fails when the new id already exists anywhere in the tree", () => {
    const result = insertChildNode(definition(), "support", {
      id: "support.triage",
      title: "Dup",
    });
    expect(result).toEqual({ ok: false, reason: "duplicate-id" });
  });
});

describe("addNodeOntologyEntry", () => {
  it("creates the list on a node that has no ontology yet", () => {
    const result = addNodeOntologyEntry(definition(), "support.triage", "skills", "refund-policy");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const triage = result.definition.root.children?.find((child) => child.id === "support.triage");
    expect(triage?.ontology).toEqual({ skills: ["refund-policy"] });
  });

  it("appends to an existing list and preserves other ontology keys", () => {
    const base = definition();
    base.root.ontology = { entities: [{ id: "claim" }], allowedTools: ["group:enterprise"] };
    const result = addNodeOntologyEntry(base, "support", "allowedTools", "invoke_action");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.definition.root.ontology).toEqual({
      entities: [{ id: "claim" }],
      allowedTools: ["group:enterprise", "invoke_action"],
    });
  });

  it("does not mutate the input definition", () => {
    const original = definition();
    addNodeOntologyEntry(original, "support", "allowedTools", "group:enterprise");
    expect(original.root.ontology).toEqual({ entities: [{ id: "claim" }] });
  });

  it("rejects a duplicate entry so the same grant is not added twice", () => {
    const base = definition();
    base.root.ontology = { allowedTools: ["group:enterprise"] };
    expect(addNodeOntologyEntry(base, "support", "allowedTools", "group:enterprise")).toEqual({
      ok: false,
      reason: "duplicate-entry",
    });
  });

  it("fails when the node id is not in the tree", () => {
    expect(addNodeOntologyEntry(definition(), "support.ghost", "skills", "x")).toEqual({
      ok: false,
      reason: "node-not-found",
    });
  });
});

describe("removeNodeOntologyEntry", () => {
  function withTools(): EditableTreeDefinition {
    const seeded = addNodeOntologyEntry(definition(), "support.triage", "allowedTools", "read");
    if (!seeded.ok) {
      throw new Error("seed failed");
    }
    const second = addNodeOntologyEntry(
      seeded.definition,
      "support.triage",
      "allowedTools",
      "bash",
    );
    if (!second.ok) {
      throw new Error("seed failed");
    }
    return second.definition;
  }

  it("detaches one entry and leaves the rest", () => {
    const result = removeNodeOntologyEntry(withTools(), "support.triage", "allowedTools", "read");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const node = result.definition.root.children?.[0];
    expect((node?.ontology as { allowedTools?: string[] })?.allowedTools).toEqual(["bash"]);
  });

  // An omitted list inherits the path's scope; an empty one grants nothing. They
  // are different states, so removing the last entry must not leave `[]` behind.
  it("drops the key entirely when the last entry goes", () => {
    const one = addNodeOntologyEntry(definition(), "support.triage", "allowedTools", "read");
    if (!one.ok) {
      throw new Error("seed failed");
    }
    const result = removeNodeOntologyEntry(
      one.definition,
      "support.triage",
      "allowedTools",
      "read",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const ontology = result.definition.root.children?.[0]?.ontology as
      | Record<string, unknown>
      | undefined;
    expect(ontology && "allowedTools" in ontology).toBe(false);
  });

  it("leaves unrelated bindings on the same node untouched", () => {
    const seeded = addNodeOntologyEntry(withTools(), "support.triage", "skills", "refund-policy");
    if (!seeded.ok) {
      throw new Error("seed failed");
    }
    const result = removeNodeOntologyEntry(
      seeded.definition,
      "support.triage",
      "allowedTools",
      "read",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const ontology = result.definition.root.children?.[0]?.ontology as {
      allowedTools?: string[];
      skills?: string[];
    };
    expect(ontology.skills).toEqual(["refund-policy"]);
    expect(ontology.allowedTools).toEqual(["bash"]);
  });

  // treeDeclaresMcpAttachment (src/enterprise/plan.ts) reads PRESENCE, not length:
  // an absent property means "written before the field existed" and leaves every
  // registered server callable, so dropping the last attachment must not remove
  // the key or the whole work-map silently stops governing MCP.
  it("keeps an empty mcpServers marker when the last attachment goes", () => {
    const seeded = addNodeOntologyEntry(definition(), "support.triage", "mcpServers", "github");
    if (!seeded.ok) {
      throw new Error("seed failed");
    }
    const result = removeNodeOntologyEntry(
      seeded.definition,
      "support.triage",
      "mcpServers",
      "github",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const ontology = result.definition.root.children?.[0]?.ontology as { mcpServers?: string[] };
    expect(ontology.mcpServers).toEqual([]);
  });

  it("reports a missing node and a missing entry distinctly", () => {
    expect(removeNodeOntologyEntry(withTools(), "nope", "allowedTools", "read")).toMatchObject({
      ok: false,
      reason: "node-not-found",
    });
    expect(
      removeNodeOntologyEntry(withTools(), "support.triage", "allowedTools", "never-added"),
    ).toMatchObject({ ok: false, reason: "entry-not-found" });
  });

  it("does not mutate the definition it was given", () => {
    const original = withTools();
    const snapshot = structuredClone(original);
    removeNodeOntologyEntry(original, "support.triage", "allowedTools", "read");
    expect(original).toEqual(snapshot);
  });
});

describe("setNodeGuidance", () => {
  it("sets the role prompt on a node that has no ontology yet", () => {
    const result = setNodeGuidance(definition(), "support.triage", "  Confirm identity first.  ");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const ontology = result.definition.root.children?.[0]?.ontology as { guidance?: string };
    // Trimmed: trailing whitespace would land verbatim in the step digest.
    expect(ontology.guidance).toBe("Confirm identity first.");
  });

  // `guidance` is optional and an empty one would render an empty instruction
  // line, so blank means "remove", not "set to empty".
  it("clears the key when the prompt is blank", () => {
    const set = setNodeGuidance(definition(), "support.triage", "something");
    if (!set.ok) {
      throw new Error("seed failed");
    }
    const cleared = setNodeGuidance(set.definition, "support.triage", "   ");
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) {
      return;
    }
    const ontology = cleared.definition.root.children?.[0]?.ontology as Record<string, unknown>;
    expect("guidance" in ontology).toBe(false);
  });

  it("leaves the node's other bindings untouched", () => {
    const seeded = addNodeOntologyEntry(definition(), "support.triage", "allowedTools", "read");
    if (!seeded.ok) {
      throw new Error("seed failed");
    }
    const result = setNodeGuidance(seeded.definition, "support.triage", "Be careful.");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const ontology = result.definition.root.children?.[0]?.ontology as {
      guidance?: string;
      allowedTools?: string[];
    };
    expect(ontology.allowedTools).toEqual(["read"]);
    expect(ontology.guidance).toBe("Be careful.");
  });

  it("reports a missing node and does not mutate the input", () => {
    const original = definition();
    const snapshot = structuredClone(original);
    expect(setNodeGuidance(original, "nope", "text")).toMatchObject({
      ok: false,
      reason: "node-not-found",
    });
    setNodeGuidance(original, "support.triage", "text");
    expect(original).toEqual(snapshot);
  });
});
