import type { WorkflowPlanner } from "@openclaw/enterprise-planner";
/**
 * Runner glue for ClawWorks enterprise mediation, shared by every agent
 * runtime (embedded, CLI-backed, ACP): binds the run to a workflow subtree,
 * injects the per-run step digest into system-prompt params where the runtime
 * supports it, and maps run outcomes onto the enterprise trace.
 */
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  adoptEnterpriseRunTranscript,
  beginEnterpriseRun,
  endEnterpriseRun,
} from "../enterprise/run-mediation.js";
import { resolveEnterpriseMode } from "../enterprise/runtime.js";
import type { EnterpriseRunStatus } from "../enterprise/types.js";
import { getAgentRunContext } from "../infra/agent-events.js";
import { hasGlobalHooks } from "../plugins/hook-runner-global.js";
import { resolveEffectiveAgentSkillsLimits } from "../skills/discovery/agent-filter.js";
import {
  DEFAULT_MAX_SKILL_FILE_BYTES,
  DEFAULT_MAX_SKILLS_IN_PROMPT,
  DEFAULT_MAX_SKILLS_PROMPT_CHARS,
} from "../skills/limits-defaults.js";
import { buildAgentRunTerminalOutcome } from "./agent-run-terminal-outcome.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

/**
 * Whether this run may appear in the session it is bound to.
 *
 * Keyed on internal session effects ONLY — never on `isControlUiVisible`, which
 * answers a different question (who gets live updates) and would, if it ever
 * became false for another reason, permanently hide a legitimate run's route.
 *
 * The run context carries it for the embedded and CLI runners, whose context is
 * registered before they mediate. ACP mediates EARLIER than that registration,
 * so it passes the flag explicitly and wins here.
 */
function resolveChatVisible(params: EnterpriseMediatedRunParams): boolean {
  if (params.chatVisible !== undefined) {
    return params.chatVisible;
  }
  // A silent run writes nothing an operator sees in this session, yet it runs
  // AGAINST the visible one (memory flush is the live example) — so its route
  // would otherwise overwrite the actual turn's progress.
  if (params.silentExpected) {
    return false;
  }
  return getAgentRunContext(params.runId)?.sessionEffectsInternal !== true;
}

/**
 * Was this turn written by the runtime continuing earlier work rather than by
 * the operator?
 *
 * From the run context for the same reason `resolveChatVisible` reads it: the
 * gateway is the only layer that can tell, and by here the turn is
 * indistinguishable from a typed one. An explicit param wins so a caller that
 * mediates before registration can still say.
 */
function resolveRuntimeContinuation(params: EnterpriseMediatedRunParams): boolean {
  if (params.runtimeContinuation !== undefined) {
    return params.runtimeContinuation;
  }
  return getAgentRunContext(params.runId)?.runtimeContinuation === true;
}

