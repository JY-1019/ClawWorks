import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkflowTreeContent } from "./tree-io.js";
import type { WorkflowNodeDefinition } from "./types.js";

const EXAMPLES_DIR = join(process.cwd(), "examples", "enterprise");

function exampleFiles(): string[] {
  return readdirSync(EXAMPLES_DIR).filter((file) => file.endsWith(".yaml"));
}

function walk(node: WorkflowNodeDefinition, depth: number): { count: number; maxDepth: number } {
  let count = 1;
  let maxDepth = depth;
  for (const child of node.children ?? []) {
    const sub = walk(child, depth + 1);
    count += sub.count;
    maxDepth = Math.max(maxDepth, sub.maxDepth);
  }
  return { count, maxDepth };
}

describe("shipped enterprise example trees", () => {
  it("every example under examples/enterprise validates", () => {
    const files = exampleFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const result = parseWorkflowTreeContent(
        readFileSync(join(EXAMPLES_DIR, file), "utf8"),
        "yaml",
      );
      if (!result.ok) {
        throw new Error(`${file} failed to validate: ${JSON.stringify(result.issues, null, 2)}`);
      }
      expect(result.ok).toBe(true);
    }
  });

  it("keeps the financial-operations tree at route-finding scale", () => {
    // This fixture exists to make route selection a real problem: a shallow or
    // small tree would let any planner look correct. Guard the scale so a future
    // edit cannot quietly shrink it back into a toy.
    const content = readFileSync(join(EXAMPLES_DIR, "financial-operations.clawworks.yaml"), "utf8");
    const result = parseWorkflowTreeContent(content, "yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { count, maxDepth } = walk(result.tree.root, 0);
    expect(result.tree.id).toBe("acme.financial-operations");
    expect(count).toBeGreaterThanOrEqual(40);
    expect(maxDepth).toBeGreaterThanOrEqual(5);
    // The four top-level domains are what make cross-domain confusion possible.
    expect(result.tree.root.children).toHaveLength(4);
  });

  it("declares a Palantir-style ontology: typed object properties, link cardinality, action effects", () => {
    const content = readFileSync(join(EXAMPLES_DIR, "financial-operations.clawworks.yaml"), "utf8");
    const result = parseWorkflowTreeContent(content, "yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const ontology = result.tree.root.ontology;
    const claim = ontology?.entities?.find((entity) => entity.id === "claim");
    expect(claim?.properties?.some((property) => property.primaryKey)).toBe(true);
    expect(ontology?.relationships?.every((relationship) => relationship.cardinality)).toBe(true);

    // The money-movement step is the one governance must be able to gate, so its
    // action has to declare what it writes.
    const collectActions = (node: WorkflowNodeDefinition): WorkflowNodeDefinition[] => [
      node,
      ...(node.children ?? []).flatMap(collectActions),
    ];
    const payment = collectActions(result.tree.root).find(
      (node) => node.id === "finops.claims.settlement.payment",
    );
    const issue = payment?.ontology?.actions?.find((action) => action.id === "issue-claim-payment");
    expect(issue?.effects).toEqual(
      expect.arrayContaining([expect.objectContaining({ entity: "payment", kind: "create" })]),
    );
    expect(issue?.preconditions?.length).toBeGreaterThan(0);
  });
});
