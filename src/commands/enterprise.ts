/**
 * Implements `openclaw enterprise` command output: workflow tree registry
 * management (list/validate/import/export/remove) and enterprise run trace
 * inspection (runs list/show).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { stripAnsi } from "../agents/utils/ansi.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEnterpriseMcpServers } from "../enterprise/active-runs.js";
import { exportWorkflowBundle, importWorkflowBundle } from "../enterprise/bundle-io.js";
import { loadPersistedBundleFoundations } from "../enterprise/knowledge-bundle-loader.js";
import type { WorkflowTreeValidationIssue } from "../enterprise/schema.js";
import { stripUnsafeDisplayChars } from "../enterprise/text-safety.js";
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
import {
  countWorkflowTreeNodes,
  getWorkflowTreeRegistrySnapshot,
} from "../enterprise/tree-registry.js";
import type { WorkflowTreeSourceFormat } from "../enterprise/tree-store.sqlite.js";
import {
  collectWorkflowTreeWarnings,
  type WorkflowTreeWarning,
} from "../enterprise/tree-warnings.js";
import type { GovernancePolicy } from "../enterprise/types.js";
import { writeTextAtomic } from "../infra/json-files.js";
import { redactSecrets } from "../logging/redact.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";

const GATEWAY_RELOAD_HINT =
  "A running gateway loads tree definitions at startup; restart it to apply this change.";

// Stated on EVERY compiled policy (both output modes): a glob policy can never encode a
// value threshold/attribute (no reliable detector exists for every way an intent can
// imply one), and every selector family runs through the sandbox tool-policy matcher, so
// the literal text can govern more than it appears. Warn unconditionally rather than guess.
const POLICY_SELECTOR_LIMITATION =
  "Selectors match ids, not values — a policy cannot enforce a threshold, amount, or record " +
  "attribute. Every selector is matched with the sandbox tool-policy rules (case-insensitive, " +
  'tool aliases, "group:" expansion), so it can govern a broader or different id than its literal ' +
  'text (e.g. a "write" selector also governs "apply_patch"). Confirm the selectors capture your intent.';

// Shared by tree and bundle commands: both exchange formats key off the same
// file extensions, so one reader keeps the extension policy in one place.
function readEnterpriseExchangeFile(
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
  subject: string,
): void {
  runtime.error(`Invalid ${subject} (${issues.length} issue(s)):`);
  for (const issue of issues) {
    runtime.error(`  - ${issue.path || "(root)"}: ${issue.message}`);
  }
}

/**
 * Report capabilities a step declares but can never reach. Never fatal: the tree
 * is valid and will load, it just cannot do part of what it says, and only the
 * author can choose between granting the tool and dropping the declaration.
 */
