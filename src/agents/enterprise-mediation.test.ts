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
import {
  applyEnterpriseMediation,
  finishEnterpriseMediation,
  resolveRouteModelRefForTest,
  resolveRoutePlannerAuthProfileIdForTest,
  type EnterpriseMediatedRunParams,
} from "./enterprise-mediation.js";

// The helper feeds BOTH entrypoints, and they take different param surfaces:
// applyEnterpriseMediation takes the runner's params, resolveRouteModelRef takes
// the mediation surface (which is where externalDispatch/authProfileId live).
// Typing it as only the former silently dropped the dispatch fields the
// model-leak guard is built on.
type MediationTestParams = RunEmbeddedAgentParams & EnterpriseMediatedRunParams;

let runCounter = 0;
function makeParams(overrides: Partial<MediationTestParams> = {}): MediationTestParams {
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
  it("mediates default runs without touching the system prompt (guidance-free tree)", async () => {
    const params = makeParams({ extraSystemPrompt: "existing" });
    const outcome = await applyEnterpriseMediation(params);
    expect(outcome.mediated).toBe(true);
    expect(outcome.blockedResult).toBeUndefined();
    expect(outcome.params.extraSystemPrompt).toBe("existing");
    expect(getEnterpriseActiveRun(params.runId)).toBeDefined();
  });

  it("skips internal model probes and promptMode none raw runs", async () => {
    const probe = makeParams({ modelRun: true });
    expect((await applyEnterpriseMediation(probe)).mediated).toBe(false);
    expect(getEnterpriseActiveRun(probe.runId)).toBeUndefined();

    const rawRun = makeParams({ promptMode: "none" });
    expect((await applyEnterpriseMediation(rawRun)).mediated).toBe(false);
    expect(getEnterpriseActiveRun(rawRun.runId)).toBeUndefined();
  });

  it("skips mediation when enterprise mode is off", async () => {
    const params = makeParams({ config: { enterprise: { mode: "off" } } });
    const outcome = await applyEnterpriseMediation(params);
    expect(outcome.mediated).toBe(false);
    expect(outcome.params).toBe(params);
  });

  it("falls back to the runtime config snapshot when params omit config", async () => {
    // Explicit-model callers omit params.config; configured governance
    // (here an opt-out) must still apply via the pinned snapshot.
    setRuntimeConfigSnapshot({ enterprise: { mode: "off" } });
    const offOutcome = await applyEnterpriseMediation(makeParams());
    expect(offOutcome.mediated).toBe(false);

    setRuntimeConfigSnapshot({
      enterprise: {
        governance: {
          policies: [{ id: "deny.everything", effect: "deny" }],
        },
      },
    });
    const deniedOutcome = await applyEnterpriseMediation(makeParams());
    expect(deniedOutcome.blockedResult?.meta.error?.kind).toBe("hook_block");
  });

  it("returns a blocked hook_block result when run-start governance denies", async () => {
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
    const outcome = await applyEnterpriseMediation(params);
    expect(outcome.mediated).toBe(false);
    expect(outcome.blockedResult?.meta.error?.kind).toBe("hook_block");
    expect(outcome.blockedResult?.payloads?.[0]).toMatchObject({
      text: "This workspace is locked down.",
      isError: true,
    });
    expect(getEnterpriseRunRecord(params.runId)?.status).toBe("blocked");
  });
});

