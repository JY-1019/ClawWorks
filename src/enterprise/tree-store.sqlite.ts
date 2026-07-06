/**
 * SQLite persistence for imported enterprise workflow trees in the shared
 * state DB. The canonical runtime source is this table plus the built-in
 * trees; import/export files are exchange artifacts, never runtime state.
 */
import { statSync } from "node:fs";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { validateWorkflowTreeDefinition } from "./schema.js";
import type { WorkflowTreeDefinition } from "./types.js";

export type EnterpriseTreeStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDatabasePath?: string;
};

/** Serialization format the tree was imported from. */
export type WorkflowTreeSourceFormat = "yaml" | "json";

export type ImportedWorkflowTreeRecord = {
  tree: WorkflowTreeDefinition;
  sourceFormat: WorkflowTreeSourceFormat;
  importedAt: number;
  updatedAt: number;
};

type EnterpriseTreeDatabase = Pick<OpenClawStateKyselyDatabase, "enterprise_workflow_trees">;

type EnterpriseTreeRow = {
  tree_id: string;
  version: string;
  name: string;
  definition_json: string;
  source_format: string;
  imported_at: number | bigint;
  updated_at: number | bigint;
};

function parseSourceFormat(value: string): WorkflowTreeSourceFormat {
  if (value === "yaml" || value === "json") {
    return value;
  }
  throw new Error(`unknown workflow tree source format "${value}"`);
}

function rowToRecord(row: EnterpriseTreeRow): ImportedWorkflowTreeRecord {
  const parsed = JSON.parse(row.definition_json) as unknown;
  const validated = validateWorkflowTreeDefinition(parsed);
  if (!validated.ok) {
    // Persisted definitions were validated at import; a failure here means the
    // row was tampered with or written by a newer incompatible schema.
    const first = validated.issues[0];
    throw new Error(
      `stored workflow tree "${row.tree_id}" no longer validates (${first.path}: ${first.message}); re-import it`,
    );
  }
  if (validated.tree.id !== row.tree_id) {
    // The row key is the removal/override handle; a mismatched definition id
    // would register under an id that remove/list cannot address.
    throw new Error(
      `stored workflow tree "${row.tree_id}" contains a definition with mismatched id "${validated.tree.id}"; re-import it`,
    );
  }
  return {
    tree: validated.tree,
    sourceFormat: parseSourceFormat(row.source_format),
    importedAt: normalizeSqliteNumber(row.imported_at) ?? 0,
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
  };
}

function stateDatabaseOptions(options: EnterpriseTreeStoreOptions): OpenClawStateDatabaseOptions {
  return {
    ...(options.env ? { env: options.env } : {}),
    ...(options.stateDatabasePath ? { path: options.stateDatabasePath } : {}),
  };
}

/**
 * Distinguish an absent store (healthy: nothing imported yet) from an
 * inaccessible one. A stat failure other than ENOENT throws so registry
 * consumers surface a storeError and enforce mode fails closed instead of
 * treating hidden imports as an empty store.
 */
function treeStoreDatabaseExists(options: EnterpriseTreeStoreOptions): boolean {
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
      `cannot access enterprise tree store at ${pathname}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/** Insert or replace one imported workflow tree definition. */
export function upsertEnterpriseWorkflowTree(
  params: {
    tree: WorkflowTreeDefinition;
    sourceFormat: WorkflowTreeSourceFormat;
    now?: number;
  },
  options: EnterpriseTreeStoreOptions = {},
): void {
  const now = params.now ?? Date.now();
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .insertInto("enterprise_workflow_trees")
        .values({
          tree_id: params.tree.id,
          version: params.tree.version,
          name: params.tree.name,
          definition_json: JSON.stringify(params.tree),
          source_format: params.sourceFormat,
          imported_at: now,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.column("tree_id").doUpdateSet({
            version: params.tree.version,
            name: params.tree.name,
            definition_json: JSON.stringify(params.tree),
            source_format: params.sourceFormat,
            updated_at: now,
          }),
        ),
    );
  }, stateDatabaseOptions(options));
}

/** Read one imported tree (null when absent). */
export function getEnterpriseWorkflowTree(
  treeId: string,
  options: EnterpriseTreeStoreOptions = {},
): ImportedWorkflowTreeRecord | null {
  if (!treeStoreDatabaseExists(options)) {
    return null;
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb.selectFrom("enterprise_workflow_trees").selectAll().where("tree_id", "=", treeId),
  ) as EnterpriseTreeRow | undefined;
  return row ? rowToRecord(row) : null;
}

export type EnterpriseWorkflowTreeReadResult = {
  records: ImportedWorkflowTreeRecord[];
  /**
   * Imports that exist but no longer load (corrupt/incompatible rows),
   * keyed by the row id so operators can re-import or remove them without
   * losing the healthy imports read alongside.
   */
  rowErrors: Array<{ treeId: string; message: string }>;
};

/** Read every imported tree, ordered by tree id, with per-row error capture. */
export function listEnterpriseWorkflowTrees(
  options: EnterpriseTreeStoreOptions = {},
): EnterpriseWorkflowTreeReadResult {
  if (!treeStoreDatabaseExists(options)) {
    return { records: [], rowErrors: [] };
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    stateDb.selectFrom("enterprise_workflow_trees").selectAll().orderBy("tree_id", "asc"),
  ).rows as EnterpriseTreeRow[];
  const records: ImportedWorkflowTreeRecord[] = [];
  const rowErrors: Array<{ treeId: string; message: string }> = [];
  for (const row of rows) {
    try {
      records.push(rowToRecord(row));
    } catch (err) {
      rowErrors.push({
        treeId: row.tree_id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { records, rowErrors };
}

/** Delete one imported tree. Returns true when a row was removed. */
export function deleteEnterpriseWorkflowTree(
  treeId: string,
  options: EnterpriseTreeStoreOptions = {},
): boolean {
  if (!treeStoreDatabaseExists(options)) {
    return false;
  }
  let removed = false;
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      stateDb.deleteFrom("enterprise_workflow_trees").where("tree_id", "=", treeId),
    );
    removed = (normalizeSqliteNumber(result.numAffectedRows ?? 0n) ?? 0) > 0;
  }, stateDatabaseOptions(options));
  return removed;
}
