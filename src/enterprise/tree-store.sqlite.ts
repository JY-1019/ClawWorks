/**
 * SQLite persistence for imported enterprise workflow trees in the shared
 * state DB. The canonical runtime source is this table plus the built-in
 * trees; import/export files are exchange artifacts, never runtime state.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { runSqliteReadTransactionSync } from "../infra/sqlite-transaction.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  type OpenClawStateDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  deleteBundledKnowledgeFoundationsForTree,
  fingerprintBundledKnowledgeForTreeFromDatabase,
  readBundledKnowledgeFoundationsFromDatabase,
  replaceBundledKnowledgeFoundationsForTree,
  type BundledKnowledgeFoundationReadResult,
} from "./enterprise-knowledge-store.sqlite.js";
import { deleteOntologyObjectsForTree } from "./object-store.sqlite.js";
import { hashWorkflowTree } from "./plan.js";
import { validateWorkflowTreeDefinition } from "./schema.js";
import type { BundledKnowledgeFoundation, WorkflowTreeDefinition } from "./types.js";

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

type EnterpriseTreeDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "enterprise_workflow_trees" | "enterprise_workflow_tree_versions"
>;

type EnterpriseTreeRow = {
  tree_id: string;
  version: string;
  name: string;
  definition_json: string;
  source_format: string;
  imported_at: number | bigint;
  updated_at: number | bigint;
};

type EnterpriseTreeVersionRow = {
  tree_id: string;
  revision: number | bigint;
  version: string;
  name: string;
  definition_json: string;
  source_format: string;
  saved_at: number | bigint;
};

/** Opaque identity for one raw row; callers never receive its possibly-sensitive bytes. */
function fingerprintEnterpriseTreeRow(row: EnterpriseTreeRow): string {
  const canonicalFields = [
    row.tree_id,
    row.version,
    row.name,
    row.definition_json,
    row.source_format,
    String(row.imported_at),
    String(row.updated_at),
  ];
  return createHash("sha256").update(JSON.stringify(canonicalFields)).digest("hex");
}

/** One recorded revision of a tree definition (newest first in listings). */
export type WorkflowTreeVersionRecord = {
  treeId: string;
  revision: number;
  version: string;
  name: string;
  sourceFormat: WorkflowTreeSourceFormat;
  savedAt: number;
};

/** A restored historical revision: the parsed definition plus its metadata. */
export type WorkflowTreeVersionDetail = {
  tree: WorkflowTreeDefinition;
  sourceFormat: WorkflowTreeSourceFormat;
  revision: number;
  savedAt: number;
};

type EnterpriseWorkflowTreeUpsertPrecondition =
  | { kind: "create-only" }
  | {
      kind: "expected-hash";
      hash: string;
      /** The process-stable registry source whose hash the caller matched. */
      expectedSource: "builtin" | "imported";
    }
  | {
      kind: "expected-bundle-state";
      treeId: string;
      expectedSource: "absent" | "builtin" | "imported";
      treeHash: string | null;
      knowledgeFingerprint: string;
    };

type EnterpriseWorkflowTreeUpsertResult =
  | { upserted: true; replacedImported: boolean }
  | { upserted: false; reason: "already-exists" | "tree-changed" | "tree-unavailable" };

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

/**
 * Non-throwing form of the `rowToRecord` invariant: a row is restorable only if
 * its JSON parses, validates, and its definition id matches the row key. Used to
 * decide whether a pre-history row is worth backfilling — a corrupt/mismatched
 * one must not enter history, or `history.get` would throw or load the wrong tree.
 */
function isRestorableTreeRow(row: EnterpriseTreeRow): boolean {
  // A corrupt source_format would map fine here but throw later in
  // listEnterpriseWorkflowTreeVersions via parseSourceFormat, breaking history.
  if (row.source_format !== "yaml" && row.source_format !== "json") {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.definition_json);
  } catch {
    return false;
  }
  const validated = validateWorkflowTreeDefinition(parsed);
  return validated.ok && validated.tree.id === row.tree_id;
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

