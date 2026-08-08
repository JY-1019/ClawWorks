/**
 * Process-local enterprise run state and the per-tool-call governance gate.
 * The registry carries prepared facts (plan, policies, trace sink) keyed by
 * runId so hot-path gate lookups never re-resolve config or definitions.
 * Trace persistence stays behind the sink installed by run mediation, keeping
 * this module import-light for agent hot paths.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { activeRuns, getEnterpriseActiveRun, type EnterpriseActiveRun } from "./active-runs.js";
import { evaluateToolCallGovernance, policyTargetsNode, policyTargetsTree } from "./governance.js";
import {
  enterpriseStepSequence,
  findPlanNode,
  planTracksSteps,
  resolvePlanNodePath,
  summarizeModelText,
} from "./plan.js";
import type {
  EnterpriseMode,
  EnterprisePlanNode,
  EnterpriseRunPlan,
  GovernanceDecision,
} from "./types.js";

// Re-exported so the registry's move stays invisible to every existing caller.
export {
  clearEnterpriseActiveRunsForTest,
  adoptEnterpriseActiveRunSessionId,
  enterpriseRunAttachedMcpServers,
  getEnterpriseActiveRun,
  getSessionActiveRunId,
  registerEnterpriseActiveRun,
  resolveEnterpriseMcpServers,
  unregisterEnterpriseActiveRun,
  type EnterpriseActiveRun,
  type EnterpriseRunTraceSink,
} from "./active-runs.js";

/** Effective enterprise mode. Enterprise is on ("enforce") unless config opts out. */
export function resolveEnterpriseMode(config?: OpenClawConfig): EnterpriseMode {
  return config?.enterprise?.mode ?? "enforce";
}

/**
 * Whether a mediated run advances/traces per-node steps (governed trees only).
 *
 * A property of the PLAN, not of the runtime executing it. Advancement used to
 * be a turn counter owned by the embedded loop, which left CLI, Codex and ACP
 * runs pinned to the root for their whole life while still being handed the
 * leaves' tools — advertised but unreachable. The cursor moves on a tool call
 * now (see completeEnterpriseStep), so any runtime that can call a tool can walk
 * the route, and one answer serves every one of them.
 */
function runTracksSteps(run: EnterpriseActiveRun): boolean {
  if (planTracksSteps(run.plan)) {
    return true;
  }
  // Node-scoped governance policies also require advancement so the active node
  // can reach the leaves they target. Only policies that can match this run
  // count, or an unrelated tree's policy would break the write-quiet no-op path.
  //
  // "Can match" means the NODES too, not just the tree: a policy whose globs hit
  // nothing in this plan can never fire, so advancing for it buys nothing — and
  // an exporter deciding which policies are relevant to a work-map would
  // otherwise disagree with this predicate and silently drop step tracking on the
  // imported copy.
  return (
    run.plan.nodes.length > 1 &&
    run.policies.some(
      (policy) =>
        (policy.nodes?.length ?? 0) > 0 &&
        policyTargetsTree(policy, run.plan.treeId) &&
        run.plan.nodes.some((node) => policyTargetsNode(policy, node.nodeId)),
    )
  );
}

export function enterpriseRunTracksSteps(runId: string): boolean {
  const run = activeRuns().get(runId);
  return run ? runTracksSteps(run) : false;
}

/** The step the run stands on, for the model and for operator-facing surfaces. */
export type EnterpriseStepRef = { nodeId: string; title: string; ordinal: number; total: number };

/**
 * Outcome of asking the run to finish its current step. Closed so callers cannot
 * confuse "there was nothing to advance" with "advanced onto the last step".
 */
export type EnterpriseStepAdvance =
  | { kind: "unmediated" }
  | { kind: "no-steps" }
  | { kind: "wrong-step"; active: EnterpriseStepRef }
  | { kind: "already-complete"; completed: EnterpriseStepRef }
  | { kind: "advanced"; completed: EnterpriseStepRef | null; next: EnterpriseStepRef }
  | { kind: "route-complete"; completed: EnterpriseStepRef };

