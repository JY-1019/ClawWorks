import { describe, expect, it } from "vitest";
import {
  addNodeOntologyEntry,
  collectDefinitionNodeIds,
  type EditableTreeDefinition,
  insertChildNode,
  newNodeIdIssue,
  addNodeOntologyEntity,
  addNodeOntologyProperty,
  addNodeOntologyRelationship,
  removeNodeOntologyEntity,
  removeNodeOntologyEntry,
  removeNodeOntologyProperty,
  removeNodeOntologyRelationship,
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
  it("links object types inherited from an ancestor", () => {
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
    expect(linked.ok).toBe(true);
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

  it("refuses removing a type a link on ANOTHER node still names", () => {
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
    if (!linked.ok) {
      throw new Error("seed failed");
    }
    // The schema tolerates a dangling endpoint, so a node-local check would let
    // this through and leave the child's link pointing outside runtime scope.
    expect(removeNodeOntologyEntity(linked.definition, "support", "policy")).toMatchObject({
      ok: false,
      reason: "entity-in-use",
    });
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

  // Import validates action effects and functions tree-wide, but the runtime
  // resolves them per path — so a sibling declaration is not a substitute.
  it("refuses removing a type an action effect or function still names", () => {
    function withReferrer(referrer: Record<string, unknown>) {
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
      const onSibling = addNodeOntologyEntity(sibling.definition, "support.audit", {
        id: "policy",
      });
      if (!onSibling.ok) {
        throw new Error("seed failed");
      }
      const withRef = structuredClone(onSibling.definition);
      const triage = withRef.root.children?.find((child) => child.id === "support.triage");
      if (!triage) {
        throw new Error("seed failed");
      }
      triage.ontology = { ...(triage.ontology as Record<string, unknown>), ...referrer };
      return withRef;
    }

    expect(
      removeNodeOntologyEntity(
        withReferrer({ actions: [{ id: "renew", effects: [{ entity: "policy", kind: "read" }] }] }),
        "support",
        "policy",
      ),
    ).toMatchObject({ ok: false, reason: "entity-referenced" });

    expect(
      removeNodeOntologyEntity(
        withReferrer({
          functions: [{ id: "age", entity: "policy", expression: "years", returns: "number" }],
        }),
        "support",
        "policy",
      ),
    ).toMatchObject({ ok: false, reason: "entity-referenced" });
  });

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
  it("checks an ancestor's function against each descendant scope", () => {
    const onRoot = addNodeOntologyEntity(definition(), "support", { id: "policy" });
    if (!onRoot.ok) {
      throw new Error("seed failed");
    }
    // The field the ancestor's function reads exists only on the CHILD.
    const extended = addNodeOntologyEntity(onRoot.definition, "support.triage", { id: "policy" });
    if (!extended.ok) {
      throw new Error("seed failed");
    }
    const withField = addNodeOntologyProperty(extended.definition, "support.triage", "policy", {
      id: "premium",
      type: "number",
    });
    if (!withField.ok) {
      throw new Error("seed failed");
    }
    const withFn = structuredClone(withField.definition);
    withFn.root.ontology = {
      ...(withFn.root.ontology as Record<string, unknown>),
      functions: [
        { id: "annual", entity: "policy", expression: "$premium * 12", returns: "number" },
      ],
    };
    // Valid today: the function resolves at support.triage. Removing the field
    // there breaks it in that scope even though the declaration lives above.
    expect(removeNodeOntologyProperty(withFn, "support.triage", "policy", "premium")).toMatchObject(
      { ok: false, reason: "property-in-use" },
    );
  });

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

  // Seeded objects and links are declarations the schema validates, so a removal
  // that strands one would be refused by the import rather than by this editor.
  it("refuses removals that would strand a seeded object or link", () => {
    let current = definition();
    for (const id of ["policy", "adjuster"]) {
      const seeded = addNodeOntologyEntity(current, "support.triage", { id });
      if (!seeded.ok) {
        throw new Error("seed failed");
      }
      current = seeded.definition;
    }
    const keyed = addNodeOntologyProperty(current, "support.triage", "policy", {
      id: "number",
      type: "string",
      primaryKey: true,
    });
    if (!keyed.ok) {
      throw new Error("seed failed");
    }
    const adjusterKey = addNodeOntologyProperty(keyed.definition, "support.triage", "adjuster", {
      id: "badge",
      type: "string",
      primaryKey: true,
    });
    if (!adjusterKey.ok) {
      throw new Error("seed failed");
    }
    const linked = addNodeOntologyRelationship(adjusterKey.definition, "support.triage", {
      id: "handled-by",
      from: "policy",
      to: "adjuster",
    });
    if (!linked.ok) {
      throw new Error("seed failed");
    }
    const withSeeds = structuredClone(linked.definition);
    const triage = withSeeds.root.children?.find((child) => child.id === "support.triage");
    if (!triage) {
      throw new Error("seed failed");
    }
    triage.ontology = {
      ...(triage.ontology as Record<string, unknown>),
      objects: [{ entity: "policy", properties: { number: "P-1" } }],
      links: [{ relationship: "handled-by", from: "P-1", to: "A-1" }],
    };

    // Its own reason: seeds are import-only records the tree detail never shows,
    // so blaming an action or derived value would misdirect the operator.
    expect(
      removeNodeOntologyProperty(withSeeds, "support.triage", "policy", "number"),
    ).toMatchObject({ ok: false, reason: "seeded-data-in-use" });

    // The link TYPE a seeded link names.
    expect(
      removeNodeOntologyRelationship(withSeeds, "support.triage", {
        id: "handled-by",
        from: "policy",
        to: "adjuster",
      }),
    ).toMatchObject({ ok: false, reason: "seeded-data-in-use" });
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

  it("refuses a link id already declared on an ancestor", () => {
    let current = definition();
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
    ).toMatchObject({ ok: false, reason: "duplicate-entry" });
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
  it("ignores a sibling declaration when judging whether a link stays resolvable", () => {
    const current = definition();
    // Root declares the type the child links.
    const onRoot = addNodeOntologyEntity(current, "support", { id: "policy" });
    if (!onRoot.ok) {
      throw new Error("seed failed");
    }
    const onRootB = addNodeOntologyEntity(onRoot.definition, "support", { id: "adjuster" });
    if (!onRootB.ok) {
      throw new Error("seed failed");
    }
    const linked = addNodeOntologyRelationship(onRootB.definition, "support.triage", {
      id: "handled-by",
      from: "policy",
      to: "adjuster",
    });
    if (!linked.ok) {
      throw new Error("seed failed");
    }
    // A sibling branch declaring the same id does not put it on triage's path.
    const sibling = insertChildNode(linked.definition, "support", {
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
    expect(removeNodeOntologyEntity(onSibling.definition, "support", "policy")).toMatchObject({
      ok: false,
      reason: "entity-in-use",
    });
  });

  it("does not mutate the definition it was given", () => {
    const original = withEntities();
    const snapshot = structuredClone(original);
    addNodeOntologyEntity(original, "support.triage", { id: "renewal" });
    addNodeOntologyProperty(original, "support.triage", "policy", { id: "number", type: "string" });
    removeNodeOntologyEntity(original, "support.triage", "adjuster");
    expect(original).toEqual(snapshot);
  });
});
