import { mkdtempSync, rmSync } from "node:fs";
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
  deleteBundledKnowledgeFoundationsForTree,
  listBundledKnowledgeFoundations,
  pruneBundledKnowledgeFoundationsForTree,
  replaceBundledKnowledgeFoundationsForTree,
} from "./enterprise-knowledge-store.sqlite.js";
import type { BundledKnowledgeFoundation } from "./types.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "clawworks-knowledge-"));
const storeOptions = { stateDatabasePath: path.join(tempDir, "openclaw.sqlite") };
const txnOptions = { path: storeOptions.stateDatabasePath };

afterAll(() => {
  closeOpenClawStateDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeFoundation(id: string, text = "hello"): BundledKnowledgeFoundation {
  return {
    id,
    descriptor: { kind: "local", displayName: `Foundation ${id}` },
    snippets: [{ foundationId: id, text, title: "doc" }],
  };
}

function replaceForTree(treeId: string, foundations: BundledKnowledgeFoundation[]): void {
  runOpenClawStateWriteTransaction(
    (database) => replaceBundledKnowledgeFoundationsForTree(database, { treeId, foundations }),
    txnOptions,
  );
}

function deleteForTree(treeId: string): void {
  runOpenClawStateWriteTransaction(
    (database) => deleteBundledKnowledgeFoundationsForTree(database, treeId),
    txnOptions,
  );
}

/** Foundation ids in one record list. */
function ids(records: ReturnType<typeof listBundledKnowledgeFoundations>["records"]): string[] {
  return records.map((record) => record.foundation.id);
}

describe("enterprise bundled knowledge store", () => {
  it("returns empty results before the database exists", () => {
    const missing = { stateDatabasePath: path.join(tempDir, "missing.sqlite") };
    expect(listBundledKnowledgeFoundations(missing)).toEqual({ records: [], rowErrors: [] });
  });

  it("persists a tree's foundations, one record per row, id-ordered with its owner", () => {
    replaceForTree("tree.a", [makeFoundation("acme.b", "beta"), makeFoundation("acme.a", "alpha")]);
    const read = listBundledKnowledgeFoundations(storeOptions);
    expect(ids(read.records)).toEqual(["acme.a", "acme.b"]);
    expect(read.records[0].treeId).toBe("tree.a");
    expect(read.records[0].foundation.snippets[0].text).toBe("alpha");
    expect(read.rowErrors).toEqual([]);
    replaceForTree("tree.a", []);
  });

  it("replaces exactly a tree's set on re-import, dropping removed foundations", () => {
    replaceForTree("tree.r", [makeFoundation("acme.x"), makeFoundation("acme.y")]);
    // Re-import without acme.y: its row must be gone, not left serving stale content.
    replaceForTree("tree.r", [makeFoundation("acme.x", "updated")]);
    const read = listBundledKnowledgeFoundations(storeOptions);
    expect(ids(read.records)).toEqual(["acme.x"]);
    expect(read.records[0].foundation.snippets[0].text).toBe("updated");
    replaceForTree("tree.r", []);
  });

  it("keeps a per-tree row for a foundation shared by two trees", () => {
    replaceForTree("tree.1", [makeFoundation("shared.kb", "one")]);
    replaceForTree("tree.2", [makeFoundation("shared.kb", "two")]);
    // One row per owning tree, not deduped — the registry keeps ownership.
    expect(
      listBundledKnowledgeFoundations(storeOptions).records.filter(
        (r) => r.foundation.id === "shared.kb",
      ),
    ).toHaveLength(2);
    deleteForTree("tree.1");
    expect(
      listBundledKnowledgeFoundations(storeOptions).records.some(
        (r) => r.foundation.id === "shared.kb",
      ),
    ).toBe(true);
    deleteForTree("tree.2");
    expect(
      listBundledKnowledgeFoundations(storeOptions).records.some(
        (r) => r.foundation.id === "shared.kb",
      ),
    ).toBe(false);
  });

  it("deletes a tree's foundations", () => {
    replaceForTree("tree.d", [makeFoundation("acme.d")]);
    deleteForTree("tree.d");
    expect(
      listBundledKnowledgeFoundations(storeOptions).records.some(
        (r) => r.foundation.id === "acme.d",
      ),
    ).toBe(false);
  });

  it("prunes a tree's foundations to a keep-set", () => {
    replaceForTree("tree.p", [makeFoundation("keep.me"), makeFoundation("drop.me")]);
    runOpenClawStateWriteTransaction(
      (database) =>
        pruneBundledKnowledgeFoundationsForTree(database, {
          treeId: "tree.p",
          keepIds: ["keep.me"],
        }),
      txnOptions,
    );
    expect(ids(listBundledKnowledgeFoundations(storeOptions).records)).toEqual(["keep.me"]);
    // An empty keep-set removes them all.
    runOpenClawStateWriteTransaction(
      (database) =>
        pruneBundledKnowledgeFoundationsForTree(database, { treeId: "tree.p", keepIds: [] }),
      txnOptions,
    );
    expect(
      listBundledKnowledgeFoundations(storeOptions).records.some(
        (r) => r.foundation.id === "keep.me",
      ),
    ).toBe(false);
  });

  it("captures per-row errors without dropping healthy rows", () => {
    replaceForTree("tree.h", [makeFoundation("acme.healthy")]);
    // Corrupt one row's descriptor JSON directly: one bad row must not blank the list.
    runOpenClawStateWriteTransaction((database) => {
      const stateDb = getNodeSqliteKysely<
        Pick<OpenClawStateKyselyDatabase, "enterprise_tree_bundled_foundations">
      >(database.db);
      executeSqliteQuerySync(
        database.db,
        stateDb.insertInto("enterprise_tree_bundled_foundations").values({
          tree_id: "tree.rotten",
          foundation_id: "acme.rotten",
          descriptor_json: "{not json",
          snippets_json: "[]",
          imported_at: 100,
          updated_at: 100,
        }),
      );
    }, txnOptions);

    const read = listBundledKnowledgeFoundations(storeOptions);
    expect(read.records.some((r) => r.foundation.id === "acme.healthy")).toBe(true);
    expect(read.rowErrors).toHaveLength(1);
    expect(read.rowErrors[0].foundationId).toBe("acme.rotten");

    deleteForTree("tree.h");
    deleteForTree("tree.rotten");
  });
});