/** Structural param surface shared by the mediated runner entrypoints. */
export type EnterpriseMediatedRunParams = {
  runId: string;
  prompt: string;
  trigger?: string;
  spawnedBy?: string | null;
  sessionKey?: string;
  /** Ephemeral session UUID; bound to the run so the loopback can attribute its
   * tool calls to this run from its own trusted sessionId. */
  sessionId?: string;
  agentId?: string;
  /**
   * Whether this run is one the operator is watching in chat. `false` for
   * `sessionEffects: "internal"` runs, which reuse a visible session for storage
   * but must not surface in it — the same reason registerAgentRunContext omits
   * their sessionKey.
   */
  chatVisible?: boolean;
  /**
   * The run produces no visible output in its session (memory flush and other
   * nested maintenance turns). Structural, so it arrives from the runner params
   * without every caller opting in.
   */
  silentExpected?: boolean;
  /**
   * The runtime continuing its own earlier work rather than the operator asking
   * for something. Structural, like `chatVisible` above: it arrives from the
   * runner params so no caller has to opt in.
   */
  runtimeContinuation?: boolean;
  config?: OpenClawConfig;
  extraSystemPrompt?: string;
  /** Internal one-shot model probe (raw model run). */
  modelRun?: boolean;
  /** "none" marks raw model runs that bypass agent mediation. */
  promptMode?: string;
  /** Cancels the turn; route planning must observe it, not outlive it. */
  abortSignal?: AbortSignal;
  /**
   * The model the RUN selected. Route planning must use it, not the agent
   * default: a user who picked a local/private model must not have the request
   * shipped to a cloud default provider just to pick a route.
   */
  model?: string;
  /**
   * The provider the RUN selected. Runners pass provider and model separately,
   * and a bare model id would be resolved against the DEFAULT provider — which
   * is exactly the leak this is here to prevent.
   */
  provider?: string;
  /**
   * The turn is dispatched to a backend OpenClaw does not pick the model for
   * (ACP). Route planning must not run: it would send the prompt to OpenClaw's
   * default completion model while the turn itself goes somewhere else entirely.
   */
  externalDispatch?: boolean;
  /** The auth profile the run dispatches with (account/tenant boundary). */
  authProfileId?: string;
  /**
   * Who chose that profile. "user" is an account/tenant the operator pinned;
   * "auto" (or absent) is whatever failover reached for, which is NOT a boundary
   * routing has to reproduce — see resolveRoutePlannerAuthProfileId.
   */
  authProfileIdSource?: "auto" | "user";
  /**
   * The skills this run already resolved for its agent. Passed through so a
   * step's declared skills can have their instructions inlined into the step
   * digest; reusing the runner's snapshot keeps this off the discovery path.
   *
   * `resolvedSkills` is runtime-only: a persisted session snapshot keeps the
   * catalog but drops it, and a reusing caller (cron) does not re-hydrate. Those
   * runs still name their steps' skills, they just carry no bodies — resolving
   * them there would rebuild the skill set on every scheduled turn, which is the
   * cost reuse exists to avoid.
   */
  skillsSnapshot?: {
    prompt?: string;
    resolvedSkills?: Array<{ name: string; filePath: string; baseDir: string }>;
  };
};

/**
 * How route planning should pick its model, from the run's own dispatch choice.
 *
 * A closed result, not a nullable string: "no ref" is ambiguous between "use the
 * agent default (which IS this run's choice)" and "this run pinned a provider we
 * cannot express as a ref" — and those must behave differently. Guessing the
 * former for the latter is exactly the leak this exists to prevent.
 */
function defaultHasHook(hook: "before_model_resolve" | "before_agent_reply"): boolean {
  try {
    return hasGlobalHooks(hook);
  } catch {
    // No hook runtime registered (tests, early startup): nothing can rewrite the
    // model or claim the turn, so planning on the run's own choice stays correct.
    return false;
  }
}

export type RouteModelChoice =
  | { kind: "ref"; ref: string; literal?: boolean }
  /** The run pinned no provider/model: the agent default IS its dispatch choice. */
  | { kind: "agent-default" }
  /** The run pinned a provider we cannot turn into a ref: do not plan at all. */
  | { kind: "skip" };

/**
 * The router model an operator configured, if any.
 *
 * Read straight off the config. This module is imported eagerly by every runner, and
 * reaching for the tool-model helpers here would pull model auth, auth-profile
 * discovery and the plugin provider runtime into runs that never plan a thing.
 */
function resolveConfiguredRouteModelRef(config?: OpenClawConfig): string | undefined {
  return config?.enterprise?.routePlanner?.model?.trim() || undefined;
}

