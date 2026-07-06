import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { BUILTIN_WORKFLOW_TREES } from "./builtin-trees.js";
import {
  getWorkflowTreeRegistryEntry,
  getWorkflowTreeRegistrySnapshot,
  invalidateWorkflowTreeRegistry,
  listWorkflowTreeRegistryEntries,
  listWorkflowTreesForRuntime,
} from "./tree-registry.js";
import { deleteEnterpriseWorkflowTree, upsertEnterpriseWorkflowTree } from "./tree-store.sqlite.js";
import type { WorkflowTreeDefinition } from "./types.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-registry-"));
const storeOptions = { stateDatabasePath: path.join(tempDir, "openclaw.sqlite") };

afterEach(() => {
  // Row cleanup keeps the optioned store isolated even on platforms where the
  // unreadable-store case cannot rely on permission tricks.
  for (const treeId of ["acme.custom", "clawworks.assist", "acme.optioned"]) {
    deleteEnterpriseWorkflowTree(treeId, storeOptions);
  }
  invalidateWorkflowTreeRegistry();
});

afterAll(() => {
  closeOpenClawStateDatabase();
  // The fails-open case points the DB path at tempDir itself, and the state
  // layer tightens its mode to 0600; restore traversal so cleanup can unlink.
  chmodSync(tempDir, 0o700);
  rmSync(tempDir, { recursive: true, force: true });
});

function makeTree(id: string, version = "1.0.0"): WorkflowTreeDefinition {
  return {
    schema: "clawworks.workflow-tree",
    schemaVersion: 1,
    id,
    version,
    name: `Tree ${id}`,
    root: { id: "root", title: "Root step" },
  };
}

describe("workflow tree registry", () => {
  it("serves built-in trees when nothing is imported", () => {
    const entries = listWorkflowTreeRegistryEntries(storeOptions);
    expect(entries.map((entry) => entry.tree.id)).toEqual(
      BUILTIN_WORKFLOW_TREES.map((tree) => tree.id).toSorted(),
    );
    expect(entries.every((entry) => entry.source === "builtin")).toBe(true);
  });

  it("merges imported trees and lets imports override builtins by id", () => {
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("acme.custom"), sourceFormat: "yaml" },
      storeOptions,
    );
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("clawworks.assist", "5.0.0"), sourceFormat: "yaml" },
      storeOptions,
    );
    invalidateWorkflowTreeRegistry();

    const entries = listWorkflowTreeRegistryEntries(storeOptions);
    const custom = entries.find((entry) => entry.tree.id === "acme.custom");
    expect(custom?.source).toBe("imported");
    const assist = entries.find((entry) => entry.tree.id === "clawworks.assist");
    expect(assist?.source).toBe("imported");
    expect(assist?.tree.version).toBe("5.0.0");
    // Deterministic ordering by id (prompt-cache/model payload discipline).
    expect(entries.map((entry) => entry.tree.id)).toEqual(
      entries.map((entry) => entry.tree.id).toSorted(),
    );
  });

  it("caches the default-options snapshot until invalidated", () => {
    try {
      const before = listWorkflowTreeRegistryEntries();
      upsertEnterpriseWorkflowTree({ tree: makeTree("acme.cached"), sourceFormat: "yaml" });
      expect(listWorkflowTreeRegistryEntries()).toBe(before);
      invalidateWorkflowTreeRegistry();
      expect(listWorkflowTreesForRuntime().some((tree) => tree.id === "acme.cached")).toBe(true);
    } finally {
      deleteEnterpriseWorkflowTree("acme.cached");
      invalidateWorkflowTreeRegistry();
    }
  });

  it("bypasses the shared snapshot for custom state-DB options", () => {
    // Prime the default snapshot, then read through explicit options: the
    // optioned store's trees must be visible without any invalidation.
    listWorkflowTreeRegistryEntries();
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("acme.optioned"), sourceFormat: "yaml" },
      storeOptions,
    );
    expect(
      listWorkflowTreesForRuntime(storeOptions).some((tree) => tree.id === "acme.optioned"),
    ).toBe(true);
    // And the default snapshot stays unpolluted by the optioned store.
    expect(listWorkflowTreesForRuntime().some((tree) => tree.id === "acme.optioned")).toBe(false);
  });

  it("surfaces a storeError with built-in entries when the store is unreadable", () => {
    // A directory path fails to open as a database on every platform.
    const unreadableDir = mkdtempSync(path.join(tmpdir(), "clawworks-unreadable-"));
    try {
      const snapshot = getWorkflowTreeRegistrySnapshot({ stateDatabasePath: unreadableDir });
      expect(snapshot.storeError).toBeTruthy();
      expect(snapshot.importErrors).toEqual([]);
      expect(snapshot.entries.map((entry) => entry.tree.id)).toEqual(
        BUILTIN_WORKFLOW_TREES.map((tree) => tree.id).toSorted(),
      );
    } finally {
      chmodSync(unreadableDir, 0o700);
      rmSync(unreadableDir, { recursive: true, force: true });
    }
  });

  it("surfaces importErrors when a stored definition no longer validates", () => {
    const corrupt = makeTree("acme.corrupt");
    corrupt.root = {
      id: "root",
      title: "Root",
      children: [
        { id: "dup", title: "A" },
        { id: "dup", title: "B" },
      ],
    };
    upsertEnterpriseWorkflowTree({ tree: corrupt, sourceFormat: "yaml" }, storeOptions);
    try {
      const snapshot = getWorkflowTreeRegistrySnapshot(storeOptions);
      expect(snapshot.importErrors).toHaveLength(1);
      expect(snapshot.importErrors[0].treeId).toBe("acme.corrupt");
      expect(snapshot.storeError).toBeUndefined();
      expect(snapshot.entries.every((entry) => entry.source === "builtin")).toBe(true);
    } finally {
      deleteEnterpriseWorkflowTree("acme.corrupt", storeOptions);
    }
  });

  it("looks up entries by id", () => {
    expect(getWorkflowTreeRegistryEntry("clawworks.assist", storeOptions)?.source).toBe("builtin");
    expect(getWorkflowTreeRegistryEntry("nope.missing", storeOptions)).toBeUndefined();
  });
});
