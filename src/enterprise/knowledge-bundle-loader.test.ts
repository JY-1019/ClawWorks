import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
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
  it("does nothing when the store does not exist", () => {
    loadPersistedBundleFoundations({ stateDatabasePath: path.join(tempDir, "missing.sqlite") });
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
