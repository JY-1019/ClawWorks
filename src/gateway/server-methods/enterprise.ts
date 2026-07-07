// ClawWorks enterprise gateway methods expose read-only projections of the
// workflow-tree registry and the run trace store to operator clients (the UI
// enterprise tab). The wire shapes trim the model-visible plan/ontology to the
// execution-scoping fields an inspector renders; the internal records carry more.
import {
  type EnterprisePlanNode,
  type EnterpriseRunDetail,
  type EnterpriseRunEvent,
  type EnterpriseRunSummary,
  type EnterpriseTreeSummary,
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateEnterpriseRunsGetParams,
  validateEnterpriseRunsListParams,
  validateEnterpriseTreesListParams,
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
  countWorkflowTreeNodes,
  getWorkflowTreeRegistrySnapshot,
} from "../../enterprise/tree-registry.js";
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
