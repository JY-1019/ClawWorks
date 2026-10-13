import { describe, expect, it } from "vitest";
import {
  addNodeOntologyEntry,
  collectDefinitionNodeIds,
  type EditableTreeDefinition,
  insertChildNode,
  newNodeIdIssue,
  addNodeOntologyAction,
  addNodeOntologyActionEffect,
  addNodeOntologyActionParameter,
  addNodeOntologyConstraint,
  addNodeOntologyEntity,
  addNodeOntologyFunction,
  addNodeOntologyProperty,
  addNodeOntologyRelationship,
  disableTreeMcpGovernance,
  enableNodeMcpGovernance,
  ONTOLOGY_CARDINALITIES,
  removeNodeOntologyAction,
  removeNodeOntologyActionEffect,
  removeNodeOntologyActionParameter,
  removeNodeOntologyConstraint,
  removeNodeOntologyEntity,
  removeNodeOntologyEntry,
  removeNodeOntologyFunction,
  removeTreeNode,
  type OntologyEffectKindName,
  removeNodeOntologyProperty,
  removeNodeOntologyRelationship,
  setNodeBehavior,
  setTreeSettings,
  type NodeOntologyMetadataUpdate,
  updateNodeOntologyMetadata,
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

describe("ONTOLOGY_CARDINALITIES", () => {
  it("matches the schema without duplicate one-to-one entries", () => {
    expect(ONTOLOGY_CARDINALITIES).toEqual([
      "one-to-one",
      "one-to-many",
      "many-to-one",
      "many-to-many",
    ]);
    expect(new Set(ONTOLOGY_CARDINALITIES).size).toBe(ONTOLOGY_CARDINALITIES.length);
  });
});

describe("setTreeSettings", () => {
  it("sets, preserves, and clears the optional execution model", () => {
    const fields = {
      version: "1.0.0",
      name: "Support",
      description: "",
      triggers: ["user"] as const,
    };
    const bound = setTreeSettings(definition(), {
      ...fields,
      triggers: [...fields.triggers],
      executionModel: " ollama/qwen3:8b ",
    }).definition;
    expect(bound.executionModel).toBe("ollama/qwen3:8b");
    expect(
      setTreeSettings(bound, { ...fields, triggers: [...fields.triggers] }).definition
        .executionModel,
    ).toBe("ollama/qwen3:8b");
    expect(
      setTreeSettings(bound, { ...fields, triggers: [...fields.triggers], executionModel: "" })
        .definition,
    ).not.toHaveProperty("executionModel");
  });
  it("updates guided fields while preserving the envelope, root, and legacy match keys", () => {
    const original = definition();
    original.description = "Old description";
    original.custom = { keep: true };
    original.match = {
      keywords: ["legacy"],
      custom: "keep",
      triggers: ["system"],
      priority: 9,
    };
    const snapshot = structuredClone(original);

    const result = setTreeSettings(original, {
      version: " 2.0.0 ",
      name: " Updated support ",
      description: "   ",
      triggers: ["user"],
    });

    expect(result.definition).toMatchObject({
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: "acme.support",
      version: "2.0.0",
      name: "Updated support",
      custom: { keep: true },
      match: { keywords: ["legacy"], custom: "keep" },
    });
    expect(result.definition).not.toHaveProperty("description");
    expect(result.definition.root).toEqual(original.root);
    expect(result.definition.root).not.toBe(original.root);
    expect(original).toEqual(snapshot);
  });

  it("preserves priority zero and writes non-default triggers", () => {
    const result = setTreeSettings(definition(), {
      version: "1.0.1",
      name: "Support",
      description: "Help customers",
      triggers: ["system", "subagent"],
      priority: 0,
    });

    expect(result.definition.description).toBe("Help customers");
    expect(result.definition.match).toEqual({
      triggers: ["system", "subagent"],
      priority: 0,
    });
  });

  it("drops an otherwise empty match for the default user trigger", () => {
    const original = definition();
    original.match = { triggers: ["system"], priority: 4 };
    const result = setTreeSettings(original, {
      version: "1.0.0",
      name: "Support",
      description: "",
      triggers: ["user"],
    });

    expect(result.definition).not.toHaveProperty("match");
  });
});

function structureDefinition(): EditableTreeDefinition {
  return {
    ...definition(),
    root: {
      id: "support",
      title: "Support",
      description: "Root description",
      children: [
        {
          id: "support.triage",
          title: "Triage",
          description: "Triage description",
          ontology: { allowedTools: ["read"] },
          children: [{ id: "support.triage.review", title: "Review" }],
        },
        { id: "support.resolve", title: "Resolve" },
        { id: "support.close", title: "Close" },
      ],
    },
  };
}

describe("removeTreeNode", () => {
  it("removes exactly one non-root subtree and preserves the rest", () => {
    const original = structureDefinition();
    const snapshot = structuredClone(original);
    const result = removeTreeNode(original, "support.triage");
    expect(result.ok).toBe(true);
    expect(result.ok && result.definition.root.children?.map((node) => node.id)).toEqual([
      "support.resolve",
      "support.close",
    ]);
    expect(result.ok && result.definition.root.description).toBe("Root description");
    expect(original).toEqual(snapshot);
  });

  it("refuses the root and a missing node", () => {
    expect(removeTreeNode(structureDefinition(), "support")).toEqual({
      ok: false,
      reason: "root-node",
    });
    expect(removeTreeNode(structureDefinition(), "missing")).toEqual({
      ok: false,
      reason: "node-not-found",
    });
  });

  it("allows deleting a child when an ancestor parameter is only rationale", () => {
    const original = structureDefinition();
    const child = original.root.children?.[0];
    if (!child) {
      throw new Error("fixture failed");
    }
    original.root.children = [child];
    original.root.ontology = {
      entities: [{ id: "policy", properties: [{ id: "id", type: "id", primaryKey: true }] }],
      actions: [
        {
          id: "review",
          parameters: [
            { id: "id", type: "id" },
            { id: "rationale", type: "string" },
          ],
          effects: [{ entity: "policy", kind: "update" }],
        },
      ],
    };

    expect(removeTreeNode(original, child.id).ok).toBe(true);
  });

  it("does not invent a new collision when an existing duplicate becomes a leaf", () => {
    const original = structureDefinition();
    const child = original.root.children?.[0];
    if (!child) {
      throw new Error("fixture failed");
    }
    original.root.children = [child];
    original.root.ontology = {
      actions: [
        { id: "notify", effects: [{ kind: "call", tool: "message" }] },
        { id: "notify", effects: [{ kind: "call", tool: "email" }] },
      ],
    };

    expect(removeTreeNode(original, child.id).ok).toBe(true);
  });

  it("keeps MCP governance when deleting its last declaring subtree", () => {
    const original = structureDefinition();
    const child = original.root.children?.[0];
    if (!child) {
      throw new Error("fixture failed");
    }
    original.root.ontology = { allowedTools: ["read"] };
    child.ontology = { mcpServers: ["github"] };

    const result = removeTreeNode(original, child.id);

    expect(result.ok).toBe(true);
    expect(result.ok && result.definition.root.ontology).toEqual({
      allowedTools: ["read"],
      mcpServers: [],
    });
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

describe("enableNodeMcpGovernance", () => {
  it("adds an empty marker once without disturbing other ontology fields", () => {
    const result = enableNodeMcpGovernance(definition(), "support");
    expect(result.ok).toBe(true);
    expect(result.ok && result.definition.root.ontology).toEqual({
      entities: [{ id: "claim" }],
      mcpServers: [],
    });
    expect(result.ok && enableNodeMcpGovernance(result.definition, "support")).toMatchObject({
      ok: false,
      reason: "duplicate-entry",
    });
  });
});

describe("disableTreeMcpGovernance", () => {
  it("removes every empty marker from an inherited tree and preserves other ontology", () => {
    const original = definition();
    original.root.ontology = {
      entities: [{ id: "claim" }],
      mcpServers: [],
    };
    const child = original.root.children?.[0];
    if (!child) {
      throw new Error("fixture failed");
    }
    child.ontology = { allowedTools: ["read"], mcpServers: [] };
    const snapshot = structuredClone(original);

    const result = disableTreeMcpGovernance(original);

    expect(result.ok).toBe(true);
    expect(result.ok && result.definition.root.ontology).toEqual({
      entities: [{ id: "claim" }],
    });
    expect(result.ok && result.definition.root.children?.[0]?.ontology).toEqual({
      allowedTools: ["read"],
    });
    expect(original).toEqual(snapshot);
  });

  it("refuses explicit trees, active attachments, malformed markers, and absent markers", () => {
    const explicit = definition();
    explicit.capabilityGrants = "explicit";
    explicit.root.ontology = { mcpServers: [] };

    const unknownMode = definition();
    unknownMode.capabilityGrants = "unknown";
    unknownMode.root.ontology = { mcpServers: [] };

    const attached = definition();
    attached.root.ontology = { mcpServers: [] };
    const attachedChild = attached.root.children?.[0];
    if (!attachedChild) {
      throw new Error("fixture failed");
    }
    attachedChild.ontology = { mcpServers: ["github"] };

    const malformed = definition();
    malformed.root.ontology = { mcpServers: "github" };

    for (const candidate of [explicit, unknownMode, attached, malformed, definition()]) {
      expect(disableTreeMcpGovernance(candidate)).toEqual({
        ok: false,
        reason: "entry-not-found",
      });
    }
  });
});

describe("setNodeBehavior", () => {
  const behavior = (guidance: string) => ({
    description: "",
    guidance,
    contextHints: [],
    expectedOutput: "",
    audit: false,
  });

  it("sets the role prompt on a node that has no ontology yet", () => {
    const result = setNodeBehavior(
      definition(),
      "support.triage",
      behavior("  Confirm identity first.  "),
    );
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
    const set = setNodeBehavior(definition(), "support.triage", behavior("something"));
    if (!set.ok) {
      throw new Error("seed failed");
    }
    const cleared = setNodeBehavior(set.definition, "support.triage", behavior("   "));
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) {
      return;
    }
    const ontology = cleared.definition.root.children?.[0]?.ontology as
      | Record<string, unknown>
      | undefined;
    expect(ontology?.guidance).toBeUndefined();
  });

  it("leaves the node's other bindings untouched", () => {
    const seeded = addNodeOntologyEntry(definition(), "support.triage", "allowedTools", "read");
    if (!seeded.ok) {
      throw new Error("seed failed");
    }
    const result = setNodeBehavior(seeded.definition, "support.triage", behavior("Be careful."));
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

  it("sets the remaining step behavior without raw JSON", () => {
    const result = setNodeBehavior(definition(), "support.triage", {
      description: " Verify the request. ",
      guidance: "Respond concisely.",
      contextHints: [" Customer is waiting. ", ""],
      expectedOutput: " A decision. ",
      audit: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const node = result.definition.root.children?.[0];
    expect(node?.description).toBe("Verify the request.");
    expect(node?.ontology).toMatchObject({
      guidance: "Respond concisely.",
      contextHints: ["Customer is waiting."],
      expectedOutput: "A decision.",
      audit: true,
    });
  });

  it("updates an optional title while preserving it when title is omitted", () => {
    const renamed = setNodeBehavior(definition(), "support.triage", {
      ...behavior("Be careful."),
      title: " Reviewed triage ",
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) {
      return;
    }
    expect(renamed.definition.root.children?.[0]?.title).toBe("Reviewed triage");

    const withoutTitle = setNodeBehavior(renamed.definition, "support.triage", behavior("Updated"));
    expect(withoutTitle.ok).toBe(true);
    expect(withoutTitle.ok && withoutTitle.definition.root.children?.[0]?.title).toBe(
      "Reviewed triage",
    );
  });

  it("refuses an explicitly blank title without mutating the input", () => {
    const original = definition();
    const snapshot = structuredClone(original);
    expect(
      setNodeBehavior(original, "support.triage", {
        ...behavior("Be careful."),
        title: "   ",
      }),
    ).toEqual({ ok: false, reason: "title-empty" });
    expect(original).toEqual(snapshot);
  });

  it("reports a missing node and does not mutate the input", () => {
    const original = definition();
    const snapshot = structuredClone(original);
    expect(setNodeBehavior(original, "nope", behavior("text"))).toMatchObject({
      ok: false,
      reason: "node-not-found",
    });
    setNodeBehavior(original, "support.triage", behavior("text"));
    expect(original).toEqual(snapshot);
  });
});

describe("ontology editing", () => {
  function entitiesOf(tree: EditableTreeDefinition, nodeId = "support.triage") {
    const node =
      nodeId === "support" ? tree.root : tree.root.children?.find((child) => child.id === nodeId);
    return ((node?.ontology ?? {}) as { entities?: Record<string, unknown>[] }).entities ?? [];
  }

  function withEntities(): EditableTreeDefinition {
    let current = definition();
    for (const id of ["policy", "adjuster"]) {
      const result = addNodeOntologyEntity(current, "support.triage", { id });
      if (!result.ok) {
        throw new Error(`seed failed: ${id}`);
      }
      current = result.definition;
    }
    return current;
  }

  it("declares an object type with an optional title", () => {
    const result = addNodeOntologyEntity(definition(), "support.triage", {
      id: "  Claim  ",
      title: " Insurance claim ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Ids are normalized the way the import expects; titles keep their casing.
    expect(entitiesOf(result.definition)).toEqual([{ id: "claim", title: "Insurance claim" }]);
  });

  it("rejects an id the import would refuse, and a duplicate", () => {
    expect(
      addNodeOntologyEntity(definition(), "support.triage", { id: "not a valid id!" }),
    ).toMatchObject({ ok: false, reason: "invalid-id" });
    expect(addNodeOntologyEntity(withEntities(), "support.triage", { id: "policy" })).toMatchObject(
      {
        ok: false,
        reason: "duplicate-entry",
      },
    );
  });

  it("refuses to remove an object type a relationship still points at", () => {
    const linked = addNodeOntologyRelationship(withEntities(), "support.triage", {
      id: "filed-by",
      from: "policy",
      to: "adjuster",
    });
    if (!linked.ok) {
      throw new Error("seed failed");
    }
    // The import rejects a link with an undeclared endpoint, so removing the
    // entity here would produce a definition the operator cannot save.
    expect(removeNodeOntologyEntity(linked.definition, "support.triage", "policy")).toMatchObject({
      ok: false,
      reason: "entity-in-use",
    });

    // Identified by the whole triple: one id may appear with different endpoint
    // pairs, and each renders as its own chip.
    const unlinked = removeNodeOntologyRelationship(linked.definition, "support.triage", {
      id: "filed-by",
      from: "policy",
      to: "adjuster",
    });
    if (!unlinked.ok) {
      throw new Error("unlink failed");
    }
    expect(removeNodeOntologyEntity(unlinked.definition, "support.triage", "policy").ok).toBe(true);
  });

  it("refuses a second identity field rather than quietly dropping the flag", () => {
    const first = addNodeOntologyProperty(withEntities(), "support.triage", "policy", {
      id: "number",
      type: "string",
      primaryKey: true,
    });
    if (!first.ok) {
      throw new Error("seed failed");
    }
    // The operator asked for an identity field; writing a plain one instead would
    // look like it worked and leave the type keyed by something else.
    expect(
      addNodeOntologyProperty(first.definition, "support.triage", "policy", {
        id: "reference",
        type: "string",
        primaryKey: true,
      }),
    ).toMatchObject({ ok: false, reason: "primary-key-taken" });

    // A plain field alongside the key is fine.
    const plain = addNodeOntologyProperty(first.definition, "support.triage", "policy", {
      id: "reference",
      type: "string",
    });
    expect(plain.ok).toBe(true);
  });

  it("edits the exact duplicate entity record selected by the UI", () => {
    const imported = definition();
    const triage = imported.root.children?.[0];
    if (!triage) {
      throw new Error("fixture failed");
    }
    triage.ontology = {
      entities: [
        { id: "policy", properties: [{ id: "number", type: "string" }] },
        { id: "policy", properties: [{ id: "premium", type: "number" }] },
      ],
    };

    const added = addNodeOntologyProperty(
      imported,
      "support.triage",
      "policy",
      { id: "active", type: "boolean" },
      1,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) {
      return;
    }
    expect(entitiesOf(added.definition)).toEqual([
      { id: "policy", properties: [{ id: "number", type: "string" }] },
      {
        id: "policy",
        properties: [
          { id: "premium", type: "number" },
          { id: "active", type: "boolean" },
        ],
      },
    ]);

    const removed = removeNodeOntologyProperty(
      added.definition,
      "support.triage",
      "policy",
      "premium",
      { entityIndex: 1, propertyIndex: 0 },
    );
    expect(removed.ok).toBe(true);
    expect(removed.ok && entitiesOf(removed.definition)[1]).toEqual({
      id: "policy",
      properties: [{ id: "active", type: "boolean" }],
    });
  });

  it("drops the properties key when the last property goes", () => {
    const added = addNodeOntologyProperty(withEntities(), "support.triage", "policy", {
      id: "number",
      type: "string",
    });
    if (!added.ok) {
      throw new Error("seed failed");
    }
    const removed = removeNodeOntologyProperty(
      added.definition,
      "support.triage",
      "policy",
      "number",
    );
    expect(removed.ok).toBe(true);
    if (!removed.ok) {
      return;
    }
    const claim = entitiesOf(removed.definition).find((entity) => entity.id === "policy");
    expect(claim && "properties" in claim).toBe(false);
  });

  it("refuses a boolean identity field that no action can address", () => {
    expect(
      addNodeOntologyProperty(withEntities(), "support.triage", "policy", {
        id: "enabled",
        type: "boolean",
        primaryKey: true,
      }),
    ).toEqual({ ok: false, reason: "identity-type-invalid" });
  });

  it("refuses a link whose endpoint the step does not declare", () => {
    expect(
      addNodeOntologyRelationship(withEntities(), "support.triage", {
        id: "filed-by",
        from: "policy",
        to: "nowhere",
      }),
    ).toMatchObject({ ok: false, reason: "entity-not-found" });
  });

  it("writes a narrower cardinality but leaves the default implicit", () => {
    const explicit = addNodeOntologyRelationship(withEntities(), "support.triage", {
      id: "filed-by",
      from: "policy",
      to: "adjuster",
      cardinality: "many-to-one",
    });
    const defaulted = addNodeOntologyRelationship(withEntities(), "support.triage", {
      id: "filed-by",
      from: "policy",
      to: "adjuster",
      cardinality: "many-to-many",
    });
    if (!explicit.ok || !defaulted.ok) {
      throw new Error("seed failed");
    }
    const read = (def: EditableTreeDefinition) =>
      (
        (def.root.children?.[0]?.ontology ?? {}) as {
          relationships?: Record<string, unknown>[];
        }
      ).relationships?.[0];
    expect(read(explicit.definition)).toMatchObject({ cardinality: "many-to-one" });
    // many-to-many IS the omitted reading, so writing it down adds nothing.
    expect(read(defaulted.definition)).not.toHaveProperty("cardinality");
  });

  // Object types are inherited down the path, so a child that declares none can
  // still link the ones an ancestor gave it — schema.test.ts accepts exactly that.
  it("refuses linking types declared only on a preceding step", () => {
    let current = definition();
    for (const id of ["policy", "adjuster"]) {
      const seeded = addNodeOntologyEntity(current, "support", { id });
      if (!seeded.ok) {
        throw new Error("seed failed");
      }
      current = seeded.definition;
    }
    const linked = addNodeOntologyRelationship(current, "support.triage", {
      id: "filed-by",
      from: "policy",
      to: "adjuster",
    });
    expect(linked).toMatchObject({ ok: false, reason: "entity-not-found" });
  });

  it("refuses a second identity field, including one inherited", () => {
    const current = definition();
    const seeded = addNodeOntologyEntity(current, "support", { id: "policy" });
    if (!seeded.ok) {
      throw new Error("seed failed");
    }
    const keyed = addNodeOntologyProperty(seeded.definition, "support", "policy", {
      id: "number",
      type: "string",
      primaryKey: true,
    });
    if (!keyed.ok) {
      throw new Error("seed failed");
    }
    // Declared again on the child, which the schema allows as an EXTENSION.
    const extended = addNodeOntologyEntity(keyed.definition, "support.triage", { id: "policy" });
    if (!extended.ok) {
      throw new Error("seed failed");
    }
    // The parent already carries the identity field, so a second is refused
    // rather than written without the flag the operator asked for.
    expect(
      addNodeOntologyProperty(extended.definition, "support.triage", "policy", {
        id: "reference",
        type: "string",
        primaryKey: true,
      }),
    ).toMatchObject({ ok: false, reason: "primary-key-taken" });
  });

  // The schema permits one link id with different endpoint pairs, and the editor
  // draws a chip each, so removal has to name which one.
  // An IMPORTED work-map may carry one link id with different endpoint pairs —
  // the schema permits it and the graph keys them separately — so removal has to
  // name which one. (The editor's own Add keeps ids unique per node.)
  // The schema merges an entity's shape across EVERY declaration, so a key on a
  // sibling branch collides just as much as one on the path.
  it("sees an identity field declared on a sibling branch", () => {
    const seeded = addNodeOntologyEntity(definition(), "support", { id: "policy" });
    if (!seeded.ok) {
      throw new Error("seed failed");
    }
    const sibling = insertChildNode(seeded.definition, "support", {
      id: "support.audit",
      title: "Audit",
    });
    if (!sibling.ok) {
      throw new Error("seed failed");
    }
    const onSibling = addNodeOntologyEntity(sibling.definition, "support.audit", { id: "policy" });
    if (!onSibling.ok) {
      throw new Error("seed failed");
    }
    const keyed = addNodeOntologyProperty(onSibling.definition, "support.audit", "policy", {
      id: "number",
      type: "string",
      primaryKey: true,
    });
    if (!keyed.ok) {
      throw new Error("seed failed");
    }
    // triage never sees support.audit on its path, but the merged shape does.
    const extended = addNodeOntologyEntity(keyed.definition, "support.triage", { id: "policy" });
    if (!extended.ok) {
      throw new Error("seed failed");
    }
    expect(
      addNodeOntologyProperty(extended.definition, "support.triage", "policy", {
        id: "reference",
        type: "string",
        primaryKey: true,
      }),
    ).toMatchObject({ ok: false, reason: "primary-key-taken" });
  });

  it("refuses a field type that conflicts with another branch's declaration", () => {
    const seeded = addNodeOntologyEntity(definition(), "support", { id: "policy" });
    if (!seeded.ok) {
      throw new Error("seed failed");
    }
    const sibling = insertChildNode(seeded.definition, "support", {
      id: "support.audit",
      title: "Audit",
    });
    if (!sibling.ok) {
      throw new Error("seed failed");
    }
    const siblingType = addNodeOntologyEntity(sibling.definition, "support.audit", {
      id: "policy",
    });
    if (!siblingType.ok) {
      throw new Error("seed failed");
    }
    const siblingField = addNodeOntologyProperty(
      siblingType.definition,
      "support.audit",
      "policy",
      { id: "premium", type: "number" },
    );
    if (!siblingField.ok) {
      throw new Error("seed failed");
    }
    const localType = addNodeOntologyEntity(siblingField.definition, "support.triage", {
      id: "policy",
    });
    if (!localType.ok) {
      throw new Error("seed failed");
    }

    expect(
      addNodeOntologyProperty(localType.definition, "support.triage", "policy", {
        id: "premium",
        type: "string",
      }),
    ).toEqual({ ok: false, reason: "property-type-conflict" });
  });

  // Import validates action effects and functions tree-wide, but the runtime
  // resolves them per path — so a sibling declaration is not a substitute.

  it("refuses removing a field a function on that path reads", () => {
    const seeded = addNodeOntologyEntity(definition(), "support.triage", { id: "policy" });
    if (!seeded.ok) {
      throw new Error("seed failed");
    }
    const withField = addNodeOntologyProperty(seeded.definition, "support.triage", "policy", {
      id: "premium",
      type: "number",
    });
    if (!withField.ok) {
      throw new Error("seed failed");
    }
    const withFn = structuredClone(withField.definition);
    const triage = withFn.root.children?.find((child) => child.id === "support.triage");
    if (!triage) {
      throw new Error("seed failed");
    }
    triage.ontology = {
      ...(triage.ontology as Record<string, unknown>),
      functions: [
        { id: "annual", entity: "policy", expression: "$premium * 12", returns: "number" },
      ],
    };
    expect(removeNodeOntologyProperty(withFn, "support.triage", "policy", "premium")).toMatchObject(
      { ok: false, reason: "property-in-use" },
    );

    // A field no function reads still comes out.
    const other = addNodeOntologyProperty(withFn, "support.triage", "policy", {
      id: "insurer",
      type: "string",
    });
    if (!other.ok) {
      throw new Error("seed failed");
    }
    expect(
      removeNodeOntologyProperty(other.definition, "support.triage", "policy", "insurer").ok,
    ).toBe(true);
  });

  // Runtime scope maps links by id, so a child reusing an ancestor's id would
  // silently replace it while the inspector shows both.
  // A write action identifies its instance by the primary key, and a parameter
  // whose id matches a property is written to it (ontology-actions.ts).
  it("refuses removing a field a write action depends on", () => {
    function withAction(action: Record<string, unknown>) {
      const seeded = addNodeOntologyEntity(definition(), "support.triage", { id: "policy" });
      if (!seeded.ok) {
        throw new Error("seed failed");
      }
      let current = seeded.definition;
      const keyed = addNodeOntologyProperty(current, "support.triage", "policy", {
        id: "number",
        type: "string",
        primaryKey: true,
      });
      if (!keyed.ok) {
        throw new Error("seed failed");
      }
      const plain = addNodeOntologyProperty(keyed.definition, "support.triage", "policy", {
        id: "premium",
        type: "number",
      });
      if (!plain.ok) {
        throw new Error("seed failed");
      }
      current = structuredClone(plain.definition);
      const triage = current.root.children?.find((child) => child.id === "support.triage");
      if (!triage) {
        throw new Error("seed failed");
      }
      triage.ontology = { ...(triage.ontology as Record<string, unknown>), actions: [action] };
      return current;
    }

    const writeAction = {
      id: "renew",
      effects: [{ entity: "policy", kind: "update" }],
      parameters: [{ id: "number", type: "string" }],
    };
    // The identity field a write needs to say WHICH instance it acts on.
    expect(
      removeNodeOntologyProperty(withAction(writeAction), "support.triage", "policy", "number"),
    ).toMatchObject({ ok: false, reason: "property-in-use" });

    // A parameter mapped onto the field; removing it would silently stop
    // persisting that argument.
    const mapped = {
      id: "reprice",
      effects: [{ entity: "policy", kind: "update" }],
      parameters: [{ id: "premium", type: "number" }],
    };
    expect(
      removeNodeOntologyProperty(withAction(mapped), "support.triage", "policy", "premium"),
    ).toMatchObject({ ok: false, reason: "property-in-use" });

    // A read-only action does not need the key, and names no such parameter.
    const readOnly = {
      id: "inspect",
      effects: [{ entity: "policy", kind: "read" }],
      parameters: [],
    };
    expect(
      removeNodeOntologyProperty(withAction(readOnly), "support.triage", "policy", "number").ok,
    ).toBe(true);
  });

  // One action can write several object types. A parameter unmapped for target A
  // is legitimate context there, so the break key has to name its target — or
  // removing the field it maps on target B would look like no new break at all.
  it("still blocks removal when an action writes more than one object type", () => {
    let current = definition();
    for (const id of ["policy", "claimant"]) {
      const seeded = addNodeOntologyEntity(current, "support.triage", { id });
      if (!seeded.ok) {
        throw new Error("seed failed");
      }
      current = seeded.definition;
    }
    for (const [entityId, propertyId] of [
      ["policy", "number"],
      ["claimant", "email"],
    ]) {
      const keyed = addNodeOntologyProperty(current, "support.triage", entityId, {
        id: propertyId,
        type: "string",
        primaryKey: true,
      });
      if (!keyed.ok) {
        throw new Error("seed failed");
      }
      current = keyed.definition;
    }
    const withAction = structuredClone(current);
    const triage = withAction.root.children?.find((child) => child.id === "support.triage");
    if (!triage) {
      throw new Error("seed failed");
    }
    triage.ontology = {
      ...(triage.ontology as Record<string, unknown>),
      actions: [
        {
          id: "transfer",
          effects: [
            { entity: "policy", kind: "update" },
            { entity: "claimant", kind: "update" },
          ],
          // Maps onto claimant.email; unmapped for policy, which is fine there.
          parameters: [{ id: "email", type: "string" }],
        },
      ],
    };
    expect(
      removeNodeOntologyProperty(withAction, "support.triage", "claimant", "email"),
    ).toMatchObject({ ok: false, reason: "property-in-use" });
  });

  // A consumer declared on an ancestor RUNS at descendants and resolves against
  // their merged scope (resolveActiveOntologyScope), so checking it only where it
  // was written misses the scope it actually executes in.

  // A delete returns before property mapping (ontology-actions.ts), so it depends
  // on the identity field alone — a contextual parameter must not block a removal.
  it("ignores delete-only parameters when removing a field", () => {
    const seeded = addNodeOntologyEntity(definition(), "support.triage", { id: "policy" });
    if (!seeded.ok) {
      throw new Error("seed failed");
    }
    const keyed = addNodeOntologyProperty(seeded.definition, "support.triage", "policy", {
      id: "number",
      type: "string",
      primaryKey: true,
    });
    if (!keyed.ok) {
      throw new Error("seed failed");
    }
    const plain = addNodeOntologyProperty(keyed.definition, "support.triage", "policy", {
      id: "reason",
      type: "string",
    });
    if (!plain.ok) {
      throw new Error("seed failed");
    }
    const withAction = structuredClone(plain.definition);
    const triage = withAction.root.children?.find((child) => child.id === "support.triage");
    if (!triage) {
      throw new Error("seed failed");
    }
    triage.ontology = {
      ...(triage.ontology as Record<string, unknown>),
      actions: [
        {
          id: "void",
          effects: [{ entity: "policy", kind: "delete" }],
          parameters: [{ id: "reason", type: "string" }],
        },
      ],
    };
    expect(removeNodeOntologyProperty(withAction, "support.triage", "policy", "reason").ok).toBe(
      true,
    );
  });

  // The schema accepts a node declaring one entity twice with disjoint fields,
  // and the inspector renders them as one merged card — so a field click must
  // find its record wherever it lives.
  it("removes a field from whichever duplicate record declares it", () => {
    const seeded = addNodeOntologyEntity(definition(), "support.triage", { id: "policy" });
    if (!seeded.ok) {
      throw new Error("seed failed");
    }
    const imported = structuredClone(seeded.definition);
    const triage = imported.root.children?.find((child) => child.id === "support.triage");
    if (!triage) {
      throw new Error("seed failed");
    }
    triage.ontology = {
      ...(triage.ontology as Record<string, unknown>),
      entities: [
        { id: "policy", properties: [{ id: "number", type: "string" }] },
        { id: "policy", properties: [{ id: "premium", type: "number" }] },
      ],
    };
    // Lives in the SECOND record.
    const removed = removeNodeOntologyProperty(imported, "support.triage", "policy", "premium");
    expect(removed.ok).toBe(true);
    if (!removed.ok) {
      return;
    }
    const records = (
      (removed.definition.root.children?.[0]?.ontology ?? {}) as {
        entities?: { id: string; properties?: { id: string }[] }[];
      }
    ).entities;
    expect(records?.[0]?.properties?.map((property) => property.id)).toEqual(["number"]);
    expect(records?.[1]).not.toHaveProperty("properties");

    // Duplicate detection spans the records too.
    expect(
      addNodeOntologyProperty(imported, "support.triage", "policy", {
        id: "premium",
        type: "number",
      }),
    ).toMatchObject({ ok: false, reason: "duplicate-entry" });
  });

  // The real parser decides, so text inside a string literal is not a read.
  it("ignores a field name that only appears inside a string literal", () => {
    const seeded = addNodeOntologyEntity(definition(), "support.triage", { id: "policy" });
    if (!seeded.ok) {
      throw new Error("seed failed");
    }
    const withField = addNodeOntologyProperty(seeded.definition, "support.triage", "policy", {
      id: "premium",
      type: "string",
    });
    if (!withField.ok) {
      throw new Error("seed failed");
    }
    const withFn = structuredClone(withField.definition);
    const triage = withFn.root.children?.find((child) => child.id === "support.triage");
    if (!triage) {
      throw new Error("seed failed");
    }
    triage.ontology = {
      ...(triage.ontology as Record<string, unknown>),
      functions: [{ id: "label", entity: "policy", expression: '"$premium"', returns: "string" }],
    };
    expect(removeNodeOntologyProperty(withFn, "support.triage", "policy", "premium").ok).toBe(true);
  });

  // Expressions name properties as `$id`, so a bare word is an op or a literal.
  it("only treats a sigiled reference as a property read", () => {
    const seeded = addNodeOntologyEntity(definition(), "support.triage", { id: "policy" });
    if (!seeded.ok) {
      throw new Error("seed failed");
    }
    let current = seeded.definition;
    for (const id of ["max", "premium"]) {
      const added = addNodeOntologyProperty(current, "support.triage", "policy", {
        id,
        type: "number",
      });
      if (!added.ok) {
        throw new Error("seed failed");
      }
      current = added.definition;
    }
    const withFn = structuredClone(current);
    const triage = withFn.root.children?.find((child) => child.id === "support.triage");
    if (!triage) {
      throw new Error("seed failed");
    }
    triage.ontology = {
      ...(triage.ontology as Record<string, unknown>),
      functions: [
        // `max` here is the OP, not the field; only `$premium` is a read.
        { id: "capped", entity: "policy", expression: "max($premium, 1)", returns: "number" },
      ],
    };
    expect(removeNodeOntologyProperty(withFn, "support.triage", "policy", "max").ok).toBe(true);
    expect(removeNodeOntologyProperty(withFn, "support.triage", "policy", "premium")).toMatchObject(
      { ok: false, reason: "property-in-use" },
    );
  });

  it("allows a separate step to reuse a local declaration id", () => {
    let current = withEntities();
    for (const id of ["policy", "adjuster"]) {
      const seeded = addNodeOntologyEntity(current, "support", { id });
      if (!seeded.ok) {
        throw new Error("seed failed");
      }
      current = seeded.definition;
    }
    const onRoot = addNodeOntologyRelationship(current, "support", {
      id: "handled-by",
      from: "policy",
      to: "adjuster",
    });
    if (!onRoot.ok) {
      throw new Error("seed failed");
    }
    expect(
      addNodeOntologyRelationship(onRoot.definition, "support.triage", {
        id: "handled-by",
        from: "adjuster",
        to: "policy",
      }),
    ).toMatchObject({ ok: true });
  });

  it("removes only the link whose endpoints match", () => {
    const seeded = addNodeOntologyEntity(withEntities(), "support.triage", { id: "broker" });
    if (!seeded.ok) {
      throw new Error("seed failed");
    }
    const imported = structuredClone(seeded.definition);
    const node = imported.root.children?.[0];
    if (!node) {
      throw new Error("seed failed");
    }
    node.ontology = {
      ...(node.ontology as Record<string, unknown>),
      relationships: [
        { id: "handled-by", from: "policy", to: "adjuster" },
        { id: "handled-by", from: "policy", to: "broker" },
      ],
    };

    const removed = removeNodeOntologyRelationship(imported, "support.triage", {
      id: "handled-by",
      from: "policy",
      to: "adjuster",
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) {
      return;
    }
    const links = (
      (removed.definition.root.children?.[0]?.ontology ?? {}) as {
        relationships?: { id: string; from: string; to: string }[];
      }
    ).relationships;
    expect(links).toEqual([{ id: "handled-by", from: "policy", to: "broker" }]);
  });

  // "Declared somewhere" is not scope: a sibling's declaration is not on the
  // referring link's own root→node path, so the link would be left dangling.

  it("does not mutate the definition it was given", () => {
    const original = withEntities();
    const snapshot = structuredClone(original);
    addNodeOntologyEntity(original, "support.triage", { id: "renewal" });
    addNodeOntologyProperty(original, "support.triage", "policy", { id: "number", type: "string" });
    removeNodeOntologyEntity(original, "support.triage", "adjuster");
    expect(original).toEqual(snapshot);
  });
});

/**
 * A step whose parent owns the object type, so the AIP verbs have to resolve
 * through the PATH — the gap between what the importer accepts tree-wide and what
 * the runtime can address at the node it runs at.
 */
function verbDefinition(): EditableTreeDefinition {
  const fixture: EditableTreeDefinition = {
    schema: "clawworks.workflow-tree",
    schemaVersion: 1,
    id: "acme.claims",
    version: "1.0.0",
    name: "Claims",
    root: {
      id: "claims",
      title: "Claims",
      ontology: {
        entities: [
          {
            id: "claim",
            properties: [
              { id: "claim-id", type: "string", primaryKey: true },
              { id: "amount", type: "number" },
            ],
          },
          { id: "note", properties: [{ id: "body", type: "string" }] },
        ],
      },
      children: [
        { id: "claims.decide", title: "Decide" },
        { id: "claims.other", title: "Other", ontology: { entities: [{ id: "audit" }] } },
      ],
    },
  };
  for (const step of fixture.root.children ?? []) {
    step.ontology = {
      ...(step.ontology as Record<string, unknown>),
      entities: [
        ...structuredClone((fixture.root.ontology as { entities: unknown[] }).entities),
        ...((step.ontology as { entities?: unknown[] } | undefined)?.entities ?? []),
      ],
    };
  }
  return fixture;
}

function nodeOntology(tree: EditableTreeDefinition, nodeId: string) {
  const walk = (node: { id: string; ontology?: unknown; children?: unknown[] }): unknown => {
    if (node.id === nodeId) {
      return node.ontology;
    }
    for (const child of (node.children ?? []) as { id: string; children?: unknown[] }[]) {
      const found = walk(child);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return walk(tree.root) as Record<string, unknown> | undefined;
}

describe("addNodeOntologyAction", () => {
  it("declares a bare action on a step", () => {
    const result = addNodeOntologyAction(verbDefinition(), "claims.decide", {
      id: "Approve-Claim",
      title: " Approve ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(nodeOntology(result.definition, "claims.decide")?.actions).toEqual([
      { id: "approve-claim", title: "Approve" },
    ]);
  });

  it("allows a separate step to reuse a local declaration id", () => {
    const seeded = addNodeOntologyAction(verbDefinition(), "claims", { id: "approve" });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) {
      return;
    }
    expect(
      addNodeOntologyAction(seeded.definition, "claims.decide", { id: "approve" }),
    ).toMatchObject({ ok: true });
  });

  it("refuses a malformed id at the field", () => {
    expect(
      addNodeOntologyAction(verbDefinition(), "claims.decide", { id: "Approve Claim" }),
    ).toEqual({ ok: false, reason: "invalid-id" });
  });

  it("undeclares an action, dropping the key with the last one", () => {
    const added = addNodeOntologyAction(verbDefinition(), "claims.decide", { id: "approve" });
    expect(added.ok).toBe(true);
    if (!added.ok) {
      return;
    }
    const removed = removeNodeOntologyAction(added.definition, "claims.decide", "approve");
    expect(removed.ok).toBe(true);
    if (!removed.ok) {
      return;
    }
    expect(nodeOntology(removed.definition, "claims.decide")?.actions).toBeUndefined();
    expect(removeNodeOntologyAction(added.definition, "claims.decide", "missing")).toEqual({
      ok: false,
      reason: "entry-not-found",
    });
  });

  it("removes an earlier duplicate without treating the unchanged winner as new breakage", () => {
    const original = verbDefinition();
    const child = original.root.children?.[0];
    if (!child) {
      throw new Error("fixture failed");
    }
    const winner = { id: "approve", effects: [{ entity: "claim", kind: "update" }] };
    child.ontology = {
      actions: [{ id: "approve", effects: [{ kind: "call", tool: "message" }] }, winner],
    };

    const removed = removeNodeOntologyAction(original, child.id, "approve", 0);

    expect(removed.ok).toBe(true);
    expect(removed.ok && nodeOntology(removed.definition, child.id)?.actions).toEqual([winner]);
  });
});

describe("action effects", () => {
  function withAction(nodeId = "claims.decide"): EditableTreeDefinition {
    const result = addNodeOntologyAction(verbDefinition(), nodeId, { id: "approve" });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.definition;
  }

  it("authorizes a write on a locally declared type", () => {
    const result = addNodeOntologyActionEffect(withAction(), "claims.decide", "approve", {
      entity: "claim",
      kind: "update",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(nodeOntology(result.definition, "claims.decide")?.actions).toEqual([
      { id: "approve", effects: [{ entity: "claim", kind: "update" }] },
    ]);
  });

  it("refuses a write on a type with no identity field", () => {
    expect(
      addNodeOntologyActionEffect(withAction(), "claims.decide", "approve", {
        entity: "note",
        kind: "update",
      }),
    ).toEqual({ ok: false, reason: "effect-needs-identity" });
  });

  it("allows a read on a type with no identity field", () => {
    expect(
      addNodeOntologyActionEffect(withAction(), "claims.decide", "approve", {
        entity: "note",
        kind: "read",
      }).ok,
    ).toBe(true);
  });

  it("refuses a type only a sibling branch declares", () => {
    expect(
      addNodeOntologyActionEffect(withAction(), "claims.decide", "approve", {
        entity: "audit",
        kind: "read",
      }),
    ).toEqual({ ok: false, reason: "entity-not-found" });
  });

  it("refuses the same entity and kind twice", () => {
    const first = addNodeOntologyActionEffect(withAction(), "claims.decide", "approve", {
      entity: "claim",
      kind: "update",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(
      addNodeOntologyActionEffect(first.definition, "claims.decide", "approve", {
        entity: "claim",
        kind: "update",
      }),
    ).toEqual({ ok: false, reason: "duplicate-entry" });
  });

  it("drops the key when the last effect is withdrawn", () => {
    const added = addNodeOntologyActionEffect(withAction(), "claims.decide", "approve", {
      entity: "claim",
      kind: "update",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) {
      return;
    }
    const removed = removeNodeOntologyActionEffect(added.definition, "claims.decide", "approve", {
      entity: "claim",
      kind: "update",
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) {
      return;
    }
    expect(nodeOntology(removed.definition, "claims.decide")?.actions).toEqual([{ id: "approve" }]);
  });

  it("reports an action that is no longer declared", () => {
    expect(
      addNodeOntologyActionEffect(verbDefinition(), "claims.decide", "approve", {
        entity: "claim",
        kind: "read",
      }),
    ).toEqual({ ok: false, reason: "action-not-found" });
  });
});

describe("action parameters", () => {
  function withAction(): EditableTreeDefinition {
    const result = addNodeOntologyAction(verbDefinition(), "claims.decide", { id: "approve" });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.definition;
  }

  it("accepts a parameter that maps onto no property, since those reach the audit trail", () => {
    const result = addNodeOntologyActionParameter(withAction(), "claims.decide", "approve", {
      id: "rationale",
      type: "string",
      required: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(nodeOntology(result.definition, "claims.decide")?.actions).toEqual([
      { id: "approve", parameters: [{ id: "rationale", type: "string", required: true }] },
    ]);
  });

  it("refuses a duplicate id, which the write path would reject on every call", () => {
    const first = addNodeOntologyActionParameter(withAction(), "claims.decide", "approve", {
      id: "rationale",
      type: "string",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(
      addNodeOntologyActionParameter(first.definition, "claims.decide", "approve", {
        id: "rationale",
        type: "number",
      }),
    ).toEqual({ ok: false, reason: "duplicate-entry" });
  });

  it("drops the key when the last parameter is removed", () => {
    const added = addNodeOntologyActionParameter(withAction(), "claims.decide", "approve", {
      id: "rationale",
      type: "string",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) {
      return;
    }
    const removed = removeNodeOntologyActionParameter(
      added.definition,
      "claims.decide",
      "approve",
      "rationale",
    );
    expect(removed.ok).toBe(true);
    if (!removed.ok) {
      return;
    }
    expect(nodeOntology(removed.definition, "claims.decide")?.actions).toEqual([{ id: "approve" }]);
  });
});

describe("addNodeOntologyFunction", () => {
  it("declares a derived value over a local type", () => {
    const result = addNodeOntologyFunction(verbDefinition(), "claims.decide", {
      id: "doubled",
      entity: "claim",
      expression: " $amount * 2 ",
      returns: "number",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(nodeOntology(result.definition, "claims.decide")?.functions).toEqual([
      { id: "doubled", entity: "claim", expression: "$amount * 2", returns: "number" },
    ]);
  });

  it("refuses an expression that does not parse", () => {
    expect(
      addNodeOntologyFunction(verbDefinition(), "claims.decide", {
        id: "doubled",
        entity: "claim",
        expression: "$amount *",
        returns: "number",
      }),
    ).toEqual({ ok: false, reason: "expression-invalid" });
  });

  it("refuses an expression reading a field the type does not have here", () => {
    expect(
      addNodeOntologyFunction(verbDefinition(), "claims.decide", {
        id: "doubled",
        entity: "claim",
        expression: "$missing * 2",
        returns: "number",
      }),
    ).toEqual({ ok: false, reason: "expression-property-unknown" });
  });

  it("refuses a type only a sibling branch declares", () => {
    expect(
      addNodeOntologyFunction(verbDefinition(), "claims.decide", {
        id: "doubled",
        entity: "audit",
        expression: "$amount * 2",
        returns: "number",
      }),
    ).toEqual({ ok: false, reason: "entity-not-found" });
  });

  it("removes a declared derived value", () => {
    const added = addNodeOntologyFunction(verbDefinition(), "claims.decide", {
      id: "doubled",
      entity: "claim",
      expression: "$amount * 2",
      returns: "number",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) {
      return;
    }
    const removed = removeNodeOntologyFunction(added.definition, "claims.decide", "doubled");
    expect(removed.ok).toBe(true);
    if (!removed.ok) {
      return;
    }
    expect(nodeOntology(removed.definition, "claims.decide")?.functions).toBeUndefined();
    expect(removeNodeOntologyFunction(added.definition, "claims.decide", "missing")).toEqual({
      ok: false,
      reason: "entry-not-found",
    });
  });
});

describe("removeNodeOntologyEntity with the verbs declared", () => {
  it("still refuses to drop a type an action writes", () => {
    const withAction = addNodeOntologyAction(verbDefinition(), "claims.decide", { id: "approve" });
    if (!withAction.ok) {
      throw new Error(withAction.reason);
    }
    const withEffect = addNodeOntologyActionEffect(
      withAction.definition,
      "claims.decide",
      "approve",
      { entity: "claim", kind: "update" },
    );
    if (!withEffect.ok) {
      throw new Error(withEffect.reason);
    }
    expect(removeNodeOntologyEntity(withEffect.definition, "claims.decide", "claim")).toEqual({
      ok: false,
      reason: "entity-referenced",
    });
  });
});

describe("AIP verb declarations resolved against the whole branch", () => {
  it("allows a separate step to reuse a local declaration id", () => {
    // resolveActiveOntologyScope maps actions by id along the active node's path,
    // last one wins — so a child's declaration silently wins over one added above
    // it, and the editor must not accept the duplicate it cannot honor.
    const seeded = addNodeOntologyAction(verbDefinition(), "claims.decide", { id: "approve" });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) {
      return;
    }
    expect(addNodeOntologyAction(seeded.definition, "claims", { id: "approve" })).toMatchObject({
      ok: true,
    });
  });

  it("allows a separate step to reuse a local declaration id", () => {
    const seeded = addNodeOntologyFunction(verbDefinition(), "claims.decide", {
      id: "doubled",
      entity: "claim",
      expression: "$amount * 2",
      returns: "number",
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) {
      return;
    }
    expect(
      addNodeOntologyFunction(seeded.definition, "claims", {
        id: "doubled",
        entity: "claim",
        expression: "$amount * 3",
        returns: "number",
      }),
    ).toMatchObject({ ok: true });
  });

  it("still allows the same id on a sibling branch, which never shares a path", () => {
    const seeded = addNodeOntologyAction(verbDefinition(), "claims.decide", { id: "approve" });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) {
      return;
    }
    expect(addNodeOntologyAction(seeded.definition, "claims.other", { id: "approve" }).ok).toBe(
      true,
    );
  });

  it("refuses an expression that yields a different type than `returns`", () => {
    // The whole-tree import type-checks this (src/enterprise/schema.ts). Without
    // the same check here the save is accepted and then refused tree-wide, so the
    // operator gets a banner instead of the field that is wrong.
    expect(
      addNodeOntologyFunction(verbDefinition(), "claims.decide", {
        id: "big-claim",
        entity: "claim",
        expression: "$amount >= 10",
        returns: "number",
      }),
    ).toEqual({ ok: false, reason: "returns-mismatch" });
  });

  it("accepts the same expression once `returns` agrees", () => {
    expect(
      addNodeOntologyFunction(verbDefinition(), "claims.decide", {
        id: "big-claim",
        entity: "claim",
        expression: "$amount >= 10",
        returns: "boolean",
      }).ok,
    ).toBe(true);
  });

  it("refuses an expression that cannot type-check against the declared fields", () => {
    // `claim-id` is a string and `amount` a number, so multiplying them is not a
    // dangling reference — it is a type error the import would also reject.
    expect(
      addNodeOntologyFunction(verbDefinition(), "claims.decide", {
        id: "nonsense",
        entity: "claim",
        expression: "$claim-id * $amount",
        returns: "number",
      }),
    ).toEqual({ ok: false, reason: "expression-type-invalid" });
  });
});

describe("action parameters that a write effect could never satisfy", () => {
  function withApprove(): EditableTreeDefinition {
    const result = addNodeOntologyAction(verbDefinition(), "claims.decide", { id: "approve" });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.definition;
  }

  function withEffect(kind: OntologyEffectKindName): EditableTreeDefinition {
    const result = addNodeOntologyActionEffect(withApprove(), "claims.decide", "approve", {
      entity: "claim",
      kind,
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.definition;
  }

  it("refuses a parameter typed against the property it would write", () => {
    // validateParameters checks the value against the PARAMETER type and
    // planEffect against the PROPERTY type, so a string `amount` targeting a
    // numeric `claim.amount` saves and then rejects every non-null call.
    expect(
      addNodeOntologyActionParameter(withEffect("update"), "claims.decide", "approve", {
        id: "amount",
        type: "string",
      }),
    ).toEqual({ ok: false, reason: "parameter-type-conflict" });
  });

  it("accepts the parameter once its type agrees with the property", () => {
    expect(
      addNodeOntologyActionParameter(withEffect("update"), "claims.decide", "approve", {
        id: "amount",
        type: "number",
      }).ok,
    ).toBe(true);
  });

  it("still accepts a parameter that maps onto no property at all", () => {
    // Those are inputs to the DECISION and reach the audit trail unmapped, which
    // is exactly what the write path documents.
    expect(
      addNodeOntologyActionParameter(withEffect("update"), "claims.decide", "approve", {
        id: "rationale",
        type: "string",
      }).ok,
    ).toBe(true);
  });

  it("ignores a read effect, which maps no parameter onto a property", () => {
    expect(
      addNodeOntologyActionParameter(withEffect("read"), "claims.decide", "approve", {
        id: "amount",
        type: "string",
      }).ok,
    ).toBe(true);
  });

  it("catches the same clash when the EFFECT is added second", () => {
    // Parameters can be declared before the effect that gives them a target, so
    // a check on only one side would let the clash in through the other.
    const withParameter = addNodeOntologyActionParameter(
      withApprove(),
      "claims.decide",
      "approve",
      { id: "amount", type: "string" },
    );
    expect(withParameter.ok).toBe(true);
    if (!withParameter.ok) {
      return;
    }
    expect(
      addNodeOntologyActionEffect(withParameter.definition, "claims.decide", "approve", {
        entity: "claim",
        kind: "update",
      }),
    ).toEqual({ ok: false, reason: "parameter-type-conflict" });
  });
});

describe("effects an action could never execute", () => {
  function withApprove(): EditableTreeDefinition {
    const result = addNodeOntologyAction(verbDefinition(), "claims.decide", { id: "approve" });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.definition;
  }

  function withEffect(
    tree: EditableTreeDefinition,
    entity: string,
    kind: OntologyEffectKindName,
  ): EditableTreeDefinition {
    const result = addNodeOntologyActionEffect(tree, "claims.decide", "approve", {
      entity,
      kind,
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.definition;
  }

  it("refuses a second write on an object type the action already writes", () => {
    // Both effects resolve the same object id from the shared key argument, and
    // invokeOntologyAction refuses an action that touches one object twice.
    expect(
      addNodeOntologyActionEffect(
        withEffect(withApprove(), "claim", "update"),
        "claims.decide",
        "approve",
        { entity: "claim", kind: "delete" },
      ),
    ).toEqual({ ok: false, reason: "effect-target-taken" });
  });

  it("still allows a read alongside a write on the same type", () => {
    expect(
      addNodeOntologyActionEffect(
        withEffect(withApprove(), "claim", "update"),
        "claims.decide",
        "approve",
        { entity: "claim", kind: "read" },
      ).ok,
    ).toBe(true);
  });

  it("validates the identity parameter of a delete effect", () => {
    // planEffect returns before mapping properties for a delete, but it still
    // resolves the target through the key argument that validateParameters has
    // already checked against the PARAMETER type.
    expect(
      addNodeOntologyActionParameter(
        withEffect(withApprove(), "claim", "delete"),
        "claims.decide",
        "approve",
        { id: "claim-id", type: "number" },
      ),
    ).toEqual({ ok: false, reason: "parameter-type-conflict" });
  });

  it("accepts a delete parameter that shares the key's runtime shape", () => {
    // `claim-id` is declared `string`; an `id` parameter is the same value shape.
    expect(
      addNodeOntologyActionParameter(
        withEffect(withApprove(), "claim", "delete"),
        "claims.decide",
        "approve",
        { id: "claim-id", type: "id" },
      ).ok,
    ).toBe(true);
  });

  it("does not require identical type LABELS, only the same runtime shape", () => {
    // `string`, `date`, and `id` are all strings at runtime, so refusing the pair
    // would reject a declaration both validations accept.
    expect(
      addNodeOntologyActionParameter(
        withEffect(withApprove(), "claim", "update"),
        "claims.decide",
        "approve",
        { id: "claim-id", type: "date" },
      ).ok,
    ).toBe(true);
  });
});

describe("relationship ids across the branch", () => {
  it("allows a separate step to reuse a local declaration id", () => {
    // resolveActiveOntologyScope keys links by id root-first, so the descendant
    // silently replaces one added above it while the inspector shows both.
    const seeded = addNodeOntologyRelationship(verbDefinition(), "claims.decide", {
      id: "claim-note",
      from: "claim",
      to: "note",
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) {
      return;
    }
    expect(
      addNodeOntologyRelationship(seeded.definition, "claims", {
        id: "claim-note",
        from: "claim",
        to: "note",
      }),
    ).toMatchObject({ ok: true });
  });

  it("still allows the same link id on a sibling branch", () => {
    const seeded = addNodeOntologyRelationship(verbDefinition(), "claims.decide", {
      id: "claim-note",
      from: "claim",
      to: "note",
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) {
      return;
    }
    expect(
      addNodeOntologyRelationship(seeded.definition, "claims.other", {
        id: "claim-note",
        from: "claim",
        to: "note",
      }).ok,
    ).toBe(true);
  });
});

describe("create effects and tree-wide required fields", () => {
  it("refuses a create when a sibling branch requires a field this step cannot see", () => {
    // collectTreeRequiredProperties is tree-wide, so the requirement applies to
    // every create — and no parameter here can supply a property this branch
    // never declares, so planEffect refuses every call.
    const tree: EditableTreeDefinition = {
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: "acme.claims",
      version: "1.0.0",
      name: "Claims",
      root: {
        id: "claims",
        title: "Claims",
        ontology: {
          entities: [
            { id: "claim", properties: [{ id: "claim-id", type: "id", primaryKey: true }] },
          ],
        },
        children: [
          {
            id: "claims.open",
            title: "Open",
            ontology: {
              entities: [
                { id: "claim", properties: [{ id: "claim-id", type: "id", primaryKey: true }] },
              ],
            },
          },
          {
            id: "claims.audit",
            title: "Audit",
            ontology: {
              entities: [
                { id: "claim", properties: [{ id: "auditor", type: "string", required: true }] },
              ],
            },
          },
        ],
      },
    };
    const withAction = addNodeOntologyAction(tree, "claims.open", { id: "open-claim" });
    expect(withAction.ok).toBe(true);
    if (!withAction.ok) {
      return;
    }
    expect(
      addNodeOntologyActionEffect(withAction.definition, "claims.open", "open-claim", {
        entity: "claim",
        kind: "create",
      }),
    ).toEqual({ ok: false, reason: "create-required-unreachable" });
    // An UPDATE is fine: it writes onto an object that already satisfies its type.
    expect(
      addNodeOntologyActionEffect(withAction.definition, "claims.open", "open-claim", {
        entity: "claim",
        kind: "update",
      }).ok,
    ).toBe(true);
  });
});

describe("authoring outward and graph effects", () => {
  /** A claims tree with a link type, plus one action to hang effects on. */
  function actionDefinition(): EditableTreeDefinition {
    const withLink = addNodeOntologyRelationship(verbDefinition(), "claims.decide", {
      id: "claim-has-note",
      from: "claim",
      to: "note",
      cardinality: "one-to-many",
    });
    if (!withLink.ok) {
      throw new Error("fixture failed");
    }
    const withAction = addNodeOntologyAction(withLink.definition, "claims.decide", {
      id: "settle",
    });
    if (!withAction.ok) {
      throw new Error("fixture failed");
    }
    return withAction.definition;
  }

  function effectsOf(tree: EditableTreeDefinition): Record<string, unknown>[] {
    const actions = (nodeOntology(tree, "claims.decide")?.actions ?? []) as Record<
      string,
      unknown
    >[];
    return (actions[0]?.effects ?? []) as Record<string, unknown>[];
  }

  it("adds an outward call naming the tool it performs", () => {
    const result = addNodeOntologyActionEffect(actionDefinition(), "claims.decide", "settle", {
      kind: "call",
      tool: "acme-ledger__post_payment",
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && effectsOf(result.definition)).toEqual([
      { kind: "call", tool: "acme-ledger__post_payment" },
    ]);
  });

  it("adds a graph effect over a link type the step can address", () => {
    const result = addNodeOntologyActionEffect(actionDefinition(), "claims.decide", "settle", {
      kind: "link",
      relationship: "claim-has-note",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && effectsOf(result.definition)).toEqual([
      { kind: "link", relationship: "claim-has-note" },
    ]);
  });

  it("allows one relationship effect for each explicit endpoint pair", () => {
    const first = addNodeOntologyActionEffect(actionDefinition(), "claims.decide", "settle", {
      kind: "link",
      relationship: "claim-has-note",
      from: "claim-id",
      to: "note-id",
    });
    if (!first.ok) {
      throw new Error("fixture failed");
    }
    const second = addNodeOntologyActionEffect(first.definition, "claims.decide", "settle", {
      kind: "link",
      relationship: "claim-has-note",
      from: "parent-claim-id",
      to: "child-note-id",
    });
    expect(second.ok).toBe(true);
    expect(
      second.ok &&
        addNodeOntologyActionEffect(second.definition, "claims.decide", "settle", {
          kind: "link",
          relationship: "claim-has-note",
          from: "claim-id",
          to: "note-id",
        }),
    ).toMatchObject({ ok: false, reason: "duplicate-entry" });
  });

  it("refuses a link type declared only on a sibling branch", () => {
    // planLinkEffect resolves against the ACTIVE node's path, so a link type this
    // step never reaches imports cleanly and then fails mid-run.
    const sibling = addNodeOntologyRelationship(actionDefinition(), "claims.other", {
      id: "audit-of-claim",
      from: "audit",
      to: "claim",
    });
    if (!sibling.ok) {
      throw new Error("fixture failed");
    }
    expect(
      addNodeOntologyActionEffect(sibling.definition, "claims.decide", "settle", {
        kind: "link",
        relationship: "audit-of-claim",
      }),
    ).toMatchObject({ ok: false, reason: "relationship-not-found" });
  });

  it("refuses a second outward call naming the same tool", () => {
    const first = addNodeOntologyActionEffect(actionDefinition(), "claims.decide", "settle", {
      kind: "call",
      tool: "acme-ledger__post_payment",
    });
    if (!first.ok) {
      throw new Error("fixture failed");
    }
    expect(
      addNodeOntologyActionEffect(first.definition, "claims.decide", "settle", {
        kind: "call",
        tool: "acme-ledger__post_payment",
      }),
    ).toMatchObject({ ok: false, reason: "duplicate-entry" });
  });

  it("refuses mixing an outward call with a local effect, from either side", () => {
    // The call cannot join the local write transaction, so the pair could never
    // be one atomic action — the import refuses it too.
    const outward = addNodeOntologyActionEffect(actionDefinition(), "claims.decide", "settle", {
      kind: "call",
      tool: "acme-ledger__post_payment",
    });
    if (!outward.ok) {
      throw new Error("fixture failed");
    }
    expect(
      addNodeOntologyActionEffect(outward.definition, "claims.decide", "settle", {
        entity: "claim",
        kind: "update",
      }),
    ).toMatchObject({ ok: false, reason: "effect-mixes-outward" });

    const local = addNodeOntologyActionEffect(actionDefinition(), "claims.decide", "settle", {
      entity: "claim",
      kind: "update",
    });
    if (!local.ok) {
      throw new Error("fixture failed");
    }
    expect(
      addNodeOntologyActionEffect(local.definition, "claims.decide", "settle", {
        kind: "call",
        tool: "acme-ledger__post_payment",
      }),
    ).toMatchObject({ ok: false, reason: "effect-mixes-outward" });
  });

  it("refuses a blank tool", () => {
    expect(
      addNodeOntologyActionEffect(actionDefinition(), "claims.decide", "settle", {
        kind: "call",
        tool: "   ",
      }),
    ).toMatchObject({ ok: false, reason: "invalid-id" });
  });

  it("removes an outward or graph effect by what it names", () => {
    // Identified by tool and relationship rather than entity: the object-effect
    // match would drop every one of them at once.
    let current = actionDefinition();
    for (const effect of [
      { kind: "link" as const, relationship: "claim-has-note" },
      { kind: "unlink" as const, relationship: "claim-has-note" },
    ]) {
      const added = addNodeOntologyActionEffect(current, "claims.decide", "settle", effect);
      if (!added.ok) {
        throw new Error("fixture failed");
      }
      current = added.definition;
    }
    const removed = removeNodeOntologyActionEffect(current, "claims.decide", "settle", {
      kind: "link",
      relationship: "claim-has-note",
    });
    expect(removed.ok).toBe(true);
    expect(removed.ok && effectsOf(removed.definition)).toEqual([
      { kind: "unlink", relationship: "claim-has-note" },
    ]);
  });
});

function staticMetadataDefinition(): EditableTreeDefinition {
  const tree = definition();
  const node = tree.root.children?.[0];
  if (!node) {
    throw new Error("fixture failed");
  }
  node.ontology = {
    futureBinding: "keep",
    entities: [
      {
        id: "claim",
        title: "Old claim",
        description: "Old entity",
        futureEntity: "keep",
        properties: [
          {
            id: "claim-id",
            type: "id",
            primaryKey: true,
            description: "Old property",
            futureProperty: "keep",
          },
        ],
      },
      { id: "note" },
    ],
    relationships: [
      {
        id: "claim-note",
        from: "claim",
        to: "note",
        cardinality: "one-to-one",
        futureRelationship: "keep",
      },
    ],
    actions: [
      {
        id: "settle",
        title: "Old action",
        tools: ["old-tool"],
        preconditions: ["Old precondition"],
        futureAction: "keep",
        parameters: [{ id: "reason", type: "string", futureParameter: "keep" }],
        effects: [
          { entity: "claim", kind: "update", futureObjectEffect: "keep" },
          { kind: "link", relationship: "claim-note", futureLinkEffect: "keep" },
        ],
      },
      {
        id: "notify",
        effects: [{ kind: "call", tool: "mail__send", futureCallEffect: "keep" }],
      },
    ],
    functions: [
      {
        id: "claim-key",
        entity: "claim",
        expression: "$claim-id",
        returns: "id",
        futureFunction: "keep",
      },
    ],
    constraints: [{ id: "review", description: "Old constraint", futureConstraint: "keep" }],
  };
  return tree;
}

function valueAtPath(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

const metadataUpdateCases: Array<{
  name: string;
  update: NodeOntologyMetadataUpdate;
  path: readonly (string | number)[];
  expected: Record<string, unknown>;
}> = [
  {
    name: "entity title and description",
    update: {
      kind: "entity",
      target: { index: 0, id: "claim" },
      title: " Updated claim ",
      description: " Entity details ",
    },
    path: ["entities", 0],
    expected: {
      id: "claim",
      title: "Updated claim",
      description: "Entity details",
      futureEntity: "keep",
    },
  },
  {
    name: "property required and description",
    update: {
      kind: "property",
      entity: { index: 0, id: "claim" },
      target: { index: 0, id: "claim-id", type: "id", primaryKey: true },
      required: true,
      description: " Stable identifier ",
    },
    path: ["entities", 0, "properties", 0],
    expected: {
      id: "claim-id",
      type: "id",
      primaryKey: true,
      required: true,
      description: "Stable identifier",
      futureProperty: "keep",
    },
  },
  {
    name: "relationship inverse and description",
    update: {
      kind: "relationship",
      target: {
        index: 0,
        id: "claim-note",
        from: "claim",
        to: "note",
        cardinality: "one-to-one",
      },
      inverse: " note-for-claim ",
      description: " Claim annotation ",
    },
    path: ["relationships", 0],
    expected: {
      id: "claim-note",
      from: "claim",
      to: "note",
      cardinality: "one-to-one",
      inverse: "note-for-claim",
      description: "Claim annotation",
      futureRelationship: "keep",
    },
  },
  {
    name: "action title, description, tools, and preconditions",
    update: {
      kind: "action",
      target: { index: 0, id: "settle" },
      title: " Settle claim ",
      description: " Local settlement ",
      tools: [],
      preconditions: [" Identity verified "],
    },
    path: ["actions", 0],
    expected: {
      id: "settle",
      title: "Settle claim",
      description: "Local settlement",
      tools: [],
      preconditions: ["Identity verified"],
      futureAction: "keep",
    },
  },
  {
    name: "object effect description",
    update: {
      kind: "object-effect",
      action: { index: 0, id: "settle" },
      target: { index: 0, kind: "update", entity: "claim" },
      description: " Apply settlement ",
    },
    path: ["actions", 0, "effects", 0],
    expected: {
      entity: "claim",
      kind: "update",
      description: "Apply settlement",
      futureObjectEffect: "keep",
    },
  },
  {
    name: "call effect description",
    update: {
      kind: "call-effect",
      action: { index: 1, id: "notify" },
      target: { index: 0, kind: "call", tool: "mail__send" },
      description: " Notify owner ",
    },
    path: ["actions", 1, "effects", 0],
    expected: {
      kind: "call",
      tool: "mail__send",
      description: "Notify owner",
      futureCallEffect: "keep",
    },
  },
  {
    name: "link effect description and endpoint parameters",
    update: {
      kind: "link-effect",
      action: { index: 0, id: "settle" },
      target: { index: 1, kind: "link", relationship: "claim-note" },
      from: " claim-id ",
      to: " note-id ",
      description: " Attach note ",
    },
    path: ["actions", 0, "effects", 1],
    expected: {
      kind: "link",
      relationship: "claim-note",
      from: "claim-id",
      to: "note-id",
      description: "Attach note",
      futureLinkEffect: "keep",
    },
  },
  {
    name: "parameter required and description",
    update: {
      kind: "parameter",
      action: { index: 0, id: "settle" },
      target: { index: 0, id: "reason", type: "string" },
      required: true,
      description: " Settlement reason ",
    },
    path: ["actions", 0, "parameters", 0],
    expected: {
      id: "reason",
      type: "string",
      required: true,
      description: "Settlement reason",
      futureParameter: "keep",
    },
  },
  {
    name: "function title and description",
    update: {
      kind: "function",
      target: {
        index: 0,
        id: "claim-key",
        entity: "claim",
        expression: "$claim-id",
        returns: "id",
      },
      title: " Claim key ",
      description: " Reads identity ",
    },
    path: ["functions", 0],
    expected: {
      id: "claim-key",
      entity: "claim",
      expression: "$claim-id",
      returns: "id",
      title: "Claim key",
      description: "Reads identity",
      futureFunction: "keep",
    },
  },
  {
    name: "constraint description",
    update: {
      kind: "constraint",
      target: { index: 0, id: "review" },
      description: " Supervisor review required ",
    },
    path: ["constraints", 0],
    expected: {
      id: "review",
      description: "Supervisor review required",
      futureConstraint: "keep",
    },
  },
];

describe("updateNodeOntologyMetadata", () => {
  it.each(metadataUpdateCases)(
    "updates $name without changing identity or unknown fields",
    (test) => {
      const original = staticMetadataDefinition();
      const snapshot = structuredClone(original);
      const result = updateNodeOntologyMetadata(original, "support.triage", test.update);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(
        valueAtPath(nodeOntology(result.definition, "support.triage"), test.path),
      ).toMatchObject(test.expected);
      expect(nodeOntology(result.definition, "support.triage")?.futureBinding).toBe("keep");
      expect(original).toEqual(snapshot);
    },
  );

  it.each(metadataUpdateCases)("refuses a stale array position for $name", (test) => {
    const stale = {
      ...test.update,
      target: { ...test.update.target, index: 99 },
    } as NodeOntologyMetadataUpdate;
    expect(updateNodeOntologyMetadata(staticMetadataDefinition(), "support.triage", stale)).toEqual(
      { ok: false, reason: "entry-not-found" },
    );
  });

  it("checks identity as well as position, including nested action owners", () => {
    expect(
      updateNodeOntologyMetadata(staticMetadataDefinition(), "support.triage", {
        kind: "entity",
        target: { index: 1, id: "claim" },
      }),
    ).toEqual({ ok: false, reason: "entry-not-found" });
    expect(
      updateNodeOntologyMetadata(staticMetadataDefinition(), "support.triage", {
        kind: "parameter",
        action: { index: 1, id: "settle" },
        target: { index: 0, id: "reason", type: "string" },
        required: true,
      }),
    ).toEqual({ ok: false, reason: "entry-not-found" });
  });

  it.each([
    {
      name: "blank selected tool",
      update: {
        kind: "action",
        target: { index: 0, id: "settle" },
        tools: ["read", "   "],
      } satisfies NodeOntologyMetadataUpdate,
    },
    {
      name: "invalid link endpoint id",
      update: {
        kind: "link-effect",
        action: { index: 0, id: "settle" },
        target: { index: 1, kind: "link", relationship: "claim-note" },
        from: "Not Valid",
      } satisfies NodeOntologyMetadataUpdate,
    },
  ])("refuses $name", ({ update }) => {
    expect(
      updateNodeOntologyMetadata(staticMetadataDefinition(), "support.triage", update),
    ).toEqual({ ok: false, reason: "invalid-id" });
  });

  it("removes blank optional metadata while preserving the tools undefined/empty distinction", () => {
    const cleared = updateNodeOntologyMetadata(staticMetadataDefinition(), "support.triage", {
      kind: "action",
      target: { index: 0, id: "settle" },
      title: " ",
      description: " ",
      tools: undefined,
      preconditions: [],
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) {
      return;
    }
    const action = valueAtPath(nodeOntology(cleared.definition, "support.triage"), ["actions", 0]);
    expect(action).not.toHaveProperty("title");
    expect(action).not.toHaveProperty("description");
    expect(action).not.toHaveProperty("tools");
    expect(action).not.toHaveProperty("preconditions");
  });
});

describe("ontology metadata adders", () => {
  it("preserves every newly exposed optional field", () => {
    let current = verbDefinition();
    const entity = addNodeOntologyEntity(current, "claims.decide", {
      id: "supplement",
      title: " Supplement ",
      description: " Supporting material ",
    });
    expect(entity.ok).toBe(true);
    if (!entity.ok) {
      return;
    }
    current = entity.definition;
    const property = addNodeOntologyProperty(current, "claims", "claim", {
      id: "status",
      type: "string",
      required: true,
      description: " Current status ",
    });
    expect(property.ok).toBe(true);
    if (!property.ok) {
      return;
    }
    current = property.definition;
    const relationship = addNodeOntologyRelationship(current, "claims", {
      id: "claim-note",
      from: "claim",
      to: "note",
      inverse: " note-for-claim ",
      description: " Attached note ",
    });
    expect(relationship.ok).toBe(true);
    if (!relationship.ok) {
      return;
    }
    current = relationship.definition;
    const action = addNodeOntologyAction(current, "claims.decide", {
      id: "settle",
      title: " Settle ",
      description: " Settle the claim ",
      tools: [],
      preconditions: [" Identity verified "],
    });
    expect(action.ok).toBe(true);
    if (!action.ok) {
      return;
    }
    current = action.definition;
    const parameter = addNodeOntologyActionParameter(current, "claims.decide", "settle", {
      id: "amount",
      type: "number",
      required: true,
      description: " Settlement amount ",
    });
    expect(parameter.ok).toBe(true);
    if (!parameter.ok) {
      return;
    }
    current = parameter.definition;
    const effect = addNodeOntologyActionEffect(current, "claims.decide", "settle", {
      entity: "claim",
      kind: "update",
      description: " Apply settlement ",
    });
    expect(effect.ok).toBe(true);
    if (!effect.ok) {
      return;
    }
    current = effect.definition;
    const fn = addNodeOntologyFunction(current, "claims.decide", {
      id: "doubled",
      title: " Double amount ",
      description: " Twice the claim amount ",
      entity: "claim",
      expression: "$amount * 2",
      returns: "number",
    });
    expect(fn.ok).toBe(true);
    if (!fn.ok) {
      return;
    }

    expect(nodeOntology(fn.definition, "claims.decide")).toMatchObject({
      entities: expect.arrayContaining([
        { id: "supplement", title: "Supplement", description: "Supporting material" },
      ]),
      actions: [
        {
          id: "settle",
          title: "Settle",
          description: "Settle the claim",
          tools: [],
          preconditions: ["Identity verified"],
          parameters: [
            {
              id: "amount",
              type: "number",
              required: true,
              description: "Settlement amount",
            },
          ],
          effects: [{ entity: "claim", kind: "update", description: "Apply settlement" }],
        },
      ],
      functions: [
        {
          id: "doubled",
          title: "Double amount",
          description: "Twice the claim amount",
          entity: "claim",
        },
      ],
    });
    expect(
      valueAtPath(nodeOntology(fn.definition, "claims"), ["entities", 0, "properties", 2]),
    ).toEqual({
      id: "status",
      type: "string",
      required: true,
      description: "Current status",
    });
    expect(nodeOntology(fn.definition, "claims")?.relationships).toEqual([
      {
        id: "claim-note",
        from: "claim",
        to: "note",
        inverse: "note-for-claim",
        description: "Attached note",
      },
    ]);
  });

  it.each([
    [
      "blank action tool",
      () =>
        addNodeOntologyAction(verbDefinition(), "claims.decide", {
          id: "settle",
          tools: ["read", " "],
        }),
    ],
    [
      "blank precondition",
      () =>
        addNodeOntologyAction(verbDefinition(), "claims.decide", {
          id: "settle",
          preconditions: [" "],
        }),
    ],
  ] as const)("refuses a %s", (_name, add) => {
    expect(add()).toEqual({ ok: false, reason: "invalid-id" });
  });

  it("preserves graph effect endpoints and rejects malformed ones", () => {
    const relationship = addNodeOntologyRelationship(verbDefinition(), "claims.decide", {
      id: "claim-note",
      from: "claim",
      to: "note",
    });
    if (!relationship.ok) {
      throw new Error("fixture failed");
    }
    const action = addNodeOntologyAction(relationship.definition, "claims.decide", {
      id: "attach-note",
    });
    if (!action.ok) {
      throw new Error("fixture failed");
    }
    const result = addNodeOntologyActionEffect(action.definition, "claims.decide", "attach-note", {
      kind: "link",
      relationship: "claim-note",
      from: " claim-id ",
      to: " note-id ",
      description: " Attach the note ",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && nodeOntology(result.definition, "claims.decide")?.actions).toEqual([
      {
        id: "attach-note",
        effects: [
          {
            kind: "link",
            relationship: "claim-note",
            from: "claim-id",
            to: "note-id",
            description: "Attach the note",
          },
        ],
      },
    ]);
    expect(
      addNodeOntologyActionEffect(action.definition, "claims.decide", "attach-note", {
        kind: "link",
        relationship: "claim-note",
        from: "Bad ID",
      }),
    ).toEqual({ ok: false, reason: "invalid-id" });
  });
});

describe("ontology constraints", () => {
  it("adds, updates, and removes one exact constraint without disturbing bindings", () => {
    const added = addNodeOntologyConstraint(definition(), "support.triage", {
      id: " Supervisor-Review ",
      description: " Review before sending ",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) {
      return;
    }
    const updated = updateNodeOntologyMetadata(added.definition, "support.triage", {
      kind: "constraint",
      target: { index: 0, id: "supervisor-review" },
      description: " Supervisor approval required ",
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) {
      return;
    }
    const removed = removeNodeOntologyConstraint(updated.definition, "support.triage", {
      index: 0,
      id: "supervisor-review",
    });
    expect(removed.ok).toBe(true);
    expect(removed.ok && nodeOntology(removed.definition, "support.triage")?.constraints).toBe(
      undefined,
    );
    expect(
      removeNodeOntologyConstraint(updated.definition, "support.triage", {
        index: 0,
        id: "stale-id",
      }),
    ).toEqual({ ok: false, reason: "entry-not-found" });
  });

  it.each([
    { id: "Bad ID", description: "valid" },
    { id: "valid", description: "   " },
  ])("refuses an invalid constraint %#", (constraint) => {
    expect(addNodeOntologyConstraint(definition(), "support.triage", constraint)).toEqual({
      ok: false,
      reason: "invalid-id",
    });
  });
});
