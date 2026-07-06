import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  deleteEnterpriseWorkflowTree,
  getEnterpriseWorkflowTree,
  listEnterpriseWorkflowTrees,
  upsertEnterpriseWorkflowTree,
} from "./tree-store.sqlite.js";
import type { WorkflowTreeDefinition } from "./types.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-trees-"));
const storeOptions = { stateDatabasePath: path.join(tempDir, "openclaw.sqlite") };

afterAll(() => {
  closeOpenClawStateDatabase();
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

describe("enterprise workflow tree store", () => {
  it("returns empty results before the database exists", () => {
    const missing = { stateDatabasePath: path.join(tempDir, "missing.sqlite") };
    expect(getEnterpriseWorkflowTree("acme.a", missing)).toBeNull();
    expect(listEnterpriseWorkflowTrees(missing)).toEqual({ records: [], rowErrors: [] });
    expect(deleteEnterpriseWorkflowTree("acme.a", missing)).toBe(false);
  });

  it("throws instead of reporting an empty store when the path cannot be statted", () => {
    // An inaccessible store must not masquerade as "nothing imported":
    // enforce-mode consumers rely on the thrown storeError to fail closed.
    const lockedDir = path.join(tempDir, "locked");
    mkdirSync(lockedDir);
    const inaccessible = { stateDatabasePath: path.join(lockedDir, "openclaw.sqlite") };
    chmodSync(lockedDir, 0o000);
    try {
      let statDenied = false;
      try {
        statSync(inaccessible.stateDatabasePath);
      } catch (err) {
        statDenied = (err as NodeJS.ErrnoException).code !== "ENOENT";
      }
      if (!statDenied) {
        // chmod has no effect on this platform; the classification cannot be
        // exercised here (CI truth is Linux, where it is).
        return;
      }
      expect(() => listEnterpriseWorkflowTrees(inaccessible)).toThrow(/cannot access/);
    } finally {
      chmodSync(lockedDir, 0o700);
      rmSync(lockedDir, { recursive: true, force: true });
    }
  });

  it("upserts, reads back, and lists trees in id order", () => {
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("acme.b"), sourceFormat: "yaml", now: 100 },
      storeOptions,
    );
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("acme.a"), sourceFormat: "json", now: 200 },
      storeOptions,
    );

    const record = getEnterpriseWorkflowTree("acme.a", storeOptions);
    expect(record?.tree.name).toBe("Tree acme.a");
    expect(record?.sourceFormat).toBe("json");
    expect(record?.importedAt).toBe(200);

    const read = listEnterpriseWorkflowTrees(storeOptions);
    expect(read.records.map((entry) => entry.tree.id)).toEqual(["acme.a", "acme.b"]);
    expect(read.rowErrors).toEqual([]);
  });

  it("captures per-row errors without dropping healthy imports", () => {
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("acme.healthy"), sourceFormat: "yaml" },
      storeOptions,
    );
    const corrupt = makeTree("acme.rotten");
    corrupt.root = {
      id: "root",
      title: "Root",
      children: [
        { id: "dup", title: "A" },
        { id: "dup", title: "B" },
      ],
    };
    upsertEnterpriseWorkflowTree({ tree: corrupt, sourceFormat: "yaml" }, storeOptions);

    const read = listEnterpriseWorkflowTrees(storeOptions);
    expect(read.records.some((entry) => entry.tree.id === "acme.healthy")).toBe(true);
    expect(read.rowErrors).toHaveLength(1);
    expect(read.rowErrors[0].treeId).toBe("acme.rotten");

    deleteEnterpriseWorkflowTree("acme.healthy", storeOptions);
    deleteEnterpriseWorkflowTree("acme.rotten", storeOptions);
  });

  it("replaces the definition on re-import and keeps importedAt", () => {
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("acme.c", "1.0.0"), sourceFormat: "yaml", now: 300 },
      storeOptions,
    );
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("acme.c", "2.0.0"), sourceFormat: "yaml", now: 400 },
      storeOptions,
    );
    const record = getEnterpriseWorkflowTree("acme.c", storeOptions);
    expect(record?.tree.version).toBe("2.0.0");
    expect(record?.importedAt).toBe(300);
    expect(record?.updatedAt).toBe(400);
  });

  it("treats tree_id/definition id mismatches as row errors", () => {
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("acme.key"), sourceFormat: "yaml" },
      storeOptions,
    );
    // Simulate a corrupted/buggy-importer row whose stored definition id no
    // longer matches the row key that remove/list address.
    runOpenClawStateWriteTransaction(
      (database) => {
        const stateDb = getNodeSqliteKysely<
          Pick<OpenClawStateKyselyDatabase, "enterprise_workflow_trees">
        >(database.db);
        executeSqliteQuerySync(
          database.db,
          stateDb
            .updateTable("enterprise_workflow_trees")
            .set({ definition_json: JSON.stringify(makeTree("acme.other")) })
            .where("tree_id", "=", "acme.key"),
        );
      },
      { path: storeOptions.stateDatabasePath },
    );

    const read = listEnterpriseWorkflowTrees(storeOptions);
    expect(read.records.some((entry) => entry.tree.id === "acme.other")).toBe(false);
    expect(read.rowErrors).toHaveLength(1);
    expect(read.rowErrors[0].treeId).toBe("acme.key");
    expect(read.rowErrors[0].message).toContain('mismatched id "acme.other"');

    deleteEnterpriseWorkflowTree("acme.key", storeOptions);
  });

  it("deletes imported trees", () => {
    upsertEnterpriseWorkflowTree({ tree: makeTree("acme.d"), sourceFormat: "yaml" }, storeOptions);
    expect(deleteEnterpriseWorkflowTree("acme.d", storeOptions)).toBe(true);
    expect(deleteEnterpriseWorkflowTree("acme.d", storeOptions)).toBe(false);
    expect(getEnterpriseWorkflowTree("acme.d", storeOptions)).toBeNull();
  });
});
