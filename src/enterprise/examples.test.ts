import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlanCandidateDigest } from "@openclaw/enterprise-planner";
import { describe, expect, it } from "vitest";
import { parseWorkflowBundleContent } from "./bundle-io.js";
import { parseWorkflowTreeContent } from "./tree-io.js";
import { collectWorkflowTreeWarnings } from "./tree-warnings.js";
import type { WorkflowNodeDefinition, WorkflowTreeDefinition } from "./types.js";

/**
 * `examples/enterprise/` ships ONE work-map on purpose.
 *
 * There used to be six, each demonstrating a single axis with the others switched
 * off, and the combination an operator actually deploys — thirty steps, four MCP
 * servers, six corpora and nine ontology writes constraining each other at once —
 * was the one shape none of them had. These tests hold the surviving example to
 * that bar: scale, per-domain ontology scoping, deny-by-default grants, and a
 * self-contained import.
 */
const EXAMPLES_DIR = join(process.cwd(), "examples", "enterprise");
const EXAMPLE_FILE = "financial-operations.clawworks-bundle.yaml";
const TREE_ID = "acme.financial-operations";

/** Every MCP server the example attaches, and the ONLY steps allowed to reach it. */
const MCP_ATTACHMENTS: Record<string, string[]> = {
  "acme-screening": [
    "finops.customer.onboarding.kyc-review.screening",
    "finops.risk.monitoring.investigation.link-analysis",
  ],
  "acme-tracker": ["finops.customer.servicing.dispute", "finops.claims.intake.escalation"],
  "acme-ledger": ["finops.claims.settlement.payment"],
  "acme-filing": ["finops.reporting.regulatory.submission"],
};

/** Every corpus, and the domain roots that may grant it. A corpus is not owned by one domain. */
const KNOWLEDGE_REACH: Record<string, string[]> = {
  "acme.kyc-manual": ["finops.customer"],
  "acme.aml-policy": ["finops.risk", "finops.reporting"],
  "acme.claims-handbook": ["finops.claims"],
  "acme.credit-policy": ["finops.risk"],
  "acme.regulatory-code": ["finops.reporting"],
  "acme.privacy-standard": ["finops.customer", "finops.risk", "finops.claims"],
};

function parseExample(): WorkflowTreeDefinition {
  const parsed = parseWorkflowBundleContent(
    readFileSync(join(EXAMPLES_DIR, EXAMPLE_FILE), "utf8"),
    "yaml",
  );
  if (!parsed.ok) {
    throw new Error(
      `${EXAMPLE_FILE} failed to validate: ${JSON.stringify(parsed.issues, null, 2)}`,
    );
  }
  const tree = parsed.bundle.trees[0];
  if (!tree) {
    throw new Error(`${EXAMPLE_FILE} carries no tree`);
  }
  return tree;
}