function printWorkflowWarnings(
  warnings: readonly WorkflowTreeWarning[],
  runtime: RuntimeEnv,
): void {
  if (warnings.length === 0) {
    return;
  }
  runtime.error(
    theme.warn(
      `${warnings.length} unreachable capability warning(s) — the model is shown these, the gate refuses them:`,
    ),
  );
  for (const warning of warnings) {
    runtime.error(`  - ${warning.path}: ${warning.message}`);
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
            nodeCount: countWorkflowTreeNodes(entry.tree.root),
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
  const file = readEnterpriseExchangeFile(filePath, runtime);
  if (!file) {
    return;
  }
  const result = parseWorkflowTreeContent(file.content, file.format);
  if (!result.ok) {
    printValidationIssues(result.issues, runtime, "workflow tree definition");
    runtime.exit(1);
    return;
  }
  runtime.log(
    `${theme.success("Valid")}: ${result.tree.id}@${result.tree.version} — ${result.tree.name} (${countWorkflowTreeNodes(result.tree.root)} node(s))`,
  );
  printWorkflowWarnings(collectWorkflowTreeWarnings(result.tree), runtime);
}

export function enterpriseTreesImportCommand(filePath: string, runtime: RuntimeEnv): void {
  const file = readEnterpriseExchangeFile(filePath, runtime);
  if (!file) {
    return;
  }
  const result = importWorkflowTreeContent({ content: file.content, format: file.format });
  if (!result.ok) {
    printValidationIssues(result.issues, runtime, "workflow tree definition");
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
  printWorkflowWarnings(collectWorkflowTreeWarnings(result.tree), runtime);
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

export async function enterpriseBundleExportCommand(
  treeId: string,
  runtime: RuntimeEnv,
  opts: { out?: string; format?: string },
): Promise<void> {
  const format = resolveExportFormat(opts, runtime);
  if (!format) {
    return;
  }
  // The enterprise CLI loads no plugins, so a fresh process has an empty
  // foundation registry; hydrate persisted bundle foundations first or the export
  // would drop the very knowledge the tree references. Server-backed foundations
  // (live plugins) are not visible here and are reported as skipped below; the
  // bundle is a portable artifact of the persisted, self-contained content.
  loadPersistedBundleFoundations();
  // Governance policies live in config, not in the tree, so the export needs it
  // or the bundle arrives unenforced with nothing saying so.
  const result = await exportWorkflowBundle({
    treeId,
    format,
    ...(getRuntimeConfigSnapshot() ? { config: getRuntimeConfigSnapshot() ?? undefined } : {}),
  });
  if (!result.ok) {
    runtime.error(result.reason);
    runtime.exit(1);
    return;
  }
  // Warn (on stderr, so piped stdout stays clean) about foundations that could
  // not be inlined: server-backed corpora expose no full-text read, so the
  // recipient must configure those separately for retrieval to work.
  for (const skipped of result.skippedFoundations) {
    runtime.error(
      `Warning: knowledge foundation "${skipped.id}" was not inlined (${skipped.reason}); the recipient must configure it separately.`,
    );
  }
  if (result.impliedAllowAllKnowledge) {
    runtime.error(
      "Warning: this tree's root declares no knowledge allow-list, so at runtime it can retrieve any " +
        "configured foundation (allow-all). The bundle cannot capture that implicit set; add an explicit " +
        "root knowledgeFoundations allow-list to bundle its knowledge completely.",
    );
  }
  if (opts.out) {
    try {
      // A bundle embeds knowledge snippet text that was protected inside the 0600
      // state DB, so write it privately (atomic temp + rename, mode 0600) instead
      // of inheriting a world-readable 0644 from the umask.
      await writeTextAtomic(opts.out, result.content);
    } catch (err) {
      runtime.error(
        `Could not write ${opts.out}: ${err instanceof Error ? err.message : String(err)}`,
      );
      runtime.exit(1);
      return;
    }
    runtime.log(`Exported bundle for ${treeId} (${result.source}) to ${opts.out}`);
    return;
  }
  runtime.log(result.content);
}

export function enterpriseBundleImportCommand(filePath: string, runtime: RuntimeEnv): void {
  const file = readEnterpriseExchangeFile(filePath, runtime);
  if (!file) {
    return;
  }
  const result = importWorkflowBundle({
    content: file.content,
    format: file.format,
    ...(getRuntimeConfigSnapshot() ? { config: getRuntimeConfigSnapshot() ?? undefined } : {}),
  });
  if (!result.ok) {
    printValidationIssues(result.issues, runtime, "workflow bundle");
    runtime.exit(1);
    return;
  }
  for (const tree of result.trees) {
    const action =
      tree.replaced === null
        ? "Imported tree"
        : tree.replaced === "builtin"
          ? "Imported tree (overrides built-in)"
          : "Updated tree";
    runtime.log(`${action}: ${tree.id}`);
  }
  for (const foundationId of result.foundations) {
    runtime.log(`Imported knowledge foundation: ${foundationId}`);
  }
  printWorkflowWarnings(result.warnings, runtime);
  // Policies are operator config, so importing one behind their back would be
  // wrong — but importing the work-map WITHOUT saying its rules are absent would
  // hand them a governed-looking tree that enforces less than the sender's.
  // Policies are only half the contract. Identical bodies enforce nothing under a
  // weaker mode, so an enforcing sender importing into `observe` or `off` is a
  // downgrade that no policy comparison would reveal.
  if (result.governanceModeDowngrade) {
    runtime.error(
      `Warning: this bundle was exported from a deployment running enterprise mode "${result.governanceModeDowngrade.from}", ` +
        `but this one runs "${result.governanceModeDowngrade.to}". Its policies are recorded here, not applied.`,
    );
  }
  // A different remedy from "missing": the operator already has a rule under this
  // id and has to decide which body is right. Nothing is rewritten for them.
  if (result.conflictingGovernancePolicies.length > 0) {
    runtime.error(
      `Warning: ${result.conflictingGovernancePolicies.length} policy/policies here differ from the ones the bundle was governed by ` +
        `(${result.conflictingGovernancePolicies.join(", ")}). The ids match but the rules do not, so this work-map may enforce differently than the sender intended.`,
    );
  }
  if (result.missingGovernancePolicies.length > 0) {
    runtime.error(
      `Warning: this bundle was governed by ${result.missingGovernancePolicies.length} policy/policies this deployment does not configure ` +
        `(${result.missingGovernancePolicies.join(", ")}). The work-map imported, but it will enforce less here until they are added to enterprise.governance.policies` +
        `${
          result.governanceModeDowngrade
            ? ` AND enterprise.mode is raised to "${result.governanceModeDowngrade.from}", the mode the sender ran — policy decisions only block when enforcing`
            : ""
        }.`,
    );
  }
  // Warn about foundations the trees reference but the bundle did not carry (the
  // sender's export skipped them as server-backed): retrieval for these is dead
  // until the operator configures them on this deployment.
  if (result.missingFoundations.length > 0) {
    runtime.error(
      `Warning: these referenced knowledge foundations were not included and must be configured separately: ${result.missingFoundations.join(", ")}`,
    );
  }
  // Surface referenced tool names: a bundle carries tree scope and knowledge,
  // never tool implementations, so the operator must confirm the target
  // deployment provides these.
  if (result.requiredTools.length > 0) {
    runtime.log(theme.muted(`Required tools: ${result.requiredTools.join(", ")}`));
  }
  // Skills are named dependencies too: the bundle carries the ids, not the skill
  // content, so the operator must confirm the target has them installed.
  if (result.requiredSkills.length > 0) {
    runtime.log(theme.muted(`Required skills: ${result.requiredSkills.join(", ")}`));
  }
  // MCP servers are the same kind of named dependency, and the most silent one:
  // an attachment naming a server this deployment never registered is inert, and
  // nothing else on import would say so. Only the names this deployment is
  // MISSING are a warning, though — listing the satisfied ones as a problem makes
  // a clean import read as a broken one.
  if (result.requiredMcpServers.length > 0) {
    // ENABLED entries only, the same set every MCP projection emits: a name that
    // is registered but turned off leaves the attachment just as inert as a
    // missing one, so reporting it as satisfied would be the opposite of true.
    const registered = new Set(
      resolveEnterpriseMcpServers(getRuntimeConfigSnapshot() ?? undefined),
    );
    const missing = result.requiredMcpServers.filter((name) => !registered.has(name));
    if (missing.length > 0) {
      runtime.error(
        `Warning: these MCP servers must be registered under mcp.servers before the imported steps can call them: ${missing.join(", ")}`,
      );
    }
    const satisfied = result.requiredMcpServers.filter((name) => registered.has(name));
    if (satisfied.length > 0) {
      runtime.log(theme.muted(`Required MCP servers: ${satisfied.join(", ")}`));
    }
  }
  runtime.log(theme.muted(GATEWAY_RELOAD_HINT));
}

// A compile FAILURE reason carries raw, untrusted provider/model text (auth/quota
// errors, refusals) that never passes the policy schema, so it can hold ANSI/OSC
// escapes, control/bidi/zero-width chars, newlines, or credentials. Normalize to the
// terminal-safe display form FIRST — strip ANSI/OSC escapes, then delete zero-width
// format chars and space out control/separator chars (stripUnsafeDisplayChars) — and
// only THEN redact. Deleting the zero-width chars rejoins a secret an attacker split
// with one (e.g. sk-...<U+200B>...) so redactSecrets can still match it; redacting
// first, or leaving the split as a space, would let the credential through.
function sanitizeCompileFailure(text: string): string {
  const normalized = stripUnsafeDisplayChars(stripAnsi(text)).replace(/\s+/g, " ").trim();
  const redacted = redactSecrets(normalized);
  return redacted.length > 400 ? `${redacted.slice(0, 399)}...` : redacted;
}

// Readable rendering for the default (non-JSON) path. --json emits the raw
// policy instead; a summary here keeps the human output free of the machine
// contract so both paths stay honest about what stdout carries.
function renderPolicySummary(policy: GovernancePolicy): string {
  // Every field is schema-clean: id is [a-z0-9-] dotted, selector globs and the
  // description reject control/format/separator chars (schema.ts). So render them
  // faithfully — the summary must equal the policy the operator pastes. Selector
  // globs are quoted so "exec, shell" (one glob) reads differently from two globs,
  // and the description is shown in full (never truncated, or an appended
  // unrepresentable-threshold caveat could be silently dropped from the review).
  const selector = (label: string, globs: string[] | undefined): string | undefined =>
    globs?.length
      ? `  ${label.padEnd(9)} ${globs.map((glob) => JSON.stringify(glob)).join(", ")}`
      : undefined;
  // A policy with no selectors is a run-level rule that policyAppliesToRun matches
  // against EVERY tree/run — a deny would block all enterprise runs. Render that scope
  // explicitly so an operator cannot miss how broad an all-selectors-omitted draft is.
  const hasSelector = Boolean(
    policy.trees?.length ||
    policy.nodes?.length ||
    policy.tools?.length ||
    policy.actions?.length ||
    policy.knowledge?.length,
  );
  const lines: (string | undefined)[] = [
    `  id        ${policy.id}`,
    `  effect    ${policy.effect}`,
    hasSelector ? undefined : "  scope     every enterprise run (no selectors)",
    selector("trees", policy.trees),
    selector("nodes", policy.nodes),
    selector("tools", policy.tools),
    selector("actions", policy.actions),
    selector("knowledge", policy.knowledge),
  ];
  if (policy.approval) {
    const parts: string[] = [];
    if (policy.approval.timeoutMs !== undefined)
      parts.push(`timeout ${policy.approval.timeoutMs}ms`);
    if (policy.approval.timeoutBehavior)
      parts.push(`on timeout ${policy.approval.timeoutBehavior}`);
    if (policy.approval.severity) parts.push(`severity ${policy.approval.severity}`);
    if (parts.length) lines.push(`  approval  ${parts.join(", ")}`);
  }
  if (policy.description) lines.push(`  note      ${policy.description}`);
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

export async function enterprisePolicyCompileCommand(
  intent: string,
  runtime: RuntimeEnv,
  opts: { model?: string; json?: boolean; cfg: OpenClawConfig; agentId: string },
): Promise<void> {
  // Lazy import: the store-only enterprise commands (list/import/...) must not pull
  // in the model-completion runtime just to be registered on the CLI.
  const { compileGovernancePolicy } =
    await import("../agents/enterprise-policy-compile.runtime.js");
  const result = await compileGovernancePolicy({
    cfg: opts.cfg,
    agentId: opts.agentId,
    intent,
    // An explicit --model may name a bundled static-catalog model; allow that
    // fallback exactly as the local `model run` path does.
    ...(opts.model ? { modelRef: opts.model, allowStaticCatalogFallback: true } : {}),
  });
  if (result.kind === "failed") {
    runtime.error(
      `Could not compile a governance policy: ${sanitizeCompileFailure(result.reason)}`,
    );
    runtime.exit(1);
    return;
  }
  // --json is the machine contract. In JSON mode the CLI framework skips the banner
  // and routes console output (including runtime.log) to stderr; write the policy
  // straight to stdout so jq/config tooling receives exactly the JSON. The limitation
  // warning is UNCONDITIONAL (docs promise it every time), so still emit it — to
  // stderr, keeping stdout pure JSON.
  if (opts.json) {
    writeRuntimeJson(runtime, result.policy);
    runtime.error(theme.muted(POLICY_SELECTOR_LIMITATION));
    return;
  }
  // Default human path: a readable summary on stdout, review reminder on stderr.
  // Adding it to config is the operator's decision, so runtime enforcement stays
  // deterministic and admin-owned.
  runtime.log(`Suggested governance policy (not applied):\n${renderPolicySummary(result.policy)}`);
  runtime.error(
    theme.muted(
      "Review this suggestion, then add it under enterprise.governance.policies in your config. " +
        `${POLICY_SELECTOR_LIMITATION} ` +
        "Re-run with --json to emit the raw policy for scripting. Nothing was changed.",
    ),
  );
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
