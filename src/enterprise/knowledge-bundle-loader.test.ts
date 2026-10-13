import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID } from "./builtin-knowledge.js";
import { BUILTIN_SUPPORT_EXAMPLE_TREE } from "./builtin-trees.js";
import { listBundledKnowledgeFoundations } from "./enterprise-knowledge-store.sqlite.js";
import {
  loadPersistedBundleFoundations,
  reloadPersistedBundleFoundations,
  resetPersistedBundleFoundationsForTest,
} from "./knowledge-bundle-loader.js";
import {
  clearEnterpriseKnowledgeFoundations,
  listEnterpriseKnowledgeFoundationDescriptors,
  listEnterpriseKnowledgeFoundationIds,
} from "./knowledge.js";
import { deleteEnterpriseWorkflowTree, upsertEnterpriseWorkflowTree } from "./tree-store.sqlite.js";
import type { BundledKnowledgeFoundation, WorkflowTreeDefinition } from "./types.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-loader-"));
const storeOptions = { stateDatabasePath: path.join(tempDir, "openclaw.sqlite") };
// A directory where the store file is expected: opening it throws, standing in
// for any unreadable/corrupt database.
const unreadableStorePath = path.join(tempDir, "unreadable.sqlite");
mkdirSync(unreadableStorePath, { recursive: true });

