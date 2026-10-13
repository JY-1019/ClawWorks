/**
 * SQLite persistence for the knowledge foundations a workflow bundle inlines,
 * keyed by the tree they were imported with. The retrieval registry is
 * process-local and plugin-populated, so a CLI `bundle import` would otherwise
 * vanish when the process exits; persisting the inlined content here lets the
 * runtime re-register it at startup (see loadPersistedBundleFoundations) — the
 * same reload contract imported trees use.
 *
 * Scoped by tree_id and written inside the tree's own write transaction
 * (mirroring enterprise_ontology_objects) so a bundle re-import replaces exactly
 * that tree's set and a tree removal drops its foundations atomically. Plain tree
 * edits leave the rows intact; runtime hydration admits only rows still referenced
 * by the current healthy definition.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  type OpenClawStateDatabase,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { BundledKnowledgeFoundationSchema } from "./schema.js";
import type { BundledKnowledgeFoundation } from "./types.js";

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
  /** Rows that failed to parse. `treeId` is kept so a caller can tell WHICH
   *  (tree, foundation) tuple an operator owns even when its content is unreadable. */
  rowErrors: Array<{ treeId: string; foundationId: string; message: string }>;
};

/** Raw target state used to review and transactionally guard a bundle replacement. */
export type BundledKnowledgeTargetState = {
  fingerprint: string;
  foundationIds: string[];
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
  return BundledKnowledgeFoundationSchema.parse({
    id: row.foundation_id,
    descriptor: JSON.parse(row.descriptor_json),
    snippets: JSON.parse(row.snippets_json),
  });
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
  return readBundledKnowledgeFoundationsFromDatabase(database);
}

/** Read through a caller-owned connection/transaction so related tables share its snapshot. */
export function readBundledKnowledgeFoundationsFromDatabase(
  database: OpenClawStateDatabase,
): BundledKnowledgeFoundationReadResult {
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
  const rowErrors: BundledKnowledgeFoundationReadResult["rowErrors"] = [];
  for (const row of rows) {
    try {
      records.push({ treeId: row.tree_id, foundation: rowToRecord(row) });
    } catch (err) {
      rowErrors.push({
        treeId: row.tree_id,
        foundationId: row.foundation_id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { records, rowErrors };
}

/**
 * Opaque identity of every persisted bundle row owned by one tree. Raw JSON and
 * timestamps are intentional: even a semantically identical concurrent bundle
 * import is a new target state that an older preview must not overwrite.
 */
export function getBundledKnowledgeTargetStateForTreeFromDatabase(
  database: OpenClawStateDatabase,
  treeId: string,
): BundledKnowledgeTargetState {
  const stateDb = getNodeSqliteKysely<EnterpriseKnowledgeDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("enterprise_tree_bundled_foundations")
      .selectAll()
      .where("tree_id", "=", treeId)
      .orderBy("foundation_id", "asc"),
  ).rows as BundledFoundationRow[];
  const identity = rows.map((row) => ({
    foundationId: row.foundation_id,
    descriptorJson: row.descriptor_json,
    snippetsJson: row.snippets_json,
    importedAt: String(row.imported_at),
    updatedAt: String(row.updated_at),
  }));
  return {
    fingerprint: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    // Read from raw rows so a corrupt foundation remains visible as replaceable
    // data instead of being silently dropped from the destructive preview.
    foundationIds: rows.map((row) => row.foundation_id),
  };
}

export function fingerprintBundledKnowledgeForTreeFromDatabase(
  database: OpenClawStateDatabase,
  treeId: string,
): string {
  return getBundledKnowledgeTargetStateForTreeFromDatabase(database, treeId).fingerprint;
}

/** Read a tree's owned-knowledge identity and raw ids for a bundle preview. */
export function getBundledKnowledgeTargetStateForTree(
  treeId: string,
  options: EnterpriseKnowledgeStoreOptions = {},
): BundledKnowledgeTargetState {
  if (!knowledgeStoreDatabaseExists(options)) {
    return {
      fingerprint: createHash("sha256").update("[]").digest("hex"),
      foundationIds: [],
    };
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  return getBundledKnowledgeTargetStateForTreeFromDatabase(database, treeId);
}

export function fingerprintBundledKnowledgeForTree(
  treeId: string,
  options: EnterpriseKnowledgeStoreOptions = {},
): string {
  return getBundledKnowledgeTargetStateForTree(treeId, options).fingerprint;
}
