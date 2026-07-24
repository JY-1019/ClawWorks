/**
 * Workflow tree import/export: YAML/JSON exchange artifacts validated against
 * the versioned tree schema. Content-level only — file reads/writes belong to
 * the calling surface (CLI today, gateway later).
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { reloadPersistedBundleFoundations } from "./knowledge-bundle-loader.js";
import { validateWorkflowTreeDefinition, type WorkflowTreeValidationIssue } from "./schema.js";
import {
  getWorkflowTreeRegistryEntry,
  getWorkflowTreeRegistrySnapshot,
  invalidateWorkflowTreeRegistry,
} from "./tree-registry.js";
import {
  deleteEnterpriseWorkflowTree,
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
  params: { content: string; format: WorkflowTreeSourceFormat },
  options: EnterpriseTreeStoreOptions = {},
): WorkflowTreeImportResult {
  const parsed = parseWorkflowTreeContent(params.content, params.format);
  if (!parsed.ok) {
    return parsed;
  }
  const existing = getWorkflowTreeRegistryEntry(parsed.tree.id, options);
  upsertEnterpriseWorkflowTree({ tree: parsed.tree, sourceFormat: params.format }, options);
  invalidateWorkflowTreeRegistry();
  // The upsert pruned any bundled foundations this tree no longer references;
  // reconcile the live registry from the canonical store so a running gateway
  // stops serving them immediately, not only after a restart.
  reloadPersistedBundleFoundations(options);
  return { ok: true, tree: parsed.tree, replaced: existing?.source ?? null };
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

/** Remove one imported tree; built-ins reappear when their override is removed. */
export function removeImportedWorkflowTree(
  treeId: string,
  options: EnterpriseTreeStoreOptions = {},
): boolean {
  const removed = deleteEnterpriseWorkflowTree(treeId, options);
  if (removed) {
    invalidateWorkflowTreeRegistry();
    // The delete dropped this tree's bundled-foundation rows; reconcile the live
    // bundle registry from the remaining rows so a running gateway stops serving
    // a removed tree's foundations (keeping ones another tree still carries). This
    // reconciles immediately, so an already-active run's next knowledge_search
    // reflects the change (known limitation; see docs/cli/enterprise.md).
    reloadPersistedBundleFoundations(options);
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
