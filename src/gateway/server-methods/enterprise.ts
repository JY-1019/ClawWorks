// ClawWorks enterprise gateway methods expose read-only projections of the
// workflow-tree registry and the run trace store to operator clients (the UI
// enterprise tab). The wire shapes trim the model-visible plan/ontology to the
// execution-scoping fields an inspector renders; the internal records carry more.
import {
  type EnterprisePlanNode,
  type EnterpriseRunDetail,
  type EnterpriseRunEvent,
  type EnterpriseRunSummary,
  type EnterpriseTreeDetail,
  type EnterpriseTreeNode,
  type EnterpriseTreeOntology,
  type EnterpriseTreesExportResult,
  type EnterpriseTreesGetResult,
  type EnterpriseTreesHistoryGetResult,
  type EnterpriseTreesHistoryListResult,
  type EnterpriseTreesImportResult,
  type EnterpriseTreesRemoveResult,
  type EnterpriseTreeSummary,
  type EnterpriseTreeVersionSummary,
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateEnterpriseRunsGetParams,
  validateEnterpriseRunsListParams,
  validateEnterpriseTreesExportParams,
  validateEnterpriseTreesGetParams,
  validateEnterpriseTreesHistoryGetParams,
  validateEnterpriseTreesHistoryListParams,
  validateEnterpriseTreesImportParams,
  validateEnterpriseTreesListParams,
  validateEnterpriseTreesRemoveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  type EnterpriseRunEventRecord,
  type EnterpriseRunRecord,
  getEnterpriseRunRecordByExecutionId,
  listEnterpriseRunEvents,
  listEnterpriseRunExecutions,
  listEnterpriseRunRecords,
} from "../../enterprise/trace-store.sqlite.js";
import {
  exportWorkflowTree,
  importWorkflowTreeContent,
  removeImportedWorkflowTree,
  serializeWorkflowTree,
} from "../../enterprise/tree-io.js";
import {
  countWorkflowTreeNodes,
  getWorkflowTreeRegistrySnapshot,
  type WorkflowTreeRegistryEntry,
} from "../../enterprise/tree-registry.js";
import {
  getEnterpriseWorkflowTreeVersion,
  listEnterpriseWorkflowTreeVersions,
} from "../../enterprise/tree-store.sqlite.js";
import type {
  OntologyBinding,
  WorkflowNodeDefinition,
  WorkflowTreeMatch,
} from "../../enterprise/types.js";
import type { GatewayRequestHandlers } from "./types.js";

type PlanNodeRecord = EnterpriseRunRecord["plan"]["nodes"][number];

/** Project only the execution-scoping ontology fields the inspector shows. */
function mapOntology(ontology: PlanNodeRecord["ontology"]): EnterprisePlanNode["ontology"] {
  return {
    ...(ontology.allowedTools ? { allowedTools: ontology.allowedTools } : {}),
    ...(ontology.deniedTools ? { deniedTools: ontology.deniedTools } : {}),
    ...(ontology.knowledgeFoundations
      ? { knowledgeFoundations: ontology.knowledgeFoundations }
      : {}),
    ...(ontology.contextHints ? { contextHints: ontology.contextHints } : {}),
    ...(ontology.expectedOutput !== undefined ? { expectedOutput: ontology.expectedOutput } : {}),
    ...(ontology.audit !== undefined ? { audit: ontology.audit } : {}),
  };
}

function mapPlanNode(node: PlanNodeRecord): EnterprisePlanNode {
  return {
    nodeId: node.nodeId,
    parentId: node.parentId,
    seq: node.seq,
    title: node.title,
    ...(node.description !== undefined ? { description: node.description } : {}),
    ontology: mapOntology(node.ontology),
  };
}

function mapRunSummary(record: EnterpriseRunRecord): EnterpriseRunSummary {
  return {
    executionId: record.executionId,
    runId: record.runId,
    treeId: record.treeId,
    treeVersion: record.treeVersion,
    mode: record.mode,
    status: record.status,
    requestSummary: record.requestSummary,
    activeNodeId: record.plan.activeNodeId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    endedAt: record.endedAt,
  };
}

