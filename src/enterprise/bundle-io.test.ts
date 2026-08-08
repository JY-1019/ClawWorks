import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  exportWorkflowBundle,
  importWorkflowBundle,
  parseWorkflowBundleContent,
  serializeWorkflowBundle,
} from "./bundle-io.js";
import { listBundledKnowledgeFoundations } from "./enterprise-knowledge-store.sqlite.js";
import { resetPersistedBundleFoundationsForTest } from "./knowledge-bundle-loader.js";
import {
  clearBundleKnowledgeFoundations,
  clearEnterpriseKnowledgeFoundations,
  InMemoryKnowledgeFoundation,
  listEnterpriseKnowledgeFoundationDescriptors,
  listEnterpriseKnowledgeFoundationIds,
  registerBundleKnowledgeFoundation,
  registerEnterpriseKnowledgeFoundation,
} from "./knowledge.js";
import { importWorkflowTreeContent, removeImportedWorkflowTree } from "./tree-io.js";
import { treeHasUnboundedKnowledgeScope } from "./tree-references.js";
import { getWorkflowTreeRegistryEntry } from "./tree-registry.js";
import { deleteEnterpriseWorkflowTree, upsertEnterpriseWorkflowTree } from "./tree-store.sqlite.js";
import type { WorkflowBundle, WorkflowTreeDefinition } from "./types.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-bundle-"));
const storeOptions = { stateDatabasePath: path.join(tempDir, "openclaw.sqlite") };