export function resolveRouteModelRef(
  params: EnterpriseMediatedRunParams,
  deps: {
    hasHook?: (hook: "before_model_resolve" | "before_agent_reply") => boolean;
    /** Resolved config; mediation falls back to the pinned snapshot, so pass its result. */
    config?: OpenClawConfig;
  } = {},
): RouteModelChoice {
  // The turn goes to a backend we do not choose the model for, so there is no
  // model choice to route with. Planning would ship the prompt to OpenClaw's
  // default provider — an unrelated cloud model for a possibly-local ACP run.
  if (params.externalDispatch) {
    return { kind: "skip" };
  }
  const hasHook = deps.hasHook ?? defaultHasHook;
  // An operator who names a router model has answered what the branches below are
  // guessing at: WHERE the routing prompt may go. That outranks anything derivable
  // from the run — but only the branches deciding WHICH model routes. The gates
  // deciding whether this run plans AT ALL still go first, so a turn that was never
  // going to reach a backend does not start paying for a routing call.
  const routerModel = resolveConfiguredRouteModelRef(deps.config);
  // A before_model_resolve hook can swap the run onto a different (often local
  // or private) provider AFTER mediation runs. We would be routing on the
  // pre-hook model, i.e. possibly the very cloud default the hook exists to
  // avoid. We cannot know the post-hook choice here, so we do not plan.
  if (hasHook("before_model_resolve") && !routerModel) {
    return { kind: "skip" };
  }
  // On a CRON run a before_agent_reply hook can claim the turn and answer it
  // without ever reaching a backend (see the same gate in cli-runner). Planning
  // first would make a model call for a turn that was never going to make one.
  //
  // Scoped to cron ON PURPOSE: a bundled plugin (memory-core) registers this hook
  // in every install, so skipping on its mere presence would disable route
  // planning for everyone.
  if (params.trigger === "cron" && hasHook("before_agent_reply")) {
    return { kind: "skip" };
  }
  if (routerModel) {
    return { kind: "ref", ref: routerModel, literal: true };
  }
  const model = params.model?.trim();
  const provider = params.provider?.trim();
  if (model) {
    if (!provider) {
      return { kind: "ref", ref: model };
    }
    // Qualify with the PINNED provider unless the model already carries it.
    // A bare "contains a slash" test would be wrong: gateway providers route
    // slash-bearing model ids (openrouter + "anthropic/claude-sonnet-4-6"), and
    // treating that as already-qualified would drop `openrouter` and send the
    // prompt to anthropic — the exact leak this function exists to prevent.
    if (model === provider || model.startsWith(`${provider}/`)) {
      return { kind: "ref", ref: model };
    }
    return { kind: "ref", ref: `${provider}/${model}` };
  }
  if (provider) {
    // A provider with no model (a CLI run on that provider's default). We cannot
    // build a ref that pins the provider, and resolving a bare default would fall
    // back to the AGENT default — possibly a cloud provider this run deliberately
    // avoided. Skip planning; the whole tree is planned instead, which is less
    // precise but never routes the prompt somewhere the run did not choose.
    return { kind: "skip" };
  }
  return { kind: "agent-default" };
}

/**
 * The auth profile route planning should dispatch with, or undefined to let the
 * provider pick one.
 *
 * ONLY a profile the operator pinned. In a multi-profile setup a pinned profile
 * is an account/tenant boundary the router must reproduce, so it stays. A profile
 * failover reached for on its own is not: the run is already willing to use any
 * profile in the provider's order, and the turn may not authenticate with that
 * profile at all — a CLI backend runs on its own login and scrubs the provider's
 * API-key env, so its "auth profile" is metadata the turn never spends. Pinning
 * the router to it turns an unused, possibly-dead credential into a hard routing
 * failure, and every failure binds a work-map the request has nothing to do with.
 */
function resolveRoutePlannerAuthProfileId(
  params: EnterpriseMediatedRunParams,
  config?: OpenClawConfig,
): string | undefined {
  if (params.authProfileIdSource !== "user") {
    return undefined;
  }
  // An auth profile names an account WITHIN one provider. A configured router on
  // another provider cannot use the run's pinned profile — it would be a credential
  // from somewhere else and fail every call — so the router picks its own there. On
  // the SAME provider the pin is still an account/tenant boundary the router has to
  // reproduce, or a cheaper same-provider router would quietly route through
  // whichever account the provider's order happens to reach first.
  const routerModel = resolveConfiguredRouteModelRef(config);
  if (routerModel && !routerSharesRunProvider(routerModel, params, config)) {
    return undefined;
  }
  return params.authProfileId;
}

