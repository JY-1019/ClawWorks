/**
 * Built-in ClawWorks workflow trees. These keep enterprise mode structurally
 * active by default: every run binds to a tree and traces per-node, while the
 * permissive ontologies below add no prompt overhead and no tool restrictions,
 * so out-of-the-box behavior matches stock OpenClaw. Organizations replace or
 * extend these via imported tree definitions.
 */
import type { WorkflowTreeDefinition } from "./types.js";

/** Default tree for user-facing requests. */
export const BUILTIN_ASSIST_TREE: WorkflowTreeDefinition = {
  schema: "clawworks.workflow-tree",
  schemaVersion: 1,
  id: "clawworks.assist",
  version: "1.0.0",
  name: "General assistance",
  description: "Default enterprise workflow for user requests.",
  match: { triggers: ["user", "subagent"], priority: -100 },
  root: {
    id: "assist",
    title: "Assist with the user request",
    // Intentionally guidance-free ontology: no allowedTools, constraints, or
    // context hints, so the default digest stays empty and prompt bytes match
    // non-enterprise OpenClaw exactly.
    ontology: {},
    children: [
      { id: "assist.understand", title: "Understand the request" },
      { id: "assist.execute", title: "Carry out the work" },
      { id: "assist.respond", title: "Report the outcome" },
    ],
  },
};

/** Tree for system-initiated runs (heartbeat, cron, memory, overflow). */
export const BUILTIN_SYSTEM_TREE: WorkflowTreeDefinition = {
  schema: "clawworks.workflow-tree",
  schemaVersion: 1,
  id: "clawworks.system",
  version: "1.0.0",
  name: "System maintenance",
  description: "Default enterprise workflow for system-triggered runs.",
  match: { triggers: ["system"], priority: -100 },
  root: {
    id: "system",
    title: "Run the scheduled system task",
    ontology: {},
    children: [
      { id: "system.execute", title: "Execute the scheduled work" },
      { id: "system.report", title: "Record the outcome" },
    ],
  },
};

/** Deterministically ordered built-in trees (sorted by id). */
export const BUILTIN_WORKFLOW_TREES: readonly WorkflowTreeDefinition[] = [
  BUILTIN_ASSIST_TREE,
  BUILTIN_SYSTEM_TREE,
];
