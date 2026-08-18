import { describe, expect, it } from "vitest";
import { collectWorkflowTreeWarnings } from "./tree-warnings.js";
import type { WorkflowTreeDefinition } from "./types.js";

function tree(root: WorkflowTreeDefinition["root"], extra?: Partial<WorkflowTreeDefinition>) {
  return {
    schema: "clawworks.workflow-tree",
    schemaVersion: 1,
    id: "test.tree",
    version: "1.0.0",
    name: "Test",
    match: { triggers: ["user"] },
    root,
    ...extra,
  } as WorkflowTreeDefinition;
}

const WRITE_EFFECT = [{ entity: "order", kind: "update" as const }];

describe("collectWorkflowTreeWarnings", () => {
  it("flags a step that declares an action it can never invoke", () => {
    const warnings = collectWorkflowTreeWarnings(
      tree({
        id: "root",
        title: "Root",
        ontology: {
          allowedTools: ["message"],
          actions: [{ id: "handoff", effects: WRITE_EFFECT }],
        },
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe("node.root.ontology.actions");
    expect(warnings[0]?.message).toContain("invoke_action");
  });

  it("stays silent when the step grants invoke_action and the action writes", () => {
    expect(
      collectWorkflowTreeWarnings(
        tree({
          id: "root",
          title: "Root",
          ontology: {
            allowedTools: ["invoke_action"],
            actions: [{ id: "refund", effects: WRITE_EFFECT }],
          },
        }),
      ),
    ).toEqual([]);
  });

  it("flags a leaf whose ANCESTOR narrows invoke_action away", () => {
    // The gate intersects allow-lists across the whole root→step path, so a leaf
    // that grants the tool is still closed by an ancestor that does not. A check
    // that only read the leaf would call this tree healthy.
    const warnings = collectWorkflowTreeWarnings(
      tree({
        id: "root",
        title: "Root",
        ontology: { allowedTools: ["message", "search_objects"] },
        children: [
          {
            id: "root.leaf",
            title: "Leaf",
            ontology: {
              allowedTools: ["invoke_action"],
              actions: [{ id: "settle", effects: WRITE_EFFECT }],
            },
          },
        ],
      }),
    );
    expect(warnings.map((w) => w.path)).toEqual(["node.root.leaf.ontology.actions"]);
  });

  it("lets an unnarrowed ancestor pass the leaf's own grant through", () => {
    expect(
      collectWorkflowTreeWarnings(
        tree({
          id: "root",
          title: "Root",
          ontology: { contextHints: ["no tool list here"] },
          children: [
            {
              id: "root.leaf",
              title: "Leaf",
              ontology: {
                allowedTools: ["invoke_action"],
                actions: [{ id: "settle", effects: WRITE_EFFECT }],
              },
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("flags an action that declares no write effects", () => {
    // invoke_action refuses it outright, so it can only ever be an instruction
    // the model cannot carry out.
    const warnings = collectWorkflowTreeWarnings(
      tree({
        id: "root",
        title: "Root",
        ontology: {
          allowedTools: ["invoke_action"],
          actions: [{ id: "classify", tools: ["memory_search"] }],
        },
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe("node.root.ontology.actions.classify.effects");
    expect(warnings[0]?.message).toContain("no write effects");
  });

  it("treats a read-only effect list as no write effects", () => {
    const warnings = collectWorkflowTreeWarnings(
      tree({
        id: "root",
        title: "Root",
        ontology: {
          allowedTools: ["invoke_action"],
          actions: [{ id: "look", effects: [{ entity: "order", kind: "read" }] }],
        },
      }),
    );
    expect(warnings.map((w) => w.path)).toEqual(["node.root.ontology.actions.look.effects"]);
  });

  it("flags a knowledge foundation the step cannot search", () => {
    const warnings = collectWorkflowTreeWarnings(
      tree({
        id: "root",
        title: "Root",
        ontology: { allowedTools: ["message"], knowledgeFoundations: ["acme.handbook"] },
      }),
    );
    expect(warnings.map((w) => w.path)).toEqual(["node.root.ontology.knowledgeFoundations"]);
  });

  it("an ontology write always needs an explicit opt-in, explicit grants or not", () => {
    // Not a capabilityGrants question: activePathAllowsWrites (runtime.ts) demands
    // a literal invoke_action / group:enterprise-write somewhere on the path in
    // EVERY mode, so a tree that narrows nothing still cannot write.
    const root = {
      id: "root",
      title: "Root",
      ontology: { actions: [{ id: "settle", effects: WRITE_EFFECT }] },
    };
    expect(collectWorkflowTreeWarnings(tree(root)).map((w) => w.path)).toEqual([
      "node.root.ontology.actions",
    ]);
    expect(
      collectWorkflowTreeWarnings(tree(root, { capabilityGrants: "explicit" })).map((w) => w.path),
    ).toEqual(["node.root.ontology.actions"]);
  });

  it("flags a create action that cannot name the object it creates", () => {
    const warnings = collectWorkflowTreeWarnings(
      tree({
        id: "root",
        title: "Root",
        ontology: {
          entities: [
            {
              id: "refund",
              properties: [
                { id: "id", type: "id", primaryKey: true },
                { id: "amount", type: "number" },
              ],
            },
          ],
          allowedTools: ["invoke_action"],
          actions: [
            {
              id: "issue-refund",
              parameters: [{ id: "amount", type: "number", required: true }],
              effects: [{ entity: "refund", kind: "create" }],
            },
          ],
        },
      }),
    );
    expect(warnings.map((w) => w.path)).toEqual([
      "node.root.ontology.actions.issue-refund.parameters",
    ]);
    expect(warnings[0]?.message).toContain('"id" parameter');
  });

  it("accepts a create action that takes the primary key, declared by an ancestor", () => {
    // Entities are declared by the domain that owns them, so the key a leaf's
    // action needs usually comes from an ancestor's scope, not its own.
    expect(
      collectWorkflowTreeWarnings(
        tree({
          id: "root",
          title: "Root",
          ontology: {
            entities: [
              { id: "refund", properties: [{ id: "refund-id", type: "id", primaryKey: true }] },
            ],
          },
          children: [
            {
              id: "root.settle",
              title: "Settle",
              ontology: {
                allowedTools: ["invoke_action"],
                actions: [
                  {
                    id: "issue-refund",
                    parameters: [{ id: "refund-id", type: "id", required: true }],
                    effects: [{ entity: "refund", kind: "create" }],
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("rejects a glob for the write opt-in, which is literal set membership", () => {
    // `invoke_*` satisfies the ordinary tool gate, but ONTOLOGY_WRITE_OPT_INS is
    // a Set lookup (runtime.ts), so the runtime still refuses the write.
    // Blessing the glob here would certify an action that can never run.
    const warnings = collectWorkflowTreeWarnings(
      tree({
        id: "root",
        title: "Root",
        ontology: {
          allowedTools: ["invoke_*"],
          actions: [{ id: "settle", effects: WRITE_EFFECT }],
        },
      }),
    );
    expect(warnings.map((w) => w.path)).toEqual(["node.root.ontology.actions"]);
  });

  it("accepts group:enterprise-write as the opt-in", () => {
    expect(
      collectWorkflowTreeWarnings(
        tree({
          id: "root",
          title: "Root",
          ontology: {
            allowedTools: ["group:enterprise-write"],
            actions: [{ id: "settle", effects: WRITE_EFFECT }],
          },
        }),
      ),
    ).toEqual([]);
  });

  it("does not warn when a DESCENDANT leaf supplies the write opt-in", () => {
    // Declarations inherit down and runs execute on leaves, so an action on an
    // interior node is reachable from any leaf beneath it that opts in. Judging
    // the declaring node's own path alone reported working work-maps as broken.
    expect(
      collectWorkflowTreeWarnings(
        tree(
          {
            id: "orders",
            title: "Orders",
            ontology: {
              entities: [{ id: "order", properties: [{ id: "id", type: "id", primaryKey: true }] }],
              actions: [
                {
                  id: "create-order",
                  parameters: [{ id: "id", type: "id", required: true }],
                  effects: [{ entity: "order", kind: "create" }],
                },
              ],
            },
            children: [
              {
                id: "orders.create",
                title: "Create",
                ontology: { allowedTools: ["invoke_action"] },
              },
            ],
          },
          { capabilityGrants: "explicit" },
        ),
      ),
    ).toEqual([]);
  });

  it("warns when NO leaf beneath the declaring node opts in", () => {
    const warnings = collectWorkflowTreeWarnings(
      tree({
        id: "orders",
        title: "Orders",
        ontology: {
          entities: [{ id: "order", properties: [{ id: "id", type: "id", primaryKey: true }] }],
          actions: [
            {
              id: "create-order",
              parameters: [{ id: "id", type: "id", required: true }],
              effects: [{ entity: "order", kind: "create" }],
            },
          ],
        },
        children: [
          { id: "orders.read", title: "Read", ontology: { allowedTools: ["search_objects"] } },
        ],
      }),
    );
    expect(warnings.map((w) => w.path)).toEqual(["node.orders.ontology.actions"]);
  });

  it("warns when a denial takes the write opt-in back", () => {
    // PASS 1 outranks every allow, so naming the tool and denying it is still dead.
    const warnings = collectWorkflowTreeWarnings(
      tree({
        id: "root",
        title: "Root",
        ontology: {
          allowedTools: ["invoke_action"],
          deniedTools: ["invoke_action"],
          actions: [{ id: "settle", effects: WRITE_EFFECT }],
        },
      }),
    );
    expect(warnings.map((w) => w.path)).toEqual(["node.root.ontology.actions"]);
  });

  it("demands the primary key for update and delete, not only create", () => {
    // planEffect resolves the target's primary key before it branches on kind,
    // so an update or a delete without it fails exactly as a create does.
    for (const kind of ["update", "delete"] as const) {
      const warnings = collectWorkflowTreeWarnings(
        tree({
          id: "root",
          title: "Root",
          ontology: {
            entities: [
              { id: "claim", properties: [{ id: "claim-id", type: "id", primaryKey: true }] },
            ],
            allowedTools: ["invoke_action"],
            actions: [
              {
                id: "touch",
                parameters: [{ id: "status", type: "string", required: true }],
                effects: [{ entity: "claim", kind }],
              },
            ],
          },
        }),
      );
      expect(warnings.map((w) => w.path)).toEqual(["node.root.ontology.actions.touch.parameters"]);
    }
  });

  it("warns when the written object type declares no primaryKey at all", () => {
    const warnings = collectWorkflowTreeWarnings(
      tree({
        id: "root",
        title: "Root",
        ontology: {
          entities: [{ id: "note", properties: [{ id: "body", type: "string" }] }],
          allowedTools: ["invoke_action"],
          actions: [{ id: "jot", effects: [{ entity: "note", kind: "create" }] }],
        },
      }),
    );
    expect(warnings.map((w) => w.path)).toEqual(["node.root.ontology.actions.jot.effects"]);
  });
});