function parseBundle() {
  const parsed = parseWorkflowBundleContent(
    readFileSync(join(EXAMPLES_DIR, EXAMPLE_FILE), "utf8"),
    "yaml",
  );
  if (!parsed.ok) {
    throw new Error(
      `${EXAMPLE_FILE} failed to validate: ${JSON.stringify(parsed.issues, null, 2)}`,
    );
  }
  return parsed.bundle;
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

/** Root→node id path, so a check can ask which domain a step sits under. */
function pathsByNode(root: WorkflowNodeDefinition): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  const visit = (node: WorkflowNodeDefinition, ancestors: string[]): void => {
    const path = [...ancestors, node.id];
    paths.set(node.id, path);
    for (const child of node.children ?? []) {
      visit(child, path);
    }
  };
  visit(root, []);
  return paths;
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

describe("the shipped enterprise example", () => {
  it("is the only one, and it validates", () => {
    // One example, deliberately. A second file here means somebody added an axis
    // demo beside the work-map that already carries every axis — fold it in.
    expect(readdirSync(EXAMPLES_DIR).filter((file) => file.endsWith(".yaml"))).toEqual([
      EXAMPLE_FILE,
    ]);
    expect(parseExample().id).toBe(TREE_ID);
  });

  it("never declares a capability its own tool scope cannot reach", () => {
    // Regression, and a large one: 31 of the 32 actions across the old examples were
    // unreachable. Every step declared them, the digest handed them to the model,
    // and the gate refused every call — "does not allow ontology writes; a step
    // must name invoke_action in its allowedTools". A live run answered by
    // INVENTING an incident id, because the action that would have created one was
    // advertised and then denied. Import-time schema validation could not see it:
    // the tree is shape-valid, just unable to do what it says.
    expect(collectWorkflowTreeWarnings(parseExample())).toEqual([]);
  });

  it("imports self-contained: every corpus inlined, every skill bundled here", () => {
    // A tree cannot carry knowledge, so an example that names a foundation it does
    // not inline retrieves nothing on the recipient's deployment, and a skill id no
    // install provides is a dependency nobody can resolve. Both failures read to an
    // operator as the enterprise layer being broken.
    const bundle = parseBundle();
    const nodes = bundle.trees.flatMap((tree) => flatten(tree.root));

    const referenced = new Set(nodes.flatMap((node) => node.ontology?.knowledgeFoundations ?? []));
    expect(bundle.knowledgeFoundations.map((foundation) => foundation.id).toSorted()).toEqual(
      [...referenced].toSorted(),
    );
    for (const foundation of bundle.knowledgeFoundations) {
      expect(foundation.snippets.length, `${foundation.id} has no content`).toBeGreaterThan(0);
    }

    // Bundled here AND needing no external binary. A skill whose `requires.bins`
    // is missing on the host is filtered out of the run, so an example that
    // declares one has its skills axis inert on exactly the machines it is meant
    // to demonstrate on — which is how `summarize` sat in five shipped examples
    // while resolving on almost none of them.
    const declared = [...new Set(nodes.flatMap((node) => node.ontology?.skills ?? []))];
    expect(declared.length).toBeGreaterThan(0);
    expect(
      declared.toSorted().map((name) => {
        const file = join(process.cwd(), "skills", name, "SKILL.md");
        if (!existsSync(file)) {
          return `MISSING:${name}`;
        }
        return /"bins"\s*:\s*\[[^\]]/.test(readFileSync(file, "utf8")) ? `NEEDS-BIN:${name}` : name;
      }),
    ).toEqual(["taskflow", "taskflow-inbox-triage"]);

    // The servers are the one thing a bundle cannot carry — transport and
    // credentials are deployment configuration — so the manifest has to name them.
    expect([...(bundle.requiredMcpServers ?? [])].toSorted()).toEqual(
      Object.keys(MCP_ATTACHMENTS).toSorted(),
    );
  });

  it("keeps its whole routing description inside the planner's digest budget", () => {
    // Since keywords retired, the tree description IS the routing signal, and the
    // candidate digest truncates it. Authors write the summary first and the
    // DOMAIN CUE last — the clause naming which requests belong here — so a
    // description over budget loses exactly the half that decides routing, and a
    // governed request escapes into the permissive default tree. Assert against
    // the real digest rather than a character count, so the budget can move
    // without this silently going stale.
    // Node lines in the ROUTE digest are truncated on purpose and are not what
    // this guards; only the tree line decides whether a request enters at all.
    const tree = parseExample();
    expect(buildPlanCandidateDigest([tree])).toContain(tree.description);
  });

  it("stays at route-finding scale", () => {
    // This fixture exists to make route selection a real problem: a shallow or
    // small tree would let any planner look correct. Guard the scale so a future
    // edit cannot quietly shrink it back into a toy.
    const tree = parseExample();
    const { count, maxDepth } = walk(tree.root, 0);
    expect(count).toBeGreaterThanOrEqual(40);
    expect(maxDepth).toBeGreaterThanOrEqual(5);
    // The four top-level domains are what make cross-domain confusion possible.
    expect(tree.root.children).toHaveLength(4);
    // And the confusable pairs the tree was built around: a planner that cannot
    // tell these apart drags a whole domain into the run.
    const ids = new Set(flatten(tree.root).map((node) => node.id));
    for (const [a, b] of [
      ["finops.risk.monitoring.alert-triage", "finops.claims.intake.triage"],
      ["finops.risk.underwriting.decision", "finops.claims.adjudication.decision"],
      ["finops.risk.monitoring.investigation", "finops.claims.adjudication.fraud-review"],
      ["finops.risk.monitoring.sar-filing", "finops.reporting.regulatory.submission"],
      ["finops.customer.onboarding.risk-rating", "finops.risk.underwriting.scoring"],
      ["finops.customer.servicing.dispute", "finops.claims.intake.escalation"],
    ]) {
      expect(ids, `${a} is missing`).toContain(a);
      expect(ids, `${b} is missing`).toContain(b);
    }
  });

  it("declares a Palantir-style ontology: typed properties, link cardinality, action effects", () => {
    const tree = parseExample();
    // Object types are declared by the domain that owns them, not at the root,
    // so look tree-wide rather than at root.ontology.
    const nodes = flatten(tree.root);
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
    const tree = parseExample();
    const scopes = scopesByNode(tree.root);
    const signatures = new Set(
      [...scopes.values()].map((scope) =>
        JSON.stringify([[...scope.entities].toSorted(), [...scope.relationships].toSorted()]),
      ),
    );
    expect(signatures.size).toBeGreaterThanOrEqual(5);

    // The root declares no object types: one that lived here would be addressable
    // from all 30 steps, which is the collapse this test guards.
    expect(tree.root.ontology?.entities ?? []).toHaveLength(0);
    expect(tree.root.ontology?.relationships ?? []).toHaveLength(0);
  });

  it("keeps sibling domains unable to address each other's object types", () => {
    const scopes = scopesByNode(parseExample().root);
    // Each case is a confusable pair the tree was built around: the step must
    // reach its own types and must NOT reach the sibling's.
    const cases = [
      {
        node: "finops.claims.settlement.payment",
        reaches: ["payment", "claim", "policy"],
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
        blocked: ["claim", "payment", "sar", "alert"],
      },
      {
        node: "finops.customer.onboarding.account-opening",
        reaches: ["account", "customer", "document"],
        blocked: ["claim", "alert", "payment"],
      },
      {
        node: "finops.reporting.regulatory.submission",
        reaches: ["regulatory-report", "sar"],
        blocked: ["payment", "policy", "credit-report"],
      },
      // Same domain, one branch apart: monitoring cannot see underwriting's bureau data.
      {
        node: "finops.risk.monitoring.investigation.link-analysis",
        reaches: ["customer", "account", "transaction"],
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
    const tree = parseExample();
    const scopes = scopesByNode(tree.root);
    const unresolved: string[] = [];
    for (const node of flatten(tree.root)) {
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

  it("gives every step that writes a role prompt saying what to gather first", () => {
    // `guidance` is the one advisory field an operator types themselves, and the
    // write steps are where its absence costs most: the tool scope says the step
    // MAY call `invoke_action`, and nothing else tells the model which parameters
    // have to be real before it does. A writer without one is the example failing
    // to demonstrate the field on the steps that need it.
    const tree = parseExample();
    const writers = flatten(tree.root).filter((node) => node.ontology?.actions?.length);
    const unguided = writers.filter((node) => !node.ontology?.guidance).map((node) => node.id);
    expect(unguided).toEqual([]);
  });

  it("grants capabilities explicitly, and keeps the write opt-in off every ancestor", () => {
    const tree = parseExample();
    expect(tree.capabilityGrants).toBe("explicit");
    const nodes = flatten(tree.root);
    const writers = nodes.filter((node) => node.ontology?.actions?.length);
    expect(writers.length).toBeGreaterThanOrEqual(5);

    // `invoke_action` is EXISTENTIAL over the root→step path
    // (runtime.ts explicitlyAllowsOntologyWrites), so naming it on an interior
    // node hands write consent to every step beneath it. Only leaves may.
    const interiorWriters = nodes
      .filter((node) => node.children?.length)
      .filter((node) => (node.ontology?.allowedTools ?? []).includes("invoke_action"))
      .map((node) => node.id);
    expect(interiorWriters).toEqual([]);
    // And every step that declares an action opts in LITERALLY: a glob such as
    // `invoke_*` satisfies the ordinary tool gate and is still refused as a write.
    for (const node of writers) {
      expect(
        node.ontology?.allowedTools ?? [],
        `${node.id} declares an action without naming invoke_action`,
      ).toContain("invoke_action");
    }
  });

  it("attaches each MCP server to exactly the steps meant to reach it", () => {
    // MCP is the one family that denies by default, so an attachment is the whole
    // grant. A stray one is not a style problem: it hands a step the ledger, the
    // screening provider, or the regulator's portal.
    const nodes = flatten(parseExample().root);
    const attached = new Map<string, string[]>();
    for (const node of nodes) {
      for (const server of node.ontology?.mcpServers ?? []) {
        attached.set(server, [...(attached.get(server) ?? []), node.id]);
      }
    }
    expect([...attached.keys()].toSorted()).toEqual(Object.keys(MCP_ATTACHMENTS).toSorted());
    for (const [server, steps] of Object.entries(MCP_ATTACHMENTS)) {
      expect(attached.get(server)?.toSorted(), `${server} is attached elsewhere`).toEqual(
        steps.toSorted(),
      );
    }

    // Every attaching step also names the server's tools in all four spellings. The
    // attachment alone is enough for the embedded runtime, which reads each tool's
    // registration; a native harness (Codex, the Claude CLI) reports a tool call
    // with no MCP origin, so there the call is judged as an ordinary tool and the
    // globs are what admit it. OpenClaw maps punctuation to `-`, Codex to `_`, and
    // either may carry the `mcp__` prefix.
    for (const node of nodes) {
      for (const server of node.ontology?.mcpServers ?? []) {
        const folded = server.replaceAll("-", "_");
        for (const glob of [
          `${server}__*`,
          `mcp__${server}__*`,
          `${folded}__*`,
          `mcp__${folded}__*`,
        ]) {
          expect(
            node.ontology?.allowedTools ?? [],
            `${node.id} attaches ${server} but a native harness could not call it`,
          ).toContain(glob);
        }
      }
    }
  });

  it("scopes each corpus to the domains that may query it", () => {
    // Knowledge narrows the same way tools do: each node with a non-empty list is
    // an independent gate, so a corpus is reachable only where some node on the
    // path names it and no node on the path drops it. A corpus granted at the root
    // would be queryable from all 30 steps, which is what this guards.
    const tree = parseExample();
    expect(tree.root.ontology?.knowledgeFoundations ?? []).toHaveLength(0);
    const paths = pathsByNode(tree.root);
    const byId = new Map(flatten(tree.root).map((node) => [node.id, node]));
    const granting = new Map<string, Set<string>>();
    for (const [nodeId, path] of paths) {
      for (const foundation of byId.get(nodeId)?.ontology?.knowledgeFoundations ?? []) {
        // Attribute the grant to the DOMAIN it sits under, which is what the
        // isolation claim is actually about.
        const domain = path[1] ?? nodeId;
        granting.set(foundation, (granting.get(foundation) ?? new Set()).add(domain));
      }
    }
    expect([...granting.keys()].toSorted()).toEqual(Object.keys(KNOWLEDGE_REACH).toSorted());
    for (const [foundation, domains] of Object.entries(KNOWLEDGE_REACH)) {
      expect([...(granting.get(foundation) ?? [])].toSorted(), `${foundation} reach`).toEqual(
        domains.toSorted(),
      );
    }

    // A step that narrows can only ever be a SUBSET of what its ancestors grant:
    // adding an id an ancestor does not name makes it unqueryable, so the
    // declaration reads as a grant and behaves as nothing.
    const unreachable: string[] = [];
    const visit = (node: WorkflowNodeDefinition, inherited: string[] | null): void => {
      const declared = node.ontology?.knowledgeFoundations ?? [];
      if (inherited && declared.some((id) => !inherited.includes(id))) {
        unreachable.push(node.id);
      }
      const next = declared.length ? declared : inherited;
      for (const child of node.children ?? []) {
        visit(child, next);
      }
    };
    visit(tree.root, null);
    expect(unreachable).toEqual([]);
  });
});

/**
 * The tutorial ships a second work-map, under `examples/enterprise/tutorial/`.
 * It is not another axis demo — the guard above still holds for the directory
 * that carries the shipped example. This one is the answer key readers compare
 * their Control UI work against in
 * docs/concepts/clawworks-enterprise-tutorial.md, so a definition that stopped
 * importing would read to them as the enterprise layer being broken.
 */
describe("the tutorial work-map", () => {
  const TUTORIAL_FILE = join(EXAMPLES_DIR, "tutorial", "acme-returns.worktree.yaml");

  it("imports, and declares nothing its own scope cannot reach", () => {
    const parsed = parseWorkflowTreeContent(readFileSync(TUTORIAL_FILE, "utf8"), "yaml");
    if (!parsed.ok) {
      throw new Error(
        `acme-returns.worktree.yaml failed to validate: ${JSON.stringify(parsed.issues, null, 2)}`,
      );
    }
    expect(parsed.tree.id).toBe("acme.returns");
    expect(collectWorkflowTreeWarnings(parsed.tree)).toEqual([]);
  });

  it("keeps the bindings the tutorial teaches", () => {
    const parsed = parseWorkflowTreeContent(readFileSync(TUTORIAL_FILE, "utf8"), "yaml");
    if (!parsed.ok) {
      throw new Error("acme-returns.worktree.yaml failed to validate");
    }
    const root = parsed.tree.root;
    // The denial is the lesson: a tool left out only asks, so the three the
    // tutorial promises are refused everywhere have to be named here.
    expect(root.ontology?.deniedTools).toEqual(["exec", "write", "edit"]);
    const steps = new Map((root.children ?? []).map((child) => [child.id, child]));
    expect([...steps.keys()]).toEqual(["returns.triage", "returns.lookup", "returns.decide"]);
    expect(steps.get("returns.triage")?.ontology?.knowledgeFoundations).toEqual([
      "acme.returns-kb",
    ]);
    expect(steps.get("returns.lookup")?.ontology?.mcpServers).toEqual(["acme-tracker"]);
    expect(steps.get("returns.decide")?.ontology?.skills).toEqual(["refund-reply"]);
    // Fewer than five nodes is never route-planned, which is what makes the
    // tutorial's traces predictable: every run walks all three steps in order.
    expect(walk(root, 1).count).toBeLessThan(5);
  });
});