describe("route planning model selection", () => {
  it("routes with the run's own provider/model, never the agent default", async () => {
    // A user on a local/private model must not have the request shipped to a
    // cloud default provider just to pick a route.
    const params = makeParams({ provider: "ollama", model: "llama3" });
    const outcome = await applyEnterpriseMediation(params);
    expect(outcome.mediated).toBe(true);
    // The ref handed to the planner is the run's dispatch choice, qualified.
    expect(resolveRouteModelRefForTest(params)).toEqual({ kind: "ref", ref: "ollama/llama3" });
  });

  it("passes an already-qualified model ref through unchanged", () => {
    expect(
      resolveRouteModelRefForTest(makeParams({ provider: "anthropic", model: "anthropic/opus" })),
    ).toEqual({ kind: "ref", ref: "anthropic/opus" });
  });

  it("keeps a gateway provider that routes slash-bearing model ids", () => {
    // openrouter serves "anthropic/claude-sonnet-4-6". Treating the slash as
    // "already qualified" would drop openrouter and send the prompt to anthropic.
    expect(
      resolveRouteModelRefForTest(
        makeParams({ provider: "openrouter", model: "anthropic/claude-sonnet-4-6" }),
      ),
    ).toEqual({ kind: "ref", ref: "openrouter/anthropic/claude-sonnet-4-6" });
  });

  it("uses the bare model when the run pinned no provider", () => {
    expect(resolveRouteModelRefForTest(makeParams({ model: "llama3" }))).toEqual({
      kind: "ref",
      ref: "llama3",
    });
  });

  it("SKIPS planning for a provider-only run (its default model has no ref)", () => {
    // A CLI run pinned to a local provider with that provider's default model:
    // a bare default would resolve against the AGENT default, possibly a cloud
    // provider this run deliberately avoided. Planning is skipped instead.
    expect(resolveRouteModelRefForTest(makeParams({ provider: "ollama" }))).toEqual({
      kind: "skip",
    });
  });

  it("SKIPS planning for an ACP run (its prompt goes to a backend we do not pick)", () => {
    // ACP dispatches to its own backend. Routing would ship the prompt to
    // OpenClaw's default completion model — an unrelated cloud model for a
    // possibly-local ACP session.
    expect(resolveRouteModelRefForTest(makeParams({ externalDispatch: true }))).toEqual({
      kind: "skip",
    });
  });

  it("SKIPS planning when a before_model_resolve hook can still swap the provider", () => {
    // The hook runs AFTER mediation, so planning here would use the pre-hook
    // model — possibly the very cloud default the hook exists to avoid.
    expect(
      resolveRouteModelRefForTest(makeParams({ provider: "anthropic", model: "opus" }), {
        hasHook: (hook) => hook === "before_model_resolve",
      }),
    ).toEqual({ kind: "skip" });
  });

  it("SKIPS planning for a CRON run when a before_agent_reply hook may claim it", () => {
    expect(
      resolveRouteModelRefForTest(
        makeParams({ provider: "anthropic", model: "opus", trigger: "cron" }),
        { hasHook: (hook) => hook === "before_agent_reply" },
      ),
    ).toEqual({ kind: "skip" });
  });

  it("still plans a normal turn when only before_agent_reply exists", () => {
    // A bundled plugin (memory-core) registers this hook in EVERY install, so
    // skipping on its presence alone would disable route planning for everyone.
    expect(
      resolveRouteModelRefForTest(makeParams({ provider: "anthropic", model: "opus" }), {
        hasHook: (hook) => hook === "before_agent_reply",
      }),
    ).toEqual({ kind: "ref", ref: "anthropic/opus" });
  });

  it("uses the agent default when the run pinned nothing (that IS its choice)", () => {
    expect(resolveRouteModelRefForTest(makeParams({}))).toEqual({ kind: "agent-default" });
  });
});

describe("resolveRoutePlannerAuthProfileId", () => {
  it("keeps a profile the operator pinned (it is an account/tenant boundary)", () => {
    expect(
      resolveRoutePlannerAuthProfileIdForTest(
        makeParams({ authProfileId: "anthropic:tenant-b", authProfileIdSource: "user" }),
      ),
    ).toBe("anthropic:tenant-b");
  });

  it("drops a profile failover picked on its own", () => {
    // The run is already willing to use any profile in the provider's order, and a
    // CLI-backed turn authenticates from its own login while scrubbing the
    // provider's API-key env — so that profile may be a credential the turn never
    // spends. Pinning routing to it made one dead API key fail EVERY run's
    // planning, and each failure bound an unrelated work-map planned whole.
    expect(
      resolveRoutePlannerAuthProfileIdForTest(
        makeParams({ authProfileId: "anthropic:default", authProfileIdSource: "auto" }),
      ),
    ).toBeUndefined();
    expect(
      resolveRoutePlannerAuthProfileIdForTest(makeParams({ authProfileId: "anthropic:default" })),
    ).toBeUndefined();
  });
});

describe("finishEnterpriseMediation", () => {
  it("maps clean results to completed", async () => {
    const params = makeParams();
    await applyEnterpriseMediation(params);
    finishEnterpriseMediation(params.runId, { result: { meta: { durationMs: 5 } } });
    expect(getEnterpriseRunRecord(params.runId)?.status).toBe("completed");
  });

  it("maps aborted results and abort errors to aborted", async () => {
    const first = makeParams();
    await applyEnterpriseMediation(first);
    finishEnterpriseMediation(first.runId, { result: { meta: { durationMs: 5, aborted: true } } });
    expect(getEnterpriseRunRecord(first.runId)?.status).toBe("aborted");

    const second = makeParams();
    await applyEnterpriseMediation(second);
    const abortError = new Error("stop");
    abortError.name = "AbortError";
    finishEnterpriseMediation(second.runId, { error: abortError });
    expect(getEnterpriseRunRecord(second.runId)?.status).toBe("aborted");
  });

  it("maps timeout metadata to timed_out via the canonical terminal outcome", async () => {
    const hardTimeout = makeParams();
    await applyEnterpriseMediation(hardTimeout);
    finishEnterpriseMediation(hardTimeout.runId, {
      result: { meta: { durationMs: 5, timeoutPhase: "provider" } },
    });
    expect(getEnterpriseRunRecord(hardTimeout.runId)?.status).toBe("timed_out");

    const softTimeout = makeParams();
    await applyEnterpriseMediation(softTimeout);
    finishEnterpriseMediation(softTimeout.runId, {
      result: { meta: { durationMs: 5, timeoutPhase: "queue" } },
    });
    expect(getEnterpriseRunRecord(softTimeout.runId)?.status).toBe("timed_out");

    // Timeout attribution beats the aborted flag (canonical precedence).
    const abortedTimeout = makeParams();
    await applyEnterpriseMediation(abortedTimeout);
    finishEnterpriseMediation(abortedTimeout.runId, {
      result: { meta: { durationMs: 5, aborted: true, timeoutPhase: "provider" } },
    });
    expect(getEnterpriseRunRecord(abortedTimeout.runId)?.status).toBe("timed_out");
  });

  it("maps run errors to failed and hook blocks to blocked", async () => {
    const first = makeParams();
    await applyEnterpriseMediation(first);
    finishEnterpriseMediation(first.runId, {
      result: { meta: { durationMs: 5, error: { kind: "retry_limit", message: "boom" } } },
    });
    expect(getEnterpriseRunRecord(first.runId)?.status).toBe("failed");

    const second = makeParams();
    await applyEnterpriseMediation(second);
    finishEnterpriseMediation(second.runId, {
      result: { meta: { durationMs: 5, error: { kind: "hook_block", message: "denied" } } },
    });
    expect(getEnterpriseRunRecord(second.runId)?.status).toBe("blocked");
  });
});

