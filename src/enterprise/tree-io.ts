/**
 * Workflow tree import/export: YAML/JSON exchange artifacts validated against
 * the versioned tree schema. Content-level only — file reads/writes belong to
 * the calling surface (CLI today, gateway later).
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { BUILTIN_WORKFLOW_TREES } from "./builtin-trees.js";
import { reloadPersistedBundleFoundations } from "./knowledge-bundle-loader.js";
import { hashWorkflowTree } from "./plan.js";
import { validateWorkflowTreeDefinition, type WorkflowTreeValidationIssue } from "./schema.js";
import {
  getWorkflowTreeRegistrySnapshot,
  invalidateWorkflowTreeRegistry,
} from "./tree-registry.js";
import {
  deleteEnterpriseWorkflowTree,
  deleteEnterpriseWorkflowTreeIfUnchanged,
  upsertEnterpriseWorkflowTree,
  type EnterpriseTreeStoreOptions,
  type WorkflowTreeSourceFormat,
} from "./tree-store.sqlite.js";
import type { WorkflowTreeDefinition } from "./types.js";

export type WorkflowTreeImportResult =
  | { ok: true; tree: WorkflowTreeDefinition; replaced: "builtin" | "imported" | null }
  | { ok: false; issues: WorkflowTreeValidationIssue[] };

export type WorkflowTreeExportResult =
  | { ok: true; content: string; source: "builtin" | "imported" }
  | { ok: false; reason: string };

/** Infer the exchange format from a file path extension. */
export function inferWorkflowTreeFileFormat(
  filePath: string,
): WorkflowTreeSourceFormat | undefined {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    return "yaml";
  }
  if (lower.endsWith(".json")) {
    return "json";
  }
  return undefined;
}

