import { describe, expect, it } from "vitest";
import { layoutWorkflowTree, type WorkflowTreeNode } from "./workflow-tree-graph.ts";

function node(id: string, parentId: string | null, depth: number, title = id): WorkflowTreeNode {
  return { id, parentId, depth, title, ontology: {} };
}

/** The example shape: a root with three leaf steps under it. */
const TREE: WorkflowTreeNode[] = [
  node("incident", null, 0),
  node("incident.triage", "incident", 1),
  node("incident.diagnose", "incident", 1),
  node("incident.remediate", "incident", 1),
];

describe("layoutWorkflowTree", () => {
  it("places each depth on its own row", () => {
    const { placed } = layoutWorkflowTree(TREE);
    const byId = new Map(placed.map((entry) => [entry.id, entry]));
    const root = byId.get("incident");
    const leaves = ["incident.triage", "incident.diagnose", "incident.remediate"].map((id) =>
      byId.get(id),
    );
    expect(root?.y).toBe(0);
    for (const leaf of leaves) {
      expect(leaf?.y).toBeGreaterThan(root?.y ?? 0);
    }
    // All siblings share a row.
    expect(new Set(leaves.map((leaf) => leaf?.y)).size).toBe(1);
  });

  it("centres a parent over its children", () => {
    const { placed } = layoutWorkflowTree(TREE);
    const byId = new Map(placed.map((entry) => [entry.id, entry]));
    const first = byId.get("incident.triage")?.x ?? 0;
    const last = byId.get("incident.remediate")?.x ?? 0;
    expect(byId.get("incident")?.x).toBeCloseTo((first + last) / 2);
  });

  it("never overlaps siblings, however deep the tree nests", () => {
    // A deeper, uneven tree: leaf packing must still keep every row disjoint.
    const deep: WorkflowTreeNode[] = [
      node("r", null, 0),
      node("r.a", "r", 1),
      node("r.a.1", "r.a", 2),
      node("r.a.2", "r.a", 2),
      node("r.b", "r", 1),
      node("r.b.1", "r.b", 2),
      node("r.b.1.x", "r.b.1", 3),
      node("r.b.1.y", "r.b.1", 3),
      node("r.c", "r", 1),
    ];
    const { placed } = layoutWorkflowTree(deep);
    const rows = new Map<number, number[]>();
    for (const entry of placed) {
      const row = rows.get(entry.y) ?? [];
      row.push(entry.x);
      rows.set(entry.y, row);
    }
    for (const xs of rows.values()) {
      const sorted = xs.toSorted((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        // Node boxes are 196 wide; any gap below that would visually collide.
        expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(196);
      }
    }
  });

  it("sizes the canvas from the leaf count and the deepest row", () => {
    const { width, height } = layoutWorkflowTree(TREE);
    // Three leaves side by side, two rows deep.
    expect(width).toBeGreaterThan(196 * 3);
    expect(height).toBeGreaterThan(62 * 2);
  });

  it("still lays out nodes when no explicit root row is present", () => {
    // Defensive: a projection that drops the root must not render an empty tree.
    const orphaned: WorkflowTreeNode[] = [node("a.1", "missing", 1), node("a.2", "missing", 1)];
    const { placed } = layoutWorkflowTree(orphaned);
    expect(placed).toHaveLength(2);
    expect(placed[0].x).not.toBe(placed[1].x);
  });

  it("places a rootless subtree exactly once (no duplicate boxes)", () => {
    // A rootless orphan that itself has children: seeding from every node would
    // place the child twice — once by recursion, once as its own seed.
    const orphaned: WorkflowTreeNode[] = [
      node("x", "missing", 1),
      node("x.1", "x", 2),
      node("x.2", "x", 2),
    ];
    const { placed } = layoutWorkflowTree(orphaned);
    expect(placed.map((entry) => entry.id).toSorted()).toEqual(["x", "x.1", "x.2"]);
  });

  it("terminates on a cyclic definition instead of recursing forever", () => {
    // Malformed input (a → b → a) must not hang the Control UI.
    const cyclic: WorkflowTreeNode[] = [
      node("a", null, 0),
      node("b", "a", 1),
      node("a-again", "b", 2),
    ];
    // Re-point the deepest node's child back at the root to close the loop.
    const looped: WorkflowTreeNode[] = [...cyclic, { ...node("a", "a-again", 3) }];
    const { placed } = layoutWorkflowTree(looped);
    const ids = placed.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