function stepRef(run: EnterpriseActiveRun, nodeId: string): EnterpriseStepRef | null {
  const node = findPlanNode(run.plan, nodeId);
  if (!node) {
    return null;
  }
  const steps = enterpriseStepSequence(run.plan);
  const index = steps.indexOf(nodeId);
  return {
    nodeId: node.nodeId,
    title: node.title,
    // Interior nodes are not steps; report them as ordinal 0 rather than -1 so a
    // rendered "step 0 of N" reads as "not on a step yet".
    ordinal: index + 1,
    total: steps.length,
  };
}

/**
 * Finish the current step and move onto the next one.
 *
 * This is the ONLY thing that advances a run, and it is driven by the model
 * (complete_step) rather than by a turn count. A turn count could not express
 * the thing that actually matters — whether the step's work is done — so a node
 * needing five turns was abandoned after one and the remaining four executed
 * under the NEXT node's tools, knowledge and ontology.
 *
 * Advancement is monotonic and one step at a time: the cursor can never go
 * backwards and never skips a step, so the worst a confused model can do is
 * finish early, which the trace records. `expectedNodeId` lets the caller assert
 * which step it believes it is finishing, so a model that has lost track is told
 * where the run actually stands instead of silently advancing the wrong one.
 */
export function completeEnterpriseStep(params: {
  runId: string;
  expectedNodeId?: string;
  summary?: string;
  /**
   * The advancing call's tool-call id. The transcript's toolResult row carries the
   * same id, so recording it on `node.completed` anchors the step timeline to an
   * exact point in the conversation instead of a timestamp somewhere near it.
   */
  toolCallId?: string;
}): EnterpriseStepAdvance {
  const run = activeRuns().get(params.runId);
  if (!run) {
    return { kind: "unmediated" };
  }
  if (!runTracksSteps(run)) {
    return { kind: "no-steps" };
  }
  const steps = enterpriseStepSequence(run.plan);
  const activeId = run.plan.activeNodeId;
  const active = stepRef(run, activeId);
  if (!active) {
    return { kind: "no-steps" };
  }
  if (params.expectedNodeId && params.expectedNodeId !== activeId) {
    return { kind: "wrong-step", active };
  }
  const activeIndex = steps.indexOf(activeId);
  // Mediation puts every tracking run's cursor on step 1, so an interior node
  // here means a plan built outside it (a test fixture, or a row restored from an
  // older shape). Enter step 1 rather than refuse: completing nothing is correct,
  // since a scope container did no work.
  const nextId = activeIndex < 0 ? steps[0] : steps[activeIndex + 1];
  const completed = activeIndex < 0 ? null : active;
  const summary = params.summary ? summarizeModelText(params.summary) : "";
  if (completed) {
    if (run.routeCompleted) {
      return { kind: "already-complete", completed };
    }
    run.sink?.({
      kind: "node.completed",
      nodeId: completed.nodeId,
      payload: {
        seq: findPlanNode(run.plan, completed.nodeId)?.seq ?? 0,
        title: completed.title,
        // What the step actually produced, in the model's words. The trace
        // otherwise records only that a step ended, never what it did — and this
        // is the only per-node account of the work that survives the run.
        //
        // Redacted and bounded HERE, at the persistence boundary, exactly like the
        // route rationale: this is model text that can quote a credential straight
        // out of the prompt or a tool result, and it is written to
        // enterprise_run_events and rendered by both the Control UI and
        // `openclaw enterprise runs show`.
        ...(summary ? { summary } : {}),
        // The conversation anchor. Joins this step to the exact transcript row
        // that closed it, which is what makes "what happened at node X" answerable
        // without stamping a node id onto every message.
        ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
      },
    });
  }
  if (!nextId) {
    // Last step. Leave the cursor where it is: dropping back to the root would
    // widen the scope the run finishes under, and there is nowhere forward.
    run.routeCompleted = true;
    return { kind: "route-complete", completed: completed ?? active };
  }
  const to = findPlanNode(run.plan, nextId);
  if (!to) {
    return { kind: "route-complete", completed: completed ?? active };
  }
  run.plan.activeNodeId = to.nodeId;
  run.sink?.({
    kind: "node.entered",
    nodeId: to.nodeId,
    payload: { seq: to.seq, title: to.title },
  });
  const next = stepRef(run, to.nodeId);
  return { kind: "advanced", completed, next: next ?? { ...active, nodeId: to.nodeId } };
}

