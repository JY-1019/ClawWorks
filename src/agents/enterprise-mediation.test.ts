/**
 * Tests the shared runner enterprise mediation glue: param injection,
 * run-start blocking, raw-run skips, and outcome→trace status mapping.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearEnterpriseRunMediationForTest } from "../enterprise/run-mediation.js";
import { getEnterpriseActiveRun } from "../enterprise/runtime.js";
import { getEnterpriseRunRecord } from "../enterprise/trace-store.sqlite.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";
import { applyEnterpriseMediation, finishEnterpriseMediation } from "./enterprise-mediation.js";

let runCounter = 0;
function makeParams(overrides: Partial<RunEmbeddedAgentParams> = {}): RunEmbeddedAgentParams {
  runCounter += 1;
  return {
    sessionId: `session-${runCounter}`,
    workspaceDir: "/tmp/clawworks-test",
    prompt: "hello",
    timeoutMs: 1000,
    runId: `mediation-glue-${runCounter}`,
    ...overrides,
  };
}

afterEach(() => {
  clearEnterpriseRunMediationForTest();
  clearRuntimeConfigSnapshot();
});

afterAll(() => {
  closeOpenClawStateDatabase();
});

describe("applyEnterpriseMediation", () => {
  it("mediates default runs without touching the system prompt (guidance-free tree)", () => {
    const params = makeParams({ extraSystemPrompt: "existing" });
    const outcome = applyEnterpriseMediation(params);
    expect(outcome.mediated).toBe(true);
    expect(outcome.blockedResult).toBeUndefined();
    expect(outcome.params.extraSystemPrompt).toBe("existing");
    expect(getEnterpriseActiveRun(params.runId)).toBeDefined();
  });

  it("skips internal model probes and promptMode none raw runs", () => {
    const probe = makeParams({ modelRun: true });
    expect(applyEnterpriseMediation(probe).mediated).toBe(false);
    expect(getEnterpriseActiveRun(probe.runId)).toBeUndefined();

    const rawRun = makeParams({ promptMode: "none" });
    expect(applyEnterpriseMediation(rawRun).mediated).toBe(false);
    expect(getEnterpriseActiveRun(rawRun.runId)).toBeUndefined();
  });

  it("skips mediation when enterprise mode is off", () => {
    const params = makeParams({ config: { enterprise: { mode: "off" } } });
    const outcome = applyEnterpriseMediation(params);
    expect(outcome.mediated).toBe(false);
    expect(outcome.params).toBe(params);
  });

  it("falls back to the runtime config snapshot when params omit config", () => {
    // Explicit-model callers omit params.config; configured governance
    // (here an opt-out) must still apply via the pinned snapshot.
    setRuntimeConfigSnapshot({ enterprise: { mode: "off" } });
    const offOutcome = applyEnterpriseMediation(makeParams());
    expect(offOutcome.mediated).toBe(false);

    setRuntimeConfigSnapshot({
      enterprise: {
        governance: {
          policies: [{ id: "deny.everything", effect: "deny" }],
        },
      },
    });
    const deniedOutcome = applyEnterpriseMediation(makeParams());
    expect(deniedOutcome.blockedResult?.meta.error?.kind).toBe("hook_block");
  });

  it("returns a blocked hook_block result when run-start governance denies", () => {
    const config: OpenClawConfig = {
      enterprise: {
        governance: {
          policies: [
            {
              id: "deny.everything",
              effect: "deny",
              description: "This workspace is locked down.",
            },
          ],
        },
      },
    };
    const params = makeParams({ config });
    const outcome = applyEnterpriseMediation(params);
    expect(outcome.mediated).toBe(false);
    expect(outcome.blockedResult?.meta.error?.kind).toBe("hook_block");
    expect(outcome.blockedResult?.payloads?.[0]).toMatchObject({
      text: "This workspace is locked down.",
      isError: true,
    });
    expect(getEnterpriseRunRecord(params.runId)?.status).toBe("blocked");
  });
});

describe("finishEnterpriseMediation", () => {
  it("maps clean results to completed", () => {
    const params = makeParams();
    applyEnterpriseMediation(params);
    finishEnterpriseMediation(params.runId, { result: { meta: { durationMs: 5 } } });
    expect(getEnterpriseRunRecord(params.runId)?.status).toBe("completed");
  });

  it("maps aborted results and abort errors to aborted", () => {
    const first = makeParams();
    applyEnterpriseMediation(first);
    finishEnterpriseMediation(first.runId, { result: { meta: { durationMs: 5, aborted: true } } });
    expect(getEnterpriseRunRecord(first.runId)?.status).toBe("aborted");

    const second = makeParams();
    applyEnterpriseMediation(second);
    const abortError = new Error("stop");
    abortError.name = "AbortError";
    finishEnterpriseMediation(second.runId, { error: abortError });
    expect(getEnterpriseRunRecord(second.runId)?.status).toBe("aborted");
  });

  it("maps timeout metadata to timed_out via the canonical terminal outcome", () => {
    const hardTimeout = makeParams();
    applyEnterpriseMediation(hardTimeout);
    finishEnterpriseMediation(hardTimeout.runId, {
      result: { meta: { durationMs: 5, timeoutPhase: "provider" } },
    });
    expect(getEnterpriseRunRecord(hardTimeout.runId)?.status).toBe("timed_out");

    const softTimeout = makeParams();
    applyEnterpriseMediation(softTimeout);
    finishEnterpriseMediation(softTimeout.runId, {
      result: { meta: { durationMs: 5, timeoutPhase: "queue" } },
    });
    expect(getEnterpriseRunRecord(softTimeout.runId)?.status).toBe("timed_out");

    // Timeout attribution beats the aborted flag (canonical precedence).
    const abortedTimeout = makeParams();
    applyEnterpriseMediation(abortedTimeout);
    finishEnterpriseMediation(abortedTimeout.runId, {
      result: { meta: { durationMs: 5, aborted: true, timeoutPhase: "provider" } },
    });
    expect(getEnterpriseRunRecord(abortedTimeout.runId)?.status).toBe("timed_out");
  });

  it("maps run errors to failed and hook blocks to blocked", () => {
    const first = makeParams();
    applyEnterpriseMediation(first);
    finishEnterpriseMediation(first.runId, {
      result: { meta: { durationMs: 5, error: { kind: "retry_limit", message: "boom" } } },
    });
    expect(getEnterpriseRunRecord(first.runId)?.status).toBe("failed");

    const second = makeParams();
    applyEnterpriseMediation(second);
    finishEnterpriseMediation(second.runId, {
      result: { meta: { durationMs: 5, error: { kind: "hook_block", message: "denied" } } },
    });
    expect(getEnterpriseRunRecord(second.runId)?.status).toBe("blocked");
  });
});
