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
    deleteEnterpriseWorkflowTree("acme.imported", storeOptions);
  });

  it("reports validation issues for an invalid bundle without persisting", () => {
    const result = importWorkflowBundle({ content: "{ not json", format: "json" }, storeOptions);
    expect(result.ok).toBe(false);
    expect(listBundledKnowledgeFoundations(storeOptions).records).toEqual([]);
  });
});