afterAll(() => {
  closeOpenClawStateDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

afterEach(() => {
  clearEnterpriseKnowledgeFoundations();
  resetPersistedBundleFoundationsForTest();
});

function treeWithOntology(id: string, foundationId = "acme.kb"): WorkflowTreeDefinition {
  return {
    schema: "clawworks.workflow-tree",
    schemaVersion: 1,
    id,
    version: "1.0.0",
    name: `Tree ${id}`,
    root: {
      id: "root",
      title: "Root",
      ontology: {
        knowledgeFoundations: [foundationId],
        allowedTools: ["read_*"],
        deniedTools: ["shell"],
        skills: ["refund-playbook"],
        mcpServers: ["acme-tracker"],
      },
    },
  };
}

function makeBundle(): WorkflowBundle {
  return {
    schema: "clawworks.workflow-bundle",
    schemaVersion: 1,
    trees: [treeWithOntology("acme.imported")],
    knowledgeFoundations: [
      {
        id: "acme.kb",
        descriptor: { kind: "local", displayName: "Acme KB" },
        snippets: [{ foundationId: "acme.kb", text: "Refunds within 30 days", title: "refunds" }],
      },
    ],
    requiredTools: ["read_*"],
    requiredSkills: ["refund-playbook"],
  };
}

describe("workflow bundle serialize/parse", () => {
  it("round-trips through YAML and JSON with stable ordering", () => {
    const bundle = makeBundle();
    for (const format of ["yaml", "json"] as const) {
      const parsed = parseWorkflowBundleContent(serializeWorkflowBundle(bundle, format), format);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        continue;
      }
      expect(parsed.bundle.trees.map((tree) => tree.id)).toEqual(["acme.imported"]);
      expect(parsed.bundle.knowledgeFoundations[0].id).toBe("acme.kb");
      expect(parsed.bundle.requiredTools).toEqual(["read_*"]);
      expect(parsed.bundle.requiredSkills).toEqual(["refund-playbook"]);
    }
  });

  it("rejects a bundle that is not exactly one tree", () => {
    const bundle = makeBundle();
    bundle.trees = [bundle.trees[0], structuredClone({ ...bundle.trees[0], id: "acme.second" })];
    const parsed = parseWorkflowBundleContent(serializeWorkflowBundle(bundle, "json"), "json");
    expect(parsed.ok).toBe(false);
  });

  it("rejects unparseable content", () => {
    const parsed = parseWorkflowBundleContent("{ not json", "json");
    expect(parsed.ok).toBe(false);
  });

  it("rejects an inlined foundation no tree references", () => {
    const bundle = makeBundle();
    bundle.knowledgeFoundations.push({
      id: "acme.orphan",
      descriptor: { kind: "local", displayName: "Orphan" },
      snippets: [{ foundationId: "acme.orphan", text: "unused" }],
    });
    const parsed = parseWorkflowBundleContent(serializeWorkflowBundle(bundle, "json"), "json");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(
      parsed.issues.some((issue) => issue.message.includes("not referenced by any tree")),
    ).toBe(true);
  });
});

describe("workflow bundle export", () => {
  it("inlines snapshottable foundations and collects the required-tools manifest", async () => {
    upsertEnterpriseWorkflowTree(
      { tree: treeWithOntology("acme.support"), sourceFormat: "yaml" },
      storeOptions,
    );
    registerEnterpriseKnowledgeFoundation(
      "acme.kb",
      new InMemoryKnowledgeFoundation(
        [{ foundationId: "acme.kb", text: "Refunds within 30 days", title: "refunds" }],
        { kind: "local", displayName: "Acme KB" },
      ),
    );

    const result = await exportWorkflowBundle(
      { treeId: "acme.support", format: "json" },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.skippedFoundations).toEqual([]);
    // The root explicitly scopes knowledge, so the export is complete (no warning).
    expect(result.impliedAllowAllKnowledge).toBe(false);
    const parsed = parseWorkflowBundleContent(result.content, "json");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.bundle.knowledgeFoundations).toHaveLength(1);
    expect(parsed.bundle.knowledgeFoundations[0].snippets[0].text).toContain("Refunds");
    // Only the node's allowed tool is required; its denied "shell" is excluded.
    expect(parsed.bundle.requiredTools).toEqual(["read_*"]);
    expect(parsed.bundle.requiredSkills).toEqual(["refund-playbook"]);

    deleteEnterpriseWorkflowTree("acme.support", storeOptions);
  });

  it("records server-backed foundations as skipped rather than shipping partial content", async () => {
    upsertEnterpriseWorkflowTree(
      { tree: treeWithOntology("acme.support2", "acme.remote"), sourceFormat: "yaml" },
      storeOptions,
    );
    // Retrieval-only adapter (no snapshot): a server-backed corpus.
    registerEnterpriseKnowledgeFoundation("acme.remote", { retrieve: async () => [] });

    const result = await exportWorkflowBundle(
      { treeId: "acme.support2", format: "yaml" },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.skippedFoundations).toEqual([{ id: "acme.remote", reason: "unsupported" }]);
    const parsed = parseWorkflowBundleContent(result.content, "yaml");
    expect(parsed.ok && parsed.bundle.knowledgeFoundations).toEqual([]);

    deleteEnterpriseWorkflowTree("acme.support2", storeOptions);
  });

  it("does not inline knowledge another tree owns for the same id", async () => {
    upsertEnterpriseWorkflowTree(
      { tree: treeWithOntology("acme.support"), sourceFormat: "yaml" },
      storeOptions,
    );
    // acme.kb is a bundle foundation owned by a DIFFERENT tree.
    registerBundleKnowledgeFoundation(
      "acme.other",
      "acme.kb",
      new InMemoryKnowledgeFoundation(
        [{ foundationId: "acme.kb", text: "other workflow secret" }],
        {
          kind: "local",
          displayName: "Other",
        },
      ),
    );

    const result = await exportWorkflowBundle(
      { treeId: "acme.support", format: "json" },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The exporting tree does not own acme.kb, so its content is never disclosed.
    expect(result.skippedFoundations).toEqual([{ id: "acme.kb", reason: "not-registered" }]);
    const parsed = parseWorkflowBundleContent(result.content, "json");
    expect(parsed.ok && parsed.bundle.knowledgeFoundations).toEqual([]);

    deleteEnterpriseWorkflowTree("acme.support", storeOptions);
  });

  it("flags a tree with no explicit knowledge references as implied allow-all", async () => {
    const treeNoKnowledge: WorkflowTreeDefinition = {
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: "acme.noknow",
      version: "1.0.0",
      name: "No knowledge",
      root: { id: "root", title: "Root", ontology: { allowedTools: ["read_*"] } },
    };
    upsertEnterpriseWorkflowTree({ tree: treeNoKnowledge, sourceFormat: "yaml" }, storeOptions);

    const result = await exportWorkflowBundle(
      { treeId: "acme.noknow", format: "json" },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.impliedAllowAllKnowledge).toBe(true);
    const parsed = parseWorkflowBundleContent(result.content, "json");
    expect(parsed.ok && parsed.bundle.knowledgeFoundations).toEqual([]);

    deleteEnterpriseWorkflowTree("acme.noknow", storeOptions);
  });

  it("warns of implied allow-all even when some foundations are inlined (mixed scopes)", async () => {
    // Root is unrestricted (allow-all); a leaf explicitly names acme.kb.
    const mixedTree: WorkflowTreeDefinition = {
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: "acme.mixed",
      version: "1.0.0",
      name: "Mixed",
      root: {
        id: "root",
        title: "Root",
        ontology: { allowedTools: ["read_*"] },
        children: [{ id: "leaf", title: "Leaf", ontology: { knowledgeFoundations: ["acme.kb"] } }],
      },
    };
    upsertEnterpriseWorkflowTree({ tree: mixedTree, sourceFormat: "yaml" }, storeOptions);
    registerEnterpriseKnowledgeFoundation(
      "acme.kb",
      new InMemoryKnowledgeFoundation([{ foundationId: "acme.kb", text: "kb" }], {
        kind: "local",
        displayName: "KB",
      }),
    );

    const result = await exportWorkflowBundle(
      { treeId: "acme.mixed", format: "json" },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const parsed = parseWorkflowBundleContent(result.content, "json");
    // acme.kb is inlined (from the leaf), yet the root's allow-all scope means the
    // bundle is incomplete, so the warning still fires.
    expect(parsed.ok && parsed.bundle.knowledgeFoundations.map((f) => f.id)).toEqual(["acme.kb"]);
    expect(result.impliedAllowAllKnowledge).toBe(true);

    deleteEnterpriseWorkflowTree("acme.mixed", storeOptions);
  });

  it("fails closed on an unregistered tree id", async () => {
    const result = await exportWorkflowBundle(
      { treeId: "nope.missing", format: "yaml" },
      storeOptions,
    );
    expect(result.ok).toBe(false);
  });
});

describe("workflow bundle import", () => {
  it("persists foundations, registers them in-memory, and upserts trees", () => {
    const content = serializeWorkflowBundle(makeBundle(), "json");
    clearEnterpriseKnowledgeFoundations();

    const result = importWorkflowBundle({ content, format: "json" }, storeOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.trees.map((tree) => tree.id)).toEqual(["acme.imported"]);
    expect(result.foundations).toEqual(["acme.kb"]);
    expect(result.missingFoundations).toEqual([]);
    expect(result.requiredTools).toEqual(["read_*"]);
    expect(result.requiredSkills).toEqual(["refund-playbook"]);
    // A server is deployment configuration, so the bundle carries only the name:
    // without this the import looks complete while the attachment is inert.
    expect(result.requiredMcpServers).toEqual(["acme-tracker"]);

    // Persisted to SQLite so a restart re-registers it.
    expect(
      listBundledKnowledgeFoundations(storeOptions).records.map((record) => record.foundation.id),
    ).toEqual(["acme.kb"]);
    // Registered in the process retrieval registry for immediate use, descriptor intact.
    expect(listEnterpriseKnowledgeFoundationIds()).toContain("acme.kb");
    const descriptor = listEnterpriseKnowledgeFoundationDescriptors().find(
      (entry) => entry.foundationId === "acme.kb",
    );
    expect(descriptor?.descriptor.displayName).toBe("Acme KB");
    // Tree persisted through the shared tree store.
    expect(getWorkflowTreeRegistryEntry("acme.imported", storeOptions)?.tree.id).toBe(
      "acme.imported",
    );

    // Removing the tree drops its bundled foundations in the same transaction.
    deleteEnterpriseWorkflowTree("acme.imported", storeOptions);
    expect(listBundledKnowledgeFoundations(storeOptions).records).toEqual([]);
  });

  it("reports referenced foundations the bundle did not inline", () => {
    const bundle: WorkflowBundle = {
      schema: "clawworks.workflow-bundle",
      schemaVersion: 1,
      trees: [
        {
          schema: "clawworks.workflow-tree",
          schemaVersion: 1,
          id: "acme.partial",
          version: "1.0.0",
          name: "Partial",
          root: {
            id: "root",
            title: "Root",
            // References acme.remote too, but the bundle only inlines acme.kb.
            ontology: {
              knowledgeFoundations: ["acme.kb", "acme.remote"],
              allowedTools: ["read_*"],
            },
          },
        },
      ],
      knowledgeFoundations: [
        {
          id: "acme.kb",
          descriptor: { kind: "local", displayName: "KB" },
          snippets: [{ foundationId: "acme.kb", text: "hi" }],
        },
      ],
      requiredTools: ["read_*"],
      requiredSkills: [],
    };
    clearBundleKnowledgeFoundations();
    const result = importWorkflowBundle(
      { content: serializeWorkflowBundle(bundle, "json"), format: "json" },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.foundations).toEqual(["acme.kb"]);
    expect(result.missingFoundations).toEqual(["acme.remote"]);
    deleteEnterpriseWorkflowTree("acme.partial", storeOptions);
  });

  it("evicts a removed tree's foundations from the live registry", () => {
    clearBundleKnowledgeFoundations();
    importWorkflowBundle(
      { content: serializeWorkflowBundle(makeBundle(), "json"), format: "json" },
      storeOptions,
    );
    expect(listEnterpriseKnowledgeFoundationIds()).toContain("acme.kb");
    // Removing the tree deletes its foundation rows and reconciles the registry.
    expect(removeImportedWorkflowTree("acme.imported", storeOptions)).toBe(true);
    expect(listEnterpriseKnowledgeFoundationIds()).not.toContain("acme.kb");
    expect(listBundledKnowledgeFoundations(storeOptions).records).toEqual([]);
  });

  it("evicts a foundation dropped by a re-import from the live registry", () => {
    clearBundleKnowledgeFoundations();
    const withBoth: WorkflowBundle = {
      schema: "clawworks.workflow-bundle",
      schemaVersion: 1,
      trees: [
        {
          schema: "clawworks.workflow-tree",
          schemaVersion: 1,
          id: "acme.evolving",
          version: "1.0.0",
          name: "Evolving",
          root: {
            id: "root",
            title: "Root",
            ontology: { knowledgeFoundations: ["acme.kb", "acme.two"], allowedTools: ["read_*"] },
          },
        },
      ],
      knowledgeFoundations: [
        {
          id: "acme.kb",
          descriptor: { kind: "local", displayName: "KB" },
          snippets: [{ foundationId: "acme.kb", text: "one" }],
        },
        {
          id: "acme.two",
          descriptor: { kind: "local", displayName: "Two" },
          snippets: [{ foundationId: "acme.two", text: "two" }],
        },
      ],
      requiredTools: ["read_*"],
      requiredSkills: [],
    };
    importWorkflowBundle(
      { content: serializeWorkflowBundle(withBoth, "json"), format: "json" },
      storeOptions,
    );
    expect(listEnterpriseKnowledgeFoundationIds()).toEqual(
      expect.arrayContaining(["acme.kb", "acme.two"]),
    );

    // Re-import the same tree, now referencing and inlining only acme.kb.
    const withOne = structuredClone(withBoth);
    withOne.trees[0].root.ontology = {
      knowledgeFoundations: ["acme.kb"],
      allowedTools: ["read_*"],
    };
    withOne.knowledgeFoundations = [structuredClone(withBoth.knowledgeFoundations[0])];
    importWorkflowBundle(
      { content: serializeWorkflowBundle(withOne, "json"), format: "json" },
      storeOptions,
    );

    expect(listEnterpriseKnowledgeFoundationIds()).toContain("acme.kb");
    expect(listEnterpriseKnowledgeFoundationIds()).not.toContain("acme.two");

    deleteEnterpriseWorkflowTree("acme.evolving", storeOptions);
  });

  it("prunes a detached foundation when a plain tree import drops its reference", () => {
    clearBundleKnowledgeFoundations();
    importWorkflowBundle(
      { content: serializeWorkflowBundle(makeBundle(), "json"), format: "json" },
      storeOptions,
    );
    expect(listEnterpriseKnowledgeFoundationIds()).toContain("acme.kb");

    // Plain re-import of the same tree, now without the acme.kb reference.
    const treeWithoutRef: WorkflowTreeDefinition = {
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: "acme.imported",
      version: "2.0.0",
      name: "Tree acme.imported",
      root: { id: "root", title: "Root", ontology: { allowedTools: ["read_*"] } },
    };
    const result = importWorkflowTreeContent(
      { content: JSON.stringify(treeWithoutRef), format: "json" },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    // The detached foundation is gone from the store and the live registry, so it
    // cannot leak into unrelated runs whose allow-list is empty (query all).
    expect(listBundledKnowledgeFoundations(storeOptions).records).toEqual([]);
    expect(listEnterpriseKnowledgeFoundationIds()).not.toContain("acme.kb");

    deleteEnterpriseWorkflowTree("acme.imported", storeOptions);
  });

  it("derives requiredTools from the tree, ignoring a stale stored manifest", () => {
    const bundle = makeBundle();
    // A stale or hand-edited manifest must not mislead the compatibility report.
    bundle.requiredTools = ["stale_tool"];
    bundle.requiredSkills = ["stale_skill"];
    clearBundleKnowledgeFoundations();
    const result = importWorkflowBundle(
      { content: serializeWorkflowBundle(bundle, "json"), format: "json" },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The tree's allow-list ["read_*"] is what the workflow actually requires.
    expect(result.requiredTools).toEqual(["read_*"]);
    // Skills derive from the tree too, so the stale ["stale_skill"] is ignored.
    expect(result.requiredSkills).toEqual(["refund-playbook"]);
    // A server is deployment configuration, so the bundle carries only the name:
    // without this the import looks complete while the attachment is inert.
    expect(result.requiredMcpServers).toEqual(["acme-tracker"]);
    deleteEnterpriseWorkflowTree("acme.imported", storeOptions);
  });

  it("reports validation issues for an invalid bundle without persisting", () => {
    const result = importWorkflowBundle({ content: "{ not json", format: "json" }, storeOptions);
    expect(result.ok).toBe(false);
    expect(listBundledKnowledgeFoundations(storeOptions).records).toEqual([]);
  });
  it("carries the policies that govern the tree through a round trip", () => {
    // Governance is the one part of a work-map's enforcement that does not live
    // in the tree, so an export without it looks complete and arrives unenforced.
    const bundle: WorkflowBundle = {
      ...makeBundle(),
      governancePolicies: [
        { id: "acme.no-bash", effect: "deny", tools: ["bash"] },
        { id: "acme.ask-first", effect: "deny", tools: ["exec"] },
      ],
    };
    const parsed = parseWorkflowBundleContent(serializeWorkflowBundle(bundle, "json"), "json");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    // Declaration ORDER is preserved, unlike every other bundle list: among
    // policies of the same effect the first match wins (resolvePolicyDecision),
    // so sorting them would change which approval settings apply.
    expect(parsed.bundle.governancePolicies?.map((policy) => policy.id)).toEqual([
      "acme.no-bash",
      "acme.ask-first",
    ]);
  });

  it("separates a policy this deployment lacks from one it defines differently", () => {
    const bundle: WorkflowBundle = {
      ...makeBundle(),
      governancePolicies: [
        { id: "acme.same", effect: "deny", tools: ["bash"] },
        { id: "acme.different", effect: "deny", tools: ["exec"] },
        { id: "acme.absent", effect: "deny", tools: ["write"] },
      ],
    };
    const result = importWorkflowBundle(
      {
        content: serializeWorkflowBundle(bundle, "json"),
        format: "json",
        config: {
          enterprise: {
            governance: {
              policies: [
                // Same rule, keys in a different order: not a conflict.
                { tools: ["bash"], effect: "deny", id: "acme.same" },
                // Same id, weaker rule: a conflict the operator must reconcile.
                { id: "acme.different", effect: "audit", tools: ["exec"] },
              ],
            },
          },
        },
      },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.missingGovernancePolicies).toEqual(["acme.absent"]);
    expect(result.conflictingGovernancePolicies).toEqual(["acme.different"]);
  });

  it("ignores a policy whose action selector names nothing the tree declares", () => {
    // Every selector a policy sets must match for the gate to apply it, so an
    // `actions` glob naming no declared action can never fire here. Reporting it
    // would send the operator to add a rule that changes no enforcement.
    const bundle: WorkflowBundle = {
      ...makeBundle(),
      governancePolicies: [{ id: "acme.governs", effect: "deny", tools: ["bash"] }],
    };
    const result = importWorkflowBundle(
      {
        content: serializeWorkflowBundle(bundle, "json"),
        format: "json",
        config: {
          enterprise: {
            governance: {
              policies: [
                { id: "acme.governs", effect: "deny", tools: ["bash"] },
                { id: "acme.elsewhere", effect: "deny", actions: ["acme.refund"] },
              ],
            },
          },
        },
      },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The local action-scoped rule never competes, so it is not a conflict — and
    // the tree's own rule still compares clean.
    expect(result.conflictingGovernancePolicies).toEqual([]);
    expect(result.missingGovernancePolicies).toEqual([]);
  });

  it("calls a policy scoped away from this tree conflicting, not missing", () => {
    // The operator HAS this rule; it just does not reach the imported work-map.
    // "Add it" would send them to write a second copy — the remedy is to widen
    // the one they already wrote.
    const bundle: WorkflowBundle = {
      ...makeBundle(),
      governancePolicies: [{ id: "acme.scoped", effect: "deny", tools: ["bash"] }],
    };
    const result = importWorkflowBundle(
      {
        content: serializeWorkflowBundle(bundle, "json"),
        format: "json",
        config: {
          enterprise: {
            governance: {
              policies: [
                { id: "acme.scoped", effect: "deny", tools: ["bash"], trees: ["other.tree"] },
              ],
            },
          },
        },
      },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.missingGovernancePolicies).toEqual([]);
    expect(result.conflictingGovernancePolicies).toEqual(["acme.scoped"]);
  });

  it("treats a repeated id as equivalent when only its effects are reordered", () => {
    // The schema permits one id across several effects, and resolvePolicyDecision
    // applies a FIXED effect precedence, so listing them the other way round
    // enforces identically.
    const bundle: WorkflowBundle = {
      ...makeBundle(),
      governancePolicies: [
        { id: "acme.pair", effect: "deny", tools: ["bash"] },
        { id: "acme.pair", effect: "audit", tools: ["read"] },
      ],
    };
    const result = importWorkflowBundle(
      {
        content: serializeWorkflowBundle(bundle, "json"),
        format: "json",
        config: {
          enterprise: {
            governance: {
              policies: [
                { id: "acme.pair", effect: "audit", tools: ["read"] },
                { id: "acme.pair", effect: "deny", tools: ["bash"] },
              ],
            },
          },
        },
      },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conflictingGovernancePolicies).toEqual([]);
  });

  it("treats a repeated selector as the set the matcher evaluates", () => {
    const bundle: WorkflowBundle = {
      ...makeBundle(),
      governancePolicies: [{ id: "acme.dupe", effect: "deny", tools: ["bash"] }],
    };
    const result = importWorkflowBundle(
      {
        content: serializeWorkflowBundle(bundle, "json"),
        format: "json",
        config: {
          enterprise: {
            // Selectors are matched as sets: listing "bash" twice denies exactly
            // what listing it once denies.
            governance: {
              policies: [{ id: "acme.dupe", effect: "deny", tools: ["bash", "bash"] }],
            },
          },
        },
      },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conflictingGovernancePolicies).toEqual([]);
  });

  it("reports an enforcement downgrade the policy bodies cannot reveal", () => {
    const bundle: WorkflowBundle = {
      ...makeBundle(),
      governancePolicies: [{ id: "acme.same", effect: "deny", tools: ["bash"] }],
      governanceMode: "enforce",
    };
    const result = importWorkflowBundle(
      {
        content: serializeWorkflowBundle(bundle, "json"),
        format: "json",
        config: {
          enterprise: {
            mode: "observe",
            governance: { policies: [{ id: "acme.same", effect: "deny", tools: ["bash"] }] },
          },
        },
      },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Identical bodies, so nothing is missing or conflicting — and yet the rule
    // does not block here.
    expect(result.missingGovernancePolicies).toEqual([]);
    expect(result.conflictingGovernancePolicies).toEqual([]);
    expect(result.governanceModeDowngrade).toEqual({ from: "enforce", to: "observe" });
  });

  it("reports reordering across ids, which changes which policy wins", () => {
    const bundle: WorkflowBundle = {
      ...makeBundle(),
      governancePolicies: [
        { id: "acme.first", effect: "require_approval", tools: ["bash"] },
        { id: "acme.second", effect: "require_approval", tools: ["bash"] },
      ],
    };
    const result = importWorkflowBundle(
      {
        content: serializeWorkflowBundle(bundle, "json"),
        format: "json",
        config: {
          enterprise: {
            governance: {
              // Same two rules, swapped. Each per-id group is identical, but
              // resolvePolicyDecision takes the FIRST of the winning effect, so
              // the approval settings that apply are the other one's.
              policies: [
                { id: "acme.second", effect: "require_approval", tools: ["bash"] },
                { id: "acme.first", effect: "require_approval", tools: ["bash"] },
              ],
            },
          },
        },
      },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conflictingGovernancePolicies).toEqual(["acme.first", "acme.second"]);
  });

  // A tree governed only by ontology restrictions still stops blocking under a
  // weaker mode, and no policy comparison would say so.
  it("reports a mode downgrade even when the bundle carries no policies", () => {
    const bundle: WorkflowBundle = { ...makeBundle(), governanceMode: "enforce" };
    const result = importWorkflowBundle(
      {
        content: serializeWorkflowBundle(bundle, "json"),
        format: "json",
        config: { enterprise: { mode: "off" } },
      },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.governanceModeDowngrade).toEqual({ from: "enforce", to: "off" });
  });

  // `enterprise.mode` is optional and defaults to `enforce`, so reading the raw
  // key would export nothing and hide the very downgrade this catches.
  it("records the default mode when the source never set one", () => {
    const result = importWorkflowBundle(
      {
        content: serializeWorkflowBundle({ ...makeBundle(), governanceMode: "enforce" }, "json"),
        format: "json",
        config: { enterprise: { mode: "observe" } },
      },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.governanceModeDowngrade).toEqual({ from: "enforce", to: "observe" });
  });

  it("treats a target with no explicit mode as enforcing", () => {
    const result = importWorkflowBundle(
      {
        content: serializeWorkflowBundle({ ...makeBundle(), governanceMode: "enforce" }, "json"),
        format: "json",
        config: {},
      },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Same default on both sides, so this is not a downgrade.
    expect(result.governanceModeDowngrade).toBeUndefined();
  });

  it("rejects a bundle whose mode is not a real enterprise mode", () => {
    const serialized = serializeWorkflowBundle(makeBundle(), "json").replace(
      '"requiredTools"',
      '"governanceMode": "enforc", "requiredTools"',
    );
    // A typo would otherwise rank as strength zero and suppress the warning.
    expect(parseWorkflowBundleContent(serialized, "json").ok).toBe(false);
  });

  // resolvePolicyDecision picks the FIRST policy of the winning effect, so a
  // local rule the bundle never carried can still take the decision away from an
  // identical carried one — while every per-id group matches.
  it("reports an extra local policy that outranks a carried one", () => {
    const bundle: WorkflowBundle = {
      ...makeBundle(),
      governancePolicies: [{ id: "acme.carried", effect: "require_approval", tools: ["bash"] }],
    };
    const result = importWorkflowBundle(
      {
        content: serializeWorkflowBundle(bundle, "json"),
        format: "json",
        config: {
          enterprise: {
            governance: {
              policies: [
                { id: "acme.local-first", effect: "require_approval", tools: ["bash"] },
                { id: "acme.carried", effect: "require_approval", tools: ["bash"] },
              ],
            },
          },
        },
      },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Nothing is absent — the carried rule is present and identical — but the
    // decision here is made by a rule the sender never had.
    expect(result.missingGovernancePolicies).toEqual([]);
    expect(result.conflictingGovernancePolicies).toContain("acme.local-first");
  });

  // resolvePolicyDecision applies a fixed effect precedence, so moving a rule past
  // one of a DIFFERENT effect cannot change the winner.
  it("does not report reordering across different effects", () => {
    const bundle: WorkflowBundle = {
      ...makeBundle(),
      governancePolicies: [
        { id: "acme.deny", effect: "deny", tools: ["bash"] },
        { id: "acme.audit", effect: "audit", tools: ["read"] },
      ],
    };
    const result = importWorkflowBundle(
      {
        content: serializeWorkflowBundle(bundle, "json"),
        format: "json",
        config: {
          enterprise: {
            governance: {
              policies: [
                { id: "acme.audit", effect: "audit", tools: ["read"] },
                { id: "acme.deny", effect: "deny", tools: ["bash"] },
              ],
            },
          },
        },
      },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conflictingGovernancePolicies).toEqual([]);
    expect(result.missingGovernancePolicies).toEqual([]);
  });

  // A bundle with no policies is not "nothing to compare": a local rule the
  // sender never had still changes how the imported tree runs.
  it("reports a target-only policy even when the bundle carries none", () => {
    const result = importWorkflowBundle(
      {
        content: serializeWorkflowBundle(makeBundle(), "json"),
        format: "json",
        config: {
          enterprise: {
            governance: { policies: [{ id: "acme.local-deny", effect: "deny", tools: ["bash"] }] },
          },
        },
      },
      storeOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.conflictingGovernancePolicies).toContain("acme.local-deny");
  });

  it("still loads a bundle written before policies travelled", () => {
    const parsed = parseWorkflowBundleContent(
      serializeWorkflowBundle(makeBundle(), "json"),
      "json",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.bundle.governancePolicies).toBeUndefined();
  });
});

describe("bundle export knowledge scope with explicit grants", () => {
  it("does not call an explicit work-map's knowledge scope unbounded", () => {
    // Silence denies under the switch in every mode, so the ids the tree names
    // ARE the whole retrievable set: warning about a missing root list would tell
    // the operator to widen a scope the switch already closed.
    const tree = {
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: "acme.explicit-kb",
      version: "1.0.0",
      name: "Explicit KB",
      capabilityGrants: "explicit",
      root: {
        id: "root",
        title: "Root",
        children: [
          { id: "root.read", title: "Read", ontology: { knowledgeFoundations: ["acme.kb"] } },
        ],
      },
    } as Parameters<typeof treeHasUnboundedKnowledgeScope>[0];

    expect(treeHasUnboundedKnowledgeScope(tree)).toBe(false);
    const inherited = { ...tree, capabilityGrants: undefined };
    expect(treeHasUnboundedKnowledgeScope(inherited)).toBe(true);
  });
});
