import { spawn } from "node:child_process";
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
  fingerprintBundledKnowledgeForTree,
  listBundledKnowledgeFoundations,
} from "./enterprise-knowledge-store.sqlite.js";
import { getOntologyObject, upsertOntologyObject } from "./object-store.sqlite.js";
import { hashWorkflowTree } from "./plan.js";
import {
  deleteEnterpriseWorkflowTree,
  deleteEnterpriseWorkflowTreeIfUnchanged,
  getEnterpriseWorkflowTree,
  getEnterpriseWorkflowTreeVersion,
  listEnterpriseWorkflowTreeHistoryIds,
  listEnterpriseWorkflowTrees,
  listEnterpriseWorkflowTreeVersions,
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
    expect(listEnterpriseWorkflowTreeHistoryIds(missing)).toEqual([]);
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

  it("keeps removed tree ids discoverable through append-only history", () => {
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("acme.history-only"), sourceFormat: "json", now: 250 },
      storeOptions,
    );
    expect(deleteEnterpriseWorkflowTree("acme.history-only", storeOptions)).toBe(true);

    expect(listEnterpriseWorkflowTreeHistoryIds(storeOptions)).toContain("acme.history-only");
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
    expect(read.rowErrors[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(listEnterpriseWorkflowTrees(storeOptions).rowErrors[0].fingerprint).toBe(
      read.rowErrors[0].fingerprint,
    );

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

  it("rejects an imported row when the guarded source was a built-in", () => {
    const tree = makeTree("acme.source-race");
    upsertEnterpriseWorkflowTree({ tree, sourceFormat: "json" }, storeOptions);

    const result = upsertEnterpriseWorkflowTree(
      {
        tree: makeTree(tree.id, "2.0.0"),
        sourceFormat: "json",
        precondition: {
          kind: "expected-hash",
          hash: hashWorkflowTree(tree),
          expectedSource: "builtin",
        },
      },
      storeOptions,
    );

    expect(result).toEqual({ upserted: false, reason: "tree-changed" });
    expect(getEnterpriseWorkflowTree(tree.id, storeOptions)?.tree.version).toBe("1.0.0");
    deleteEnterpriseWorkflowTree(tree.id, storeOptions);
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

  it("checks the removal hash after waiting for a concurrent writer", async () => {
    const treeId = "acme.concurrent-remove";
    const first = makeTree(treeId, "1.0.0");
    const replacement = makeTree(treeId, "2.0.0");
    upsertEnterpriseWorkflowTree({ tree: first, sourceFormat: "json" }, storeOptions);
    runOpenClawStateWriteTransaction(
      (database) =>
        upsertOntologyObject(database, {
          treeId,
          entity: "case",
          objectId: "C-1",
          properties: { id: "C-1" },
        }),
      { path: storeOptions.stateDatabasePath },
    );

    const child = spawn(
      process.execPath,
      [
        "-e",
        `
          const { DatabaseSync } = require("node:sqlite");
          const db = new DatabaseSync(process.argv[1]);
          db.exec("BEGIN IMMEDIATE;");
          db.prepare(
            "UPDATE enterprise_workflow_trees SET version = ?, name = ?, definition_json = ?, updated_at = ? WHERE tree_id = ?",
          ).run(process.argv[3], process.argv[4], process.argv[5], Date.now(), process.argv[2]);
          process.stdout.write("locked\\n");
          setTimeout(() => {
            db.exec("COMMIT;");
            db.close();
          }, 250);
        `,
        storeOptions.stateDatabasePath,
        treeId,
        replacement.version,
        replacement.name,
        JSON.stringify(replacement),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const childExit = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`contention child exited with code ${code}`));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      let locked = false;
      child.stdout.once("data", () => {
        locked = true;
        resolve();
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (!locked) {
          reject(new Error(`contention child exited before locking with code ${code}`));
        }
      });
    });

    let result: ReturnType<typeof deleteEnterpriseWorkflowTreeIfUnchanged>;
    try {
      result = deleteEnterpriseWorkflowTreeIfUnchanged(
        { treeId, expectedHash: hashWorkflowTree(first) },
        storeOptions,
      );
    } finally {
      await childExit;
    }

    expect(result).toEqual({ removed: false, reason: "tree-changed" });
    expect(getEnterpriseWorkflowTree(treeId, storeOptions)?.tree.version).toBe("2.0.0");
    expect(
      getOntologyObject({ treeId, entity: "case", objectId: "C-1" }, storeOptions),
    ).not.toBeNull();
    deleteEnterpriseWorkflowTree(treeId, storeOptions);
  });

  it("rejects a bundle write when owned knowledge changed under the write lock", () => {
    const treeId = "acme.bundle-cas";
    const tree = makeTree(treeId);
    const foundation = (text: string) => ({
      id: "acme.kb",
      descriptor: { kind: "local" as const, displayName: "Acme KB" },
      snippets: [{ foundationId: "acme.kb", text }],
    });
    upsertEnterpriseWorkflowTree(
      {
        tree,
        sourceFormat: "json",
        now: 100,
        bundledFoundations: [foundation("previewed")],
      },
      storeOptions,
    );
    const knowledgeFingerprint = fingerprintBundledKnowledgeForTree(treeId, storeOptions);
    upsertEnterpriseWorkflowTree(
      {
        tree,
        sourceFormat: "json",
        now: 200,
        bundledFoundations: [foundation("winner")],
      },
      storeOptions,
    );

    const stale = upsertEnterpriseWorkflowTree(
      {
        tree,
        sourceFormat: "json",
        now: 300,
        bundledFoundations: [foundation("stale")],
        precondition: {
          kind: "expected-bundle-state",
          treeId,
          expectedSource: "imported",
          treeHash: hashWorkflowTree(tree),
          knowledgeFingerprint,
        },
      },
      storeOptions,
    );

    expect(stale).toEqual({ upserted: false, reason: "tree-changed" });
    const stored = listBundledKnowledgeFoundations(storeOptions).records.find(
      (record) => record.treeId === treeId,
    );
    expect(stored?.foundation.snippets[0]?.text).toBe("winner");
    deleteEnterpriseWorkflowTree(treeId, storeOptions);
  });
});

describe("enterprise workflow tree version history", () => {
  it("returns empty history before the database exists", () => {
    const missing = { stateDatabasePath: path.join(tempDir, "missing.sqlite") };
    expect(listEnterpriseWorkflowTreeVersions("hist.none", missing)).toEqual([]);
    expect(getEnterpriseWorkflowTreeVersion("hist.none", 1, missing)).toBeNull();
  });

  it("records a monotonic revision per tree on every upsert, newest first", () => {
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("hist.a", "1.0.0"), sourceFormat: "yaml", now: 1000 },
      storeOptions,
    );
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("hist.a", "2.0.0"), sourceFormat: "json", now: 2000 },
      storeOptions,
    );
    // A different tree keeps its own revision sequence.
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("hist.b", "1.0.0"), sourceFormat: "yaml", now: 1500 },
      storeOptions,
    );

    const versions = listEnterpriseWorkflowTreeVersions("hist.a", storeOptions);
    expect(versions.map((entry) => entry.revision)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({
      revision: 2,
      version: "2.0.0",
      sourceFormat: "json",
      savedAt: 2000,
    });
    expect(versions[1]).toMatchObject({ revision: 1, version: "1.0.0", savedAt: 1000 });
    expect(
      listEnterpriseWorkflowTreeVersions("hist.b", storeOptions).map((v) => v.revision),
    ).toEqual([1]);
  });

  it("bounds the listing to the newest revisions when a limit is given", () => {
    for (const [version, now] of [
      ["1.0.0", 10],
      ["2.0.0", 20],
      ["3.0.0", 30],
    ] as const) {
      upsertEnterpriseWorkflowTree(
        { tree: makeTree("hist.limit", version), sourceFormat: "yaml", now },
        storeOptions,
      );
    }
    const bounded = listEnterpriseWorkflowTreeVersions("hist.limit", storeOptions, 2);
    expect(bounded.map((entry) => entry.revision)).toEqual([3, 2]);
    // No limit returns the full append-only history.
    expect(
      listEnterpriseWorkflowTreeVersions("hist.limit", storeOptions).map((entry) => entry.revision),
    ).toEqual([3, 2, 1]);
  });

  it("backfills the prior definition on the first save after an un-versioned upgrade", () => {
    // Simulate a pre-history upgrade: a live imported row with no revisions yet.
    runOpenClawStateWriteTransaction(
      (database) => {
        const stateDb = getNodeSqliteKysely<
          Pick<OpenClawStateKyselyDatabase, "enterprise_workflow_trees">
        >(database.db);
        executeSqliteQuerySync(
          database.db,
          stateDb.insertInto("enterprise_workflow_trees").values({
            tree_id: "hist.upgrade",
            version: "1.0.0",
            name: "Tree hist.upgrade",
            definition_json: JSON.stringify(makeTree("hist.upgrade", "1.0.0")),
            source_format: "yaml",
            imported_at: 500,
            updated_at: 500,
          }),
        );
      },
      { path: storeOptions.stateDatabasePath },
    );

    upsertEnterpriseWorkflowTree(
      { tree: makeTree("hist.upgrade", "2.0.0"), sourceFormat: "json", now: 600 },
      storeOptions,
    );

    const versions = listEnterpriseWorkflowTreeVersions("hist.upgrade", storeOptions);
    expect(versions.map((entry) => entry.revision)).toEqual([2, 1]);
    // Revision 1 is the backfilled pre-upgrade definition (restorable), keeping
    // its original updated_at as saved_at; revision 2 is the new save.
    const restoredPrior = getEnterpriseWorkflowTreeVersion("hist.upgrade", 1, storeOptions);
    expect(restoredPrior?.tree.version).toBe("1.0.0");
    expect(restoredPrior?.savedAt).toBe(500);
    const restoredNew = getEnterpriseWorkflowTreeVersion("hist.upgrade", 2, storeOptions);
    expect(restoredNew?.tree.version).toBe("2.0.0");
    expect(restoredNew?.savedAt).toBe(600);
  });

  it("skips backfill when the pre-upgrade live row is un-restorable", () => {
    // A live row whose stored definition id does not match its key: valid JSON
    // that would otherwise load the wrong tree if backfilled into history.
    runOpenClawStateWriteTransaction(
      (database) => {
        const stateDb = getNodeSqliteKysely<
          Pick<OpenClawStateKyselyDatabase, "enterprise_workflow_trees">
        >(database.db);
        executeSqliteQuerySync(
          database.db,
          stateDb.insertInto("enterprise_workflow_trees").values({
            tree_id: "hist.mismatch",
            version: "1.0.0",
            name: "Mismatch",
            definition_json: JSON.stringify(makeTree("hist.other", "1.0.0")),
            source_format: "json",
            imported_at: 700,
            updated_at: 700,
          }),
        );
      },
      { path: storeOptions.stateDatabasePath },
    );

    upsertEnterpriseWorkflowTree(
      { tree: makeTree("hist.mismatch", "2.0.0"), sourceFormat: "json", now: 800 },
      storeOptions,
    );

    // No synthetic revision for the un-restorable prior row; the valid save is r1.
    const versions = listEnterpriseWorkflowTreeVersions("hist.mismatch", storeOptions);
    expect(versions.map((entry) => entry.revision)).toEqual([1]);
    const restored = getEnterpriseWorkflowTreeVersion("hist.mismatch", 1, storeOptions);
    expect(restored?.tree.id).toBe("hist.mismatch");
    expect(restored?.tree.version).toBe("2.0.0");
  });

  it("skips backfill when the prior row has a corrupt source_format", () => {
    // Valid JSON + id, but a source_format listEnterpriseWorkflowTreeVersions
    // could not map — backfilling it would make history.list throw.
    runOpenClawStateWriteTransaction(
      (database) => {
        const stateDb = getNodeSqliteKysely<
          Pick<OpenClawStateKyselyDatabase, "enterprise_workflow_trees">
        >(database.db);
        executeSqliteQuerySync(
          database.db,
          stateDb.insertInto("enterprise_workflow_trees").values({
            tree_id: "hist.badformat",
            version: "1.0.0",
            name: "Bad format",
            definition_json: JSON.stringify(makeTree("hist.badformat", "1.0.0")),
            source_format: "xml",
            imported_at: 700,
            updated_at: 700,
          }),
        );
      },
      { path: storeOptions.stateDatabasePath },
    );

    upsertEnterpriseWorkflowTree(
      { tree: makeTree("hist.badformat", "2.0.0"), sourceFormat: "json", now: 800 },
      storeOptions,
    );

    // history.list must not throw, and only the valid save is recorded.
    const versions = listEnterpriseWorkflowTreeVersions("hist.badformat", storeOptions);
    expect(versions.map((entry) => entry.revision)).toEqual([1]);
    expect(versions[0].sourceFormat).toBe("json");
  });

  it("restores a specific revision's full definition", () => {
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("hist.restore", "1.0.0"), sourceFormat: "yaml", now: 1000 },
      storeOptions,
    );
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("hist.restore", "2.0.0"), sourceFormat: "json", now: 2000 },
      storeOptions,
    );
    const detail = getEnterpriseWorkflowTreeVersion("hist.restore", 1, storeOptions);
    expect(detail?.tree.version).toBe("1.0.0");
    expect(detail?.tree.id).toBe("hist.restore");
    expect(detail?.sourceFormat).toBe("yaml");
    expect(detail?.savedAt).toBe(1000);
    expect(getEnterpriseWorkflowTreeVersion("hist.restore", 99, storeOptions)).toBeNull();
  });

  it("snapshots a pre-history tree on removal so it stays restorable", () => {
    // A live imported row with no revisions (pre-history), removed before any
    // save — the definition must be preserved, not lost.
    runOpenClawStateWriteTransaction(
      (database) => {
        const stateDb = getNodeSqliteKysely<
          Pick<OpenClawStateKyselyDatabase, "enterprise_workflow_trees">
        >(database.db);
        executeSqliteQuerySync(
          database.db,
          stateDb.insertInto("enterprise_workflow_trees").values({
            tree_id: "hist.removed",
            version: "1.0.0",
            name: "Tree hist.removed",
            definition_json: JSON.stringify(makeTree("hist.removed", "1.0.0")),
            source_format: "yaml",
            imported_at: 900,
            updated_at: 900,
          }),
        );
      },
      { path: storeOptions.stateDatabasePath },
    );

    expect(deleteEnterpriseWorkflowTree("hist.removed", storeOptions)).toBe(true);
    expect(getEnterpriseWorkflowTree("hist.removed", storeOptions)).toBeNull();
    const versions = listEnterpriseWorkflowTreeVersions("hist.removed", storeOptions);
    expect(versions.map((entry) => entry.revision)).toEqual([1]);
    const restored = getEnterpriseWorkflowTreeVersion("hist.removed", 1, storeOptions);
    expect(restored?.tree.version).toBe("1.0.0");
    expect(restored?.savedAt).toBe(900);
  });

  it("retains history after the current tree is removed (append-only audit trail)", () => {
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("hist.retain", "1.0.0"), sourceFormat: "yaml", now: 1000 },
      storeOptions,
    );
    upsertEnterpriseWorkflowTree(
      { tree: makeTree("hist.retain", "2.0.0"), sourceFormat: "json", now: 2000 },
      storeOptions,
    );
    expect(deleteEnterpriseWorkflowTree("hist.retain", storeOptions)).toBe(true);
    expect(getEnterpriseWorkflowTree("hist.retain", storeOptions)).toBeNull();
    // The saved revisions remain queryable even though the live row is gone.
    expect(
      listEnterpriseWorkflowTreeVersions("hist.retain", storeOptions).map((v) => v.revision),
    ).toEqual([2, 1]);
  });
});
