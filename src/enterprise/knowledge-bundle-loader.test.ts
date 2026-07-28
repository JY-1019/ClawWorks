import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID } from "./builtin-knowledge.js";
import { BUILTIN_SUPPORT_EXAMPLE_TREE } from "./builtin-trees.js";
import { replaceBundledKnowledgeFoundationsForTree } from "./enterprise-knowledge-store.sqlite.js";
import {
  loadPersistedBundleFoundations,
  resetPersistedBundleFoundationsForTest,
} from "./knowledge-bundle-loader.js";
import {
  clearEnterpriseKnowledgeFoundations,
  listEnterpriseKnowledgeFoundationDescriptors,
  listEnterpriseKnowledgeFoundationIds,
} from "./knowledge.js";
import type { BundledKnowledgeFoundation } from "./types.js";

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

describe("persisted bundle foundation loader", () => {
  it("registers only the shipped example when the store does not exist", () => {
    loadPersistedBundleFoundations({ stateDatabasePath: path.join(tempDir, "missing.sqlite") });
    expect(listEnterpriseKnowledgeFoundationIds()).toEqual([
      BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    ]);
  });

  it("leaves the shipped example out when an operator import owns the same tuple", () => {
    runOpenClawStateWriteTransaction(
      (database) =>
        replaceBundledKnowledgeFoundationsForTree(database, {
          treeId: BUILTIN_SUPPORT_EXAMPLE_TREE.id,
          foundations: [
            makeFoundation(BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID, "Production refund policy"),
          ],
        }),
      { path: storeOptions.stateDatabasePath },
    );
    loadPersistedBundleFoundations(storeOptions);

    const descriptor = listEnterpriseKnowledgeFoundationDescriptors().find(
      (entry) => entry.foundationId === BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID,
    );
    // The operator's row is what retrieval must serve; the example label would
    // mean the stock corpus quietly replaced it.
    expect(descriptor?.descriptor.displayName).toBe(BUILTIN_SUPPORT_KNOWLEDGE_FOUNDATION_ID);
  });

  it("registers nothing when the store read fails, examples included", () => {
    // An unreadable store may hold the operator's own content for the example's
    // tuple, so standing in for it would answer retrieval with example policy.
    loadPersistedBundleFoundations({ stateDatabasePath: unreadableStorePath });
    expect(listEnterpriseKnowledgeFoundationIds()).toEqual([]);
  });

  it("registers persisted foundations into the retrieval registry with their descriptor", () => {
    runOpenClawStateWriteTransaction(
      (database) =>
        replaceBundledKnowledgeFoundationsForTree(database, {
          treeId: "tree.support",
          foundations: [makeFoundation("acme.kb", "Refund window is 30 days")],
        }),
      { path: storeOptions.stateDatabasePath },
    );
    loadPersistedBundleFoundations(storeOptions);

    expect(listEnterpriseKnowledgeFoundationIds()).toContain("acme.kb");
    // The stored label is carried, but kind is normalized to "remote": an inlined
    // snapshot is read-only, so the inspector must not offer document management.
    const descriptor = listEnterpriseKnowledgeFoundationDescriptors().find(
      (entry) => entry.foundationId === "acme.kb",
    );
    expect(descriptor?.descriptor).toEqual({ kind: "remote", displayName: "acme.kb" });
  });
});
