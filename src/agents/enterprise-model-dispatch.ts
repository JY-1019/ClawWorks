import { getEnterpriseActiveRun, resolveEnterpriseMode } from "../enterprise/runtime.js";
import { getWorkflowTreeRegistrySnapshot } from "../enterprise/tree-registry.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../process/command-queue.js";
import { waitForDeferredTurnMaintenanceForSession } from "./embedded-agent-runner/context-engine-maintenance.js";
import {
  resolveGlobalLane,
  resolveSessionLane,
  resolveRunSessionQueuePriority,
  resolveEmbeddedRunLaneTimeoutMs,
} from "./embedded-agent-runner/lanes.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { withEnterpriseDispatch } from "./enterprise-dispatch-context.js";
import {
  applyEnterpriseMediation,
  finishEnterpriseMediation,
  type EnterpriseMediatedRunParams,
} from "./enterprise-mediation.js";
import { runWithModelFallback, type RunWithModelFallbackParams } from "./model-fallback.js";
import { parseModelRef } from "./model-selection.js";

/** Pins survive a failed attempt: outer retry loops must not select another map. */
export class EnterpriseModelExecutionError extends Error {
  constructor(
    readonly executionModel: string,
    cause: unknown,
  ) {
    super(
      `Work-map model ${executionModel} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "EnterpriseModelExecutionError";
  }
}

/** Select the work-map before auth, harness selection or fallback can dispatch a model. */
export async function runWithEnterpriseModelFallback(
  params: RunWithModelFallbackParams<EmbeddedAgentRunResult> & {
    enterpriseRun: EnterpriseMediatedRunParams & {
      sessionId: string;
      timeoutMs: number;
      onExecutionStarted?: () => void;
      onLaneWait?: (info: { waiting: boolean }) => void;
    };
  },
): Promise<
  Awaited<ReturnType<typeof runWithModelFallback<EmbeddedAgentRunResult>>> & {
    executionModel?: string;
  }
> {
  const { enterpriseRun, ...fallback } = params;
  if (
    enterpriseRun.modelRun ||
    enterpriseRun.promptMode === "none" ||
    resolveEnterpriseMode(params.cfg) === "off" ||
    !getWorkflowTreeRegistrySnapshot().entries.some(({ tree }) => tree.executionModel)
  ) {
    return runWithModelFallback(fallback);
  }
  const priority = resolveRunSessionQueuePriority(enterpriseRun.trigger);
  const sessionLane = resolveSessionLane(enterpriseRun.sessionKey || enterpriseRun.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const noteLaneWaitIfBusy = (lane: string) => {
    if (!enterpriseRun.onLaneWait) {
      return;
    }
    const snapshot = getCommandLaneSnapshot(lane);
    if (snapshot.queuedCount > 0 || snapshot.activeCount >= snapshot.maxConcurrent) {
      // Cron must suspend its setup watchdog while queued, before admission.
      enterpriseRun.onLaneWait({ waiting: true });
    }
  };
  noteLaneWaitIfBusy(sessionLane);
  // Keep session ownership through planning and all attempts. Inner runners
  // reuse this admission; later turns cannot overtake the routing call.
  return enqueueCommandInLane(
    sessionLane,
    async () => {
      enterpriseRun.onLaneWait?.({ waiting: false });
      params.abortSignal?.throwIfAborted();
      await waitForDeferredTurnMaintenanceForSession(enterpriseRun.sessionKey);
      params.abortSignal?.throwIfAborted();
      const controller = new AbortController();
      const signal = params.abortSignal
        ? AbortSignal.any([params.abortSignal, controller.signal])
        : controller.signal;
      const run = {
        ...enterpriseRun,
        config: params.cfg,
        provider: params.provider,
        model: params.model,
        abortSignal: signal,
      };
      const dispatch = { runId: run.runId, abortSignal: signal };
      try {
        const result = await withEnterpriseDispatch(dispatch, async () => {
          // Only planning borrows a global slot. Each execution attempt keeps
          // its own watchdog, so timeout state cannot leak into a later fallback.
          noteLaneWaitIfBusy(globalLane);
          const mediation = await enqueueCommandInLane(
            globalLane,
            () => {
              signal.throwIfAborted();
              enterpriseRun.onLaneWait?.({ waiting: false });
              enterpriseRun.onExecutionStarted?.();
              return applyEnterpriseMediation(run);
            },
            {
              priority,
              taskTimeoutMs: resolveEmbeddedRunLaneTimeoutMs(enterpriseRun.timeoutMs),
              onWait: () => enterpriseRun.onLaneWait?.({ waiting: true }),
            },
          );
          if (mediation.blockedResult) {
            return {
              outcome: "completed" as const,
              result: mediation.blockedResult,
              provider: params.provider,
              model: params.model,
              attempts: [],
            };
          }
          signal.throwIfAborted();
          const modelRef = getEnterpriseActiveRun(run.runId)?.plan.executionModel;
          const binding = modelRef ? parseModelRef(modelRef, "") : null;
          const executed = await runWithModelFallback({
            ...fallback,
            abortSignal: signal,
            ...(binding
              ? { provider: binding.provider, model: binding.model, fallbacksOverride: [] }
              : {}),
          }).catch((error: unknown) => {
            if (!modelRef || !binding || signal.aborted) {
              throw error;
            }
            throw new EnterpriseModelExecutionError(modelRef, error);
          });
          return { ...executed, ...(binding ? { executionModel: modelRef } : {}) };
        });
        finishEnterpriseMediation(run.runId, { result: result.result });
        return result;
      } catch (error) {
        // The watchdog can reject while its task is still running. Cancel that
        // task and finalize here; late completion never finalizes a newer run.
        controller.abort(error);
        finishEnterpriseMediation(run.runId, { error });
        throw error;
      }
    },
    { priority, onWait: () => enterpriseRun.onLaneWait?.({ waiting: true }) },
  );
}

/** A work-map pin is turn-local; it must never be persisted as session fallback. */
export function getEnterpriseExecutionModel(runId: string): string | undefined {
  return getEnterpriseActiveRun(runId)?.plan.executionModel;
}