function mapEvent(event: EnterpriseRunEventRecord): EnterpriseRunEvent {
  return {
    seq: event.seq,
    nodeId: event.nodeId,
    kind: event.kind,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

function mapRunDetail(
  record: EnterpriseRunRecord,
  events: EnterpriseRunEventRecord[],
  executionCount: number,
): EnterpriseRunDetail {
  return {
    executionId: record.executionId,
    runId: record.runId,
    sessionKey: record.sessionKey,
    agentId: record.agentId,
    treeId: record.treeId,
    treeVersion: record.treeVersion,
    treeName: record.plan.treeName,
    mode: record.mode,
    status: record.status,
    matchedBy: record.plan.matchedBy,
    requestSummary: record.requestSummary,
    activeNodeId: record.plan.activeNodeId,
    nodes: record.plan.nodes.map(mapPlanNode),
    events: events.map(mapEvent),
    executionCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    endedAt: record.endedAt,
  };
}

/** Project a node's full ontology (structure graph + execution scope). */
function mapTreeOntology(ontology: OntologyBinding | undefined): EnterpriseTreeOntology {
  if (!ontology) {
    return {};
  }
  const projected: EnterpriseTreeOntology = {};
  if (ontology.entities?.length) {
    projected.entities = ontology.entities.map((entity) => ({
      id: entity.id,
      description: entity.description,
    }));
  }
  if (ontology.relationships?.length) {
    projected.relationships = ontology.relationships.map((relationship) => ({
      id: relationship.id,
      from: relationship.from,
      to: relationship.to,
      description: relationship.description,
    }));
  }
  if (ontology.actions?.length) {
    // Clone the tool globs: the registry snapshot is process-stable and shared,
    // so the read-only payload must not hand out its mutable arrays.
    projected.actions = ontology.actions.map((action) => ({
      id: action.id,
      description: action.description,
      tools: action.tools ? [...action.tools] : undefined,
    }));
  }
  if (ontology.constraints?.length) {
    projected.constraints = ontology.constraints.map((constraint) => ({
      id: constraint.id,
      description: constraint.description,
    }));
  }
  if (ontology.allowedTools) {
    projected.allowedTools = [...ontology.allowedTools];
  }
  if (ontology.deniedTools) {
    projected.deniedTools = [...ontology.deniedTools];
  }
  if (ontology.knowledgeFoundations) {
    projected.knowledgeFoundations = [...ontology.knowledgeFoundations];
  }
  if (ontology.contextHints) {
    projected.contextHints = [...ontology.contextHints];
  }
  if (ontology.expectedOutput !== undefined) {
    projected.expectedOutput = ontology.expectedOutput;
  }
  if (ontology.audit !== undefined) {
    projected.audit = ontology.audit;
  }
  return projected;
}

/** Flatten a tree root depth-first into wire nodes carrying parent id + depth. */
function flattenTreeNodes(root: WorkflowNodeDefinition): EnterpriseTreeNode[] {
  const nodes: EnterpriseTreeNode[] = [];
  const walk = (node: WorkflowNodeDefinition, parentId: string | null, depth: number): void => {
    nodes.push({
      id: node.id,
      parentId,
      depth,
      title: node.title,
      description: node.description,
      ontology: mapTreeOntology(node.ontology),
    });
    for (const child of node.children ?? []) {
      walk(child, node.id, depth + 1);
    }
  };
  walk(root, null, 0);
  return nodes;
}

function mapTreeMatch(match: WorkflowTreeMatch): NonNullable<EnterpriseTreeDetail["match"]> {
  // Clone the shared registry arrays so payload mutation can't affect selection.
  const projected: NonNullable<EnterpriseTreeDetail["match"]> = {};
  if (match.keywords) {
    projected.keywords = [...match.keywords];
  }
  if (match.triggers) {
    projected.triggers = [...match.triggers];
  }
  if (match.priority !== undefined) {
    projected.priority = match.priority;
  }
  return projected;
}

function buildTreeDetail(entry: WorkflowTreeRegistryEntry): EnterpriseTreeDetail {
  const detail: EnterpriseTreeDetail = {
    id: entry.tree.id,
    version: entry.tree.version,
    name: entry.tree.name,
    description: entry.tree.description,
    source: entry.source,
    nodes: flattenTreeNodes(entry.tree.root),
  };
  if (entry.tree.match) {
    detail.match = mapTreeMatch(entry.tree.match);
  }
  return detail;
}

export const enterpriseHandlers: GatewayRequestHandlers = {
  "enterprise.trees.list": ({ params, respond }) => {
    if (!validateEnterpriseTreesListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.trees.list params: ${formatValidationErrors(validateEnterpriseTreesListParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = getWorkflowTreeRegistrySnapshot();
    respond(true, {
      trees: snapshot.entries.map(
        (entry): EnterpriseTreeSummary => ({
          id: entry.tree.id,
          version: entry.tree.version,
          name: entry.tree.name,
          source: entry.source,
          nodeCount: countWorkflowTreeNodes(entry.tree.root),
        }),
      ),
      importErrors: snapshot.importErrors,
      ...(snapshot.storeError !== undefined ? { storeError: snapshot.storeError } : {}),
    });
  },
  "enterprise.trees.get": ({ params, respond }) => {
    if (!validateEnterpriseTreesGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.trees.get params: ${formatValidationErrors(validateEnterpriseTreesGetParams.errors)}`,
        ),
      );
      return;
    }
    // Use the full snapshot (not just the resolved entry) so import/store load
    // failures for this id are surfaced. Otherwise a corrupt imported override
    // would return the stale built-in, and a failed imported-only tree would
    // return null, both as a misleadingly successful lookup.
    const snapshot = getWorkflowTreeRegistrySnapshot();
    const entry = snapshot.entries.find((candidate) => candidate.tree.id === params.treeId);
    const importError = snapshot.importErrors.find((issue) => issue.treeId === params.treeId);
    const result: EnterpriseTreesGetResult = { tree: entry ? buildTreeDetail(entry) : null };
    if (snapshot.storeError !== undefined) {
      result.storeError = snapshot.storeError;
    }
    if (importError) {
      result.importError = importError.message;
    }
    respond(true, result);
  },
  "enterprise.trees.import": ({ params, respond }) => {
    if (!validateEnterpriseTreesImportParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.trees.import params: ${formatValidationErrors(validateEnterpriseTreesImportParams.errors)}`,
        ),
      );
      return;
    }
    // Persist + snapshot a revision + refresh the registry. Schema-invalid
    // content is user data, not a protocol error: report it as ok:false issues
    // the editor renders inline rather than a request failure.
    const outcome = importWorkflowTreeContent({ content: params.content, format: params.format });
    const result: EnterpriseTreesImportResult = outcome.ok
      ? { ok: true, treeId: outcome.tree.id, replaced: outcome.replaced }
      : { ok: false, issues: outcome.issues.map((issue) => ({ ...issue })) };
    respond(true, result);
  },
  "enterprise.trees.export": ({ params, respond }) => {
    if (!validateEnterpriseTreesExportParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.trees.export params: ${formatValidationErrors(validateEnterpriseTreesExportParams.errors)}`,
        ),
      );
      return;
    }
    const outcome = exportWorkflowTree({ treeId: params.treeId, format: params.format });
    const result: EnterpriseTreesExportResult = outcome.ok
      ? { content: outcome.content, source: outcome.source }
      : { content: null, reason: outcome.reason };
    respond(true, result);
  },
  "enterprise.trees.remove": ({ params, respond }) => {
    if (!validateEnterpriseTreesRemoveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.trees.remove params: ${formatValidationErrors(validateEnterpriseTreesRemoveParams.errors)}`,
        ),
      );
      return;
    }
    // Only imported rows are removable; a shadowed built-in reappears. The
    // append-only version history is retained as an audit trail.
    const result: EnterpriseTreesRemoveResult = {
      removed: removeImportedWorkflowTree(params.treeId),
    };
    respond(true, result);
  },
  "enterprise.trees.history.list": ({ params, respond }) => {
    if (!validateEnterpriseTreesHistoryListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.trees.history.list params: ${formatValidationErrors(validateEnterpriseTreesHistoryListParams.errors)}`,
        ),
      );
      return;
    }
    // Bound the read: history is append-only and grows per save. Default to a
    // page of the newest revisions when the client does not specify a limit.
    const limit = params.limit ?? 100;
    const result: EnterpriseTreesHistoryListResult = {
      versions: listEnterpriseWorkflowTreeVersions(params.treeId, {}, limit).map(
        (record): EnterpriseTreeVersionSummary => ({
          revision: record.revision,
          version: record.version,
          name: record.name,
          sourceFormat: record.sourceFormat,
          savedAt: record.savedAt,
        }),
      ),
    };
    respond(true, result);
  },
  "enterprise.trees.history.get": ({ params, respond }) => {
    if (!validateEnterpriseTreesHistoryGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.trees.history.get params: ${formatValidationErrors(validateEnterpriseTreesHistoryGetParams.errors)}`,
        ),
      );
      return;
    }
    // Serialize the stored revision into the requested exchange format so the
    // editor can load it directly. Null content signals an unknown revision.
    const detail = getEnterpriseWorkflowTreeVersion(params.treeId, params.revision);
    const result: EnterpriseTreesHistoryGetResult = detail
      ? { content: serializeWorkflowTree(detail.tree, params.format), savedAt: detail.savedAt }
      : { content: null };
    respond(true, result);
  },
  "enterprise.runs.list": ({ params, respond }) => {
    if (!validateEnterpriseRunsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.runs.list params: ${formatValidationErrors(validateEnterpriseRunsListParams.errors)}`,
        ),
      );
      return;
    }
    const records = listEnterpriseRunRecords(params.limit ? { limit: params.limit } : {});
    respond(true, { runs: records.map(mapRunSummary) });
  },
  "enterprise.runs.get": ({ params, respond }) => {
    if (!validateEnterpriseRunsGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid enterprise.runs.get params: ${formatValidationErrors(validateEnterpriseRunsGetParams.errors)}`,
        ),
      );
      return;
    }
    const record = getEnterpriseRunRecordByExecutionId(params.executionId);
    if (!record) {
      // Null (not an error) is the schema's not-found signal; the inspector
      // renders an empty-state instead of surfacing a request failure.
      respond(true, { run: null });
      return;
    }
    const events = listEnterpriseRunEvents(record.executionId);
    // Sibling execution count for the same runId gives the inspector "run N of M".
    const executionCount = listEnterpriseRunExecutions(record.runId).length;
    respond(true, { run: mapRunDetail(record, events, executionCount) });
  },
};
