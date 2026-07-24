/**
 * SQLite persistence for the knowledge foundations a workflow bundle inlines,
 * keyed by the tree they were imported with. The retrieval registry is
 * process-local and plugin-populated, so a CLI `bundle import` would otherwise
 * vanish when the process exits; persisting the inlined content here lets the
 * runtime re-register it at startup (see loadPersistedBundleFoundations) — the
 * same reload contract imported trees use.
 *
 * Scoped by tree_id and written inside the tree's own write transaction
 * (mirroring enterprise_ontology_objects) so a re-import replaces exactly that
 * tree's set and a tree removal drops its foundations atomically — the tree owns
 * this satellite data and its lifecycle.
 */
import { statSync } from "node:fs";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  type OpenClawStateDatabase,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type {
  BundledKnowledgeFoundation,
  KnowledgeFoundationDescriptor,
  KnowledgeSnippet,
} from "./types.js";

export type EnterpriseKnowledgeStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDatabasePath?: string;
};

/** One persisted row: a foundation plus the tree it was imported with (its owner). */
export type BundledKnowledgeFoundationRecord = {
  treeId: string;
  foundation: BundledKnowledgeFoundation;
};

export type BundledKnowledgeFoundationReadResult = {
  records: BundledKnowledgeFoundationRecord[];
  rowErrors: Array<{ foundationId: string; message: string }>;
};

type EnterpriseKnowledgeDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "enterprise_tree_bundled_foundations"
>;

type BundledFoundationRow = {
  tree_id: string;
  foundation_id: string;
  descriptor_json: string;
  snippets_json: string;
  imported_at: number | bigint;
  updated_at: number | bigint;
};

function stateDatabaseOptions(
  options: EnterpriseKnowledgeStoreOptions,
): OpenClawStateDatabaseOptions {
  return {
    ...(options.env ? { env: options.env } : {}),
    ...(options.stateDatabasePath ? { path: options.stateDatabasePath } : {}),
  };
}

/**
 * Distinguish an absent store (healthy: nothing imported yet) from an
 * inaccessible one, mirroring the tree store: a stat failure other than ENOENT
 * throws so consumers surface the error instead of treating hidden rows as empty.
 */
function knowledgeStoreDatabaseExists(options: EnterpriseKnowledgeStoreOptions): boolean {
  const pathname =
    options.stateDatabasePath ?? resolveOpenClawStateSqlitePath(options.env ?? process.env);
  try {
    statSync(pathname);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new Error(
      `cannot access enterprise knowledge store at ${pathname}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

function rowToRecord(row: BundledFoundationRow): BundledKnowledgeFoundation {
  const descriptor = JSON.parse(row.descriptor_json) as KnowledgeFoundationDescriptor;
  const snippets = JSON.parse(row.snippets_json) as KnowledgeSnippet[];
  return { id: row.foundation_id, descriptor, snippets };
}

/**
 * Replace a tree's persisted bundled foundations with the given set, inside the
 * caller's write transaction. Delete-then-insert so a re-import that dropped a
 * foundation removes its stale row rather than leaving it to serve old snippets.
 */
export function replaceBundledKnowledgeFoundationsForTree(
  database: OpenClawStateDatabase,
  params: { treeId: string; foundations: readonly BundledKnowledgeFoundation[]; now?: number },
): void {
  const now = params.now ?? Date.now();
  const stateDb = getNodeSqliteKysely<EnterpriseKnowledgeDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    stateDb.deleteFrom("enterprise_tree_bundled_foundations").where("tree_id", "=", params.treeId),
  );
  for (const foundation of params.foundations) {
    executeSqliteQuerySync(
      database.db,
      stateDb.insertInto("enterprise_tree_bundled_foundations").values({
        tree_id: params.treeId,
        foundation_id: foundation.id,
        descriptor_json: JSON.stringify(foundation.descriptor),
        snippets_json: JSON.stringify(foundation.snippets),
        imported_at: now,
        updated_at: now,
      }),
    );
  }
}

/**
 * Drop every bundled foundation belonging to a tree, inside the caller's write
 * transaction. Like the tree's ontology objects there is no FK to cascade from,
 * so a tree removal must delete these explicitly or they outlive the tree.
 */
export function deleteBundledKnowledgeFoundationsForTree(
  database: OpenClawStateDatabase,
  treeId: string,
): void {
  const stateDb = getNodeSqliteKysely<EnterpriseKnowledgeDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    stateDb.deleteFrom("enterprise_tree_bundled_foundations").where("tree_id", "=", treeId),
  );
}

/**
 * Prune a tree's persisted foundations to the given keep-set, inside the caller's
 * write transaction. Used by a plain tree import (which carries no inlined
 * content): it drops foundation rows the new definition no longer references so
 * they cannot outlive the reference and leak into unrelated runs, while leaving
 * still-referenced rows untouched. An empty keep-set removes them all.
 */
export function pruneBundledKnowledgeFoundationsForTree(
  database: OpenClawStateDatabase,
  params: { treeId: string; keepIds: readonly string[] },
): void {
  const stateDb = getNodeSqliteKysely<EnterpriseKnowledgeDatabase>(database.db);
  let query = stateDb
    .deleteFrom("enterprise_tree_bundled_foundations")
    .where("tree_id", "=", params.treeId);
  if (params.keepIds.length > 0) {
    // `not in ()` is invalid SQL, so only add the filter when there is something
    // to keep; an empty keep-set falls through to deleting every row for the tree.
    query = query.where("foundation_id", "not in", [...params.keepIds]);
  }
  executeSqliteQuerySync(database.db, query);
}

/**
 * Read every persisted bundled foundation for runtime re-registration, one record
 * per (tree, foundation) row so the registry can key each foundation under its
 * owning tree and never leak bundle knowledge across workflows. Ordered by
 * foundation id then tree id for a deterministic registration order. Per-row JSON
 * faults are captured, not thrown, so one corrupt row does not hide the healthy ones.
 */
export function listBundledKnowledgeFoundations(
  options: EnterpriseKnowledgeStoreOptions = {},
): BundledKnowledgeFoundationReadResult {
  if (!knowledgeStoreDatabaseExists(options)) {
    return { records: [], rowErrors: [] };
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseKnowledgeDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("enterprise_tree_bundled_foundations")
      .selectAll()
      .orderBy("foundation_id", "asc")
      .orderBy("tree_id", "asc"),
  ).rows as BundledFoundationRow[];
  const records: BundledKnowledgeFoundationRecord[] = [];
  const rowErrors: Array<{ foundationId: string; message: string }> = [];
  for (const row of rows) {
    try {
      records.push({ treeId: row.tree_id, foundation: rowToRecord(row) });
    } catch (err) {
      rowErrors.push({
        foundationId: row.foundation_id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { records, rowErrors };
}
