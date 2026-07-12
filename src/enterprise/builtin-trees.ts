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

/**
 * Shipped EXAMPLE work-map, always visible in the Enterprise UI: a customer-support
 * workflow whose leaves each carry their own ontology (tool scope, actions,
 * constraints, expected output), so the UI shows a rich per-node ontology and the
 * entity/relationship graph. Its keyword is a DISTINCTIVE opt-in phrase ("clawworks
 * support example") that real traffic never contains, so it binds only when someone
 * deliberately triggers the demo — every normal request still resolves to the
 * guidance-free `clawworks.assist` default, so stock behavior (including enforce-mode
 * tool scope) is unchanged. This matters because the example DOES restrict tools per
 * node, which must not silently apply to unrelated requests. To test it, prefix a
 * request with the phrase, e.g.:
 *   "clawworks support example: resolve ticket #12, already triaged and investigated,
 *    issue a $30 refund". With `enterprise.routePlanner.enabled` the LLM route planner
 * then narrows the run to just the steps the request needs (here -> support.resolve).
 */
export const BUILTIN_SUPPORT_EXAMPLE_TREE: WorkflowTreeDefinition = {
  schema: "clawworks.workflow-tree",
  schemaVersion: 1,
  id: "clawworks.support",
  version: "1.0.0",
  name: "Customer support (example)",
  description:
    'Example enterprise work-map for inspecting per-node ontology and trying the route planner. It stays out of normal runs on purpose: prefix a request with "clawworks support example" to route a run through it (e.g. "clawworks support example: resolve ticket #12, already triaged, issue a $30 refund"). With enterprise.routePlanner.enabled the LLM route planner narrows the run to the steps your request needs. Click a step to inspect its ontology.',
  match: {
    keywords: ["clawworks support example"],
    triggers: ["user"],
    priority: 10,
  },
  root: {
    id: "support",
    title: "Handle a customer support request",
    ontology: {
      entities: [
        { id: "customer", description: "The person who opened the request." },
        { id: "order", description: "A purchase the request refers to." },
        { id: "ticket", description: "The support case being worked." },
        { id: "refund", description: "A repayment issued to the customer." },
      ],
      relationships: [
        {
          id: "owns",
          from: "customer",
          to: "order",
          description: "The customer placed the order.",
        },
        {
          id: "concerns",
          from: "ticket",
          to: "order",
          description: "The ticket is about the order.",
        },
        { id: "settles", from: "refund", to: "order", description: "A refund settles the order." },
      ],
      // knowledge_search is allowed here (and inherited by the investigate step) so
      // the declared knowledge source is queryable under the path scope. Declare the
      // KB allow-list at the root too, or an omitted list would let the root scope
      // (used by non-advancing CLI/ACP runs) query every registered foundation.
      allowedTools: ["memory_search", "memory_get", "message", "knowledge_search"],
      knowledgeFoundations: ["clawworks.support-kb"],
      constraints: [
        { id: "no-card-numbers", description: "Never repeat full payment card numbers." },
      ],
      contextHints: [
        "Keep replies concise and empathetic.",
        "Refunds over $200 require human approval.",
      ],
      audit: true,
    },
    children: [
      {
        id: "support.triage",
        title: "Triage the request",
        ontology: {
          allowedTools: ["memory_search", "message"],
          actions: [
            {
              id: "classify",
              description: "Set the request's category and priority.",
              tools: ["memory_search"],
            },
          ],
          constraints: [
            {
              id: "confirm-ids",
              description: "Confirm the ticket and order ids before acting.",
            },
          ],
          expectedOutput: "A category, a priority, and the order the request concerns.",
        },
      },
      {
        id: "support.investigate",
        title: "Investigate account and order history",
        ontology: {
          allowedTools: ["memory_search", "memory_get", "message", "knowledge_search"],
          knowledgeFoundations: ["clawworks.support-kb"],
          actions: [
            {
              id: "lookup-history",
              description: "Read prior orders and conversations.",
              tools: ["memory_search", "memory_get"],
            },
          ],
          expectedOutput: "The order and account facts needed to resolve the request.",
        },
      },
      {
        id: "support.resolve",
        title: "Resolve the request or issue a refund",
        ontology: {
          allowedTools: ["memory_get", "message"],
          actions: [
            {
              id: "reply",
              description: "Send the resolution to the customer.",
              tools: ["message"],
            },
            { id: "issue-refund", description: "Issue a refund within the approval limit." },
          ],
          constraints: [
            {
              id: "refund-cap",
              description: "Do not issue a refund over $200 without human approval.",
            },
          ],
          expectedOutput: "A resolution message, plus a refund record when one was issued.",
        },
      },
      {
        id: "support.escalate",
        title: "Escalate to a human agent",
        ontology: {
          allowedTools: ["message"],
          actions: [
            {
              id: "handoff",
              description: "Summarize the case and hand it to a human.",
              tools: ["message"],
            },
          ],
          expectedOutput: "An escalation summary for the human queue.",
        },
      },
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
  BUILTIN_SUPPORT_EXAMPLE_TREE,
  BUILTIN_SYSTEM_TREE,
];
