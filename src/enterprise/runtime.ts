/**
 * Process-local enterprise run state and the per-tool-call governance gate.
 * The registry carries prepared facts (plan, policies, trace sink) keyed by
 * runId so hot-path gate lookups never re-resolve config or definitions.
 * Trace persistence stays behind the sink installed by run mediation, keeping
 * this module import-light for agent hot paths.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { evaluateToolCallGovernance } from "./governance.js";
import { findPlanNode } from "./plan.js";
import type {
  EnterpriseMode,
  EnterpriseRunPlan,
  GovernanceDecision,
  GovernancePolicy,
} from "./types.js";

/** Trace sink installed by run mediation; must never throw. */
export type EnterpriseRunTraceSink = (event: {
  kind: "governance.decision";
  nodeId: string;
  payload: Record<string, unknown>;
}) => void;

export type EnterpriseActiveRun = {
  plan: EnterpriseRunPlan;
  policies: readonly GovernancePolicy[];
  sink?: EnterpriseRunTraceSink;
};

/** Effective enterprise mode. Enterprise is on ("enforce") unless config opts out. */
export function resolveEnterpriseMode(config?: OpenClawConfig): EnterpriseMode {
  return config?.enterprise?.mode ?? "enforce";
}

// Symbol-keyed global so duplicated dist chunks share one registry
// (same pattern as the memory embedding provider registry).
const ACTIVE_RUNS_KEY = Symbol.for("openclaw.enterpriseActiveRuns");

function activeRuns(): Map<string, EnterpriseActiveRun> {
  const holder = globalThis as { [ACTIVE_RUNS_KEY]?: Map<string, EnterpriseActiveRun> };
  holder[ACTIVE_RUNS_KEY] ??= new Map();
  return holder[ACTIVE_RUNS_KEY];
}

export function registerEnterpriseActiveRun(run: EnterpriseActiveRun): void {
  activeRuns().set(run.plan.runId, run);
}

export function getEnterpriseActiveRun(runId: string): EnterpriseActiveRun | undefined {
  return activeRuns().get(runId);
}

export function unregisterEnterpriseActiveRun(runId: string): void {
  activeRuns().delete(runId);
}

/** Test-only: clear registry state between cases (isolate:false lanes). */
export function clearEnterpriseActiveRunsForTest(): void {
  activeRuns().clear();
}

export type EnterpriseToolCallVerdict = {
  decision: GovernanceDecision;
  nodeId: string;
  treeId: string;
  mode: Exclude<EnterpriseMode, "off">;
  /** True when the decision must block execution (enforce mode denials). */
  blocked: boolean;
};

/**
 * Governance gate for one tool call. Returns undefined when the run is not
 * enterprise-mediated (mode off, unmediated caller, or unknown runId).
 * Never throws: internal evaluation failures fail closed in enforce mode and
 * open in observe mode, mirroring the enterprise/observe contract.
 */
export function evaluateEnterpriseToolCall(params: {
  runId?: string;
  toolName: string;
  toolCallId?: string;
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
    const decision = evaluateToolCallGovernance({
      plan,
      node,
      toolName: params.toolName,
      policies: run.policies,
    });
    const verdict: EnterpriseToolCallVerdict = {
      decision,
      nodeId: node.nodeId,
      treeId: plan.treeId,
      mode: plan.mode,
      blocked: decision.effect === "deny" && plan.mode === "enforce",
    };
    // Default allows stay silent (matching run-start mediation) so the stock
    // enterprise path adds no per-tool-call SQLite writes; nodes opt into
    // full decision auditing with ontology.audit.
    const silentDefaultAllow =
      decision.effect === "allow" && decision.source === "default" && node.ontology.audit !== true;
    if (!silentDefaultAllow) {
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
    };
    recordDecision(run, verdict, params);
    return verdict;
  }
}

function recordDecision(
  run: EnterpriseActiveRun,
  verdict: EnterpriseToolCallVerdict,
  params: { toolName: string; toolCallId?: string },
): void {
  try {
    run.sink?.({
      kind: "governance.decision",
      nodeId: verdict.nodeId,
      payload: {
        subject: "tool_call",
        toolName: params.toolName,
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
