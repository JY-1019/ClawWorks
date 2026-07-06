/**
 * Runner glue for ClawWorks enterprise mediation, shared by every agent
 * runtime (embedded, CLI-backed, ACP): binds the run to a workflow subtree,
 * injects the per-run step digest into system-prompt params where the runtime
 * supports it, and maps run outcomes onto the enterprise trace.
 */
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { beginEnterpriseRun, endEnterpriseRun } from "../enterprise/run-mediation.js";
import type { EnterpriseRunStatus } from "../enterprise/types.js";
import { buildAgentRunTerminalOutcome } from "./agent-run-terminal-outcome.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

/** Structural param surface shared by the mediated runner entrypoints. */
export type EnterpriseMediatedRunParams = {
  runId: string;
  prompt: string;
  trigger?: string;
  spawnedBy?: string | null;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
  extraSystemPrompt?: string;
  /** Internal one-shot model probe (raw model run). */
  modelRun?: boolean;
  /** "none" marks raw model runs that bypass agent mediation. */
  promptMode?: string;
};

export type EnterpriseMediationOutcome<T extends EnterpriseMediatedRunParams> = {
  params: T;
  /** Set when run-start governance denied the run in enforce mode. */
  blockedResult?: EmbeddedAgentRunResult;
  /** True when this run is enterprise-mediated and must be finished. */
  mediated: boolean;
};

/**
 * Bind an agent run to enterprise mediation. Call AFTER session identity is
 * resolved (sessionKey backfill, session-target agentId) so the persisted
 * trace attributes the run correctly.
 */
export function applyEnterpriseMediation<T extends EnterpriseMediatedRunParams>(
  params: T,
): EnterpriseMediationOutcome<T> {
  // Raw model runs (one-shot probes, promptMode "none") are runtime
  // machinery outside agent mediation, matching isRawModelRun semantics.
  if (params.modelRun || params.promptMode === "none") {
    return { params, mediated: false };
  }
  // Explicit-model callers may omit params.config (the runner only snapshots
  // config for default model resolution). Governance must still see the
  // configured enterprise mode/policies, so fall back to the pinned snapshot.
  const config = params.config ?? getRuntimeConfigSnapshot() ?? undefined;
  const mediation = beginEnterpriseRun({
    runId: params.runId,
    prompt: params.prompt,
    ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
    ...(params.spawnedBy !== undefined ? { spawnedBy: params.spawnedBy } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(config ? { config } : {}),
  });
  if (mediation.kind === "off") {
    return { params, mediated: false };
  }
  if (mediation.kind === "blocked") {
    return {
      params,
      mediated: false,
      blockedResult: {
        payloads: [{ text: mediation.reason, isError: true }],
        meta: {
          durationMs: 0,
          error: { kind: "hook_block", message: mediation.reason },
        },
      },
    };
  }
  if (!mediation.promptSection) {
    return { params, mediated: true };
  }
  return {
    mediated: true,
    params: {
      ...params,
      extraSystemPrompt: [params.extraSystemPrompt, mediation.promptSection]
        .filter(Boolean)
        .join("\n\n"),
    },
  };
}

/**
 * Map one agent-run outcome onto the enterprise run trace.
 * No-op for unmediated runs (mode off, probes, unknown runId).
 */
export function finishEnterpriseMediation(
  runId: string,
  outcome: { result?: EmbeddedAgentRunResult; error?: unknown },
): void {
  endEnterpriseRun({ runId, status: resolveEnterpriseRunStatus(outcome) });
}

function resolveEnterpriseRunStatus(outcome: {
  result?: EmbeddedAgentRunResult;
  error?: unknown;
}): Exclude<EnterpriseRunStatus, "running"> {
  if (outcome.error !== undefined) {
    return isAbortError(outcome.error) ? "aborted" : "failed";
  }
  const meta = outcome.result?.meta;
  if (!meta) {
    return "completed";
  }
  if (meta.error?.kind === "hook_block") {
    return "blocked";
  }
  // Canonical terminal normalization owns timeout/liveness/stop-reason
  // precedence (repo rule: never rederive it in projections). meta.aborted
  // only classifies runs the normalizer would otherwise call completed, so
  // aborted timeouts keep their timeout attribution.
  const terminal = buildAgentRunTerminalOutcome({
    status: meta.error ? "error" : meta.timeoutPhase ? "timeout" : "ok",
    error: meta.error?.message,
    stopReason: meta.stopReason,
    livenessState: meta.livenessState,
    timeoutPhase: meta.timeoutPhase,
    providerStarted: meta.providerStarted,
  });
  switch (terminal.reason) {
    case "completed":
      return meta.aborted ? "aborted" : "completed";
    case "hard_timeout":
    case "timed_out":
      return "timed_out";
    case "cancelled":
    case "aborted":
      return "aborted";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    default:
      return terminal.reason satisfies never;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