/**
 * Snapshot the current live row into history when it is a restorable definition
 * not already captured as the latest revision — a pre-history upgrade row, or a
 * live row written outside the versioned path. Returns the resulting max
 * revision so callers can number the next snapshot. Runs inside a write txn so
 * both `upsert` (before overwrite) and `delete` (before removal) preserve the
 * definition, honoring the append-only/restorable history contract.
 */
function snapshotCurrentTreeRow(
  database: OpenClawStateDatabase,
  treeId: string,
  fallbackNow: number,
): number {
  const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
  const existingRow = executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb.selectFrom("enterprise_workflow_trees").selectAll().where("tree_id", "=", treeId),
  ) as EnterpriseTreeRow | undefined;
  const latest = executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb
      .selectFrom("enterprise_workflow_tree_versions")
      .select(["revision", "definition_json"])
      .where("tree_id", "=", treeId)
      .orderBy("revision", "desc")
      .limit(1),
  ) as { revision: number | bigint; definition_json: string } | undefined;
  const maxRevision = latest ? (normalizeSqliteNumber(latest.revision) ?? 0) : 0;
  // Skip a corrupt/mismatched row (unrestorable) and a state already captured by
  // the last save, so history gains no broken or duplicate revisions.
  if (!existingRow || !isRestorableTreeRow(existingRow)) {
    return maxRevision;
  }
  if (latest && latest.definition_json === existingRow.definition_json) {
    return maxRevision;
  }
  const nextRevision = maxRevision + 1;
  executeSqliteQuerySync(
    database.db,
    stateDb.insertInto("enterprise_workflow_tree_versions").values({
      tree_id: existingRow.tree_id,
      revision: nextRevision,
      version: existingRow.version,
      name: existingRow.name,
      definition_json: existingRow.definition_json,
      source_format: existingRow.source_format,
      saved_at: normalizeSqliteNumber(existingRow.updated_at) ?? fallbackNow,
    }),
  );
  return nextRevision;
}