/** The step the run currently stands on, or null when it tracks no steps. */
export function enterpriseRunActiveStep(runId: string): EnterpriseStepRef | null {
  const run = activeRuns().get(runId);
  if (!run || !runTracksSteps(run)) {
    return null;
  }
  return stepRef(run, run.plan.activeNodeId);
}

export type EnterpriseToolCallVerdict = {
  decision: GovernanceDecision;
  nodeId: string;
  treeId: string;
  mode: Exclude<EnterpriseMode, "off">;
  /** True when the decision must block execution (enforce mode denials). */
  blocked: boolean;
  /** True when enforce mode must gate this call behind a human approval. */
  requiresApproval: boolean;
};

/**
 * Governance gate for one tool call. Returns undefined when the run is not
 * enterprise-mediated (mode off, unmediated caller, or unknown runId).
 * Never throws: internal evaluation failures fail closed in enforce mode and
 * open in observe mode, mirroring the enterprise/observe contract.
 */
/**
 * The ontology action a tool call names, if any.
 *
 * invoke_action is the only tool whose SUBJECT is an ontology action rather than
 * the tool itself, and governance has to know which action was chosen before it
 * can decide. The tool-name literal lives here, in the enterprise domain that
 * owns the tool, rather than in the generic before-tool-call gate.
 */
/**
 * Record what an ontology action actually DID. The governance decision that
 * permitted the call is a separate event and says nothing about the write, so
 * without this the audit trail can show that a write was allowed but not that it
 * happened, nor to which object.
 */
export function recordEnterpriseActionInvoked(
  runId: string,
  event: { actionId: string; writes: readonly unknown[]; context: Record<string, unknown> },
): void {
  const run = getEnterpriseActiveRun(runId);
  if (!run?.sink) {
    return;
  }
  try {
    run.sink({
      kind: "action.invoked",
      nodeId: run.plan.activeNodeId,
      payload: { actionId: event.actionId, writes: event.writes, context: event.context },
    });
  } catch {
    // Fail OPEN. The write is already committed and durable, so letting a trace
    // fault propagate would report a successful mutation as a FAILED tool call —
    // and the model would sensibly retry it, writing twice. The sink logs its own
    // persistence failures (persistTrace), and this module stays import-light for
    // the agent hot path, so there is nothing to add here but the guarantee.
  }
}

/**
 * Does this tool's SUBJECT come from its params rather than its name?
 *
 * invoke_action's action id decides which governance policy applies, and a hook
 * can add or change it after the first gate — including filling in one that was
 * absent. So the final decision for this tool must always be taken on the final
 * params, whether or not the call arrived with an action.
 */
export function toolCarriesOntologyAction(toolName: string): boolean {
  return toolName === "invoke_action";
}

/**
 * The two ways a node can consent to ontology writes: naming the tool, or naming
 * the group that exists solely to hold it. `*` and `group:enterprise` (the READ
 * group) are not consent — a wildcard has not thought about writes, and the read
 * group has only ever meant read.
 *
 * Normalized like the tool-policy matcher normalizes a name (trim + lowercase),
 * because the ontology scope gate accepts `INVOKE_ACTION` and a step that
 * explicitly allowed the tool must not have its writes denied on casing.
 */
const ONTOLOGY_WRITE_OPT_INS = new Set(["invoke_action", "group:enterprise-write"]);
function explicitlyAllowsOntologyWrites(node: EnterprisePlanNode): boolean {
  return (node.ontology.allowedTools ?? []).some((tool) =>
    ONTOLOGY_WRITE_OPT_INS.has(tool.trim().toLowerCase()),
  );
}

/**
 * Does ANY planned node opt into ontology writes? Plan-level, so the tool list
 * stays fixed for the run (prompt cache). Exposure only — see the path check.
 */
export function runAllowsOntologyWrites(runId: string): boolean {
  const run = getEnterpriseActiveRun(runId);
  return run ? run.plan.nodes.some(explicitlyAllowsOntologyWrites) : false;
}

