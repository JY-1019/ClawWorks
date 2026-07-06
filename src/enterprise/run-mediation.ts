/**
 * Enterprise run mediation: binds one agent execution to a workflow subtree,
 * evaluates run-start governance, registers the active run for the
 * per-tool-call gate, and persists the run trace. Trace persistence fails
 * open (logged) — only governance enforcement fails closed.
 *
 * runIds recur (fallback retries reuse them; recurring cron sessions reuse
 * their sessionId), so every begin→end cycle gets its own execution_id trace
 * row and the in-memory registry only holds currently-active executions.
 */
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { BUILTIN_WORKFLOW_TREES } from "./builtin-trees.js";
import { evaluateRunStartGovernance, resolveGovernancePolicies } from "./governance.js";
import {
  buildEnterprisePromptSection,
  buildEnterpriseRunPlan,
  classifyWorkflowTrigger,
} from "./plan.js";
import {
  registerEnterpriseActiveRun,
  resolveEnterpriseMode,
  unregisterEnterpriseActiveRun,
  type EnterpriseActiveRun,
} from "./runtime.js";
import {
  appendEnterpriseRunEvent,
  finalizeEnterpriseRun,
  persistEnterpriseRunStart,
} from "./trace-store.sqlite.js";
import type { EnterpriseRunEventKind, EnterpriseRunPlan, EnterpriseRunStatus } from "./types.js";

const log = createSubsystemLogger("enterprise");

type MediatedRunState = EnterpriseActiveRun & {
  executionId: string;
  allocateSeq: () => number;
};

// Active executions only, keyed by runId (the gate looks runs up by the
// HookContext runId). Entries are removed when the execution ends.
const mediatedRuns = new Map<string, MediatedRunState>();

export type EnterpriseRunMediation =
  | { kind: "off" }
  | { kind: "blocked"; reason: string }
  | { kind: "mediated"; plan: EnterpriseRunPlan; promptSection: string };

export type BeginEnterpriseRunParams = {
  runId: string;
  prompt: string;
  trigger?: string;
  spawnedBy?: string | null;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
};

/** Begin enterprise mediation for one agent execution. */
export function beginEnterpriseRun(params: BeginEnterpriseRunParams): EnterpriseRunMediation {
  const mode = resolveEnterpriseMode(params.config);
  if (mode === "off") {
    return { kind: "off" };
  }

  const existing = mediatedRuns.get(params.runId);
  if (existing) {
    // The same execution is still active (nested begin from one runner
    // invocation); reuse it rather than double-tracing.
    return {
      kind: "mediated",
      plan: existing.plan,
      promptSection: buildEnterprisePromptSection(existing.plan),
    };
  }

  const plan = buildEnterpriseRunPlan({
    runId: params.runId,
    requestText: params.prompt,
    trigger: classifyWorkflowTrigger({
      ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
      ...(params.spawnedBy !== undefined ? { spawnedBy: params.spawnedBy } : {}),
    }),
    mode,
    trees: BUILTIN_WORKFLOW_TREES,
  });
  const policies = resolveGovernancePolicies(params.config);
  const startDecision = evaluateRunStartGovernance({ plan, policies });

  let seq = 0;
  const run: MediatedRunState = {
    plan,
    policies,
    executionId: randomUUID(),
    allocateSeq: () => seq++,
    sink: (event) => {
      persistTrace(() => {
        appendEvent(run, event.kind, event.nodeId, event.payload);
      });
    },
  };

  persistTrace(() => {
    persistEnterpriseRunStart({
      executionId: run.executionId,
      plan,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
    });
  });
  persistTrace(() => {
    appendEvent(run, "run.started", null, {
      treeId: plan.treeId,
      treeVersion: plan.treeVersion,
      matchedBy: plan.matchedBy,
      mode: plan.mode,
    });
  });

  const runStartBlocked = startDecision.effect === "deny" && mode === "enforce";
  if (startDecision.source !== "default") {
    // Policy-sourced run decisions (deny, audit, explicit allow) are trace
    // evidence operators configured; only default allows stay silent.
    persistTrace(() => {
      appendEvent(run, "governance.decision", null, {
        subject: "run",
        effect: startDecision.effect,
        enforced: runStartBlocked,
        policyId: startDecision.policyId,
        source: startDecision.source,
        reason: startDecision.reason,
      });
    });
  }
  if (runStartBlocked) {
    persistTrace(() => {
      appendEvent(run, "run.ended", null, { status: "blocked", reason: startDecision.reason });
    });
    persistTrace(() => {
      finalizeEnterpriseRun({ executionId: run.executionId, status: "blocked" });
    });
    return { kind: "blocked", reason: startDecision.reason };
  }

  mediatedRuns.set(params.runId, run);
  registerEnterpriseActiveRun(run);
  return { kind: "mediated", plan, promptSection: buildEnterprisePromptSection(plan) };
}

/** Finish the active execution for a runId with its terminal outcome. */
export function endEnterpriseRun(params: {
  runId: string;
  status: Exclude<EnterpriseRunStatus, "running">;
  reason?: string;
}): void {
  const run = mediatedRuns.get(params.runId);
  if (!run) {
    return;
  }
  mediatedRuns.delete(params.runId);
  unregisterEnterpriseActiveRun(params.runId);
  persistTrace(() => {
    appendEvent(run, "run.ended", null, {
      status: params.status,
      ...(params.reason ? { reason: params.reason } : {}),
    });
  });
  persistTrace(() => {
    finalizeEnterpriseRun({ executionId: run.executionId, status: params.status });
  });
}

/** Test-only: reset mediation state between cases (isolate:false lanes). */
export function clearEnterpriseRunMediationForTest(): void {
  for (const runId of mediatedRuns.keys()) {
    unregisterEnterpriseActiveRun(runId);
  }
  mediatedRuns.clear();
}

function appendEvent(
  run: MediatedRunState,
  kind: EnterpriseRunEventKind,
  nodeId: string | null,
  payload: Record<string, unknown>,
): void {
  appendEnterpriseRunEvent({
    executionId: run.executionId,
    seq: run.allocateSeq(),
    nodeId,
    kind,
    payload,
    createdAt: Date.now(),
  });
}

function persistTrace(write: () => void): void {
  try {
    write();
  } catch (err) {
    log.warn(
      `enterprise trace persistence failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