/** Parse and validate one tree definition from file content. */
export function parseWorkflowTreeContent(
  content: string,
  format: WorkflowTreeSourceFormat,
): WorkflowTreeImportResult {
  let raw: unknown;
  try {
    raw = format === "yaml" ? parseYaml(content) : JSON.parse(content);
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          path: "",
          message: `invalid ${format.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  const result = validateWorkflowTreeDefinition(raw);
  if (!result.ok) {
    return { ok: false, issues: result.issues };
  }
  return { ok: true, tree: result.tree, replaced: null };
}

/** Validate + persist one tree definition, refreshing the runtime registry. */
export function importWorkflowTreeContent(
  params: {
    content: string;
    format: WorkflowTreeSourceFormat;
    createOnly?: boolean;
    expectedHash?: string;
  },
  options: EnterpriseTreeStoreOptions = {},
): WorkflowTreeImportResult {
  const parsed = parseWorkflowTreeContent(params.content, params.format);
  if (!parsed.ok) {
    return parsed;
  }
  const snapshot = getWorkflowTreeRegistrySnapshot(options);
  const existing = snapshot.entries.find((entry) => entry.tree.id === parsed.tree.id);
  if (params.createOnly && BUILTIN_WORKFLOW_TREES.some((tree) => tree.id === parsed.tree.id)) {
    return {
      ok: false,
      issues: [{ path: "id", message: `workflow tree "${parsed.tree.id}" already exists` }],
    };
  }
  if (
    params.expectedHash !== undefined &&
    existing?.source === "builtin" &&
    hashWorkflowTree(existing.tree) !== params.expectedHash
  ) {
    return {
      ok: false,
      issues: [
        {
          path: "id",
          message: `workflow tree "${parsed.tree.id}" changed since it was loaded; discard this edit, reload the tree, and reapply your change`,
        },
      ],
    };
  }
  const precondition = params.createOnly
    ? ({ kind: "create-only" } as const)
    : params.expectedHash !== undefined
      ? ({
          kind: "expected-hash",
          hash: params.expectedHash,
          expectedSource: existing?.source ?? "imported",
        } as const)
      : undefined;
  const write = upsertEnterpriseWorkflowTree(
    {
      tree: parsed.tree,
      sourceFormat: params.format,
      ...(precondition ? { precondition } : {}),
    },
    options,
  );
  if (!write.upserted) {
    // The write lock observed a newer external state than the process snapshot.
    // Refresh both registries so the instructed reload does not repeat the conflict.
    refreshAfterTreeStoreChange(options);
    return {
      ok: false,
      issues: [
        {
          path: "id",
          message:
            write.reason === "already-exists"
              ? `workflow tree "${parsed.tree.id}" already exists`
              : `workflow tree "${parsed.tree.id}" changed since it was loaded; discard this edit, reload the tree, and reapply your change`,
        },
      ],
    };
  }
  refreshAfterTreeStoreChange(options);
  const replaced = write.replacedImported
    ? "imported"
    : existing?.source === "builtin"
      ? "builtin"
      : null;
  return { ok: true, tree: parsed.tree, replaced };
}

/** Serialize one registered tree (builtin or imported) for export. */
export function exportWorkflowTree(
  params: { treeId: string; format: WorkflowTreeSourceFormat },
  options: EnterpriseTreeStoreOptions = {},
): WorkflowTreeExportResult {
  // Use the full snapshot, not the resolved entry, so a corrupt imported
  // override or an unreadable store fails closed here instead of exporting a
  // stale built-in the caller would then edit or restore as the wrong tree.
  const snapshot = getWorkflowTreeRegistrySnapshot(options);
  if (snapshot.storeError !== undefined) {
    return { ok: false, reason: snapshot.storeError };
  }
  const importError = snapshot.importErrors.find((issue) => issue.treeId === params.treeId);
  if (importError) {
    return { ok: false, reason: importError.message };
  }
  const entry = snapshot.entries.find((candidate) => candidate.tree.id === params.treeId);
  if (!entry) {
    return { ok: false, reason: `no workflow tree registered with id "${params.treeId}"` };
  }
  return {
    ok: true,
    content: serializeWorkflowTree(entry.tree, params.format),
    source: entry.source,
  };
}

/** Remove only while the imported row still matches the state the operator saw. */
export function removeImportedWorkflowTreeIfUnchanged(
  params:
    | { treeId: string; expectedHash: string }
    | { treeId: string; expectedInvalidFingerprint: string },
  options: EnterpriseTreeStoreOptions = {},
): ReturnType<typeof deleteEnterpriseWorkflowTreeIfUnchanged> {
  let result: ReturnType<typeof deleteEnterpriseWorkflowTreeIfUnchanged>;
  try {
    result = deleteEnterpriseWorkflowTreeIfUnchanged(params, options);
  } catch {
    invalidateWorkflowTreeRegistry();
    return { removed: false, reason: "tree-unavailable" };
  }
  // A failed guard can itself reveal a newer cross-process row. Refresh so the
  // caller's next list/get observes the state named by the structured result.
  refreshAfterTreeStoreChange(options);
  return result;
}

function refreshAfterTreeStoreChange(options: EnterpriseTreeStoreOptions): void {
  invalidateWorkflowTreeRegistry();
  // Tree writes can change which persisted foundations are reachable, or delete
  // their rows entirely. Reconcile the live registry immediately so an active
  // run's next knowledge_search reflects the current definition.
  reloadPersistedBundleFoundations(options);
}

/** Remove one imported tree; built-ins reappear when their override is removed. */
export function removeImportedWorkflowTree(
  treeId: string,
  options: EnterpriseTreeStoreOptions = {},
): boolean {
  const removed = deleteEnterpriseWorkflowTree(treeId, options);
  if (removed) {
    refreshAfterTreeStoreChange(options);
  }
  return removed;
}

export function serializeWorkflowTree(
  tree: WorkflowTreeDefinition,
  format: WorkflowTreeSourceFormat,
): string {
  if (format === "yaml") {
    return stringifyYaml(tree);
  }
  return `${JSON.stringify(tree, null, 2)}\n`;
}