/**
 * Whether a configured router resolves to the same provider the run dispatches to.
 *
 * Compared as AUTH identities, not as written: `moonshotai/...` and `moonshot/...`
 * are the same account boundary once resolution canonicalizes them, and a raw string
 * compare would drop the pin for a router that is not actually going anywhere else.
 */
function routerSharesRunProvider(
  routerModel: string,
  params: EnterpriseMediatedRunParams,
  config?: OpenClawConfig,
): boolean {
  const lookup = config ? { config } : undefined;
  const runProvider = providerOfRef(params.provider?.trim() || params.model, lookup);
  const routerProvider = providerOfRef(routerModel, lookup);
  return Boolean(runProvider && routerProvider && runProvider === routerProvider);
}

/** The canonical auth provider a ref (or a bare provider id) belongs to. */
function providerOfRef(
  ref: string | undefined,
  lookup: { config: OpenClawConfig } | undefined,
): string | undefined {
  const trimmed = ref?.trim();
  if (!trimmed) {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  const provider = slash > 0 ? trimmed.slice(0, slash) : trimmed;
  return resolveProviderIdForAuth(provider, lookup) || undefined;
}

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
export async function applyEnterpriseMediation<T extends EnterpriseMediatedRunParams>(
  params: T,
): Promise<EnterpriseMediationOutcome<T>> {
  // Raw model runs (one-shot probes, promptMode "none") are runtime
  // machinery outside agent mediation, matching isRawModelRun semantics.
  if (params.modelRun || params.promptMode === "none") {
    return { params, mediated: false };
  }
  // Explicit-model callers may omit params.config (the runner only snapshots
  // config for default model resolution). Governance must still see the
  // configured enterprise mode/policies, so fall back to the pinned snapshot.
  const config = params.config ?? getRuntimeConfigSnapshot() ?? undefined;
  // The planner is only built when a config exists AND enterprise mediation is
  // actually on: without one there is no model to ask, and mediation plans the
  // whole subtree (its prior behavior).
  //
  // It is loaded LAZILY. The planner module pulls in the provider/completion
  // runtime, and a static import would put that cost on every embedded/CLI/ACP
  // run — including the ones with enterprise mode off, which never plan.
  const modelChoice = resolveRouteModelRef(params, config ? { config } : {});
  const routeAuthProfileId = resolveRoutePlannerAuthProfileId(params, config);
  const planningPossible =
    Boolean(config) && resolveEnterpriseMode(config) !== "off" && modelChoice.kind !== "skip";
  // The planner module pulls in the provider/completion runtime. Import it inside
  // the CALLBACK, not here: selectWorkflowPlan skips small trees entirely (the
  // built-in default is 4 nodes), so a stock run would otherwise pay that startup
  // cost on the hot path for a planner it never calls.
  const routePlanner: WorkflowPlanner | undefined =
    planningPossible && config
      ? async (plannerParams) => {
          const { createModelWorkflowPlanner } =
            await import("./enterprise-route-planner.runtime.js");
          const planner = createModelWorkflowPlanner({
            cfg: config,
            ...(params.agentId ? { agentId: params.agentId } : {}),
            // Route with the exact provider/model the run dispatches to, and with
            // the account the operator pinned when there is one.
            ...(modelChoice.kind === "ref"
              ? {
                  modelRef: modelChoice.ref,
                  ...(modelChoice.literal ? { literalModelRef: true } : {}),
                }
              : {}),
            ...(routeAuthProfileId ? { authProfileId: routeAuthProfileId } : {}),
          });
          // No planner could be built (no config): "cannot be consulted", not
          // "answered badly" — the default tree governs rather than a work-map.
          return planner ? await planner(plannerParams) : { kind: "unavailable" };
        }
      : undefined;
  const agentSkillsLimits = resolveEffectiveAgentSkillsLimits(config, params.agentId);
  // Defaults matter: the loader applies them whether or not an operator set the
  // key, so reading only the configured value would hand the appendix a second
  // independent budget on every stock install. Mirrors resolveSkillsLimits.
  const configuredSkillPromptChars =
    agentSkillsLimits?.maxSkillsPromptChars ??
    config?.skills?.limits?.maxSkillsPromptChars ??
    DEFAULT_MAX_SKILLS_PROMPT_CHARS;
  const configuredMaxSkillsInPrompt =
    config?.skills?.limits?.maxSkillsInPrompt ?? DEFAULT_MAX_SKILLS_IN_PROMPT;
  // What is LEFT of the cap after the catalog the model already gets. Passing the
  // full cap would hand the appendix a second independent budget, so a small
  // context could receive the catalog plus another catalog's worth of bodies.
  // The snapshot's catalog is the best proxy available here: mediation runs
  // before the attempt layer may drop the catalog (toolsAllow) or a sandbox
  // rebuilds it from materialized paths, so this can be slightly off in either
  // direction. It is a budget, not a gate, and erring toward the pre-run catalog
  // keeps the appendix from claiming a second full allowance.
  const catalogPrompt = params.skillsSnapshot?.prompt ?? "";
  const skillPromptCharCap = Math.max(0, configuredSkillPromptChars - catalogPrompt.length);
  // Count is shared too: the catalog already spent part of the allowance, and
  // `resolvedSkills` is pre-limit, so a work-map must not get a fresh quota.
  const catalogSkillCount = (catalogPrompt.match(/<name>/g) ?? []).length;
  const skillCountCap = Math.max(0, configuredMaxSkillsInPrompt - catalogSkillCount);
  const mediation = await beginEnterpriseRun({
    runId: params.runId,
    prompt: params.prompt,
    ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
    ...(resolveRuntimeContinuation(params) ? { runtimeContinuation: true } : {}),
    ...(params.spawnedBy !== undefined ? { spawnedBy: params.spawnedBy } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(resolveChatVisible(params) === false ? { chatVisible: false } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(config ? { config } : {}),
    ...(routePlanner ? { routePlanner } : {}),
    // Cancelling the turn must cancel route planning with it; otherwise the
    // planner runs to its timeout and traces a route for an aborted run.
    ...(params.abortSignal ? { signal: params.abortSignal } : {}),
    // Only the already-resolved set: mediation must not trigger skill discovery.
    ...(params.skillsSnapshot?.resolvedSkills?.length
      ? { availableSkills: params.skillsSnapshot.resolvedSkills }
      : {}),
    // The inlined bodies are model-facing skill text, so the operator's catalog
    // limits govern them too — including a per-agent override, which takes
    // precedence over the global cap exactly as the snapshot builder applies it
    // (resolveSkillsLimits in src/skills/loading/workspace.ts).
    maxSkillPromptChars: skillPromptCharCap,
    maxSkillsInPrompt: skillCountCap,
    maxSkillFileBytes: config?.skills?.limits?.maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES,
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

/** Test-only alias: the ref contract is what keeps a private run off a cloud default. */
export { resolveRouteModelRef as resolveRouteModelRefForTest };

/** Test-only alias: which account routing is allowed to spend. */
export { resolveRoutePlannerAuthProfileId as resolveRoutePlannerAuthProfileIdForTest };

/**
 * Point this run's governed trace at a rotated transcript.
 *
 * Re-exported here so runners keep reaching the enterprise layer through this
 * one adapter rather than importing its internals directly.
 */
export function adoptEnterpriseRunSessionId(runId: string, sessionId: string): void {
  adoptEnterpriseRunTranscript(runId, sessionId);
}