describe("a configured router model", () => {
  // A Mistral key costs a fraction of the turn's model and, unlike a CLI or
  // subscription backend, it is something the direct completion API accepts —
  // which is the whole reason an operator names a router model.
  const withRouter = (ref: string): OpenClawConfig =>
    ({ enterprise: { routePlanner: { model: ref } } }) as OpenClawConfig;

  it("wins over the model the turn happens to run on", () => {
    expect(
      resolveRouteModelRefForTest(makeParams({ provider: "openai", model: "gpt-5.5" }), {
        config: withRouter("mistral/mistral-medium-3-5"),
      }),
    ).toEqual({ kind: "ref", ref: "mistral/mistral-medium-3-5", literal: true });
  });

  it("gives a provider-only run a route again", () => {
    // Without a named router this run cannot be planned at all: its default model
    // has no ref to route with. Naming one answers exactly that.
    expect(
      resolveRouteModelRefForTest(makeParams({ provider: "ollama" }), {
        config: withRouter("mistral/mistral-small-latest"),
      }),
    ).toEqual({ kind: "ref", ref: "mistral/mistral-small-latest", literal: true });
  });

  it("outranks a hook that may swap the run's own model later", () => {
    // The hook gate exists because we cannot know the post-hook model. An operator
    // who names the router has already said where the routing prompt may go.
    expect(
      resolveRouteModelRefForTest(makeParams({}), {
        config: withRouter("mistral/mistral-medium-3-5"),
        hasHook: (hook) => hook === "before_model_resolve",
      }),
    ).toEqual({ kind: "ref", ref: "mistral/mistral-medium-3-5", literal: true });
  });

  it("still refuses to plan a cron turn a hook may answer without a backend", () => {
    // A before_agent_reply hook can finish the cron turn without ever dispatching,
    // so naming a router must not start buying routing calls for work that never
    // runs. Gates about WHETHER to plan outrank the operator's choice of model.
    expect(
      resolveRouteModelRefForTest(makeParams({ trigger: "cron" }), {
        config: withRouter("mistral/mistral-medium-3-5"),
        hasHook: (hook) => hook === "before_agent_reply",
      }),
    ).toEqual({ kind: "skip" });
  });

  it("still refuses to plan an ACP run", () => {
    // ACP owns its tool channel and its own backend; a router model does not change
    // who dispatches the turn.
    expect(
      resolveRouteModelRefForTest(makeParams({ externalDispatch: true }), {
        config: withRouter("mistral/mistral-medium-3-5"),
      }),
    ).toEqual({ kind: "skip" });
  });

  it("keeps a pinned profile when the router shares the run's provider", () => {
    // A pin is an account/tenant boundary. A cheaper same-provider router must
    // reproduce it, or routing quietly runs through whichever account the provider
    // order reaches first.
    expect(
      resolveRoutePlannerAuthProfileIdForTest(
        makeParams({
          provider: "openai",
          model: "gpt-5.5",
          authProfileId: "openai:tenant-b",
          authProfileIdSource: "user",
        }),
        withRouter("openai/gpt-5.4-mini"),
      ),
    ).toBe("openai:tenant-b");
  });

  it("does not hand the router an auth profile from another provider", () => {
    // authProfileId names an account INSIDE one provider. Forwarding the turn's
    // pinned profile to a router on a different provider fails every call.
    expect(
      resolveRoutePlannerAuthProfileIdForTest(
        makeParams({ authProfileId: "openai:tenant-b", authProfileIdSource: "user" }),
        withRouter("mistral/mistral-medium-3-5"),
      ),
    ).toBeUndefined();
  });

  it("keeps forwarding the pinned profile when no router is named", () => {
    expect(
      resolveRoutePlannerAuthProfileIdForTest(
        makeParams({ authProfileId: "openai:tenant-b", authProfileIdSource: "user" }),
      ),
    ).toBe("openai:tenant-b");
  });
});