/** Insert or replace one imported workflow tree definition. */
export function upsertEnterpriseWorkflowTree(
  params: {
    tree: WorkflowTreeDefinition;
    sourceFormat: WorkflowTreeSourceFormat;
    now?: number;
    /**
     * Knowledge foundations a bundle inlined for this tree. Provided only by
     * bundle import; a plain tree import omits it and leaves any existing set
     * untouched, so editing a tree never silently drops its bundled knowledge.
     */
    bundledFoundations?: readonly BundledKnowledgeFoundation[];
    /** Optional optimistic guard checked against the imported row under the write lock. */
    precondition?: EnterpriseWorkflowTreeUpsertPrecondition;
  },
  options: EnterpriseTreeStoreOptions = {},
): EnterpriseWorkflowTreeUpsertResult {
  const now = params.now ?? Date.now();
  const definitionJson = JSON.stringify(params.tree);
  return runOpenClawStateWriteTransaction<EnterpriseWorkflowTreeUpsertResult>((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
    const currentRow = executeSqliteQueryTakeFirstSync(
      database.db,
      stateDb
        .selectFrom("enterprise_workflow_trees")
        .selectAll()
        .where("tree_id", "=", params.tree.id),
    ) as EnterpriseTreeRow | undefined;
    if (params.precondition) {
      // BEGIN IMMEDIATE is already held here. Keep this check, history append,
      // tree write, and knowledge reconciliation in the same transaction.
      if (params.precondition.kind === "create-only") {
        if (currentRow) {
          return { upserted: false, reason: "already-exists" };
        }
      } else if (params.precondition.kind === "expected-bundle-state") {
        if (params.precondition.treeId !== params.tree.id) {
          return { upserted: false, reason: "tree-changed" };
        }
        const expectsImported = params.precondition.expectedSource === "imported";
        if (Boolean(currentRow) !== expectsImported) {
          return { upserted: false, reason: "tree-changed" };
        }
        if (currentRow) {
          let currentTree: WorkflowTreeDefinition;
          try {
            currentTree = rowToRecord(currentRow).tree;
          } catch {
            return { upserted: false, reason: "tree-unavailable" };
          }
          if (hashWorkflowTree(currentTree) !== params.precondition.treeHash) {
            return { upserted: false, reason: "tree-changed" };
          }
        }
        // The bundle replaces both tables. Checking the owned rows under the same
        // BEGIN IMMEDIATE lock closes the race where the tree bytes stay equal but
        // another importer changes its inlined knowledge after preview.
        const knowledgeFingerprint = fingerprintBundledKnowledgeForTreeFromDatabase(
          database,
          params.tree.id,
        );
        if (knowledgeFingerprint !== params.precondition.knowledgeFingerprint) {
          return { upserted: false, reason: "tree-changed" };
        }
      } else if (params.precondition.expectedSource === "builtin" && currentRow) {
        // A built-in has no store row. Even identical bytes here mean another
        // writer installed an override after preview, so source identity changed.
        return { upserted: false, reason: "tree-changed" };
      } else if (!currentRow) {
        // Built-ins are process-stable and have no store row. An expected
        // imported row disappearing is a conflict, but a matched built-in may
        // be overridden while the imported slot remains empty.
        if (params.precondition.expectedSource === "imported") {
          return { upserted: false, reason: "tree-changed" };
        }
      } else {
        let currentTree: WorkflowTreeDefinition;
        try {
          currentTree = rowToRecord(currentRow).tree;
        } catch {
          return { upserted: false, reason: "tree-unavailable" };
        }
        if (hashWorkflowTree(currentTree) !== params.precondition.hash) {
          return { upserted: false, reason: "tree-changed" };
        }
      }
    }
    // Preserve the definition being overwritten (upgrade/divergence) first.
    const priorRevision = snapshotCurrentTreeRow(database, params.tree.id, now);

    executeSqliteQuerySync(
      database.db,
      stateDb
        .insertInto("enterprise_workflow_trees")
        .values({
          tree_id: params.tree.id,
          version: params.tree.version,
          name: params.tree.name,
          definition_json: definitionJson,
          source_format: params.sourceFormat,
          imported_at: now,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.column("tree_id").doUpdateSet({
            version: params.tree.version,
            name: params.tree.name,
            definition_json: definitionJson,
            source_format: params.sourceFormat,
            updated_at: now,
          }),
        ),
    );
    // Record this save as the next revision in the append-only history, in the
    // same transaction so the current row and its snapshot never diverge.
    executeSqliteQuerySync(
      database.db,
      stateDb.insertInto("enterprise_workflow_tree_versions").values({
        tree_id: params.tree.id,
        revision: priorRevision + 1,
        version: params.tree.version,
        name: params.tree.name,
        definition_json: definitionJson,
        source_format: params.sourceFormat,
        saved_at: now,
      }),
    );
    // A bundle import replaces this tree's persisted foundation set in the SAME
    // transaction, so tree and knowledge are never half-applied. A plain tree
    // import carries no foundation content and intentionally leaves the set alone:
    // editing a definition must not destroy the only persisted copy of its bundle.
    // Runtime hydration filters these rows against the current healthy definition.
    // Bundled knowledge is not part of revision history; re-import a bundle to
    // restore different content.
    if (params.bundledFoundations) {
      // Bundle import: replace with the inlined set (the importer already filtered
      // it to the tree's references), so a re-import drops foundations it omitted.
      replaceBundledKnowledgeFoundationsForTree(database, {
        treeId: params.tree.id,
        foundations: params.bundledFoundations,
        now,
      });
    }
    return { upserted: true, replacedImported: currentRow !== undefined };
  }, stateDatabaseOptions(options));
}

/**
 * List recorded revisions of a tree, newest first (metadata only). `limit`
 * bounds the rows returned — history is append-only and grows per save, so
 * callers (the Gateway read) must cap it to avoid unbounded work/payloads.
 */
export function listEnterpriseWorkflowTreeVersions(
  treeId: string,
  options: EnterpriseTreeStoreOptions = {},
  limit?: number,
): WorkflowTreeVersionRecord[] {
  if (!treeStoreDatabaseExists(options)) {
    return [];
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
  const baseQuery = stateDb
    .selectFrom("enterprise_workflow_tree_versions")
    .select(["tree_id", "revision", "version", "name", "source_format", "saved_at"])
    .where("tree_id", "=", treeId)
    .orderBy("revision", "desc");
  const rows = executeSqliteQuerySync(
    database.db,
    limit === undefined ? baseQuery : baseQuery.limit(limit),
  ).rows as EnterpriseTreeVersionRow[];
  return rows.map((row) => ({
    treeId: row.tree_id,
    revision: normalizeSqliteNumber(row.revision) ?? 0,
    version: row.version,
    name: row.name,
    sourceFormat: parseSourceFormat(row.source_format),
    savedAt: normalizeSqliteNumber(row.saved_at) ?? 0,
  }));
}

/** Tree ids that still own an append-only revision history, sorted for stable UI lists. */
export function listEnterpriseWorkflowTreeHistoryIds(
  options: EnterpriseTreeStoreOptions = {},
): string[] {
  if (!treeStoreDatabaseExists(options)) {
    return [];
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("enterprise_workflow_tree_versions")
      .select("tree_id")
      .distinct()
      .orderBy("tree_id", "asc"),
  ).rows as Array<{ tree_id: string }>;
  return rows.map((row) => row.tree_id);
}

/** Read one recorded revision's full definition (null when absent). */
export function getEnterpriseWorkflowTreeVersion(
  treeId: string,
  revision: number,
  options: EnterpriseTreeStoreOptions = {},
): WorkflowTreeVersionDetail | null {
  if (!treeStoreDatabaseExists(options)) {
    return null;
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb
      .selectFrom("enterprise_workflow_tree_versions")
      .selectAll()
      .where("tree_id", "=", treeId)
      .where("revision", "=", revision),
  ) as EnterpriseTreeVersionRow | undefined;
  if (!row) {
    return null;
  }
  const parsed = JSON.parse(row.definition_json) as unknown;
  const validated = validateWorkflowTreeDefinition(parsed);
  if (!validated.ok) {
    // History snapshots were validated at save; a failure means a newer,
    // incompatible schema or a tampered row — surface it rather than restore junk.
    const first = validated.issues[0];
    throw new Error(
      `stored workflow tree version "${treeId}"@r${revision} no longer validates (${first.path}: ${first.message})`,
    );
  }
  return {
    tree: validated.tree,
    sourceFormat: parseSourceFormat(row.source_format),
    revision: normalizeSqliteNumber(row.revision) ?? 0,
    savedAt: normalizeSqliteNumber(row.saved_at) ?? 0,
  };
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
  rowErrors: Array<{ treeId: string; message: string; fingerprint: string }>;
};

type EnterpriseWorkflowTreeDeleteResult =
  | { removed: true }
  | { removed: false; reason: "not-found" | "tree-changed" | "tree-unavailable" };

/** Read every imported tree, ordered by tree id, with per-row error capture. */
export function listEnterpriseWorkflowTrees(
  options: EnterpriseTreeStoreOptions = {},
): EnterpriseWorkflowTreeReadResult {
  if (!treeStoreDatabaseExists(options)) {
    return { records: [], rowErrors: [] };
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  return readEnterpriseWorkflowTreesFromDatabase(database);
}

function readEnterpriseWorkflowTreesFromDatabase(
  database: OpenClawStateDatabase,
): EnterpriseWorkflowTreeReadResult {
  const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    stateDb.selectFrom("enterprise_workflow_trees").selectAll().orderBy("tree_id", "asc"),
  ).rows as EnterpriseTreeRow[];
  const records: ImportedWorkflowTreeRecord[] = [];
  const rowErrors: EnterpriseWorkflowTreeReadResult["rowErrors"] = [];
  for (const row of rows) {
    try {
      records.push(rowToRecord(row));
    } catch (err) {
      rowErrors.push({
        treeId: row.tree_id,
        message: err instanceof Error ? err.message : String(err),
        fingerprint: fingerprintEnterpriseTreeRow(row),
      });
    }
  }
  return { records, rowErrors };
}

export type EnterpriseWorkflowKnowledgeSnapshot = {
  trees: EnterpriseWorkflowTreeReadResult;
  foundations: BundledKnowledgeFoundationReadResult;
};

/** Read tree definitions and their owned knowledge from one SQLite snapshot. */
export function readEnterpriseWorkflowKnowledgeSnapshot(
  options: EnterpriseTreeStoreOptions = {},
): EnterpriseWorkflowKnowledgeSnapshot {
  if (!treeStoreDatabaseExists(options)) {
    return {
      trees: { records: [], rowErrors: [] },
      foundations: { records: [], rowErrors: [] },
    };
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  return runSqliteReadTransactionSync(database.db, () => ({
    trees: readEnterpriseWorkflowTreesFromDatabase(database),
    foundations: readBundledKnowledgeFoundationsFromDatabase(database),
  }));
}

function deleteEnterpriseWorkflowTreeInTransaction(
  database: OpenClawStateDatabase,
  treeId: string,
): boolean {
  const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
  // Preserve the current definition in history before deleting the live row,
  // so a pre-history tree removed before its first save stays restorable.
  snapshotCurrentTreeRow(database, treeId, Date.now());
  const result = executeSqliteQuerySync(
    database.db,
    stateDb.deleteFrom("enterprise_workflow_trees").where("tree_id", "=", treeId),
  );
  const removed = (normalizeSqliteNumber(result.numAffectedRows ?? 0n) ?? 0) > 0;
  if (removed) {
    // There is no FK to cascade from (built-in trees are code, not rows), so
    // this has to be explicit: otherwise the removed tree's objects and bundled
    // foundations survive and are inherited by whatever tree next claims the id.
    deleteOntologyObjectsForTree(database, treeId);
    deleteBundledKnowledgeFoundationsForTree(database, treeId);
  }
  return removed;
}

/** Delete one imported tree. Returns true when a row was removed. */
export function deleteEnterpriseWorkflowTree(
  treeId: string,
  options: EnterpriseTreeStoreOptions = {},
): boolean {
  if (!treeStoreDatabaseExists(options)) {
    return false;
  }
  return runOpenClawStateWriteTransaction(
    (database) => deleteEnterpriseWorkflowTreeInTransaction(database, treeId),
    stateDatabaseOptions(options),
  );
}

/** Atomically remove an imported row only while its expected state still holds. */
export function deleteEnterpriseWorkflowTreeIfUnchanged(
  params:
    | { treeId: string; expectedHash: string }
    | { treeId: string; expectedInvalidFingerprint: string },
  options: EnterpriseTreeStoreOptions = {},
): EnterpriseWorkflowTreeDeleteResult {
  if (!treeStoreDatabaseExists(options)) {
    return { removed: false, reason: "not-found" };
  }
  return runOpenClawStateWriteTransaction<EnterpriseWorkflowTreeDeleteResult>((database) => {
    // BEGIN IMMEDIATE excludes other writers before this read; comparison,
    // history snapshot, deletion, and owned-data cleanup must stay in this txn.
    const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      stateDb
        .selectFrom("enterprise_workflow_trees")
        .selectAll()
        .where("tree_id", "=", params.treeId),
    ) as EnterpriseTreeRow | undefined;
    if (!row) {
      return { removed: false, reason: "not-found" };
    }
    let tree: WorkflowTreeDefinition;
    try {
      tree = rowToRecord(row).tree;
    } catch {
      if (!("expectedInvalidFingerprint" in params)) {
        return { removed: false, reason: "tree-unavailable" };
      }
      if (fingerprintEnterpriseTreeRow(row) !== params.expectedInvalidFingerprint) {
        return { removed: false, reason: "tree-changed" };
      }
      return deleteEnterpriseWorkflowTreeInTransaction(database, params.treeId)
        ? { removed: true }
        : { removed: false, reason: "not-found" };
    }
    if ("expectedInvalidFingerprint" in params || hashWorkflowTree(tree) !== params.expectedHash) {
      return { removed: false, reason: "tree-changed" };
    }
    return deleteEnterpriseWorkflowTreeInTransaction(database, params.treeId)
      ? { removed: true }
      : { removed: false, reason: "not-found" };
  }, stateDatabaseOptions(options));
}
