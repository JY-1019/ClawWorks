// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * ClawWorks enterprise inspection protocol schemas.
 *
 * Read-only projections of the workflow-tree registry and the run trace store,
 * surfaced to operator clients (the UI enterprise tab). These are bounded
 * summaries — the model-visible plan/ontology carries more, but only the
 * execution-scoping fields an inspector renders are exposed here.
 */

const TimestampSchema = Type.Integer({ minimum: 0 });

/** Closed enterprise run lifecycle statuses (mirror EnterpriseRunStatus). */
export const EnterpriseRunStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("blocked"),
  Type.Literal("aborted"),
  Type.Literal("timed_out"),
]);

/** How a workflow tree definition reached the runtime registry. */
export const EnterpriseTreeSourceSchema = Type.Union([
  Type.Literal("builtin"),
  Type.Literal("imported"),
]);

/** One registry tree, summarized for the tree list. */
export const EnterpriseTreeSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    version: Type.String(),
    name: Type.String(),
    source: EnterpriseTreeSourceSchema,
    nodeCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** A tree import that exists but failed to load; enforce-mode fails closed on it. */
export const EnterpriseTreeImportErrorSchema = Type.Object(
  {
    treeId: Type.String(),
    message: Type.String(),
  },
  { additionalProperties: false },
);

/** Tree list request (no filters; the registry is small and process-stable). */
export const EnterpriseTreesListParamsSchema = Type.Object({}, { additionalProperties: false });

