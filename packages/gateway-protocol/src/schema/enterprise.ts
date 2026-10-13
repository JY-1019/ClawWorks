// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * ClawWorks enterprise inspection protocol schemas.
 *
 * Workflow-tree registry and run-trace shapes surfaced to operator clients.
 * List entries stay bounded; a selected tree projects its complete authorable
 * ontology so the Control UI can inspect and edit it without parsing source.
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
    /** Opaque identity of the invalid stored row, used for guarded removal. */
    fingerprint: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** One validation issue or authoring warning (path + message). */
export const EnterpriseTreeImportIssueSchema = Type.Object(
  { path: Type.String(), message: Type.String() },
  { additionalProperties: false },
);

/** Tree list request (no filters; the registry is small and process-stable). */
export const EnterpriseTreesListParamsSchema = Type.Object({}, { additionalProperties: false });

/** Tree list response including the imported-tree load state. */
export const EnterpriseTreesListResultSchema = Type.Object(
  {
    trees: Type.Array(EnterpriseTreeSummarySchema),
    importErrors: Type.Array(EnterpriseTreeImportErrorSchema),
    /** Removed imported-only trees whose retained revisions can still be restored. */
    historyOnlyTreeIds: Type.Optional(Type.Array(NonEmptyString)),
    storeError: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Value types an ontology property or action parameter carries. */
export const EnterpriseOntologyValueTypeSchema = Type.Union([
  Type.Literal("string"),
  Type.Literal("number"),
  Type.Literal("boolean"),
  Type.Literal("date"),
  Type.Literal("id"),
]);

/** One typed field on an ontology object type. */
export const EnterpriseOntologyPropertySchema = Type.Object(
  {
    id: NonEmptyString,
    type: EnterpriseOntologyValueTypeSchema,
    primaryKey: Type.Optional(Type.Boolean()),
    required: Type.Optional(Type.Boolean()),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** One ontology object type (a domain concept the step reasons about). */
export const EnterpriseOntologyEntitySchema = Type.Object(
  {
    id: NonEmptyString,
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    properties: Type.Optional(Type.Array(EnterpriseOntologyPropertySchema)),
  },
  { additionalProperties: false },
);

/** How many instances each side of a link type may bind to. */
export const EnterpriseOntologyCardinalitySchema = Type.Union([
  Type.Literal("one-to-one"),
  Type.Literal("one-to-many"),
  Type.Literal("many-to-one"),
  Type.Literal("many-to-many"),
]);

/** A directed link type between two object types (an ontology-graph edge). */
export const EnterpriseOntologyRelationshipSchema = Type.Object(
  {
    id: NonEmptyString,
    from: NonEmptyString,
    to: NonEmptyString,
    cardinality: Type.Optional(EnterpriseOntologyCardinalitySchema),
    inverse: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** One declared input to an action type. */
export const EnterpriseOntologyActionParameterSchema = Type.Object(
  {
    id: NonEmptyString,
    type: EnterpriseOntologyValueTypeSchema,
    required: Type.Optional(Type.Boolean()),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** What an action does to an object type when it runs. */
export const EnterpriseOntologyActionEffectSchema = Type.Union([
  Type.Object(
    {
      entity: NonEmptyString,
      kind: Type.Union([
        Type.Literal("read"),
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("delete"),
      ]),
      description: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  // The outward effect names a TOOL, not an object type: the action happens in the
  // system that owns the data, and the governance gate holds the call to this
  // action's parameters. Additive — an existing payload still validates.
  Type.Object(
    {
      kind: Type.Literal("call"),
      tool: NonEmptyString,
      description: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  // The graph effect relates two objects the action's parameters identify.
  Type.Object(
    {
      kind: Type.Union([Type.Literal("link"), Type.Literal("unlink")]),
      relationship: NonEmptyString,
      from: Type.Optional(NonEmptyString),
      to: Type.Optional(NonEmptyString),
      description: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

/** An action type a step may perform: bound tools plus what it reads/writes. */
export const EnterpriseOntologyActionSchema = Type.Object(
  {
    id: NonEmptyString,
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    tools: Type.Optional(Type.Array(Type.String())),
    parameters: Type.Optional(Type.Array(EnterpriseOntologyActionParameterSchema)),
    preconditions: Type.Optional(Type.Array(Type.String())),
    effects: Type.Optional(Type.Array(EnterpriseOntologyActionEffectSchema)),
  },
  { additionalProperties: false },
);

/** A derived value computed from one object type's own properties. */
export const EnterpriseOntologyFunctionSchema = Type.Object(
  {
    id: NonEmptyString,
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    entity: NonEmptyString,
    expression: NonEmptyString,
    returns: EnterpriseOntologyValueTypeSchema,
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
    functions: Type.Optional(Type.Array(EnterpriseOntologyFunctionSchema)),
    constraints: Type.Optional(Type.Array(EnterpriseOntologyConstraintSchema)),
    allowedTools: Type.Optional(Type.Array(Type.String())),
    deniedTools: Type.Optional(Type.Array(Type.String())),
    knowledgeFoundations: Type.Optional(Type.Array(Type.String())),
    contextHints: Type.Optional(Type.Array(Type.String())),
    guidance: Type.Optional(Type.String()),
    skills: Type.Optional(Type.Array(Type.String())),
    mcpServers: Type.Optional(Type.Array(Type.String())),
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
    /** Content hash of THIS definition; lets a client prove it is the one a run used. */
    hash: Type.Optional(Type.String()),
    name: Type.String(),
    description: Type.Optional(Type.String()),
    executionModel: Type.Optional(Type.String()),
    source: EnterpriseTreeSourceSchema,
    match: Type.Optional(EnterpriseTreeMatchSchema),
    /**
     * `"explicit"` requires local declarations for each executable step. Skills are narrowed once for the run to those declared on
     * its planned route; each step still identifies which of them applies there.
     * Absent for permissive local scopes.
     *
     * Tool, skill-catalog, and MCP grants apply under `enterprise.mode:
     * "enforce"`; knowledge remains scoped while observing as well.
     */
    capabilityGrants: Type.Optional(Type.Literal("explicit")),
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
 * requested tree's imported definition failed to load, `importError` carries its
 * reason (a stale built-in may still be returned as `tree`); the additive
 * `importErrorFingerprint` lets newer clients guard removal of that exact bad
 * row. `storeError` is set when the whole tree store is unreadable. Callers must
 * not treat a present `tree` as authoritative while `importError`/`storeError`
 * is set.
 */
export const EnterpriseTreesGetResultSchema = Type.Object(
  {
    tree: Type.Union([EnterpriseTreeDetailSchema, Type.Null()]),
    /** Authoring warnings computed from this exact authoritative tree snapshot. */
    warnings: Type.Optional(Type.Array(EnterpriseTreeImportIssueSchema)),
    importError: Type.Optional(Type.String()),
    importErrorFingerprint: Type.Optional(NonEmptyString),
    storeError: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** A concrete ontology property VALUE (an object instance carries these). */
export const EnterpriseOntologyValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

/** One ontology object INSTANCE, as the operator inspector renders it. */
export const EnterpriseOntologyObjectSchema = Type.Object(
  {
    objectId: NonEmptyString,
    properties: Type.Record(Type.String(), EnterpriseOntologyValueSchema),
    /** Whether the tree declared this object (`seed`) or an action created it (`runtime`). */
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

/** Instances of one object type in one tree, for the node inspector. */
export const EnterpriseObjectsListParamsSchema = Type.Object(
  {
    treeId: NonEmptyString,
    entity: NonEmptyString,
    /** Case-insensitive substring over property values. */
    match: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);

export const EnterpriseObjectsListResultSchema = Type.Object(
  { objects: Type.Array(EnterpriseOntologyObjectSchema) },
  { additionalProperties: false },
);

/** Exchange serialization format for tree import/export. */
export const EnterpriseTreeFormatSchema = Type.Union([Type.Literal("yaml"), Type.Literal("json")]);

const EnterpriseTreeContentProperties = {
  content: Type.String(),
  format: EnterpriseTreeFormatSchema,
} as const;

const EnterpriseCreateOnlyGuardProperties = {
  /** Create only when neither a built-in nor imported tree owns the parsed id. */
  createOnly: Type.Literal(true),
} as const;

const EnterpriseExpectedHashGuardProperties = {
  /** Update only while the current tree keeps this stable content hash. */
  expectedHash: NonEmptyString,
} as const;

const EnterpriseTreeCreateOnlyImportParamsSchema = Type.Object(
  {
    ...EnterpriseTreeContentProperties,
    ...EnterpriseCreateOnlyGuardProperties,
  },
  { additionalProperties: false },
);

const EnterpriseTreeExpectedHashImportParamsSchema = Type.Object(
  {
    ...EnterpriseTreeContentProperties,
    ...EnterpriseExpectedHashGuardProperties,
  },
  { additionalProperties: false },
);

const EnterpriseTreeImportProjection = {
  type: "object",
  properties: {
    ...EnterpriseTreeContentProperties,
    ...EnterpriseCreateOnlyGuardProperties,
    ...EnterpriseExpectedHashGuardProperties,
  },
  required: ["content", "format"],
  additionalProperties: false,
} as const;

/** Import (create/overwrite) one tree from raw YAML/JSON content. */
export const EnterpriseTreesImportParamsSchema = Type.Union(
  [
    Type.Object(EnterpriseTreeContentProperties, { additionalProperties: false }),
    EnterpriseTreeCreateOnlyImportParamsSchema,
    EnterpriseTreeExpectedHashImportParamsSchema,
  ],
  EnterpriseTreeImportProjection,
);

/**
 * Import outcome. `ok: true` carries the stored id and what it replaced (an
 * existing import, a shadowed built-in, or nothing). `ok: false` carries the
 * validation or write-precondition issues so the editor can surface them inline;
 * the request itself still succeeds because these are expected user outcomes.
 */
export const EnterpriseTreesImportResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    treeId: Type.Optional(NonEmptyString),
    replaced: Type.Optional(
      Type.Union([Type.Literal("builtin"), Type.Literal("imported"), Type.Null()]),
    ),
    issues: Type.Optional(Type.Array(EnterpriseTreeImportIssueSchema)),
    /**
     * Authoring checks on the tree that was WRITTEN: declarations no run could
     * ever reach (an unreachable action, a knowledge source every path excludes).
     * Same path+message shape as `issues`, and deliberately not one: the import
     * succeeded, so a client that ignores this field keeps working — but a
     * work-map authored in a GUI would otherwise ship a dead declaration that
     * only the CLI importer ever printed.
     */
    warnings: Type.Optional(Type.Array(EnterpriseTreeImportIssueSchema)),
  },
  { additionalProperties: false },
);

/** Export one registered tree as YAML/JSON. */
export const EnterpriseTreesExportParamsSchema = Type.Object(
  { treeId: NonEmptyString, format: EnterpriseTreeFormatSchema },
  { additionalProperties: false },
);

/** Export result; `content` is null (with a `reason`) when the id is unknown. */
export const EnterpriseTreesExportResultSchema = Type.Object(
  {
    content: Type.Union([Type.String(), Type.Null()]),
    source: Type.Optional(EnterpriseTreeSourceSchema),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Inspect one workflow bundle without writing it. */
export const EnterpriseBundlesPreviewParamsSchema = Type.Object(
  { content: Type.String(), format: EnterpriseTreeFormatSchema },
  { additionalProperties: false },
);

const EnterpriseBundleReviewTokenSchema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-f0-9]{64}$",
});

export const EnterpriseBundleTreeSchema = Type.Object(
  {
    id: NonEmptyString,
    replaced: Type.Union([EnterpriseTreeSourceSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const EnterpriseBundlePreviewTreeSchema = Type.Object(
  {
    id: NonEmptyString,
    version: Type.String(),
    replaced: Type.Union([EnterpriseTreeSourceSchema, Type.Null()]),
    currentVersion: Type.Union([Type.String(), Type.Null()]),
    /** Hash the guarded apply must match; null means use createOnly. */
    currentHash: Type.Union([NonEmptyString, Type.Null()]),
  },
  { additionalProperties: false },
);

/** Enterprise execution mode, switchable from the chat surface. */
export const EnterpriseModeSchema = Type.Union([
  Type.Literal("enforce"),
  Type.Literal("observe"),
  Type.Literal("off"),
]);

export const EnterpriseBundleModeDowngradeSchema = Type.Object(
  { from: EnterpriseModeSchema, to: EnterpriseModeSchema },
  { additionalProperties: false },
);

const EnterpriseBundleDiagnostics = {
  foundations: Type.Array(NonEmptyString),
  missingFoundations: Type.Array(NonEmptyString),
  removedFoundations: Type.Array(NonEmptyString),
  replacedFoundations: Type.Array(NonEmptyString),
  shadowedFoundations: Type.Array(NonEmptyString),
  requiredTools: Type.Array(NonEmptyString),
  requiredSkills: Type.Array(NonEmptyString),
  requiredMcpServers: Type.Array(NonEmptyString),
  missingMcpServers: Type.Array(NonEmptyString),
  warnings: Type.Array(EnterpriseTreeImportIssueSchema),
  missingGovernancePolicies: Type.Array(NonEmptyString),
  conflictingGovernancePolicies: Type.Array(NonEmptyString),
  governanceModeDowngrade: Type.Optional(EnterpriseBundleModeDowngradeSchema),
} as const;

const EnterpriseBundleFailureSchema = Type.Object(
  { ok: Type.Literal(false), issues: Type.Array(EnterpriseTreeImportIssueSchema) },
  { additionalProperties: false },
);

/** Complete dependency/replacement review returned before a bundle can be applied. */
export const EnterpriseBundlesPreviewResultSchema = Type.Union(
  [
    Type.Object(
      {
        ok: Type.Literal(true),
        reviewToken: EnterpriseBundleReviewTokenSchema,
        trees: Type.Array(EnterpriseBundlePreviewTreeSchema),
        ...EnterpriseBundleDiagnostics,
      },
      { additionalProperties: false },
    ),
    EnterpriseBundleFailureSchema,
  ],
  {
    type: "object",
    properties: {
      ok: Type.Boolean(),
      reviewToken: EnterpriseBundleReviewTokenSchema,
      trees: Type.Array(EnterpriseBundlePreviewTreeSchema),
      ...EnterpriseBundleDiagnostics,
      issues: Type.Array(EnterpriseTreeImportIssueSchema),
    },
    required: ["ok"],
    additionalProperties: false,
  },
);

/** Guarded bundle apply: create after an empty preview, or update the exact previewed hash. */
export const EnterpriseBundlesImportParamsSchema = Type.Union(
  [
    Type.Object(
      {
        ...EnterpriseTreeContentProperties,
        reviewToken: EnterpriseBundleReviewTokenSchema,
        ...EnterpriseCreateOnlyGuardProperties,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...EnterpriseTreeContentProperties,
        reviewToken: EnterpriseBundleReviewTokenSchema,
        ...EnterpriseExpectedHashGuardProperties,
      },
      { additionalProperties: false },
    ),
  ],
  {
    type: "object",
    properties: {
      ...EnterpriseTreeContentProperties,
      reviewToken: EnterpriseBundleReviewTokenSchema,
      ...EnterpriseCreateOnlyGuardProperties,
      ...EnterpriseExpectedHashGuardProperties,
    },
    required: ["content", "format", "reviewToken"],
    additionalProperties: false,
  },
);

/** Applied bundle result; user/data issues remain an expected ok:false payload. */
export const EnterpriseBundlesImportResultSchema = Type.Union(
  [
    Type.Object(
      {
        ok: Type.Literal(true),
        trees: Type.Array(EnterpriseBundleTreeSchema),
        ...EnterpriseBundleDiagnostics,
      },
      { additionalProperties: false },
    ),
    EnterpriseBundleFailureSchema,
  ],
  {
    type: "object",
    properties: {
      ok: Type.Boolean(),
      trees: Type.Array(EnterpriseBundleTreeSchema),
      ...EnterpriseBundleDiagnostics,
      issues: Type.Array(EnterpriseTreeImportIssueSchema),
    },
    required: ["ok"],
    additionalProperties: false,
  },
);

/** Export one tree plus its inlinable knowledge and dependency manifest. */
export const EnterpriseBundlesExportParamsSchema = Type.Object(
  { treeId: NonEmptyString, format: EnterpriseTreeFormatSchema },
  { additionalProperties: false },
);

export const EnterpriseBundleSkippedFoundationSchema = Type.Object(
  { id: NonEmptyString, reason: Type.String() },
  { additionalProperties: false },
);

export const EnterpriseBundlesExportResultSchema = Type.Union(
  [
    Type.Object(
      {
        ok: Type.Literal(true),
        content: Type.String(),
        source: EnterpriseTreeSourceSchema,
        skippedFoundations: Type.Array(EnterpriseBundleSkippedFoundationSchema),
        impliedAllowAllKnowledge: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { ok: Type.Literal(false), reason: Type.String() },
      { additionalProperties: false },
    ),
  ],
  {
    type: "object",
    properties: {
      ok: Type.Boolean(),
      content: Type.String(),
      source: EnterpriseTreeSourceSchema,
      skippedFoundations: Type.Array(EnterpriseBundleSkippedFoundationSchema),
      impliedAllowAllKnowledge: Type.Boolean(),
      reason: Type.String(),
    },
    required: ["ok"],
    additionalProperties: false,
  },
);

/** Remove one imported tree (a shadowed built-in reappears). */
export const EnterpriseTreesRemoveParamsSchema = Type.Object(
  {
    treeId: NonEmptyString,
    /** Added in protocol v4; the server refuses a legacy unguarded request. */
    expectedHash: Type.Optional(NonEmptyString),
    /** Added in protocol v4; identifies one exact malformed persisted row. */
    expectedInvalidFingerprint: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Expected remove outcome; conflicts and unreadable rows are not request errors. */
export const EnterpriseTreesRemoveResultSchema = Type.Union(
  [
    Type.Object({ removed: Type.Literal(true) }, { additionalProperties: false }),
    Type.Object(
      {
        removed: Type.Literal(false),
        reason: Type.Union([
          Type.Literal("not-found"),
          Type.Literal("precondition-required"),
          Type.Literal("tree-changed"),
          Type.Literal("tree-unavailable"),
        ]),
      },
      { additionalProperties: false },
    ),
  ],
  {
    // Preserve the discriminated anyOf validation while generating one stable
    // native result struct; `reason` remains required only when removed is false.
    type: "object",
    properties: { removed: Type.Boolean(), reason: Type.String() },
    required: ["removed"],
    additionalProperties: false,
  },
);

/** One recorded revision of a tree, summarized for the history list. */
export const EnterpriseTreeVersionSummarySchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    version: Type.String(),
    name: Type.String(),
    sourceFormat: EnterpriseTreeFormatSchema,
    savedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

/** List the saved revisions of one tree (newest first), bounded by limit. */
export const EnterpriseTreesHistoryListParamsSchema = Type.Object(
  {
    treeId: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
);

export const EnterpriseTreesHistoryListResultSchema = Type.Object(
  { versions: Type.Array(EnterpriseTreeVersionSummarySchema) },
  { additionalProperties: false },
);

/** Load one saved revision's definition, serialized in the requested format. */
export const EnterpriseTreesHistoryGetParamsSchema = Type.Object(
  {
    treeId: NonEmptyString,
    revision: Type.Integer({ minimum: 1 }),
    format: EnterpriseTreeFormatSchema,
  },
  { additionalProperties: false },
);

/** History get result; `content` is null when the revision is unknown. */
export const EnterpriseTreesHistoryGetResultSchema = Type.Object(
  {
    content: Type.Union([Type.String(), Type.Null()]),
    savedAt: Type.Optional(TimestampSchema),
  },
  { additionalProperties: false },
);

/** One run execution, summarized for the run list. */
export const EnterpriseRunSummarySchema = Type.Object(
  {
    executionId: NonEmptyString,
    runId: NonEmptyString,
    // Chat filters the run list by session to show only THIS thread's route.
    // Optional on the wire: an older gateway omits it entirely, and a required
    // field would make its responses undecodable for generated clients.
    sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
    /** Only runs bound to this session (chat shows one thread's route). */
    sessionKey: Type.Optional(Type.String()),
    /**
     * Only runs owned by this agent. Needed alongside `sessionKey` because every
     * agent's store shares the canonical "global" key, so that filter alone can
     * return another agent's run.
     */
    agentId: Type.Optional(Type.String()),
    /**
     * Skip runs that borrowed a visible session but must not appear in it
     * (`sessionEffects: "internal"`). Chat sets this; the audit screen does not,
     * so inspection still sees every run.
     */
    chatVisibleOnly: Type.Optional(Type.Boolean()),
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
    guidance: Type.Optional(Type.String()),
    skills: Type.Optional(Type.Array(Type.String())),
    mcpServers: Type.Optional(Type.Array(Type.String())),
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
  Type.Literal("route.selected"),
  Type.Literal("run.ended"),
  Type.Literal("governance.decision"),
  Type.Literal("node.entered"),
  Type.Literal("node.completed"),
  Type.Literal("run.resumed"),
  Type.Literal("action.invoked"),
  Type.Literal("run.steered"),
  Type.Literal("node.reopened"),
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
/** Which part of the tree the run planned, and why. */
export const EnterpriseRunRouteSchema = Type.Object(
  {
    routes: Type.Array(Type.String()),
    rationale: Type.String(),
    source: Type.Union([Type.Literal("planner"), Type.Literal("whole-tree")]),
    selectedNodes: Type.Integer({ minimum: 0 }),
    totalNodes: Type.Integer({ minimum: 0 }),
    invalidRoutes: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

const EnterpriseRunsResumeRefusalReasonSchema = Type.Union([
  Type.Literal("not-found"),
  Type.Literal("still-running"),
  Type.Literal("no-session"),
  Type.Literal("no-steps-completed"),
  Type.Literal("route-complete"),
  Type.Literal("transcript-rotated"),
]);

export const EnterpriseRunDetailSchema = Type.Object(
  {
    executionId: NonEmptyString,
    runId: NonEmptyString,
    sessionKey: Type.Union([Type.String(), Type.Null()]),
    /** Transcript UUID this execution belongs to; absent on legacy trace rows. */
    sessionId: Type.Optional(NonEmptyString),
    agentId: Type.Union([Type.String(), Type.Null()]),
    treeId: Type.String(),
    treeVersion: Type.String(),
    treeName: Type.String(),
    /** Content hash of the tree definition the run planned against. */
    treeHash: Type.Optional(Type.String()),
    mode: Type.String(),
    status: EnterpriseRunStatusSchema,
    /**
     * Whether THIS gateway process is executing the run right now.
     *
     * Live step events are process-local, so a `running` row owned by another
     * process (`openclaw agent --local`, a second gateway) can never deliver its
     * later transitions here. A live surface must not present such a run as
     * something it can follow.
     */
    locallyActive: Type.Optional(Type.Boolean()),
    /**
     * An operator asked for this execution to be continued and nothing has
     * consumed it yet. Server-owned: the marker is one-shot and another operator
     * or the next run can clear it, so a client that remembered its own request
     * would keep showing it as pending long after it fired.
     */
    resumeRequested: Type.Optional(Type.Boolean()),
    /**
     * Whether asking to continue this execution would be accepted. Server-owned
     * for the same reason the decision is: it depends on the route's unfinished
     * remainder, which only the stored plan plus the run's completion ancestry
     * can answer. A client guessing from the event list would offer a button
     * whose only outcome is a refusal.
     */
    resumable: Type.Optional(Type.Boolean()),
    /** Why resume would be refused; absent when the run is resumable. */
    resumeRefusalReason: Type.Optional(EnterpriseRunsResumeRefusalReasonSchema),
    matchedBy: Type.String(),
    requestSummary: Type.String(),
    activeNodeId: Type.String(),
    route: Type.Optional(EnterpriseRunRouteSchema),
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

/** Ask for an ended execution to be continued by the next run in its session. */
export const EnterpriseRunsResumeParamsSchema = Type.Object(
  {
    executionId: NonEmptyString,
    /**
     * Expected transcript UUID from run detail; the server verifies it is still
     * current. Added in protocol v4, so an absent legacy value is accepted at
     * the wire boundary but safely refused as transcript-rotated.
     */
    sessionId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/**
 * Whether the request was accepted, and if not, why — the operator sees a
 * specific reason rather than a failed call, since every refusal here is a normal
 * state of the run rather than a fault.
 */
export const EnterpriseRunsResumeResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    reason: Type.Optional(EnterpriseRunsResumeRefusalReasonSchema),
  },
  { additionalProperties: false },
);

export const EnterpriseModeGetParamsSchema = Type.Object({}, { additionalProperties: false });

export const EnterpriseModeGetResultSchema = Type.Object(
  { mode: EnterpriseModeSchema },
  { additionalProperties: false },
);

export const EnterpriseModeSetParamsSchema = Type.Object(
  { mode: EnterpriseModeSchema },
  { additionalProperties: false },
);

export const EnterpriseModeSetResultSchema = Type.Object(
  { mode: EnterpriseModeSchema },
  { additionalProperties: false },
);

/**
 * Who administers a knowledge foundation's content (mirrors
 * KnowledgeFoundationKind). Operator-declared, not inferred from the URL.
 */
export const EnterpriseKnowledgeFoundationKindSchema = Type.Union([
  Type.Literal("remote"),
  Type.Literal("local"),
]);

/** One node that names a foundation in its ontology allow-list. */
export const EnterpriseKnowledgeFoundationReferenceSchema = Type.Object(
  {
    treeId: NonEmptyString,
    treeName: Type.String(),
    nodeId: NonEmptyString,
    nodeTitle: Type.String(),
  },
  { additionalProperties: false },
);

/** One registered foundation, summarized for the Knowledge inspector. */
export const EnterpriseKnowledgeFoundationSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    kind: EnterpriseKnowledgeFoundationKindSchema,
    displayName: Type.String(),
    /** Non-secret locator (e.g. server origin); adapters strip credentials. */
    detail: Type.Optional(Type.String()),
    /** Non-secret one-line summary of what the foundation covers. */
    description: Type.Optional(Type.String()),
    /**
     * The one tree whose imported bundle owns this row. Retrieval resolves a
     * bundle foundation only for its OWNING tree, so the same id may appear in
     * several rows with different descriptors. Empty means a plugin registered
     * the id globally; omitted means an older gateway did not report ownership.
     */
    ownerTreeIds: Type.Optional(Type.Array(NonEmptyString)),
    /** Nodes whose ontology allow-list names this foundation. */
    referencedBy: Type.Array(EnterpriseKnowledgeFoundationReferenceSchema),
  },
  { additionalProperties: false },
);

/** Foundation list request (the registry is process-local and small). */
export const EnterpriseKnowledgeFoundationsListParamsSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const EnterpriseKnowledgeFoundationsListResultSchema = Type.Object(
  {
    foundations: Type.Array(EnterpriseKnowledgeFoundationSummarySchema),
  },
  { additionalProperties: false },
);

/**
 * Connection probe outcome. Wider than the adapter's own ok/failed because only
 * the host knows an id went away or that the adapter cannot probe at all — the
 * inspector renders those differently from a server answering "unreachable".
 */
export const EnterpriseKnowledgeConnectionStatusSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("failed"),
  Type.Literal("unsupported"),
  Type.Literal("not-registered"),
]);

export const EnterpriseKnowledgeFoundationsTestConnectionParamsSchema = Type.Object(
  { foundationId: NonEmptyString },
  { additionalProperties: false },
);

export const EnterpriseKnowledgeFoundationsTestConnectionResultSchema = Type.Object(
  {
    status: EnterpriseKnowledgeConnectionStatusSchema,
    detail: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Normalized document indexing lifecycle (mirrors KnowledgeDocumentStatus). */
export const EnterpriseKnowledgeDocumentStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("processing"),
  Type.Literal("indexed"),
  Type.Literal("failed"),
  Type.Literal("unknown"),
]);

/** One document held by a locally administered foundation. */
export const EnterpriseKnowledgeDocumentSchema = Type.Object(
  {
    id: NonEmptyString,
    name: Type.String(),
    status: EnterpriseKnowledgeDocumentStatusSchema,
    /** Store-derived excerpt; some stores expose no full-text read. */
    summary: Type.Optional(Type.String()),
    contentLength: Type.Optional(Type.Integer({ minimum: 0 })),
    chunkCount: Type.Optional(Type.Integer({ minimum: 0 })),
    error: Type.Optional(Type.String()),
    updatedAt: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * Why a document call could not be served. Shared by all three document
 * methods: "read-only" means the foundation is not operator-administered
 * (`kind !== "local"`), which is a policy answer rather than a fault.
 */
const KnowledgeDocumentsUnavailableStatuses = [
  Type.Literal("unsupported"),
  Type.Literal("read-only"),
  Type.Literal("not-registered"),
  Type.Literal("failed"),
] as const;

export const EnterpriseKnowledgeDocumentsListParamsSchema = Type.Object(
  { foundationId: NonEmptyString },
  { additionalProperties: false },
);

/** Named so codegen emits a real enum instead of an opaque any-typed field. */
export const EnterpriseKnowledgeDocumentsListStatusSchema = Type.Union([
  Type.Literal("ok"),
  ...KnowledgeDocumentsUnavailableStatuses,
]);

export const EnterpriseKnowledgeDocumentsListResultSchema = Type.Object(
  {
    status: EnterpriseKnowledgeDocumentsListStatusSchema,
    /** Always present; empty unless status is "ok". */
    documents: Type.Array(EnterpriseKnowledgeDocumentSchema),
    detail: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * Decoded upload cap. Base64 inflates by 4/3, so 8 MiB of file is ~11 MiB on
 * the wire — well inside the gateway's 25 MiB frame limit (MAX_PAYLOAD_BYTES)
 * with room for the rest of the envelope.
 */
export const ENTERPRISE_KNOWLEDGE_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;

export const EnterpriseKnowledgeDocumentsUploadParamsSchema = Type.Object(
  {
    foundationId: NonEmptyString,
    name: NonEmptyString,
    // Length gate before decoding, so an oversized payload is rejected without
    // allocating it; the handler re-checks the decoded byte length.
    contentBase64: Type.String({ minLength: 1, maxLength: 11_184_816 }),
  },
  { additionalProperties: false },
);

/**
 * Flat closed outcome. The store's answers (accepted/duplicate/too-large/
 * rejected) and the host's (unsupported/read-only/not-registered/failed) share
 * one enum so a client switches once instead of unwrapping nested statuses.
 */
export const EnterpriseKnowledgeDocumentsUploadStatusSchema = Type.Union([
  Type.Literal("accepted"),
  Type.Literal("duplicate"),
  Type.Literal("too-large"),
  Type.Literal("rejected"),
  ...KnowledgeDocumentsUnavailableStatuses,
]);

export const EnterpriseKnowledgeDocumentsUploadResultSchema = Type.Object(
  {
    status: EnterpriseKnowledgeDocumentsUploadStatusSchema,
    /** Store-side tracking handle for the async indexing job, when given. */
    trackingId: Type.Optional(Type.String()),
    detail: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const EnterpriseKnowledgeDocumentsRemoveParamsSchema = Type.Object(
  { foundationId: NonEmptyString, documentId: NonEmptyString },
  { additionalProperties: false },
);

/** "started" rather than "removed": stores commonly delete in the background. */
export const EnterpriseKnowledgeDocumentsRemoveStatusSchema = Type.Union([
  Type.Literal("started"),
  Type.Literal("busy"),
  Type.Literal("refused"),
  ...KnowledgeDocumentsUnavailableStatuses,
]);

export const EnterpriseKnowledgeDocumentsRemoveResultSchema = Type.Object(
  {
    status: EnterpriseKnowledgeDocumentsRemoveStatusSchema,
    detail: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
