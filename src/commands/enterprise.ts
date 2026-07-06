/**
 * Implements `openclaw enterprise` command output: workflow tree registry
 * management (list/validate/import/export/remove) and enterprise run trace
 * inspection (runs list/show).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { WorkflowTreeValidationIssue } from "../enterprise/schema.js";
import {
  getEnterpriseRunRecord,
  listEnterpriseRunEvents,
  listEnterpriseRunExecutions,
  listEnterpriseRunRecords,
} from "../enterprise/trace-store.sqlite.js";
import {
  exportWorkflowTree,
  importWorkflowTreeContent,
  inferWorkflowTreeFileFormat,
  parseWorkflowTreeContent,
} from "../enterprise/tree-io.js";
import { removeImportedWorkflowTree } from "../enterprise/tree-io.js";
import { getWorkflowTreeRegistrySnapshot } from "../enterprise/tree-registry.js";
import type { WorkflowTreeSourceFormat } from "../enterprise/tree-store.sqlite.js";
import type { RuntimeEnv } from "../runtime.js";

const GATEWAY_RELOAD_HINT =
  "A running gateway loads tree definitions at startup; restart it to apply this change.";

function readTreeFile(
  filePath: string,
  runtime: RuntimeEnv,
): { content: string; format: WorkflowTreeSourceFormat } | null {
  const format = inferWorkflowTreeFileFormat(filePath);
  if (!format) {
    runtime.error(`Unsupported file extension for ${filePath}; use .yaml, .yml, or .json.`);
    runtime.exit(1);
    return null;
  }
  try {
    return { content: readFileSync(filePath, "utf8"), format };
  } catch (err) {
    runtime.error(
      `Could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    runtime.exit(1);
    return null;
  }
}

function printValidationIssues(
  issues: readonly WorkflowTreeValidationIssue[],
  runtime: RuntimeEnv,
): void {
  runtime.error(`Invalid workflow tree definition (${issues.length} issue(s)):`);
  for (const issue of issues) {
    runtime.error(`  - ${issue.path || "(root)"}: ${issue.message}`);
  }
}

export function enterpriseTreesListCommand(runtime: RuntimeEnv, opts: { json?: boolean }): void {
  const snapshot = getWorkflowTreeRegistrySnapshot();
  const hasErrors = snapshot.importErrors.length > 0 || snapshot.storeError !== undefined;
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          trees: snapshot.entries.map((entry) => ({
            id: entry.tree.id,
            version: entry.tree.version,
            name: entry.tree.name,
            source: entry.source,
            nodeCount: countTreeNodes(entry.tree.root),
          })),
          importErrors: snapshot.importErrors,
          ...(snapshot.storeError !== undefined ? { storeError: snapshot.storeError } : {}),
        },
        null,
        2,
      ),
    );
    if (hasErrors) {
      runtime.exit(1);
    }
    return;
  }
  for (const entry of snapshot.entries) {
    const badge = entry.source === "imported" ? theme.accent("imported") : theme.muted("builtin");
    runtime.log(`${entry.tree.id}@${entry.tree.version} (${badge}) — ${entry.tree.name}`);
  }
  for (const failure of snapshot.importErrors) {
    runtime.error(
      `Import failed to load: ${failure.treeId} — ${failure.message} (enforce-mode runs are blocked until it is re-imported or removed)`,
    );
  }
  if (snapshot.storeError) {
    runtime.error(`Tree store unreadable: ${snapshot.storeError}`);
  }
  if (hasErrors) {
    runtime.exit(1);
  }
}

export function enterpriseTreesValidateCommand(filePath: string, runtime: RuntimeEnv): void {
  const file = readTreeFile(filePath, runtime);
  if (!file) {
    return;
  }
  const result = parseWorkflowTreeContent(file.content, file.format);
  if (!result.ok) {
    printValidationIssues(result.issues, runtime);
    runtime.exit(1);
    return;
  }
  runtime.log(
    `${theme.success("Valid")}: ${result.tree.id}@${result.tree.version} — ${result.tree.name} (${countTreeNodes(result.tree.root)} node(s))`,
  );
}

export function enterpriseTreesImportCommand(filePath: string, runtime: RuntimeEnv): void {
  const file = readTreeFile(filePath, runtime);
  if (!file) {
    return;
  }
  const result = importWorkflowTreeContent({ content: file.content, format: file.format });
  if (!result.ok) {
    printValidationIssues(result.issues, runtime);
    runtime.exit(1);
    return;
  }
  const action =
    result.replaced === null
      ? "Imported"
      : result.replaced === "builtin"
        ? "Imported (overrides built-in tree)"
        : "Updated";
  runtime.log(`${action}: ${result.tree.id}@${result.tree.version} — ${result.tree.name}`);
  runtime.log(theme.muted(GATEWAY_RELOAD_HINT));
}

export function enterpriseTreesExportCommand(
  treeId: string,
  runtime: RuntimeEnv,
  opts: { out?: string; format?: string },
): void {
  const format = resolveExportFormat(opts, runtime);
  if (!format) {
    return;
  }
  const result = exportWorkflowTree({ treeId, format });
  if (!result.ok) {
    runtime.error(result.reason);
    runtime.exit(1);
    return;
  }
  if (opts.out) {
    try {
      writeFileSync(opts.out, result.content, "utf8");
    } catch (err) {
      runtime.error(
        `Could not write ${opts.out}: ${err instanceof Error ? err.message : String(err)}`,
      );
      runtime.exit(1);
      return;
    }
    runtime.log(`Exported ${treeId} (${result.source}) to ${opts.out}`);
    return;
  }
  runtime.log(result.content);
}

export function enterpriseTreesRemoveCommand(treeId: string, runtime: RuntimeEnv): void {
  const removed = removeImportedWorkflowTree(treeId);
  if (!removed) {
    runtime.error(
      `No imported workflow tree with id "${treeId}". Built-in trees cannot be removed, only overridden.`,
    );
    runtime.exit(1);
    return;
  }
  runtime.log(`Removed imported workflow tree ${treeId}.`);
  runtime.log(theme.muted(GATEWAY_RELOAD_HINT));
}

export function enterpriseRunsListCommand(
  runtime: RuntimeEnv,
  opts: { limit?: number; json?: boolean },
): void {
  const records = listEnterpriseRunRecords(opts.limit ? { limit: opts.limit } : {});
  if (opts.json) {
    runtime.log(JSON.stringify(records, null, 2));
    return;
  }
  if (records.length === 0) {
    runtime.log("No enterprise runs recorded yet.");
    return;
  }
  for (const record of records) {
    runtime.log(
      `${new Date(record.createdAt).toISOString()} ${formatRunStatus(record.status)} ` +
        `run=${record.runId} exec=${record.executionId.slice(0, 8)} ` +
        `${record.treeId}@${record.treeVersion} — ${record.requestSummary}`,
    );
  }
}

export function enterpriseRunsShowCommand(
  runId: string,
  runtime: RuntimeEnv,
  opts: { json?: boolean },
): void {
  const record = getEnterpriseRunRecord(runId);
  if (!record) {
    runtime.error(`No enterprise run trace found for runId "${runId}".`);
    runtime.exit(1);
    return;
  }
  const events = listEnterpriseRunEvents(record.executionId);
  if (opts.json) {
    const executions = listEnterpriseRunExecutions(runId);
    runtime.log(
      JSON.stringify({ latest: record, events, executionCount: executions.length }, null, 2),
    );
    return;
  }
  runtime.log(`Run ${record.runId} (latest execution ${record.executionId})`);
  runtime.log(`  Status: ${formatRunStatus(record.status)}  Mode: ${record.mode}`);
  runtime.log(`  Tree: ${record.treeId}@${record.treeVersion}`);
  runtime.log(`  Request: ${record.requestSummary}`);
  runtime.log(`  Active node: ${record.plan.activeNodeId}`);
  runtime.log("  Nodes:");
  for (const node of record.plan.nodes) {
    const marker = node.nodeId === record.plan.activeNodeId ? "*" : " ";
    runtime.log(`   ${marker} ${node.seq}. ${node.nodeId} — ${node.title}`);
  }
  runtime.log("  Events:");
  for (const event of events) {
    const where = event.nodeId ? ` node=${event.nodeId}` : "";
    runtime.log(`    ${event.seq}. ${event.kind}${where} ${JSON.stringify(event.payload)}`);
  }
}

function resolveExportFormat(
  opts: { out?: string; format?: string },
  runtime: RuntimeEnv,
): WorkflowTreeSourceFormat | null {
  if (opts.format) {
    if (opts.format !== "yaml" && opts.format !== "json") {
      runtime.error(`Unknown format "${opts.format}"; use yaml or json.`);
      runtime.exit(1);
      return null;
    }
    return opts.format;
  }
  if (opts.out) {
    const inferred = inferWorkflowTreeFileFormat(opts.out);
    if (inferred) {
      return inferred;
    }
  }
  return "yaml";
}

function formatRunStatus(status: string): string {
  switch (status) {
    case "completed":
      return theme.success(status);
    case "running":
      return theme.accent(status);
    default:
      return theme.warn(status);
  }
}

function countTreeNodes(node: { children?: unknown[] }): number {
  let count = 1;
  for (const child of node.children ?? []) {
    count += countTreeNodes(child as { children?: unknown[] });
  }
  return count;
}
