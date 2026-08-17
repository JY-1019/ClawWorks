import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkflowBundleContent } from "./bundle-io.js";
import { parseWorkflowTreeContent } from "./tree-io.js";
import { collectWorkflowTreeWarnings } from "./tree-warnings.js";
import type { WorkflowNodeDefinition } from "./types.js";

const EXAMPLES_DIR = join(process.cwd(), "examples", "enterprise");
const BUNDLE_SUFFIX = "-bundle.yaml";

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

function flatten(node: WorkflowNodeDefinition): WorkflowNodeDefinition[] {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

type NodeScope = { entities: Set<string>; relationships: Set<string> };

/**
 * The object + link types each node can actually address: its own declarations
 * merged with every ancestor's, which is how governance merges the root→node
 * path (src/enterprise/governance.ts) and what the Control UI node inspector
 * renders (collectNodeOntologyGraph). Declaring a type at the root therefore
 * puts it on EVERY node's scope, which is what these tests exist to catch.
 */
function scopesByNode(root: WorkflowNodeDefinition): Map<string, NodeScope> {
  const scopes = new Map<string, NodeScope>();
  const visit = (node: WorkflowNodeDefinition, inherited: NodeScope): void => {
    const scope: NodeScope = {
      entities: new Set(inherited.entities),
      relationships: new Set(inherited.relationships),
    };
    for (const entity of node.ontology?.entities ?? []) {
      scope.entities.add(entity.id);
    }
    for (const relationship of node.ontology?.relationships ?? []) {
      scope.relationships.add(relationship.id);
    }
    scopes.set(node.id, scope);
    for (const child of node.children ?? []) {
      visit(child, scope);
    }
  };
  visit(root, { entities: new Set(), relationships: new Set() });
  return scopes;
}

describe("shipped enterprise example trees", () => {
  it("every example under examples/enterprise validates", () => {
    const files = exampleFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(join(EXAMPLES_DIR, file), "utf8");
      // A bundle is a tree PLUS its inlined knowledge, so it needs the bundle
      // schema. Route on the filename suffix rather than skipping unknown
      // shapes: a mis-named bundle then fails this test loudly instead of
      // going unvalidated.
      const result = file.endsWith(BUNDLE_SUFFIX)
        ? parseWorkflowBundleContent(content, "yaml")
        : parseWorkflowTreeContent(content, "yaml");
      if (!result.ok) {
        throw new Error(`${file} failed to validate: ${JSON.stringify(result.issues, null, 2)}`);
      }
      expect(result.ok).toBe(true);
    }
  });

  it("never ships a step that declares a capability its tool scope cannot reach", () => {
    // Regression, and a large one: 31 of the 32 actions across these examples were
    // unreachable. Every step declared them, the digest handed them to the model,
    // and the gate refused every call — "does not allow ontology writes; a step
    // must name invoke_action in its allowedTools". A live run on the incident
    // example answered by INVENTING an incident id, because the action that would
    // have created one was advertised but denied. Import-time schema validation
    // could not see it: each tree is shape-valid, just unable to do what it says.
    const offenders: string[] = [];
    for (const file of exampleFiles()) {
      const content = readFileSync(join(EXAMPLES_DIR, file), "utf8");
      const trees = file.endsWith(BUNDLE_SUFFIX)
        ? (() => {
            const parsed = parseWorkflowBundleContent(content, "yaml");
            return parsed.ok ? parsed.bundle.trees : [];
          })()
        : (() => {
            const parsed = parseWorkflowTreeContent(content, "yaml");
            return parsed.ok ? [parsed.tree] : [];
          })();
      for (const tree of trees) {
        for (const warning of collectWorkflowTreeWarnings(tree)) {
          offenders.push(`${file}: ${warning.path} — ${warning.message}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("ships a bundle whose tools, skills, and knowledge all resolve on a stock install", () => {
    // The tree examples declare all three axes but none of them runs as shipped:
    // a tree cannot carry knowledge, and the skills they name are ids no install
    // provides. This bundle is the one an operator can import and actually run,
    // so guard each axis — an example that quietly goes inert reads to an
    // operator as the enterprise layer being broken.
    const bundles = exampleFiles().filter((file) => file.endsWith(BUNDLE_SUFFIX));
    expect(bundles.length).toBeGreaterThan(0);
    for (const file of bundles) {
      const parsed = parseWorkflowBundleContent(
        readFileSync(join(EXAMPLES_DIR, file), "utf8"),
        "yaml",
      );
      if (!parsed.ok) {
        throw new Error(`${file} failed to validate: ${JSON.stringify(parsed.issues, null, 2)}`);
      }
      const bundle = parsed.bundle;
      const nodes = bundle.trees.flatMap((tree) => flatten(tree.root));

      // Tools: at least one step narrows scope rather than inheriting allow-all.
      expect(nodes.some((node) => node.ontology?.allowedTools?.length)).toBe(true);

      // Knowledge: referenced AND inlined with content, so `knowledge_search`
      // returns snippets right after import instead of silently finding nothing.
      const referenced = new Set(
        nodes.flatMap((node) => node.ontology?.knowledgeFoundations ?? []),
      );
      expect(referenced.size).toBeGreaterThan(0);
      for (const foundation of bundle.knowledgeFoundations) {
        expect(referenced, `${file} inlines an unreferenced foundation`).toContain(foundation.id);
        expect(
          foundation.snippets.length,
          `${file}: ${foundation.id} has no content`,
        ).toBeGreaterThan(0);
      }
      expect(
        bundle.knowledgeFoundations.map((foundation) => foundation.id).toSorted(),
        `${file} references a foundation it does not inline`,
      ).toEqual([...referenced].toSorted());

      // Skills: every declared name must be a skill this repo actually bundles,
      // or the dependency is unresolvable for anyone who imports the example.
      const declared = nodes.flatMap((node) => node.ontology?.skills ?? []);
      expect(declared.length).toBeGreaterThan(0);
      for (const name of declared) {
        expect(
          existsSync(join(process.cwd(), "skills", name, "SKILL.md")),
          `${file} declares skill "${name}", which this repo does not bundle`,
        ).toBe(true);
      }
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
    // Object types are declared by the domain that owns them, not at the root,
    // so look tree-wide rather than at root.ontology.
    const nodes = flatten(result.tree.root);
    const entities = nodes.flatMap((node) => node.ontology?.entities ?? []);
    const relationships = nodes.flatMap((node) => node.ontology?.relationships ?? []);
    const claim = entities.find((entity) => entity.id === "claim");
    expect(claim?.properties?.some((property) => property.primaryKey)).toBe(true);
    expect(relationships.length).toBeGreaterThan(0);
    expect(relationships.every((relationship) => relationship.cardinality)).toBe(true);

    // The money-movement step is the one governance must be able to gate, so its
    // action has to declare what it writes.
    const payment = nodes.find((node) => node.id === "finops.claims.settlement.payment");
    const issue = payment?.ontology?.actions?.find((action) => action.id === "issue-claim-payment");
    expect(issue?.effects).toEqual(
      expect.arrayContaining([expect.objectContaining({ entity: "payment", kind: "create" })]),
    );
    expect(issue?.preconditions?.length).toBeGreaterThan(0);
  });

  it("scopes the ontology per domain instead of hoisting it onto the root", () => {
    // Regression: every object type used to be declared on the root, so all 40
    // nodes resolved to one identical scope — the node inspector showed the same
    // graph everywhere and the documented sibling isolation was not demonstrated
    // at all (docs/concepts/clawworks-enterprise.md, "the typed object model").
    const content = readFileSync(join(EXAMPLES_DIR, "financial-operations.clawworks.yaml"), "utf8");
    const result = parseWorkflowTreeContent(content, "yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const scopes = scopesByNode(result.tree.root);
    const signatures = new Set(
      [...scopes.values()].map((scope) =>
        JSON.stringify([[...scope.entities].toSorted(), [...scope.relationships].toSorted()]),
      ),
    );
    expect(signatures.size).toBeGreaterThanOrEqual(5);

    // The root declares no object types: one that lived here would be addressable
    // from all 40 steps, which is the collapse this test guards.
    expect(result.tree.root.ontology?.entities ?? []).toHaveLength(0);
    expect(result.tree.root.ontology?.relationships ?? []).toHaveLength(0);
  });

  it("keeps sibling domains unable to address each other's object types", () => {
    const content = readFileSync(join(EXAMPLES_DIR, "financial-operations.clawworks.yaml"), "utf8");
    const result = parseWorkflowTreeContent(content, "yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const scopes = scopesByNode(result.tree.root);
    // Each case is a confusable pair the tree was built around: the step must
    // reach its own types and must NOT reach the sibling's.
    const cases = [
      {
        node: "finops.claims.settlement.payment",
        reaches: ["payment", "claim"],
        blocked: ["sar", "credit-report", "alert"],
      },
      {
        node: "finops.risk.monitoring.alert-triage",
        reaches: ["alert", "transaction"],
        blocked: ["payment", "claim", "policy"],
      },
      {
        node: "finops.risk.underwriting.scoring",
        reaches: ["credit-report", "customer"],
        blocked: ["claim", "payment", "sar"],
      },
      {
        node: "finops.customer.onboarding.account-opening",
        reaches: ["account", "customer"],
        blocked: ["claim", "alert", "payment"],
      },
      {
        node: "finops.reporting.regulatory",
        reaches: ["regulatory-report", "sar"],
        blocked: ["payment", "policy", "credit-report"],
      },
      // Same domain, one level apart: monitoring cannot see underwriting's bureau data.
      {
        node: "finops.risk.monitoring.investigation.link-analysis",
        reaches: ["customer", "account"],
        blocked: ["credit-report"],
      },
    ];
    for (const { node, reaches, blocked } of cases) {
      const scope = scopes.get(node);
      expect(scope, `${node} is missing from the tree`).toBeDefined();
      for (const entity of reaches) {
        expect([...(scope?.entities ?? [])], `${node} must reach ${entity}`).toContain(entity);
      }
      for (const entity of blocked) {
        expect([...(scope?.entities ?? [])], `${node} must NOT reach ${entity}`).not.toContain(
          entity,
        );
      }
    }
  });

  it("keeps every action effect inside the declaring node's own scope", () => {
    // The schema only checks that an effect's entity is declared SOMEWHERE in the
    // tree, so a mis-scoped action passes import and then cannot resolve its own
    // object type at runtime. This closes that gap for the shipped example.
    const content = readFileSync(join(EXAMPLES_DIR, "financial-operations.clawworks.yaml"), "utf8");
    const result = parseWorkflowTreeContent(content, "yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const scopes = scopesByNode(result.tree.root);
    const unresolved: string[] = [];
    for (const node of flatten(result.tree.root)) {
      const scope = scopes.get(node.id);
      for (const action of node.ontology?.actions ?? []) {
        for (const effect of action.effects ?? []) {
          if (!scope?.entities.has(effect.entity)) {
            unresolved.push(`${node.id} → ${action.id} → ${effect.entity}`);
          }
        }
      }
    }
    expect(unresolved).toEqual([]);
  });
});