/**
 * May the run write from where it currently STANDS?
 *
 * Exposure is plan-level and must be (the model-visible tool list cannot change
 * mid-run), but exposure is not permission: one sibling opting into writes would
 * otherwise hand the tool to every other step, including one that declares actions
 * and omits `allowedTools` — which the per-call scope gate reads as allow-all.
 *
 * This is GOVERNANCE, not a tool-level afterthought: deciding it here means a
 * non-opted step is denied and recorded before any approval is prompted, rather
 * than prompting a human and then having the tool refuse the call anyway.
 */
function activePathAllowsWrites(plan: EnterpriseRunPlan): boolean {
  const node = findPlanNode(plan, plan.activeNodeId);
  if (!node) {
    return false;
  }
  return resolvePlanNodePath(plan, node.nodeId).some(explicitlyAllowsOntologyWrites);
}

export function readInvokedActionId(toolName: string, params: unknown): string | undefined {
  if (!toolCarriesOntologyAction(toolName) || !params || typeof params !== "object") {
    return undefined;
  }
  const action = (params as Record<string, unknown>).action;
  return typeof action === "string" && action.trim().length > 0 ? action.trim() : undefined;
}

export function evaluateEnterpriseToolCall(params: {
  runId?: string;
  toolName: string;
  /** This tool's MCP registration, from the tool object the dispatcher holds. */
  mcpTool?: { serverName: string; safeServerName: string; toolName: string };
  toolCallId?: string;
  /** The ontology action the call names (invoke_action). See readInvokedActionId. */
  actionId?: string;
  /**
   * Write the decision to the audit trail. The pre-hook check for a call whose
   * params a hook may still rewrite passes false: recording there would leave the
   * trail claiming action A was allowed when action B actually ran, and nothing
   * can retract an appended event.
   */
  record?: boolean;
}): EnterpriseToolCallVerdict | undefined {
  if (!params.runId) {
    return undefined;
  }
  const run = getEnterpriseActiveRun(params.runId);
  if (!run) {
    return undefined;
  }
  const { plan } = run;
  try {
    const node = findPlanNode(plan, plan.activeNodeId);
    if (!node) {
      throw new Error(`active workflow node "${plan.activeNodeId}" missing from plan`);
    }
    // An ontology WRITE needs an explicit opt-in on the active path, decided
    // before any policy or approval runs.
    if (toolCarriesOntologyAction(params.toolName) && !activePathAllowsWrites(plan)) {
      const verdict: EnterpriseToolCallVerdict = {
        decision: {
          effect: "deny",
          policyId: null,
          source: "ontology",
          reason: `workflow step "${node.nodeId}" does not allow ontology writes; a step must name invoke_action in its allowedTools`,
        },
        nodeId: node.nodeId,
        treeId: plan.treeId,
        mode: plan.mode,
        blocked: plan.mode === "enforce",
        requiresApproval: false,
      };
      // Same rule as every other decision: a BLOCKED call is always recorded (it
      // returns immediately, so nothing can rewrite it), but an observed one that
      // a later pass will re-judge must not be written twice.
      if (verdict.blocked || params.record !== false) {
        recordDecision(run, verdict, params);
      }
      return verdict;
    }
    // Scope the call with the active node's ontology plus its ancestors so a
    // deeper step cannot escape the tool scope its root declared.
    const path = resolvePlanNodePath(plan, node.nodeId);
    const decision = evaluateToolCallGovernance({
      plan,
      node,
      toolName: params.toolName,
      policies: run.policies,
      path,
      ...(params.mcpTool ? { mcpTool: params.mcpTool } : {}),
      ...(run.mcpServers ? { mcpServers: run.mcpServers } : {}),
      // A run with no steps to walk never leaves its opening scope, so a leaf's
      // attachment could never be reached from the active path — read them
      // plan-wide there instead of denying every grant the work-map declared.
      // The same answer also tells governance whether the core step-advance tool
      // exists for this run, which is what makes a call by that name provably ours.
      ...(runTracksSteps(run) ? { tracksSteps: true } : { attachmentScope: "plan" as const }),
      ...(params.actionId !== undefined ? { actionId: params.actionId } : {}),
      ...(toolCarriesOntologyAction(params.toolName) ? { carriesAction: true } : {}),
    });
    const verdict: EnterpriseToolCallVerdict = {
      decision,
      nodeId: node.nodeId,
      treeId: plan.treeId,
      mode: plan.mode,
      blocked: decision.effect === "deny" && plan.mode === "enforce",
      requiresApproval: decision.effect === "require_approval" && plan.mode === "enforce",
    };
    // Default allows stay silent (matching run-start mediation) so the stock
    // enterprise path adds no per-tool-call SQLite writes; a node opts into full
    // decision auditing with ontology.audit. Audit is inherited down the path so
    // a root audit setting keeps covering leaves after the run advances.
    // Approval-gated calls are recorded once the human decision resolves.
    const auditEnabled = path.some((step) => step.ontology.audit === true);
    const silentDefaultAllow =
      decision.effect === "allow" && decision.source === "default" && !auditEnabled;
    // A BLOCKED call is always recorded, whatever `record` says: it returns
    // immediately, so no hook can still rewrite it, and a denied write attempt is
    // exactly the event an operator needs in the trace. `record: false` exists to
    // suppress a decision that a later hook could invalidate — never a denial.
    const shouldRecord = verdict.blocked || params.record !== false;
    if (shouldRecord && !silentDefaultAllow && !verdict.requiresApproval) {
      recordDecision(run, verdict, params);
    }
    return verdict;
  } catch (err) {
    const reason = `enterprise governance evaluation failed: ${err instanceof Error ? err.message : String(err)}`;
    const decision: GovernanceDecision = {
      effect: plan.mode === "enforce" ? "deny" : "allow",
      policyId: null,
      source: "default",
      reason,
    };
    const verdict: EnterpriseToolCallVerdict = {
      decision,
      nodeId: plan.activeNodeId,
      treeId: plan.treeId,
      mode: plan.mode,
      blocked: plan.mode === "enforce",
      requiresApproval: false,
    };
    recordDecision(run, verdict, params);
    return verdict;
  }
}

