/**
 * Workflow subtree selection and per-run plan construction. Selection is the
 * slice-1 request-decomposition placeholder: trees advertise keyword/trigger
 * match hints and the highest-scoring tree wins deterministically.
 */
import { redactSecrets } from "../logging/redact.js";
import { BUILTIN_ASSIST_TREE } from "./builtin-trees.js";
import type {
  EnterpriseMode,
  EnterprisePlanNode,
  EnterpriseRunPlan,
  WorkflowNodeDefinition,
  WorkflowTreeDefinition,
  WorkflowTreeTrigger,
} from "./types.js";

const REQUEST_SUMMARY_MAX_CHARS = 300;
const DIGEST_MAX_STEP_LINES = 12;
const DIGEST_MAX_HINT_LINES = 8;

/** Map an embedded run trigger + spawn lineage onto tree trigger classes. */
export function classifyWorkflowTrigger(params: {
  trigger?: string;
  spawnedBy?: string | null;
}): WorkflowTreeTrigger {
  if (params.spawnedBy) {
    return "subagent";
  }
  switch (params.trigger) {
    case "cron":
    case "heartbeat":
    case "memory":
    case "overflow":
      return "system";
    default:
      return "user";
  }
}

function scoreKeywords(requestText: string, keywords: readonly string[] | undefined): number {
  if (!keywords || keywords.length === 0) {
    return 0;
  }
  const haystack = requestText.toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    if (haystack.includes(keyword.toLowerCase())) {
      hits += 1;
    }
  }
  return hits;
}

export type WorkflowTreeSelection = {
  tree: WorkflowTreeDefinition;
  matchedBy: EnterpriseRunPlan["matchedBy"];
};

/**
 * Pick the tree for a request. Keyword hits beat trigger-only matches; ties
 * break on priority then tree id so selection stays deterministic.
 */
export function selectWorkflowTree(params: {
  requestText: string;
  trigger: WorkflowTreeTrigger;
  trees: readonly WorkflowTreeDefinition[];
}): WorkflowTreeSelection {
  let best: { tree: WorkflowTreeDefinition; keywordHits: number; priority: number } | null = null;
  for (const tree of params.trees) {
    // Omitted or empty trigger lists mean user-triggered (the schema rejects
    // empty arrays; this also covers programmatically-built trees).
    const triggers = tree.match?.triggers?.length ? tree.match.triggers : ["user"];
    if (!triggers.includes(params.trigger)) {
      continue;
    }
    const keywordHits = scoreKeywords(params.requestText, tree.match?.keywords);
    if (tree.match?.keywords?.length && keywordHits === 0) {
      // Keyword-scoped trees only apply when the request mentions them.
      continue;
    }
    const priority = tree.match?.priority ?? 0;
    if (
      !best ||
      keywordHits > best.keywordHits ||
      (keywordHits === best.keywordHits && priority > best.priority) ||
      (keywordHits === best.keywordHits && priority === best.priority && tree.id < best.tree.id)
    ) {
      best = { tree, keywordHits, priority };
    }
  }
  if (best) {
    return {
      tree: best.tree,
      matchedBy: best.keywordHits > 0 ? "keywords" : "trigger",
    };
  }
  // No tree matched the trigger class: fall back to the default tree so
  // enterprise mode never leaves a run without a bound tree. The fallback is
  // resolved from the provided list first so imported overrides of the
  // built-in default keep governing unmatched runs.
  const fallback =
    params.trees.find((tree) => tree.id === BUILTIN_ASSIST_TREE.id) ?? BUILTIN_ASSIST_TREE;
  return { tree: fallback, matchedBy: "default" };
}

function flattenPlanNodes(root: WorkflowNodeDefinition): EnterprisePlanNode[] {
  const nodes: EnterprisePlanNode[] = [];
  const visit = (node: WorkflowNodeDefinition, parentId: string | null) => {
    nodes.push({
      nodeId: node.id,
      parentId,
      seq: nodes.length,
      title: node.title,
      ...(node.description !== undefined ? { description: node.description } : {}),
      ontology: node.ontology ?? {},
    });
    for (const child of node.children ?? []) {
      visit(child, node.id);
    }
  };
  visit(root, null);
  return nodes;
}

