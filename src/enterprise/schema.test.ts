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

describe("ontology object / link / action types", () => {
  it("accepts typed properties, link cardinality, and action effects", () => {
    const tree = validTree();
    const root = (tree.root as Record<string, unknown>).ontology as Record<string, unknown>;
    root.entities = [
      {
        id: "customer",
        title: "Customer",
        properties: [
          { id: "customer-id", type: "id", primaryKey: true, required: true },
          { id: "risk-rating", type: "string" },
        ],
      },
      { id: "account", title: "Account", properties: [{ id: "account-id", type: "id" }] },
    ];
    root.relationships = [
      {
        id: "customer-holds-account",
        from: "customer",
        to: "account",
        cardinality: "one-to-many",
        inverse: "account-owned-by",
      },
    ];
    root.actions = [
      {
        id: "open-account",
        title: "Open account",
        tools: ["memory_search"],
        parameters: [{ id: "customer-id", type: "id", required: true }],
        preconditions: ["Identity must be verified."],
        effects: [
          { entity: "account", kind: "create" },
          { entity: "customer", kind: "update" },
        ],
      },
    ];
    const result = validateWorkflowTreeDefinition(tree);
    expect(result.ok).toBe(true);
  });

  it("rejects a second primaryKey on one object type (identity would be ambiguous)", () => {
    const tree = validTree();
    const root = (tree.root as Record<string, unknown>).ontology as Record<string, unknown>;
    root.entities = [
      {
        id: "customer",
        properties: [
          { id: "customer-id", type: "id", primaryKey: true },
          { id: "tax-id", type: "id", primaryKey: true },
        ],
      },
    ];
    const result = validateWorkflowTreeDefinition(tree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes("at most one primaryKey"))).toBe(
        true,
      );
    }
  });

  it("rejects duplicate property ids on one object type", () => {
    const tree = validTree();
    const root = (tree.root as Record<string, unknown>).ontology as Record<string, unknown>;
    root.entities = [
      {
        id: "customer",
        properties: [
          { id: "customer-id", type: "id" },
          { id: "customer-id", type: "string" },
        ],
      },
    ];
    const result = validateWorkflowTreeDefinition(tree);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown property type (the value-type set is closed)", () => {
    const tree = validTree();
    const root = (tree.root as Record<string, unknown>).ontology as Record<string, unknown>;
    root.entities = [{ id: "customer", properties: [{ id: "customer-id", type: "uuid" }] }];
    expect(validateWorkflowTreeDefinition(tree).ok).toBe(false);
  });

  it("accepts a link endpoint that was never declared under entities (implicit object type)", () => {
    // Trees imported before object types existed name endpoints they never
    // repeat under `entities`, and the UI synthesizes those. Hard-failing here
    // would make an already-stored tree unloadable, which fails closed in
    // enforce mode — so link endpoints stay permissive on purpose.
    const tree = validTree();
    const root = (tree.root as Record<string, unknown>).ontology as Record<string, unknown>;
    root.relationships = [{ id: "customer-holds-ghost", from: "customer", to: "ghost" }];
    expect(validateWorkflowTreeDefinition(tree).ok).toBe(true);
  });

  it("rejects an action effect on an undeclared object type (its write scope would be unenforceable)", () => {
    const tree = validTree();
    const root = (tree.root as Record<string, unknown>).ontology as Record<string, unknown>;
    root.actions = [{ id: "lookup", effects: [{ entity: "ghost", kind: "update" }] }];
    const result = validateWorkflowTreeDefinition(tree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].message).toContain("undeclared object type");
    }
  });

  it("rejects two primary keys for one object type across different nodes", () => {
    // Object types are tree-scoped and merged, so a child redeclaring `customer`
    // with a different primaryKey would make instance identity ambiguous.
    const tree = validTree();
    const root = tree.root as Record<string, unknown>;
    (root.ontology as Record<string, unknown>).entities = [
      { id: "customer", properties: [{ id: "customer-id", type: "id", primaryKey: true }] },
    ];
    root.children = [
      {
        id: "support.triage",
        title: "Triage",
        ontology: {
          entities: [
            { id: "customer", properties: [{ id: "tax-id", type: "id", primaryKey: true }] },
          ],
        },
      },
    ];
    const result = validateWorkflowTreeDefinition(tree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].message).toContain("two primary keys");
    }
  });

  it("rejects one object-type property declared with conflicting types across nodes", () => {
    const tree = validTree();
    const root = tree.root as Record<string, unknown>;
    (root.ontology as Record<string, unknown>).entities = [
      { id: "claim", properties: [{ id: "amount", type: "number" }] },
    ];
    root.children = [
      {
        id: "support.triage",
        title: "Triage",
        ontology: { entities: [{ id: "claim", properties: [{ id: "amount", type: "string" }] }] },
      },
    ];
    const result = validateWorkflowTreeDefinition(tree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].message).toContain("both");
    }
  });

  it("accepts the same object type extended with new properties on a deeper step", () => {
    // Merging is the point: a deeper step may add fields, it just may not
    // contradict the ones already declared.
    const tree = validTree();
    const root = tree.root as Record<string, unknown>;
    (root.ontology as Record<string, unknown>).entities = [
      { id: "claim", properties: [{ id: "claim-id", type: "id", primaryKey: true }] },
    ];
    root.children = [
      {
        id: "support.triage",
        title: "Triage",
        ontology: { entities: [{ id: "claim", properties: [{ id: "amount", type: "number" }] }] },
      },
    ];
    expect(validateWorkflowTreeDefinition(tree).ok).toBe(true);
  });

  it("rejects one link type re-declared with a conflicting cardinality", () => {
    // The graph dedupes links by [from, to, id] and keeps the first, so a
    // contradicting redeclaration would silently render the wrong cardinality.
    const tree = validTree();
    const root = tree.root as Record<string, unknown>;
    (root.ontology as Record<string, unknown>).entities = [{ id: "customer" }, { id: "account" }];
    (root.ontology as Record<string, unknown>).relationships = [
      { id: "customer-holds-account", from: "customer", to: "account", cardinality: "one-to-many" },
    ];
    root.children = [
      {
        id: "support.triage",
        title: "Triage",
        ontology: {
          relationships: [
            {
              id: "customer-holds-account",
              from: "customer",
              to: "account",
              cardinality: "many-to-many",
            },
          ],
        },
      },
    ];
    const result = validateWorkflowTreeDefinition(tree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].message).toContain("cardinality");
    }
  });

  it("accepts a link re-declared with the same metadata (parent and child may both name it)", () => {
    const tree = validTree();
    const root = tree.root as Record<string, unknown>;
    (root.ontology as Record<string, unknown>).entities = [{ id: "customer" }, { id: "account" }];
    const relationship = {
      id: "customer-holds-account",
      from: "customer",
      to: "account",
      cardinality: "one-to-many",
    };
    (root.ontology as Record<string, unknown>).relationships = [relationship];
    root.children = [
      { id: "support.triage", title: "Triage", ontology: { relationships: [relationship] } },
    ];
    expect(validateWorkflowTreeDefinition(tree).ok).toBe(true);
  });

  it("resolves object types declared on an ancestor from a deeper step", () => {
    // Object types are tree-scoped: a leaf may link types its ancestor declared.
    const tree = validTree();
    const root = tree.root as Record<string, unknown>;
    (root.ontology as Record<string, unknown>).entities = [{ id: "customer" }, { id: "account" }];
    root.children = [
      {
        id: "support.triage",
        title: "Triage",
        ontology: {
          relationships: [{ id: "customer-holds-account", from: "customer", to: "account" }],
        },
      },
    ];
    expect(validateWorkflowTreeDefinition(tree).ok).toBe(true);
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