export type EnterpriseApprovalOutcome = "approved" | "denied";

/**
 * Record the resolution of an approval-gated tool call. Called from the
 * approval onResolution callback so the trace reflects the real outcome
 * across inline, deferred, and cancelled resolutions.
 */
export function recordEnterpriseApprovalResolution(params: {
  runId: string;
  verdict: EnterpriseToolCallVerdict;
  toolName: string;
  toolCallId?: string;
  /** The ontology action the approval was about (invoke_action). */
  actionId?: string;
  outcome: EnterpriseApprovalOutcome;
  resolution: string;
}): void {
  const run = getEnterpriseActiveRun(params.runId);
  if (!run) {
    return;
  }
  try {
    run.sink?.({
      kind: "governance.decision",
      nodeId: params.verdict.nodeId,
      payload: {
        subject: "tool_call",
        toolName: params.toolName,
        // Which declared action the approval was about; see recordDecision.
        ...(params.actionId !== undefined ? { actionId: params.actionId } : {}),
        ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
        effect: "require_approval",
        enforced: params.outcome === "denied",
        approved: params.outcome === "approved",
        resolution: params.resolution,
        policyId: params.verdict.decision.policyId,
        source: params.verdict.decision.source,
        reason: params.verdict.decision.reason,
      },
    });
  } catch {
    // Trace sinks fail open: a persistence fault must never affect the
    // approval outcome already resolved for this call.
  }
}

function recordDecision(
  run: EnterpriseActiveRun,
  verdict: EnterpriseToolCallVerdict,
  params: { toolName: string; toolCallId?: string; actionId?: string },
): void {
  try {
    run.sink?.({
      kind: "governance.decision",
      nodeId: verdict.nodeId,
      payload: {
        subject: "tool_call",
        toolName: params.toolName,
        // The ACTION is the subject of an invoke_action decision, and the reason
        // string is not always going to carry it (a policy may set its own
        // description). Without it, a denied or approved write in the trail cannot
        // say WHICH declared action was attempted.
        ...(params.actionId !== undefined ? { actionId: params.actionId } : {}),
        ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
        effect: verdict.decision.effect,
        enforced: verdict.blocked,
        policyId: verdict.decision.policyId,
        source: verdict.decision.source,
        reason: verdict.decision.reason,
      },
    });
  } catch {
    // Trace sinks fail open: a persistence fault must never affect the
    // governance verdict already computed for this call.
  }
}