afterAll(() => {
  closeOpenClawStateDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

afterEach(() => {
  clearEnterpriseKnowledgeFoundations();
  resetPersistedBundleFoundationsForTest();
});

function makeFoundation(id: string, text: string): BundledKnowledgeFoundation {
  return {
    id,
    descriptor: { kind: "local", displayName: id },
    snippets: [{ foundationId: id, text }],
  };
}

function makeTree(id: string, foundationIds: string[]): WorkflowTreeDefinition {
  return {
    schema: "clawworks.workflow-tree",
    schemaVersion: 1,
    id,
    version: "1.0.0",
    name: id,
    root: {
      id: "root",
      title: "Root",
      ontology: { knowledgeFoundations: foundationIds },
    },
  };
}

describe("persisted bundle foundation loader", () => {
  it("registers only the shipped example when the store does not exist", () => {
    loadPersistedBundleFoundations({ stateDatabasePath: path.join(tempDir, "missing.sqlite") });
    expect(listEnterpriseKnowledgeFoundationIds()).toEqual([
      BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    ]);
  });

  it("leaves the shipped example out when an operator import owns the same tuple", () => {
    upsertEnterpriseWorkflowTree(
      {
        tree: BUILTIN_SUPPORT_EXAMPLE_TREE,
        sourceFormat: "yaml",
        bundledFoundations: [
          makeFoundation(BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID, "Production refund policy"),
        ],
      },
      storeOptions,
    );
    loadPersistedBundleFoundations(storeOptions);

    const descriptor = listEnterpriseKnowledgeFoundationDescriptors().find(
      (entry) => entry.foundationId === BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    );
    // The operator's row is what retrieval must serve; the example label would
    // mean the stock corpus quietly replaced it.
    expect(descriptor?.descriptor.displayName).toBe(BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID);
    deleteEnterpriseWorkflowTree(BUILTIN_SUPPORT_EXAMPLE_TREE.id, storeOptions);
  });

  it("does not expose stock content through an imported override that dropped its reference", () => {
    const treeId = BUILTIN_SUPPORT_EXAMPLE_TREE.id;
    upsertEnterpriseWorkflowTree(
      {
        tree: BUILTIN_SUPPORT_EXAMPLE_TREE,
        sourceFormat: "yaml",
        bundledFoundations: [
          makeFoundation(BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID, "Production refund policy"),
        ],
      },
      storeOptions,
    );
    upsertEnterpriseWorkflowTree(
      { tree: makeTree(treeId, []), sourceFormat: "yaml" },
      storeOptions,
    );

    reloadPersistedBundleFoundations(storeOptions);

    expect(listBundledKnowledgeFoundations(storeOptions).records).toHaveLength(1);
    expect(listEnterpriseKnowledgeFoundationIds()).not.toContain(
      BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    );

    // A healthy imported copy of the shipped example may still use the stock
    // fallback when it explicitly references the example id but owns no row.
    upsertEnterpriseWorkflowTree(
      {
        tree: makeTree(treeId, [BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID]),
        sourceFormat: "yaml",
        bundledFoundations: [],
      },
      storeOptions,
    );
    reloadPersistedBundleFoundations(storeOptions);
    expect(listEnterpriseKnowledgeFoundationIds()).toContain(
      BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    );
    deleteEnterpriseWorkflowTree(treeId, storeOptions);
  });

  it("does not expose stock content through an unreadable imported override", () => {
    const treeId = BUILTIN_SUPPORT_EXAMPLE_TREE.id;
    const corruptTree = makeTree(treeId, [BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID]);
    corruptTree.root.children = [
      { id: "duplicate", title: "First" },
      { id: "duplicate", title: "Second" },
    ];
    upsertEnterpriseWorkflowTree(
      {
        tree: corruptTree,
        sourceFormat: "yaml",
        bundledFoundations: [],
      },
      storeOptions,
    );

    loadPersistedBundleFoundations(storeOptions);

    expect(listEnterpriseKnowledgeFoundationIds()).not.toContain(
      BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    );
    deleteEnterpriseWorkflowTree(treeId, storeOptions);
  });

  it("registers nothing when the store read fails, examples included", () => {
    // An unreadable store may hold the operator's own content for the example's
    // tuple, so standing in for it would answer retrieval with example policy.
    loadPersistedBundleFoundations({ stateDatabasePath: unreadableStorePath });
    expect(listEnterpriseKnowledgeFoundationIds()).toEqual([]);
  });

  it("registers persisted foundations into the retrieval registry with their descriptor", () => {
    upsertEnterpriseWorkflowTree(
      {
        tree: makeTree("tree.support", ["acme.kb"]),
        sourceFormat: "yaml",
        bundledFoundations: [makeFoundation("acme.kb", "Refund window is 30 days")],
      },
      storeOptions,
    );
    loadPersistedBundleFoundations(storeOptions);

    expect(listEnterpriseKnowledgeFoundationIds()).toContain("acme.kb");
    // The stored label is carried, but kind is normalized to "remote": an inlined
    // snapshot is read-only, so the inspector must not offer document management.
    const descriptor = listEnterpriseKnowledgeFoundationDescriptors().find(
      (entry) => entry.foundationId === "acme.kb",
    );
    expect(descriptor?.descriptor).toEqual({ kind: "remote", displayName: "acme.kb" });
    deleteEnterpriseWorkflowTree("tree.support", storeOptions);
  });

  it("keeps detached rows persisted but out of the live registry", () => {
    const treeId = "tree.retained";
    const active = makeFoundation("acme.active", "active");
    const detached = makeFoundation("acme.detached", "detached");
    upsertEnterpriseWorkflowTree(
      {
        tree: makeTree(treeId, [active.id, detached.id]),
        sourceFormat: "yaml",
        bundledFoundations: [active, detached],
      },
      storeOptions,
    );
    upsertEnterpriseWorkflowTree(
      { tree: makeTree(treeId, [active.id]), sourceFormat: "yaml" },
      storeOptions,
    );

    loadPersistedBundleFoundations(storeOptions);

    expect(
      listBundledKnowledgeFoundations(storeOptions).records.map(({ foundation }) => foundation.id),
    ).toEqual([active.id, detached.id]);
    expect(listEnterpriseKnowledgeFoundationIds()).toContain(active.id);
    expect(listEnterpriseKnowledgeFoundationIds()).not.toContain(detached.id);
    deleteEnterpriseWorkflowTree(treeId, storeOptions);
  });
});