/** Tree list response including the imported-tree load state. */
export const EnterpriseTreesListResultSchema = Type.Object(
  {
    trees: Type.Array(EnterpriseTreeSummarySchema),
    importErrors: Type.Array(EnterpriseTreeImportErrorSchema),
    storeError: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** One ontology entity (a domain concept the step reasons about). */
export const EnterpriseOntologyEntitySchema = Type.Object(
  { id: NonEmptyString, description: Type.Optional(Type.String()) },
  { additionalProperties: false },
);

/** A directed relationship between two ontology entities (an ontology-graph edge). */
export const EnterpriseOntologyRelationshipSchema = Type.Object(
  {
    id: NonEmptyString,
    from: NonEmptyString,
    to: NonEmptyString,
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** An action a step may perform, optionally bound to concrete tool globs. */
export const EnterpriseOntologyActionSchema = Type.Object(
  {
    id: NonEmptyString,
    description: Type.Optional(Type.String()),
    tools: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

/** A constraint the step must respect (prompt guidance). */
export const EnterpriseOntologyConstraintSchema = Type.Object(
  { id: NonEmptyString, description: Type.String() },
  { additionalProperties: false },
);

/** Full ontology binding for a tree node (structure + execution scope). */
export const EnterpriseTreeOntologySchema = Type.Object(
  {
    entities: Type.Optional(Type.Array(EnterpriseOntologyEntitySchema)),
    relationships: Type.Optional(Type.Array(EnterpriseOntologyRelationshipSchema)),
    actions: Type.Optional(Type.Array(EnterpriseOntologyActionSchema)),
    constraints: Type.Optional(Type.Array(EnterpriseOntologyConstraintSchema)),
    allowedTools: Type.Optional(Type.Array(Type.String())),
    deniedTools: Type.Optional(Type.Array(Type.String())),
    knowledgeFoundations: Type.Optional(Type.Array(Type.String())),
    contextHints: Type.Optional(Type.Array(Type.String())),
    expectedOutput: Type.Optional(Type.String()),
    audit: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** One workflow-tree node, flattened depth-first with parent + depth for layout. */
export const EnterpriseTreeNodeSchema = Type.Object(
  {
    id: NonEmptyString,
    parentId: Type.Union([Type.String(), Type.Null()]),
    depth: Type.Integer({ minimum: 0 }),
    title: Type.String(),
    description: Type.Optional(Type.String()),
    ontology: EnterpriseTreeOntologySchema,
  },
  { additionalProperties: false },
);

/** Tree selection hints (how a request binds to the tree). */
export const EnterpriseTreeMatchSchema = Type.Object(
  {
    keywords: Type.Optional(Type.Array(Type.String())),
    triggers: Type.Optional(Type.Array(Type.String())),
    priority: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

/** Full workflow-tree definition for the visualization/editor. */
export const EnterpriseTreeDetailSchema = Type.Object(
  {
    id: NonEmptyString,
    version: Type.String(),
    name: Type.String(),
    description: Type.Optional(Type.String()),
    source: EnterpriseTreeSourceSchema,
    match: Type.Optional(EnterpriseTreeMatchSchema),
    nodes: Type.Array(EnterpriseTreeNodeSchema),
  },
  { additionalProperties: false },
);

/** Tree detail lookup by tree id. */
export const EnterpriseTreesGetParamsSchema = Type.Object(
  { treeId: NonEmptyString },
  { additionalProperties: false },
);

/**
 * Tree detail response. `tree` is null when the id is not registered. When the
 * requested tree's imported definition failed to load, `importError` carries the
 * reason (a stale built-in may still be returned as `tree`); `storeError` is set
 * when the whole tree store is unreadable. Callers must not treat a present
 * `tree` as authoritative while `importError`/`storeError` is set.
 */
export const EnterpriseTreesGetResultSchema = Type.Object(
  {
    tree: Type.Union([EnterpriseTreeDetailSchema, Type.Null()]),
    importError: Type.Optional(Type.String()),
    storeError: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** One run execution, summarized for the run list. */
export const EnterpriseRunSummarySchema = Type.Object(
  {
    executionId: NonEmptyString,
    runId: NonEmptyString,
    treeId: Type.String(),
    treeVersion: Type.String(),
    mode: Type.String(),
    status: EnterpriseRunStatusSchema,
    requestSummary: Type.String(),
    activeNodeId: Type.String(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    endedAt: Type.Union([TimestampSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

/** Recent-run list request with bounded limit. */
export const EnterpriseRunsListParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
);

/** Recent-run list response, newest first. */
export const EnterpriseRunsListResultSchema = Type.Object(
  {
    runs: Type.Array(EnterpriseRunSummarySchema),
  },
  { additionalProperties: false },
);

/** Execution-scoping ontology fields shown in the node inspector. */
export const EnterpriseNodeOntologySchema = Type.Object(
  {
    allowedTools: Type.Optional(Type.Array(Type.String())),
    deniedTools: Type.Optional(Type.Array(Type.String())),
    knowledgeFoundations: Type.Optional(Type.Array(Type.String())),
    contextHints: Type.Optional(Type.Array(Type.String())),
    expectedOutput: Type.Optional(Type.String()),
    audit: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** One flattened plan node for the tree/node inspector. */
export const EnterprisePlanNodeSchema = Type.Object(
  {
    nodeId: NonEmptyString,
    parentId: Type.Union([Type.String(), Type.Null()]),
    seq: Type.Integer({ minimum: 0 }),
    title: Type.String(),
    description: Type.Optional(Type.String()),
    ontology: EnterpriseNodeOntologySchema,
  },
  { additionalProperties: false },
);

/** Closed trace event kinds (mirror EnterpriseRunEventKind). */
export const EnterpriseRunEventKindSchema = Type.Union([
  Type.Literal("run.started"),
  Type.Literal("run.ended"),
  Type.Literal("governance.decision"),
  Type.Literal("node.entered"),
  Type.Literal("node.completed"),
]);

/** One trace event in an execution timeline. */
export const EnterpriseRunEventSchema = Type.Object(
  {
    seq: Type.Integer({ minimum: 0 }),
    nodeId: Type.Union([Type.String(), Type.Null()]),
    kind: EnterpriseRunEventKindSchema,
    payload: Type.Record(Type.String(), Type.Unknown()),
    createdAt: TimestampSchema,
  },
  { additionalProperties: false },
);

/** Full run detail: plan nodes + event timeline for the inspector. */
export const EnterpriseRunDetailSchema = Type.Object(
  {
    executionId: NonEmptyString,
    runId: NonEmptyString,
    sessionKey: Type.Union([Type.String(), Type.Null()]),
    agentId: Type.Union([Type.String(), Type.Null()]),
    treeId: Type.String(),
    treeVersion: Type.String(),
    treeName: Type.String(),
    mode: Type.String(),
    status: EnterpriseRunStatusSchema,
    matchedBy: Type.String(),
    requestSummary: Type.String(),
    activeNodeId: Type.String(),
    nodes: Type.Array(EnterprisePlanNodeSchema),
    events: Type.Array(EnterpriseRunEventSchema),
    executionCount: Type.Integer({ minimum: 0 }),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    endedAt: Type.Union([TimestampSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

/** Run detail lookup by execution id (one specific listed run row). */
export const EnterpriseRunsGetParamsSchema = Type.Object(
  {
    executionId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Run detail response; `run` is null when no trace exists for the execution id. */
export const EnterpriseRunsGetResultSchema = Type.Object(
  {
    run: Type.Union([EnterpriseRunDetailSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