function summarizeRequestText(requestText: string): string {
  const redacted = redactSecrets(requestText).replace(/\s+/g, " ").trim();
  if (redacted.length <= REQUEST_SUMMARY_MAX_CHARS) {
    return redacted;
  }
  return `${redacted.slice(0, REQUEST_SUMMARY_MAX_CHARS - 1)}…`;
}

/** Build the prepared execution plan for one enterprise-mode run. */
export function buildEnterpriseRunPlan(params: {
  runId: string;
  requestText: string;
  trigger: WorkflowTreeTrigger;
  mode: Exclude<EnterpriseMode, "off">;
  trees: readonly WorkflowTreeDefinition[];
  now?: number;
}): EnterpriseRunPlan {
  const selection = selectWorkflowTree({
    requestText: params.requestText,
    trigger: params.trigger,
    trees: params.trees,
  });
  const nodes = flattenPlanNodes(selection.tree.root);
  return {
    runId: params.runId,
    treeId: selection.tree.id,
    treeVersion: selection.tree.version,
    treeName: selection.tree.name,
    matchedBy: selection.matchedBy,
    requestSummary: summarizeRequestText(params.requestText),
    nodes,
    // Slice 1 scopes execution with the subtree root's ontology; per-leaf
    // step advancement is owned by the workflow-runtime slice.
    activeNodeId: nodes[0].nodeId,
    mode: params.mode,
    createdAt: params.now ?? Date.now(),
  };
}

export function findPlanNode(
  plan: EnterpriseRunPlan,
  nodeId: string,
): EnterprisePlanNode | undefined {
  return plan.nodes.find((node) => node.nodeId === nodeId);
}

/**
 * Compact per-run system prompt section describing the bound workflow step.
 * Returns an empty string when the active ontology carries no guidance so the
 * built-in permissive trees add zero prompt bytes (prompt-cache/back-compat).
 */
export function buildEnterprisePromptSection(plan: EnterpriseRunPlan): string {
  const active = findPlanNode(plan, plan.activeNodeId);
  if (!active) {
    return "";
  }
  const ontology = active.ontology;
  const hasGuidance = Boolean(
    ontology.constraints?.length ||
    ontology.contextHints?.length ||
    ontology.allowedTools?.length ||
    ontology.deniedTools?.length ||
    ontology.actions?.length ||
    ontology.expectedOutput,
  );
  if (!hasGuidance) {
    return "";
  }
  const lines: string[] = [
    "## Enterprise workflow",
    `This run is governed by workflow "${plan.treeName}" (${plan.treeId}@${plan.treeVersion}).`,
    `Current step: ${active.title}${active.description ? ` — ${active.description}` : ""}`,
  ];
  const steps = plan.nodes.filter((node) => node.parentId === active.nodeId);
  if (steps.length > 0) {
    lines.push("Planned steps:");
    for (const step of steps.slice(0, DIGEST_MAX_STEP_LINES)) {
      lines.push(`${step.seq}. ${step.title}`);
    }
  }
  if (ontology.actions?.length) {
    lines.push("Actions:");
    for (const action of ontology.actions.slice(0, DIGEST_MAX_HINT_LINES)) {
      const detail = [
        action.description,
        action.tools?.length ? `tools: ${action.tools.toSorted().join(", ")}` : undefined,
      ]
        .filter(Boolean)
        .join(" — ");
      lines.push(`- ${action.id}${detail ? `: ${detail}` : ""}`);
    }
  }
  if (ontology.constraints?.length) {
    lines.push("Constraints:");
    for (const constraint of ontology.constraints.slice(0, DIGEST_MAX_HINT_LINES)) {
      lines.push(`- ${constraint.description}`);
    }
  }
  if (ontology.contextHints?.length) {
    lines.push("Context:");
    for (const hint of ontology.contextHints.slice(0, DIGEST_MAX_HINT_LINES)) {
      lines.push(`- ${hint}`);
    }
  }
  if (ontology.allowedTools?.length) {
    lines.push(`Allowed tools: ${ontology.allowedTools.toSorted().join(", ")}`);
  }
  if (ontology.deniedTools?.length) {
    lines.push(`Denied tools: ${ontology.deniedTools.toSorted().join(", ")}`);
  }
  if (ontology.expectedOutput) {
    lines.push(`Expected output: ${ontology.expectedOutput}`);
  }
  return lines.join("\n");
}
